import Foundation

/// A UTC calendar day, the unit the read contract works in (`docs/schema.md` §0:
/// dates are `YYYY-MM-DD`, UTC).
///
/// This exists as a type rather than a `String` or a `Date` because both of the
/// obvious alternatives get the boundary wrong in practice. A `String` lets a
/// caller pass `"2026-2-3"` or `"03/02/2026"` and find out from a 400. A `Date`
/// carries an instant, and formatting an instant into a day is where the
/// local-timezone bug lives: on 2026-08-17 at 01:00 in Berlin, the UTC day is
/// still the 16th, and a reader that asks for "today" in local time silently
/// requests a range the backend will clamp or zero-fill.
///
/// So the only ways to make one are from explicit components, or from a `Date`
/// with UTC named at the call site.
public struct StatsDay: Sendable, Hashable, Comparable, Codable, CustomStringConvertible {
    public let year: Int
    public let month: Int
    public let day: Int

    /// Fails for a value that is not a real calendar day.
    ///
    /// The check is a ROUND TRIP — build the date, read the components back, and
    /// require they match what went in. `Calendar.date(from:)` alone is not a
    /// validator: it is lenient, so `2026-02-30` yields March 2nd and
    /// `2026-04-31` yields May 1st, both non-nil. Asking the calendar for the
    /// month's day range is no better, because it answers for the *rolled-over*
    /// month. Only comparing the output to the input rejects them.
    public init?(year: Int, month: Int, day: Int) {
        guard year >= 1, (1...12).contains(month), (1...31).contains(day) else { return nil }

        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!

        var components = DateComponents()
        components.year = year
        components.month = month
        components.day = day
        guard let date = calendar.date(from: components) else { return nil }

        let readBack = calendar.dateComponents([.year, .month, .day], from: date)
        guard readBack.year == year, readBack.month == month, readBack.day == day else { return nil }

        self.year = year
        self.month = month
        self.day = day
    }

    /// Parses exactly `YYYY-MM-DD`. Nothing more lenient: a format this narrow is
    /// the point, since the backend's contract is exactly this form.
    public init?(_ string: String) {
        let parts = string.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3,
              parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2]),
              let parsed = StatsDay(year: year, month: month, day: day)
        else { return nil }
        self = parsed
    }

    /// The UTC calendar day containing `date`. `utcDayOf` is in the label so a
    /// call site cannot read as if it meant the local day.
    public init(utcDayOf date: Date) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        self.year = c.year!
        self.month = c.month!
        self.day = c.day!
    }

    /// `YYYY-MM-DD`, zero-padded — the exact wire form.
    public var description: String {
        let y = String(format: "%04d", year)
        let m = String(format: "%02d", month)
        let d = String(format: "%02d", day)
        return "\(y)-\(m)-\(d)"
    }

    public static func < (lhs: StatsDay, rhs: StatsDay) -> Bool {
        (lhs.year, lhs.month, lhs.day) < (rhs.year, rhs.month, rhs.day)
    }

    // Encoded as the wire string, so a `StatsSummary` round-trips through JSON
    // unchanged.
    public init(from decoder: any Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        guard let parsed = StatsDay(raw) else {
            throw DecodingError.dataCorrupted(
                .init(codingPath: decoder.codingPath, debugDescription: "Not a YYYY-MM-DD UTC day.")
            )
        }
        self = parsed
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(description)
    }
}
