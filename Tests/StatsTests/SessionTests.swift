import Foundation
@testable import Stats
import StatsTesting
import Testing

/// Schema §10 and §12: session boundaries and the auto-events they produce.
@Suite("Sessions")
struct SessionTests {
    @Test("A session id is epochSeconds plus exactly 8 digits")
    func sessionIdFormat() async {
        let harness = Harness()
        await harness.client.track("a")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let sessionId = await harness.sink.sentEvents.first?.sessionId
        let parts = (sessionId ?? "").split(separator: "-")
        #expect(parts.count == 2)
        #expect(parts.first?.count ?? 0 >= 10)
        #expect(parts.last?.count == 8)
        #expect(parts.allSatisfy { $0.allSatisfy(\.isNumber) })
        // The prefix is the wall clock at session start, so ids sort by start.
        #expect(parts.first == "1786012978")
        #expect(parts.first?.count == 10, "the prefix is zero-padded to at least 10 digits (§10)")
        await harness.tearDown()
    }

    /// Discriminating on the gap being measured monotonically and evaluated
    /// lazily: with the clock advanced by less than the gap the session must be
    /// the same one, and by more than the gap a different one.
    @Test("Activity inside the gap stays in one session; past it a new one starts")
    func inactivityGap() async {
        let harness = Harness(sessionGap: .seconds(300))
        await harness.client.track("a")
        harness.clock.advance(by: .seconds(299))
        await harness.client.track("b")
        harness.clock.advance(by: .seconds(301))
        await harness.client.track("c")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let events = await harness.sink.sentEvents
        #expect(events.count == 3)
        #expect(events[0].sessionId == events[1].sessionId)
        #expect(events[1].sessionId != events[2].sessionId)
        // No timer is involved: the ids' prefixes are the wall clock readings at
        // the two session starts.
        #expect(events[2].sessionId.hasPrefix("1786013578"))
        await harness.tearDown()
    }

    @Test("The default gap is 30 minutes on macOS and 5 elsewhere")
    func platformDefaultGap() {
        #if os(macOS)
        #expect(StatsConfiguration.defaultSessionGap == .seconds(1800))
        #else
        #expect(StatsConfiguration.defaultSessionGap == .seconds(300))
        #endif
    }

    @Test("Auto-events are off by default, so a bare track() emits exactly one event")
    func autoEventsOptIn() async {
        let harness = Harness()
        await harness.client.track("a")
        await harness.client.applicationDidBecomeActive()
        await harness.client.flush()
        await harness.client.waitForFlushes()

        #expect(await harness.sink.sentEventNames == ["a"])
        await harness.tearDown()
    }

