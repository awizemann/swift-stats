import Foundation

/// ISO 8601 UTC timestamps with exactly millisecond precision and a literal
/// `Z`, per schema §0: `2026-08-17T14:03:11.482Z`.
///
/// Hand-rolled rather than `ISO8601DateFormatter` for three reasons: the
/// formatter is not `Sendable` (so an actor would need one per call or an
/// unsafe shared instance), it is measurably slower than integer arithmetic on
/// a hot path that runs once per event, and the schema's format is fixed
/// forever — there is nothing to configure. The civil-date conversions are
/// Howard Hinnant's `days_from_civil` / `civil_from_days`.
nonisolated enum StatsTimestamp {
    static func string(from date: Date) -> String {
        // Round to the millisecond the wire carries; the sub-millisecond part
        // of a `Date` is not representable in the schema's format.
        let totalMilliseconds = Int64((date.timeIntervalSince1970 * 1000).rounded())
        let days = floorDivide(totalMilliseconds, 86_400_000)
        let msOfDay = totalMilliseconds - days * 86_400_000
        let (year, month, day) = civil(fromDays: days)
        let hour = Int(msOfDay / 3_600_000)
        let minute = Int((msOfDay / 60_000) % 60)
        let second = Int((msOfDay / 1_000) % 60)
        let millisecond = Int(msOfDay % 1_000)
        return String(
            format: "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
            year, month, day, hour, minute, second, millisecond
        )
    }

    /// Strict parse: anything that is not exactly the schema's form returns
    /// `nil`. Used for decoding a persisted queue and by the round-trip tests;
    /// a lenient parse would let a malformed timestamp survive a restart.
    static func date(from string: String) -> Date? {
        let scalars = Array(string.utf8)
        guard scalars.count == 24 else { return nil }
        func digits(_ range: Range<Int>) -> Int? {
            var value = 0
            for index in range {
                let byte = scalars[index]
                guard byte >= 48, byte <= 57 else { return nil }
                value = value * 10 + Int(byte - 48)
            }
            return value
        }
        guard scalars[4] == UInt8(ascii: "-"), scalars[7] == UInt8(ascii: "-"),
              scalars[10] == UInt8(ascii: "T"), scalars[13] == UInt8(ascii: ":"),
              scalars[16] == UInt8(ascii: ":"), scalars[19] == UInt8(ascii: "."),
              scalars[23] == UInt8(ascii: "Z"),
              let year = digits(0..<4), let month = digits(5..<7), let day = digits(8..<10),
              let hour = digits(11..<13), let minute = digits(14..<16),
              let second = digits(17..<19), let millisecond = digits(20..<23),
              (1...12).contains(month),
              // Days-per-month, leap years included: `2026-02-30` and
              // `2026-04-31` are not calendar days, and `daysFromCivil` below
              // would silently roll them into the next month rather than fail.
              day >= 1, day <= Self.daysInMonth(year: year, month: month),
              hour < 24, minute < 60,
              // §0 fixes the format at `HH:MM:SS.mmmZ` with no leap second, so
              // `60` is not a second the schema can carry. Accepting it would
              // mean `…:23:60.000Z` decoded to `…:24:00.000Z` and re-encoded as
              // a different string than the one that was queued.
              second < 60
        else { return nil }

        let days = daysFromCivil(year: Int64(year), month: Int64(month), day: Int64(day))
        let total = days * 86_400_000
            + Int64(hour) * 3_600_000 + Int64(minute) * 60_000
            + Int64(second) * 1_000 + Int64(millisecond)
        return Date(timeIntervalSince1970: Double(total) / 1000)
    }

    // MARK: Calendar arithmetic

    /// Proleptic Gregorian, which is the calendar `daysFromCivil` implements.
    static func daysInMonth(year: Int, month: Int) -> Int {
        switch month {
        case 1, 3, 5, 7, 8, 10, 12: 31
        case 4, 6, 9, 11: 30
        case 2: isLeapYear(year) ? 29 : 28
        default: 0
        }
    }

    static func isLeapYear(_ year: Int) -> Bool {
        (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
    }

    private static func floorDivide(_ lhs: Int64, _ rhs: Int64) -> Int64 {
        let quotient = lhs / rhs
        return (lhs % rhs != 0 && (lhs < 0) != (rhs < 0)) ? quotient - 1 : quotient
    }

    private static func civil(fromDays days: Int64) -> (year: Int, month: Int, day: Int) {
        let shifted = days + 719_468
        let era = floorDivide(shifted, 146_097)
        let dayOfEra = shifted - era * 146_097
        let yearOfEra = (dayOfEra - dayOfEra / 1_460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365
        let year = yearOfEra + era * 400
        let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
        let monthPrime = (5 * dayOfYear + 2) / 153
        let day = dayOfYear - (153 * monthPrime + 2) / 5 + 1
        let month = monthPrime < 10 ? monthPrime + 3 : monthPrime - 9
        return (Int(month <= 2 ? year + 1 : year), Int(month), Int(day))
    }

    private static func daysFromCivil(year: Int64, month: Int64, day: Int64) -> Int64 {
        let adjustedYear = month <= 2 ? year - 1 : year
        let era = floorDivide(adjustedYear, 400)
        let yearOfEra = adjustedYear - era * 400
        let monthPrime = month > 2 ? month - 3 : month + 9
        let dayOfYear = (153 * monthPrime + 2) / 5 + day - 1
        let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        return era * 146_097 + dayOfEra - 719_468
    }
}
