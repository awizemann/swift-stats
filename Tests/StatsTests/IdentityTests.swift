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

    @Test("The persisted defaults live in the SDK's own suite, never in .standard")
    func ownSuite() async {
        let harness = Harness()
        await harness.client.track("a")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let suite = UserDefaults(suiteName: StatsIdentityStore.suiteName(appId: harness.appId))
        #expect(suite?.string(forKey: "installUUID") != nil)
        #expect(UserDefaults.standard.string(forKey: "installUUID") == nil)
        await harness.tearDown()
    }
}
