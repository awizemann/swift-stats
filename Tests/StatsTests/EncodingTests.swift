import Foundation
@testable import Stats
import Testing

/// Line-by-line conformance to the wire schema's §1–§4.
@Suite("Wire encoding")
struct EncodingTests {
    private func json(_ value: some Encodable) throws -> [String: Any] {
        let data = try StatsJSON.encoder.encode(value)
        return try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    @Test("An event encodes exactly the schema §2 example keys")
    func eventKeys() throws {
        let event = StatsEvent(
            name: "project_opened",
            ts: try #require(StatsTimestamp.date(from: "2026-08-17T14:03:11.482Z")),
            sessionId: "1786012991-40371852",
            installId: "3f8a1c9e5b2d47a08e6f1b3c9d0a7e42d5c81f9a0b3e6d2c4f7a19b8e05c3d6f",
            appId: "com.wizemann.Overwatch",
            projectId: "overwatch",
            seq: 41,
            props: ["section": "analytics", "count": 3, "cached": true]
        )
        let object = try json(event)
        #expect(object["name"] as? String == "project_opened")
        #expect(object["ts"] as? String == "2026-08-17T14:03:11.482Z")
        #expect(object["sessionId"] as? String == "1786012991-40371852")
        #expect(object["appId"] as? String == "com.wizemann.Overwatch")
        #expect(object["projectId"] as? String == "overwatch")
        #expect(object["seq"] as? Int == 41)
        let props = try #require(object["props"] as? [String: Any])
        #expect(props["section"] as? String == "analytics")
        #expect(props["count"] as? Int == 3)
        #expect(props["cached"] as? Bool == true)
        // §0: emitters omit rather than send null.
        #expect(object["userId"] == nil)
        #expect(object.keys.sorted() == ["appId", "installId", "name", "projectId", "props", "seq", "sessionId", "ts"])
    }

    /// Discriminating: fails if `encodeIfPresent`/`isEmpty` guards are replaced
    /// with plain `encode`, which would put `"projectId": null` and `"props":
    /// {}` on the wire.
    @Test("Absent optionals and empty props are omitted, not nulled")
    func omissions() throws {
        let event = StatsEvent(
            name: "app_open", ts: Date(timeIntervalSince1970: 0),
            sessionId: "1786012991-40371852", installId: "a", appId: "b", seq: 0
        )
        let object = try json(event)
        #expect(object.keys.sorted() == ["appId", "installId", "name", "seq", "sessionId", "ts"])
    }

    @Test("A batch envelope round-trips through the schema §4 example")
    func envelopeRoundTrip() throws {
        let event = StatsEvent(
            name: "session_start",
            ts: try #require(StatsTimestamp.date(from: "2026-08-17T14:02:58.101Z")),
            sessionId: "1786012978-40371852",
            installId: "3f8a1c9e5b2d47a08e6f1b3c9d0a7e42d5c81f9a0b3e6d2c4f7a19b8e05c3d6f",
            appId: "com.wizemann.Overwatch", projectId: "overwatch", seq: 40
        )
        let batch = StatsBatch(
            batchId: "8B0B8AF0-3E9F-4F9F-9F1D-4E45B0A9C0D1",
            sentAt: try #require(StatsTimestamp.date(from: "2026-08-17T14:03:12.004Z")),
            context: Harness.exampleContext,
            events: [event]
        )
        let object = try json(batch)
        #expect(object["schema"] as? String == "v1")
        #expect(object["batchId"] as? String == "8B0B8AF0-3E9F-4F9F-9F1D-4E45B0A9C0D1")
        #expect(object["sentAt"] as? String == "2026-08-17T14:03:12.004Z")

        let context = try #require(object["context"] as? [String: Any])
        #expect(context.keys.sorted() == [
            "appBuild", "appVersion", "arch", "bundleId", "colorScheme", "deviceModel",
            "isDebug", "isTestFlight", "locale", "osName", "osVersion", "region",
            "screenHeight", "screenScale", "screenWidth", "sdkVersion"
        ])
        #expect(context["screenScale"] as? Double == 2.0)

        let decoded = try StatsJSON.decoder.decode(StatsBatch.self, from: try batch.serialized())
        #expect(decoded == batch)
    }

    @Test("colorScheme is omitted when not sampled")
    func contextOmitsColorScheme() throws {
        var context = Harness.exampleContext
        context.colorScheme = nil
        let object = try json(context)
        #expect(object["colorScheme"] == nil)
        #expect(object.count == 15)
    }

    /// Discriminating: a lenient `ISO8601DateFormatter`-based parse would accept
    /// `+02:00` and second-precision forms, both of which a backend MUST reject.
    @Test("Timestamps are millisecond UTC with a literal Z, and nothing else parses", arguments: [
        "2026-08-17T14:03:11.482Z", "1970-01-01T00:00:00.000Z", "2000-02-29T23:59:59.999Z"
    ])
    func timestampRoundTrip(text: String) throws {
        let date = try #require(StatsTimestamp.date(from: text))
        #expect(StatsTimestamp.string(from: date) == text)
    }

    @Test("Malformed timestamps are rejected", arguments: [
        "2026-08-17T14:03:11Z",          // no milliseconds
        "2026-08-17T14:03:11.482+02:00", // local offset
        "2026-08-17T14:03:11.482",       // no zone
        "2026-08-17 14:03:11.482Z",      // no T
        "26-08-17T14:03:11.482Z",        // short year
        "2026-13-17T14:03:11.482Z"       // month out of range
    ])
    func timestampRejection(text: String) {
        #expect(StatsTimestamp.date(from: text) == nil)
    }

    @Test("An event with a malformed ts fails to decode rather than loading silently")
    func decodeRejectsBadTimestamp() throws {
        let line = """
            {"name":"a","ts":"2026-08-17T14:03:11Z","sessionId":"1786012978-40371852",\
            "installId":"x","appId":"y","seq":0}
            """
        #expect(throws: DecodingError.self) {
            try StatsJSON.decoder.decode(StatsEvent.self, from: Data(line.utf8))
        }
    }

    @Test("StatsValue covers exactly the schema's value domain and round-trips")
    func valueRoundTrip() throws {
        let values: [String: StatsValue] = [
            "s": "text", "i": 3, "d": 1.5, "b": true, "n": nil
        ]
        let data = try StatsJSON.encoder.encode(values)
        #expect(String(decoding: data, as: UTF8.self) == #"{"b":true,"d":1.5,"i":3,"n":null,"s":"text"}"#)
        let decoded = try StatsJSON.decoder.decode([String: StatsValue].self, from: data)
        #expect(decoded == values)
    }

    @Test("A nested props value cannot be decoded (the schema forbids emitting one)")
    func nestedValueRejected() {
        #expect(throws: (any Error).self) {
            try StatsJSON.decoder.decode([String: StatsValue].self, from: Data(#"{"a":{"b":1}}"#.utf8))
        }
    }
}
