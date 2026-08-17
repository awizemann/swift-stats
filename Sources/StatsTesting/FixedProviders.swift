import Foundation
import Stats
import Synchronization

/// UUIDs a test chooses.
///
/// Feeds both the install identity and `batchId`, so a test can assert an exact
/// hashed `installId` and an exact envelope.
public final class FixedUUIDProvider: StatsUUIDProvider, @unchecked Sendable {
    private let state: Mutex<(queue: [UUID], issued: [UUID], fallback: UUID)>

    /// - Parameters:
    ///   - uuids: handed out in order.
    ///   - fallback: used once the list runs out. Deterministic on purpose: an
    ///     accidental extra UUID request shows up as a repeated value in an
    ///     assertion rather than as a random flake.
    public init(
        _ uuids: [UUID] = [],
        fallback: UUID = UUID(uuidString: "00000000-0000-4000-8000-000000000000")!
    ) {
        self.state = Mutex((queue: uuids, issued: [], fallback: fallback))
    }

    public func uuid() -> UUID {
        state.withLock { state in
            let next = state.queue.isEmpty ? state.fallback : state.queue.removeFirst()
            state.issued.append(next)
            return next
        }
    }

    /// Every UUID handed out, in order.
    public var issued: [UUID] { state.withLock { $0.issued } }
}

/// Deterministic randomness: a fixed digit string for session ids and a fixed
/// jitter fraction for the backoff.
/// The digits **advance by one per call** rather than repeating: two sessions
/// starting in the same wall-clock second would otherwise get the same session
/// id — which the schema tolerates (ids are unique per install, not globally) but
/// which would leave a test unable to tell "a new session started" from "the same
/// session continued".
public final class FixedRandomSource: StatsRandomSource, @unchecked Sendable {
    private let state: Mutex<Int>
    private let jitter: Double

    /// - Parameters:
    ///   - firstDigits: the first digit run to return; each later call returns
    ///     that number plus one.
    ///   - fraction: the jitter multiplier. `1.0` by default, which makes the
    ///     full-jitter backoff equal to its unjittered ceiling — the value that
    ///     makes a schedule assertion readable (`1, 2, 4, 8…` seconds).
    public init(firstDigits: Int = 40_371_852, fraction: Double = 1.0) {
        self.state = Mutex(firstDigits)
        self.jitter = fraction
    }

    public func digits(count: Int) -> String {
        let value = state.withLock { current -> Int in
            defer { current += 1 }
            return current
        }
        let text = String(value)
        if text.count >= count { return String(text.suffix(count)) }
        return String(repeating: "0", count: count - text.count) + text
    }

    public func fraction() -> Double { jitter }
}