    /// Discriminating on §12's fixed boundary ordering: `session_end` carries the
    /// previous id, the lower `seq`, and a `ts` *older* than the event before it.
    @Test("At a session boundary the order is session_end, session_start, app_open")
    func boundaryOrdering() async {
        let harness = Harness(autoEvents: [.sessions, .appOpen], sessionGap: .seconds(300))
        await harness.client.applicationDidBecomeActive()
        await harness.client.track("first")
        harness.clock.advance(by: .seconds(60))
        await harness.client.track("second")
        harness.clock.advance(by: .seconds(600))
        await harness.client.track("third")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let events = await harness.sink.sentEvents
        #expect(events.map(\.name) == [
            "session_start", "app_open", "first", "second",
            "session_end", "session_start", "third"
        ])
        // seq is strictly increasing in track order, always (§2.2).
        #expect(events.map(\.seq) == Array(0..<events.count))

        let end = events[4]
        let newStart = events[5]
        #expect(end.sessionId == events[0].sessionId, "session_end carries the previous session's id")
        #expect(newStart.sessionId != end.sessionId)
        // §12: session_end's ts is the previous session's *last event*, so it is
        // strictly older than the session_start that follows it — the one place
        // in v1 where ts is not monotonic with seq.
        #expect(end.ts == events[3].ts)
        #expect(end.ts < newStart.ts)
        #expect(end.seq < newStart.seq)
        #expect(end.props["duration_s"] == .int(60))
        #expect(events[0].props.isEmpty)
        await harness.tearDown()
    }

    @Test("A session that never resumes gets no session_end")
    func noSessionEndWithoutResume() async {
        let harness = Harness(autoEvents: .sessions)
        await harness.client.track("a")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        #expect(await harness.sink.sentEventNames == ["session_start", "a"])
        await harness.tearDown()
    }

    /// Discriminating on §12's definition ("the app becomes active in the
    /// foreground"): a `track()` that starts a session must NOT manufacture an
    /// `app_open`, or a background-only process inflates §8.1's `opens`.
    @Test("track() alone never emits app_open")
    func appOpenNeedsForeground() async {
        let harness = Harness(autoEvents: [.appOpen, .sessions])
        await harness.client.track("a")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        #expect(await harness.sink.sentEventNames == ["session_start", "a"])
        await harness.tearDown()
    }

    /// Discriminating on §12's identity rule combined with §1: `session_end` must
    /// close the *previous* session under the install id that session ran with.
    /// Emitting it after the ephemeral id rotates would attribute it to a session
    /// the backend never saw, since sessions are keyed on (installId, sessionId).
    @Test("Under ephemeral identity, session_end carries the previous session's install id")
    func sessionEndKeepsPreviousIdentity() async {
        let harness = Harness(
            consent: [.usage, .diagnostics], autoEvents: .sessions, sessionGap: .seconds(300)
        )
        await harness.client.track("a")
        harness.clock.advance(by: .seconds(400))
        await harness.client.track("b")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let events = await harness.sink.sentEvents
        #expect(events.map(\.name) == ["session_start", "a", "session_end", "session_start", "b"])
        #expect(events[2].installId == events[0].installId, "session_end belongs to the old identity")
        #expect(events[2].sessionId == events[0].sessionId)
        #expect(events[3].installId != events[0].installId, "the new session has a fresh ephemeral id")
        await harness.tearDown()
    }

    @Test("app_open is emitted at most once per session")
    func appOpenOncePerSession() async {
        let harness = Harness(autoEvents: [.appOpen], sessionGap: .seconds(300))
        await harness.client.applicationDidBecomeActive()
        await harness.client.applicationDidBecomeActive()
        harness.clock.advance(by: .seconds(400))
        await harness.client.applicationDidBecomeActive()
        await harness.client.flush()
        await harness.client.waitForFlushes()

        #expect(await harness.sink.sentEventNames == ["app_open", "app_open"])
        let events = await harness.sink.sentEvents
        #expect(events[0].sessionId != events[1].sessionId)
        await harness.tearDown()
    }

    @Test("app_background is emitted before the background flush")
    func backgroundEventThenFlush() async {
        let harness = Harness(autoEvents: [.appBackground])
        await harness.client.track("a")
        await harness.client.applicationDidEnterBackground()
        await harness.client.waitForFlushes()

        #expect(await harness.sink.sentEventNames == ["a", "app_background"])
        #expect(await harness.client.queuedEventCount == 0)
        await harness.tearDown()
    }

    @Test("A reserved name passed to track() is refused, not emitted", arguments: [
        "app_open", "app_background", "session_start", "session_end", "stats_internal"
    ])
    func reservedNamesRefused(name: String) async {
        let harness = Harness()
        await harness.client.track(name)
        await harness.client.track("legit")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        #expect(await harness.sink.sentEventNames == ["legit"])
        await harness.tearDown()
    }

    @Test("A malformed name is refused without disturbing seq of real events")
    func malformedNameRefused() async {
        let harness = Harness()
        await harness.client.track("Bad Name")
        await harness.client.track("good_name")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let events = await harness.sink.sentEvents
        #expect(events.map(\.name) == ["good_name"])
        #expect(events.first?.seq == 0, "a refused event must not consume a seq")
        await harness.tearDown()
    }
}
