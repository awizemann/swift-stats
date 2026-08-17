import Foundation

/// Time, as the SDK needs it.
///
/// Two clocks, deliberately:
///
/// - `wallNow()` is the calendar time that goes on the wire (`ts`, `sentAt`,
///   the session id's `epochSeconds` prefix).
/// - `monotonicNow()` measures elapsed time and is immune to the user changing
///   the device clock, which schema §10 *requires* for the inactivity gap — a
///   wall-clock gap could be used to fabricate or suppress sessions.
///
/// `sleep(for:)` is on the same seam so that a test can drive backoff and the
/// interval flush without any real waiting. Nothing in this package calls
/// `Date.now` or `Task.sleep` directly.
public nonisolated protocol StatsClock: Sendable {
    func wallNow() -> Date
    /// Elapsed time since an arbitrary fixed origin. Only differences are
    /// meaningful.
    func monotonicNow() -> Duration
    func sleep(for duration: Duration) async throws
}

/// The production clock: `Date` for the wall, `ContinuousClock` for elapsed
/// time (it keeps running while the device sleeps, which is what an inactivity
/// gap should measure).
public struct SystemStatsClock: StatsClock {
    private let origin = ContinuousClock.now

    public init() {}

    public func wallNow() -> Date { Date() }

    public func monotonicNow() -> Duration { origin.duration(to: ContinuousClock.now) }

    public func sleep(for duration: Duration) async throws {
        try await Task.sleep(for: duration, clock: ContinuousClock())
    }
}

/// UUID generation seam — install identity (§9) and `batchId` (§6).
public nonisolated protocol StatsUUIDProvider: Sendable {
    func uuid() -> UUID
}

public struct SystemUUIDProvider: StatsUUIDProvider {
    public init() {}
    public func uuid() -> UUID { UUID() }
}

/// Randomness seam: the 8-digit session-id suffix (§10) and the full jitter in
/// the retry backoff (§7).
public nonisolated protocol StatsRandomSource: Sendable {
    /// Exactly `count` decimal digits, zero-padded.
    func digits(count: Int) -> String
    /// A value in `0...1`, used as the jitter multiplier.
    func fraction() -> Double
}

public struct SystemRandomSource: StatsRandomSource {
    public init() {}

    public func digits(count: Int) -> String {
        var out = ""
        out.reserveCapacity(count)
        for _ in 0..<count {
            out.append(Character(UnicodeScalar(UInt8(ascii: "0") + UInt8.random(in: 0...9))))
        }
        return out
    }

    public func fraction() -> Double { Double.random(in: 0...1) }
}
