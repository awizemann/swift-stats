import CryptoKit
import Foundation
@testable import Stats
import StatsTesting
import Testing

/// Schema §9 and §2.5: how the install id and the optional `userId` are derived.
@Suite("Identity")
struct IdentityTests {
    /// The hash is spelled out here rather than reusing the SDK's helper: if the
    /// concatenation order, the separator or the case ever changes, this fails
    /// and every already-installed app's identity would have changed with it.
    private func expectedHash(_ value: String, salt: String = Harness.salt) -> String {
        SHA256.hash(data: Data((value + salt).utf8)).map { String(format: "%02x", $0) }.joined()
    }

    @Test("installId is lowercase hex SHA-256 of the uppercase UUID string plus the salt")
    func installIdFormula() async {
        let harness = Harness()
        let uuid = Harness.defaultUUIDs[0]
        await harness.client.track("project_opened")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let events = await harness.sink.sentEvents
        #expect(events.count == 1)
        let installId = events.first?.installId
        #expect(installId == expectedHash(uuid.uuidString))
        #expect(installId?.count == 64)
        #expect(installId?.allSatisfy { $0.isHexDigit && !$0.isUppercase } == true)
        // The raw UUID must never appear on the wire.
        #expect(installId?.contains(uuid.uuidString) == false)
        await harness.tearDown()
    }

    @Test("The install id is stable across a relaunch, and seq keeps counting")
    func identityAndSeqSurviveRelaunch() async {
        let first = Harness()
        await first.client.track("a")
        await first.client.flush()
        await first.client.waitForFlushes()
        let firstEvent = await first.sink.sentEvents.first
        await first.client.shutdown()
        first.clock.cancelAllSleepers()

        let second = first.relaunched()
        await second.client.track("b")
        await second.client.flush()
        await second.client.waitForFlushes()
        let secondEvent = await second.sink.sentEvents.first

        #expect(firstEvent?.installId == secondEvent?.installId)
        // §2.2: seq is never reset within an install — it survives relaunch.
        #expect(firstEvent?.seq == 0)
        #expect(secondEvent?.seq == 1)
        // A relaunch always begins a new session (§10).
        #expect(firstEvent?.sessionId != secondEvent?.sessionId)
        await second.tearDown()
    }

    @Test("reset() regenerates the identity, zeroes seq and unlinks the sessions")
    func resetUnlinks() async {
        let harness = Harness()
        await harness.client.identify(userID: "account-1")
        await harness.client.track("a")
        await harness.client.flush()
        await harness.client.reset()
        await harness.client.track("b")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let events = await harness.sink.sentEvents
        #expect(events.count == 2)
        let before = events[0]
        let after = events[1]
        #expect(before.installId != after.installId)
        #expect(before.seq == 0)
        #expect(after.seq == 0, "reset() resets seq to 0 (§9)")
        #expect(before.sessionId != after.sessionId)
        #expect(before.userId != nil)
        #expect(after.userId == nil, "reset() clears userId (§9)")
        await harness.tearDown()
    }

    @Test("identify() hashes the supplied id with the install salt before it leaves the device")
    func userIdIsHashed() async {
        let harness = Harness()
        await harness.client.identify(userID: "person@example.com")
        await harness.client.track("a")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let userId = await harness.sink.sentEvents.first?.userId
        #expect(userId == expectedHash("person@example.com"))
        #expect(userId?.contains("@") == false, "a raw address must never reach the wire")
        await harness.tearDown()
    }

    // MARK: forgetUser() — the sign-out unlink

    /// The sign-out case: the account goes, the install stays.
    @Test("forgetUser() drops userId from later events and keeps the install id")
    func forgetUserUnlinksAccountNotInstall() async {
        let harness = Harness()
        await harness.client.identify(userID: "account-1")
        await harness.client.track("signed_in")
        await harness.client.forgetUser()
        await harness.client.track("signed_out")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let events = await harness.sink.sentEvents
        #expect(events.map(\.name) == ["signed_in", "signed_out"])
        #expect(events.first?.userId == expectedHash("account-1"))
        #expect(events.last?.userId == nil, "forgetUser() clears userId (§2.5)")
        #expect(events.first?.installId == events.last?.installId, "the install is not forgotten")
        #expect(events.map(\.seq) == [0, 1], "seq is not reset")
        await harness.tearDown()
    }

    /// `record()` buffers; the event is captured on a later drain. forgetUser()
    /// drains first, so the event is stamped with the id it was recorded under
    /// even though it reaches the queue — and the wire — after the call.
    @Test("An event recorded before forgetUser() keeps the userId it was recorded under")
    func recordedBeforeForgetUserKeepsUserId() async {
        let harness = Harness()
        await harness.client.identify(userID: "account-1")
        harness.client.record("recorded_while_signed_in")
        await harness.client.forgetUser()
        harness.client.record("recorded_after")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let events = await harness.sink.sentEvents
        #expect(events.map(\.name) == ["recorded_while_signed_in", "recorded_after"])
        #expect(events.first?.userId == expectedHash("account-1"))
        #expect(events.last?.userId == nil)
        await harness.tearDown()
    }

    @Test("forgetUser() clears the persisted hash: a relaunch sends no userId")
    func forgetUserSurvivesRelaunch() async {
        let first = Harness()
        await first.client.identify(userID: "account-1")
        await first.client.track("a")
        await first.client.forgetUser()
        await first.client.flush()
        await first.client.waitForFlushes()
        let suite = UserDefaults(suiteName: first.configuration.identitySuiteName)
        #expect(suite?.string(forKey: "userIdHash") == nil, "removed from the SDK's suite, not just memory")
        await first.client.shutdown()
        first.clock.cancelAllSleepers()

        let second = first.relaunched()
        await second.client.track("b")
        await second.client.flush()
        await second.client.waitForFlushes()
        let secondEvent = await second.sink.sentEvents.last
        #expect(secondEvent?.name == "b")
        #expect(secondEvent?.userId == nil)
        #expect(secondEvent?.installId == (await first.sink.sentEvents.first?.installId))
        await second.tearDown()
    }

