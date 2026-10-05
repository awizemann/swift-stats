import Foundation
import Stats
import Synchronization

/// A clock a test drives by hand.
///
/// Implemented rather than depended on: the package has zero dependencies, so
/// `swift-clocks`' `TestClock` is not available, and Swift has no test clock in
/// the standard library. It conforms both to `Stats`' own `StatsClock` seam and
/// to the standard `Clock` protocol, so a consumer can pass it to their own
/// `Task.sleep(for:clock:)` call sites too.
///
/// Nothing here waits: `sleep(for:)` suspends until `advance(by:)` moves past
/// the deadline, and the wall clock moves with it. A test therefore controls
/// both the inactivity gap and the retry backoff exactly.
public final class ManualClock: StatsClock, Clock, @unchecked Sendable {
    /// An instant is just an offset from the clock's origin.
    public struct Instant: InstantProtocol, Sendable {
        public var offset: Duration
        public init(offset: Duration) { self.offset = offset }

        public func advanced(by duration: Duration) -> Instant { Instant(offset: offset + duration) }
        public func duration(to other: Instant) -> Duration { other.offset - offset }
        public static func < (lhs: Instant, rhs: Instant) -> Bool { lhs.offset < rhs.offset }
    }

    private struct Sleeper {
        var id: Int
        var deadline: Duration
        var continuation: CheckedContinuation<Void, Never>
    }

    private struct State {
        var elapsed: Duration = .zero
        var wallBase: Date
        var sleepers: [Sleeper] = []
        var nextID = 0
        var requestedSleeps: [Duration] = []
        /// `waitForSleepers(count:)` callers, resumed by `sleep(for:)` the
        /// moment enough sleepers are registered.
        var registrationWaiters: [(id: Int, count: Int, continuation: CheckedContinuation<Void, Never>)] = []
    }

    private let state: Mutex<State>

    /// - Parameter wallStart: the wall-clock instant the clock reports at
    ///   `elapsed == 0`. Fixed by default so timestamp assertions are stable.
    public init(wallStart: Date = Date(timeIntervalSince1970: 1_786_012_978)) {
        self.state = Mutex(State(wallBase: wallStart))
    }

    // MARK: StatsClock

    public func wallNow() -> Date {
        state.withLock { $0.wallBase.addingTimeInterval($0.elapsed.statsSeconds) }
    }

    public func monotonicNow() -> Duration {
        state.withLock { $0.elapsed }
    }

