import Foundation
@testable import Stats
import Testing

/// Schema §2.3: the emitter enforces the props limits by truncating and
/// dropping, never by discarding the event.
@Suite("Props enforcement")
struct PropsTests {
    @Test("An over-long string value is truncated to 200 scalars, not dropped")
    func truncatesStringValue() {
        let long = String(repeating: "a", count: 512)
        let props = StatsProps.sanitized(["note": .string(long)], eventName: "e")
        if case .string(let value) = props["note"] {
            #expect(value.unicodeScalars.count == 200)
        } else {
            Issue.record("the over-long value was dropped instead of truncated")
        }
    }

    /// The surviving 32 are the first 32 in byte-wise ascending key order, which
    /// is what lets a truncating backend make the same choice (§2.3). For the
    /// `[a-z0-9_]` key alphabet the schema allows, byte order and Swift's own
    /// `String` order agree — the rule exists so a JS emitter agrees too — so
    /// this test pins the *selection*, not the comparator.
    @Test("Beyond 32 keys, the first 32 in byte-wise key order survive")
    func capsKeyCount() {
        var raw: [String: StatsValue] = [:]
        for index in 0..<40 {
            raw[String(format: "k%02d", index)] = .int(index)
        }
        let props = StatsProps.sanitized(raw, eventName: "e")
        #expect(props.count == 32)
        #expect(props["k00"] != nil)
        #expect(props["k31"] != nil)
        #expect(props["k32"] == nil)
        #expect(props["k39"] == nil)
    }

    /// Documents the comparator itself (§0). UTF-8 preserves code-point order, so
    /// the interesting cases are the ones where Swift's canonical-equivalence
    /// comparison does *not* order by code point.
    @Test("The comparator orders by UTF-8 bytes")
    func byteWiseOrdering() {
        #expect(statsUTF8Ascending("a_b", "ab"))    // "_" (0x5F) < "b" (0x62)
        #expect(statsUTF8Ascending("é", "\u{FF}"))  // C3 A9 < C3 BF
        // Canonically equivalent, but different bytes: Swift calls these equal,
        // the schema's comparator does not.
        #expect(statsUTF8Ascending("e\u{301}", "\u{E9}"))
        #expect("e\u{301}" == "\u{E9}", "…while Swift's own == considers them the same string")
    }

    /// Discriminating on `track()` actually routing props through the sanitizer:
    /// `PropsTests` otherwise only exercises `StatsProps.sanitized` directly, so a
    /// `capture()` that passed raw props straight through would go unnoticed.
    @Test("track() applies the props rules end to end")
    func trackSanitizesProps() async {
        let harness = Harness()
        await harness.client.track("thing_happened", props: [
            "ok": .int(1),
            "Bad Key": .int(2),
            "nan": .double(.nan),
            "long": .string(String(repeating: "x", count: 400))
        ])
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let props = await harness.sink.sentEvents.first?.props ?? [:]
        #expect(props["ok"] == .int(1))
        #expect(props["Bad Key"] == nil)
        #expect(props["nan"] == nil)
        if case .string(let value) = props["long"] {
            #expect(value.unicodeScalars.count == 200)
        } else {
            Issue.record("the long value should have been truncated, not dropped")
        }
        await harness.tearDown()
    }

    @Test("Non-conforming keys are dropped and the rest of the event survives", arguments: [
        "Section",            // uppercase
        "9lives",             // leading digit
        "with space",
        "with-dash",
        "",                   // empty
        String(repeating: "k", count: 41)  // over 40 scalars
    ])
    func dropsBadKeys(key: String) {
        let props = StatsProps.sanitized([key: .int(1), "good": .int(2)], eventName: "e")
        #expect(props[key] == nil)
        #expect(props["good"] == .int(2))
    }

    @Test("A non-finite number is dropped, because NaN and Infinity are not JSON")
    func dropsNonFinite() {
        let props = StatsProps.sanitized(
            ["nan": .double(.nan), "inf": .double(.infinity), "ok": .double(1.5)], eventName: "e"
        )
        #expect(props["nan"] == nil)
        #expect(props["inf"] == nil)
        #expect(props["ok"] == .double(1.5))
    }

    @Test("An explicit null survives — it is a meaningful value, not an absence")
    func keepsNull() {
        let props = StatsProps.sanitized(["section": nil], eventName: "e")
        #expect(props["section"] == StatsValue.null)
        #expect(props.count == 1)
    }

    @Test("Event names accept snake_case and refuse everything else", arguments: [
        ("project_opened", true),
        ("a", true),
        ("token_verified_2", true),
        ("Project_opened", false),
        ("project-opened", false),
        ("2_projects", false),
        ("", false),
        ("app_open", false),        // reserved (§12)
        ("session_end", false),     // reserved
        ("stats_anything", false),  // reserved prefix
        (String(repeating: "a", count: 65), false)
    ])
    func nameValidation(name: String, isValid: Bool) {
        #expect(StatsEventName.isValidForApp(name) == isValid)
    }

    @Test("A 64-scalar name is the longest accepted")
    func nameLengthBoundary() {
        #expect(StatsEventName.isValidForApp(String(repeating: "a", count: 64)))
        #expect(!StatsEventName.isValidForApp(String(repeating: "a", count: 65)))
    }
}
