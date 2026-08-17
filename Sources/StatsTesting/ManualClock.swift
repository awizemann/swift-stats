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
                let alreadyDue = state.withLock { state -> Bool in
                    guard state.elapsed < deadline else { return true }
                    state.sleepers.append(Sleeper(id: id, deadline: deadline, continuation: continuation))
                    return false
                }
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

    /// Yields (never sleeps) until at least `count` sleepers are registered, so
    /// a test cannot `advance` past a deadline that has not been set yet.
    /// Returns `false` if they never arrived.
    @discardableResult
    public func waitForSleepers(count: Int = 1, maxYields: Int = 10_000) async -> Bool {
        for _ in 0..<maxYields {
            if pendingSleepCount >= count { return true }
            await Task.yield()
        }
        return false
    }

    /// Resumes everything still waiting. Call in teardown so a suspended retry
    /// task does not outlive the test.
    public func cancelAllSleepers() {
        let sleepers: [Sleeper] = state.withLock { state in
            let all = state.sleepers
            state.sleepers.removeAll()
            return all
        }
        for sleeper in sleepers { sleeper.continuation.resume() }
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