    /// The point of the call: unlike `setEnabled(false)` + `setEnabled(true)`,
    /// nothing queued is discarded and the session carries on.
    @Test("forgetUser() keeps the session and the queue")
    func forgetUserKeepsSessionAndQueue() async {
        let harness = Harness(autoEvents: [.sessions], flushAt: 10_000)
        await harness.client.identify(userID: "account-1")
        await harness.client.track("a")
        let queuedBefore = await harness.client.queuedEventCount
        await harness.client.forgetUser()
        #expect(await harness.client.queuedEventCount == queuedBefore, "nothing queued is dropped")
        #expect(await harness.client.isEnabled)
        #expect(await harness.client.currentConsent == [.usage, .diagnostics, .identity])
        await harness.client.track("b")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let events = await harness.sink.sentEvents
        #expect(events.map(\.name) == ["session_start", "a", "b"], "no session_end / session_start")
        #expect(Set(events.map(\.sessionId)).count == 1)
        #expect(events.map(\.userId) == [expectedHash("account-1"), expectedHash("account-1"), nil])
        await harness.tearDown()
    }

    /// A sign-out screen holding its own client must unlink the *app*.
    @Test("forgetUser() through a forwarding client clears the owner's userId")
    func forgetUserForwardsToOwner() async {
        let harness = Harness(flushAt: 10_000)
        await harness.client.identify(userID: "account-1")
        await harness.client.track("a")

        let otherSink = InMemorySink()
        var configuration = harness.configuration
        configuration.sink = otherSink
        let other = StatsClient(configuration: configuration)
        await other.forgetUser()

        await harness.client.track("b")
        await harness.client.flush()
        await harness.client.waitForFlushes()
        let events = await harness.sink.sentEvents
        #expect(events.map(\.name) == ["a", "b"])
        #expect(events.map(\.userId) == [expectedHash("account-1"), nil])
        #expect(await otherSink.batchCount == 0, "the forwarding client's own sink is never used")
        let suite = UserDefaults(suiteName: harness.configuration.identitySuiteName)
        #expect(suite?.string(forKey: "userIdHash") == nil)

        await other.shutdown()
        await harness.tearDown()
    }

    /// Under denied `identity` the hash lives in memory only (§2.5) and would
    /// start appearing on a later grant; forgetUser() must clear it even then.
    @Test("forgetUser() under denied identity clears the remembered hash; with nothing set it is a no-op")
    func forgetUserUnderDeniedIdentity() async {
        let harness = Harness(consent: [.usage, .diagnostics])
        await harness.client.forgetUser()
        await harness.client.identify(userID: "account-1")
        await harness.client.forgetUser()
        await harness.client.forgetUser()
        await harness.client.setConsent([.usage, .diagnostics, .identity])
        await harness.client.track("a")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let events = await harness.sink.sentEvents
        #expect(events.map(\.name) == ["a"])
        #expect(events.first?.userId == nil, "the in-memory hash did not resurface on the grant")
        await harness.tearDown()
    }

    @Test("StatsConfiguration.hashedUserId(_:) equals the userId identify() puts on the wire")
    func hashHelperMatchesWire() async {
        let harness = Harness()
        await harness.client.identify(userID: "account-42")
        await harness.client.track("a")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let wire = await harness.sink.sentEvents.first?.userId
        #expect(wire != nil)
        #expect(harness.configuration.hashedUserId("account-42") == wire)
        #expect(StatsConfiguration.hashedUserId("account-42", salt: Harness.salt) == wire)
        #expect(wire == expectedHash("account-42"), "the documented formula, spelled out")
        #expect(StatsConfiguration.hashedUserId("account-42", salt: "other-salt") != wire, "the salt is per configuration")
        // The fixed vector published in docs/schema.md §2.5.
        #expect(
            StatsConfiguration.hashedUserId("account-1", salt: "test-salt")
                == "ff0315ef5b57317d76a46521554b19ae36c120ed198f87f718ad7913d79bfa3e"
        )
        await harness.tearDown()
    }

    /// Every other test moves the suite into a temporary directory so a run
    /// leaves nothing in `~/Library/Preferences`; this pins what production
    /// uses, without touching disk.
    @Test("Without a test directory the suite is com.wizemann.stats.<appId>; with one it is an absolute path inside it")
    func suiteNaming() {
        var configuration = StatsConfiguration(appId: "com.example.App", installIdSalt: "s", sink: InMemorySink())
        #expect(configuration.identitySuiteDirectory == nil)
        #expect(configuration.identitySuiteName == "com.wizemann.stats.com.example.App")
        configuration.identitySuiteDirectory = URL(fileURLWithPath: "/tmp/defaults", isDirectory: true)
        #expect(configuration.identitySuiteName == "/tmp/defaults/com.wizemann.stats.com.example.App")
    }

    @Test("The persisted defaults live in the SDK's own suite, never in .standard")
    func ownSuite() async {
        let harness = Harness()
        await harness.client.track("a")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let suite = UserDefaults(suiteName: harness.configuration.identitySuiteName)
        #expect(suite?.string(forKey: "installUUID") != nil)
        #expect(UserDefaults.standard.string(forKey: "installUUID") == nil)
        await harness.tearDown()
    }
}
