import Foundation
import Testing
@testable import StatsCloudflare

@Suite("StatsDay — the UTC day boundary")
struct StatsDayTests {

    @Test("Parses and re-emits the exact wire form")
    func roundTrip() {
        let day = StatsDay("2026-08-17")
        #expect(day?.description == "2026-08-17")
        #expect(day?.year == 2026)
        #expect(day?.month == 8)
        #expect(day?.day == 17)
    }

    @Test("Zero-pads single-digit months and days")
    func zeroPadding() {
        // Discriminating: string interpolation without padding yields "2026-1-3",
        // which the backend rejects with a 400 — a bug that only shows up in
        // January.
        #expect(StatsDay(year: 2026, month: 1, day: 3)?.description == "2026-01-03")
    }

    @Test("Rejects a day that is not a real calendar day")
    func rejectsImpossibleDays() {
        // Each of these passes a bare `\d{4}-\d{2}-\d{2}` regex, and a lenient
        // `Calendar` would roll 2026-02-30 forward to March 2nd rather than fail.
        #expect(StatsDay("2026-02-30") == nil)
        #expect(StatsDay("2026-13-01") == nil)
        #expect(StatsDay("2026-00-10") == nil)
        #expect(StatsDay("2026-04-31") == nil)
        #expect(StatsDay(year: 2026, month: 2, day: 30) == nil)
    }

    @Test("Accepts a leap day in a leap year and rejects it otherwise")
    func leapDay() {
        #expect(StatsDay("2028-02-29")?.description == "2028-02-29")
        #expect(StatsDay("2026-02-29") == nil)
        // 1900 is not a leap year despite being divisible by 4.
        #expect(StatsDay("1900-02-29") == nil)
    }

    @Test("Rejects anything but YYYY-MM-DD")
    func rejectsOtherFormats() {
        for bad in ["2026-8-17", "26-08-17", "2026/08/17", "17-08-2026", "2026-08", "", "2026-08-17T00:00:00Z"] {
            #expect(StatsDay(bad) == nil, "\(bad) must not parse")
        }
    }

    @Test("Takes the UTC day, not the local day")
    func utcNotLocal() {
        // 2026-08-17T01:00Z is still 2026-08-16 in Los Angeles and already
        // 2026-08-17 in Berlin. The UTC day is the contract (§8.1), so this must
        // be 08-17 wherever the test runs — which is what fails if the
        // implementation reaches for `Calendar.current`.
        let instant = Date(timeIntervalSince1970: 1_786_928_400) // 2026-08-17T01:00:00Z
        #expect(StatsDay(utcDayOf: instant).description == "2026-08-17")

        // And an instant that is already the next day in Berlin (15:30 local) but
        // is still the 16th in UTC.
        let lateOn16th = Date(timeIntervalSince1970: 1_786_887_000) // 2026-08-16T13:30:00Z
        #expect(StatsDay(utcDayOf: lateOn16th).description == "2026-08-16")
    }

    @Test("Orders chronologically")
    func ordering() {
        #expect(StatsDay("2026-08-16")! < StatsDay("2026-08-17")!)
        #expect(StatsDay("2026-07-31")! < StatsDay("2026-08-01")!)
        #expect(StatsDay("2025-12-31")! < StatsDay("2026-01-01")!)
    }

    @Test("Counts inclusive spans, including across a month and a leap year")
    func inclusiveSpans() {
        let span = { (a: String, b: String) in
            StatsDay.daysInclusive(from: StatsDay(a)!, to: StatsDay(b)!)
        }
        // The off-by-one that matters: a single day is 1, not 0.
        #expect(span("2026-08-17", "2026-08-17") == 1)
        #expect(span("2026-08-01", "2026-08-03") == 3)
        #expect(span("2026-07-30", "2026-08-02") == 4)
        // §8.1's exact boundary: 400 days is allowed, 401 is not.
        #expect(span("2025-01-01", "2026-02-04") == 400)
        #expect(span("2025-01-01", "2026-02-05") == 401)
        // 2028 is a leap year, so this span includes February 29th.
        #expect(span("2028-02-28", "2028-03-01") == 3)
    }

    @Test("Encodes as the wire string, not as an object")
    func codable() throws {
        let data = try JSONEncoder().encode(StatsDay("2026-08-17")!)
        #expect(String(decoding: data, as: UTF8.self) == "\"2026-08-17\"")
        #expect(try JSONDecoder().decode(StatsDay.self, from: data) == StatsDay("2026-08-17"))
    }
}