    public func sleep(for duration: Duration) async throws {
        guard duration > .zero else { return }
        let (id, deadline) = state.withLock { state -> (Int, Duration) in
            state.requestedSleeps.append(duration)
            state.nextID += 1
            return (state.nextID, state.elapsed + duration)
        }

        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                let (alreadyDue, satisfied) = state.withLock { state -> (Bool, [CheckedContinuation<Void, Never>]) in
                    guard state.elapsed < deadline else { return (true, []) }
                    state.sleepers.append(Sleeper(id: id, deadline: deadline, continuation: continuation))
                    let count = state.sleepers.count
                    let ready = state.registrationWaiters.filter { $0.count <= count }.map(\.continuation)
                    state.registrationWaiters.removeAll { $0.count <= count }
                    return (false, ready)
                }
                for waiter in satisfied { waiter.resume() }
                if alreadyDue { continuation.resume() }
            }
        } onCancel: {
            // Resume rather than leak: a cancelled `Task.sleep` throws, but this
            // seam's callers treat a cancelled sleep as "stop waiting", and they
            // re-check `Task.isCancelled` on the other side.
            resume(id: id)
        }
    }

    // MARK: Clock

    public var now: Instant { Instant(offset: monotonicNow()) }
    public var minimumResolution: Duration { .nanoseconds(1) }

    public func sleep(until deadline: Instant, tolerance: Duration? = nil) async throws {
        let remaining = now.duration(to: deadline)
        guard remaining > .zero else { return }
        try await sleep(for: remaining)
    }

    // MARK: Driving

    /// Moves both clocks forward and resumes every sleeper whose deadline has
    /// passed.
    public func advance(by duration: Duration) {
        let due: [Sleeper] = state.withLock { state in
            state.elapsed += duration
            let ready = state.sleepers.filter { $0.deadline <= state.elapsed }
            state.sleepers.removeAll { $0.deadline <= state.elapsed }
            return ready
        }
        for sleeper in due { sleeper.continuation.resume() }
    }

    /// Moves **only** the wall clock, as a user changing the device time does:
    /// the monotonic clock and every sleeper are unaffected. Negative values
    /// set it back. This is what lets a test check that elapsed-time logic
    /// never reads the wall clock (§10).
    public func shiftWallClock(by seconds: TimeInterval) {
        state.withLock { $0.wallBase = $0.wallBase.addingTimeInterval(seconds) }
    }

    /// How many sleepers are currently waiting. Use `waitForSleepers` rather
    /// than reading this in a loop.
    public var pendingSleepCount: Int {
        state.withLock { $0.sleepers.count }
    }

    /// Every duration ever passed to `sleep(for:)`, in order — this is how a
    /// test asserts a backoff schedule without any real waiting.
    public var requestedSleeps: [Duration] {
        state.withLock { $0.requestedSleeps }
    }

    /// Suspends until at least `count` sleepers are **pending** at once, so a
    /// test cannot `advance` past a deadline that has not been set yet.
    ///
    /// Signalled by `sleep(for:)` itself the moment a sleeper registers — no
    /// polling, so it does not depend on how busy the machine is. It counts
    /// sleepers waiting *now*, the same number ``pendingSleepCount`` reports:
    /// one that registered and was already resumed by an `advance` (or
    /// cancelled) does not count. So call it before advancing past the
    /// deadlines it is waiting for, not after.
    ///
    /// It waits for as long as that takes; a sleeper that never arrives is a
    /// hang, which a test's time limit turns into a failure — and the
    /// cancellation that time limit delivers resumes this call rather than
    /// leaking it. To assert that a sleeper does *not* arrive, use
    /// ``waitForSleepers(count:maxYields:)``.
    public func waitForSleepers(count: Int = 1) async {
        let id = state.withLock { state -> Int in
            state.nextID += 1
            return state.nextID
        }
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                let ready = state.withLock { state -> Bool in
                    // Checked under the lock, so a cancellation whose handler
                    // ran before this waiter was stored still resumes it.
                    guard state.sleepers.count < count, !Task.isCancelled else { return true }
                    state.registrationWaiters.append((id, count, continuation))
                    return false
                }
                if ready { continuation.resume() }
            }
        } onCancel: {
            let waiter = state.withLock { state -> CheckedContinuation<Void, Never>? in
                guard let index = state.registrationWaiters.firstIndex(where: { $0.id == id }) else { return nil }
                return state.registrationWaiters.remove(at: index).continuation
            }
            waiter?.resume()
        }
    }

    /// The bounded form: yields (never sleeps) up to `maxYields` times for
    /// `count` sleepers to register, and returns `false` if they did not. Only
    /// for a negative assertion — a yield budget is a race against the
    /// scheduler, so "arrived" should be awaited with ``waitForSleepers(count:)``.
    @discardableResult
    public func waitForSleepers(count: Int, maxYields: Int) async -> Bool {
        for _ in 0..<maxYields {
            if pendingSleepCount >= count { return true }
            await Task.yield()
        }
        return false
    }

    /// Resumes everything still waiting. Call in teardown so a suspended retry
    /// task does not outlive the test.
    /// Also releases any `waitForSleepers(count:)` still waiting, so a test
    /// that failed before its sleeper arrived does not leak a suspended task.
    public func cancelAllSleepers() {
        let (sleepers, waiters) = state.withLock { state in
            let all = state.sleepers
            let waiting = state.registrationWaiters.map(\.continuation)
            state.sleepers.removeAll()
            state.registrationWaiters.removeAll()
            return (all, waiting)
        }
        for sleeper in sleepers { sleeper.continuation.resume() }
        for waiter in waiters { waiter.resume() }
    }

    private func resume(id: Int) {
        let sleeper: Sleeper? = state.withLock { state in
            guard let index = state.sleepers.firstIndex(where: { $0.id == id }) else { return nil }
            return state.sleepers.remove(at: index)
        }
        sleeper?.continuation.resume()
    }
}

extension Duration {
    /// Seconds as a `Double`, for the backoff-schedule assertions in this
    /// package's own tests.
    ///
    /// `package`, not `public`: a testing library has no business adding a
    /// member to a standard-library type in every consumer's namespace, where it
    /// would collide with theirs and could never be removed without a breaking
    /// change. A consumer who wants it can write the one line themselves.
    package var statsSeconds: Double {
        Double(components.seconds) + Double(components.attoseconds) * 1e-18
    }
}
