import Foundation
@testable import Stats
import StatsTesting
import Testing

/// Schema §11: opt-out by default, three independent groups, and what a
/// revocation must destroy.
@Suite("Consent and opt-out")
struct ConsentTests {
    /// The product decision: the package is opt-**out** by default *for an app*,
    /// and the end-user opt-out is `setEnabled(false)`. `.identity` stays out of
    /// the default because granting it changes the consumer's §14 disclosure.
    @Test("The configuration default is [.usage, .diagnostics] — identity withheld")
    func configurationDefaultIsUsageAndDiagnostics() async {
        #expect(StatsConsent.default == [.usage, .diagnostics])
        #expect(!StatsConsent.default.contains(.identity))

        // Discriminating on the *client*, not just the constant: a client whose
        // configuration never mentions consent collects, and collects without a
        // stable identity.
        let harness = Harness(consent: .default, sessionGap: .seconds(300))
        #expect(await harness.client.currentConsent == [.usage, .diagnostics])

        await harness.client.identify(userID: "account-1")
        await harness.client.track("a")
        harness.clock.advance(by: .seconds(400))
        await harness.client.track("b")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let events = await harness.sink.sentEvents
        #expect(events.map(\.name) == ["a", "b"])
        // `diagnostics` granted, so the context is the real one …
        #expect(await harness.sink.batches.first?.context.deviceModel != "unknown")
        // … and `identity` is not, so no userId and a per-session install id.
        #expect(events.allSatisfy { $0.userId == nil })
        #expect(events[0].installId != events[1].installId)
        let suite = UserDefaults(suiteName: StatsIdentityStore.suiteName(appId: harness.appId))
        #expect(suite?.string(forKey: "installUUID") == nil)
        await harness.tearDown()
    }

    /// The default changing must not weaken the `.none` guarantee: an app that
    /// asks for collect-nothing still gets collect-nothing.
    @Test("With consent .none, nothing is captured at all")
    func defaultCollectsNothing() async {
        let harness = Harness(consent: .none)
        await harness.client.track("a")
        await harness.client.applicationDidBecomeActive()
        await harness.client.flush()
        await harness.client.waitForFlushes()

        #expect(await harness.client.queuedEventCount == 0)
        #expect(await harness.sink.batchCount == 0)
        // No install id was generated either.
        let suite = UserDefaults(suiteName: StatsIdentityStore.suiteName(appId: harness.appId))
        #expect(suite?.string(forKey: "installUUID") == nil)
        await harness.tearDown()
    }

    @Test("usage denied means nothing is emitted, whatever the other groups say")
    func usageDeniedSilencesEverything() async {
        let harness = Harness(consent: [.diagnostics, .identity])
        await harness.client.track("a")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        #expect(await harness.sink.batchCount == 0)
        await harness.tearDown()
    }

    /// Discriminating: with `identity` denied the events must carry **no**
    /// `userId` even though `identify()` was called, and a *different* install id
    /// per session, so nothing is linkable across sessions.
    @Test("identity denied: no userId, and a fresh ephemeral install id per session")
    func identityDenied() async {
        let harness = Harness(consent: [.usage, .diagnostics], sessionGap: .seconds(300))
        await harness.client.identify(userID: "account-1")
        await harness.client.track("a")
        harness.clock.advance(by: .seconds(400))
        await harness.client.track("b")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let events = await harness.sink.sentEvents
        #expect(events.count == 2)
        #expect(events.allSatisfy { $0.userId == nil })
        #expect(events[0].installId != events[1].installId, "the install id must be per-session")
        #expect(events[0].installId.count == 64)
        // Nothing was persisted, so a relaunch cannot resume the identity.
        let suite = UserDefaults(suiteName: StatsIdentityStore.suiteName(appId: harness.appId))
        #expect(suite?.string(forKey: "installUUID") == nil)
        await harness.tearDown()
    }

    @Test("diagnostics denied: the documented unknown values, and a well-formed context")
    func diagnosticsDenied() async {
        let harness = Harness(consent: [.usage, .identity])
        await harness.client.track("a")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let context = await harness.sink.batches.first?.context
        #expect(context?.osVersion == "15", "the major version only")
        #expect(context?.deviceModel == "unknown")
        #expect(context?.locale == "en", "the language only")
        #expect(context?.region == "ZZ")
        #expect(context?.screenWidth == 0)
        #expect(context?.screenHeight == 0)
        #expect(context?.screenScale == 1.0)
        #expect(context?.colorScheme == nil)
        // Always sent, whatever consent says.
        #expect(context?.sdkVersion == "0.2.0")
        #expect(context?.appVersion == "1.4.2")
        #expect(context?.appBuild == "318")
        #expect(context?.bundleId == harness.appId)
        // Not identifying, so they stay real.
        #expect(context?.osName == "macOS")
        #expect(context?.arch == "arm64")
        await harness.tearDown()
    }

    /// §2.5: with `identity` denied an `identify()` call is "remembered in memory
    /// but never emitted". Persisting the hash would let a later grant resume a
    /// linkage the person never re-authorized.
    @Test("identify() under denied identity consent is remembered but never stored")
    func identifyNotPersistedWhenDenied() async {
        let harness = Harness(consent: [.usage, .diagnostics])
        await harness.client.identify(userID: "account-1")
        await harness.client.track("a")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        #expect(await harness.sink.sentEvents.first?.userId == nil)
        let suite = UserDefaults(suiteName: StatsIdentityStore.suiteName(appId: harness.appId))
        #expect(suite?.string(forKey: "userIdHash") == nil, "the hash must not reach disk")
        await harness.tearDown()
    }

    @Test("Revoking a group discards the queue and deletes the stored install UUID")
    func revocationDestroysIdentityAndQueue() async {
        let harness = Harness()
        await harness.client.identify(userID: "account-1")
        await harness.client.track("a")
        #expect(await harness.client.queuedEventCount == 1)

        await harness.client.setConsent([.usage, .diagnostics])   // identity revoked

        #expect(await harness.client.queuedEventCount == 0, "a revocation discards, it does not flush")
        #expect(await harness.sink.batchCount == 0)
        let suite = UserDefaults(suiteName: StatsIdentityStore.suiteName(appId: harness.appId))
        #expect(suite?.string(forKey: "installUUID") == nil)
        #expect(suite?.string(forKey: "userIdHash") == nil)

        // Re-granting starts a new identity rather than resuming the old one.
        await harness.client.setConsent(.all)
        await harness.client.track("b")
        await harness.client.flush()
        await harness.client.waitForFlushes()
        let events = await harness.sink.sentEvents
        #expect(events.map(\.name) == ["b"])
        #expect(events.first?.seq == 0)
        #expect(events.first?.userId == nil, "identify() is not resumed across a revocation")
        await harness.tearDown()
    }

    @Test("Granting a group is not a revocation and keeps the queue")
    func grantingKeepsQueue() async {
        let harness = Harness(consent: [.usage])
        await harness.client.track("a")
        await harness.client.setConsent([.usage, .diagnostics])
        #expect(await harness.client.queuedEventCount == 1)
        await harness.tearDown()
    }

    @Test("The persisted choice wins over the configuration on a relaunch")
    func persistedConsentWins() async {
        let harness = Harness(consent: .all)
        await harness.client.setConsent([.usage])
        await harness.client.shutdown()
        harness.clock.cancelAllSleepers()

        // The relaunch asks for everything; the recorded choice must stand.
        let relaunched = harness.relaunched(consent: .all)
        #expect(await relaunched.client.currentConsent == [.usage])
        // The stored choice, not the configuration's `.all`, decides it.
        #expect(await relaunched.client.hasStableInstallIdentity == false)
        await relaunched.tearDown()
    }

    // MARK: - Stable install identity

    /// The per-session-install warning is said at the first ephemeral mint,
    /// once per client. Under the default configuration — no auto-events at
    /// all — a plain `track()` is enough to trigger it.
    @Test("Default consent warns once at the first ephemeral install id, not again next session")
    func ephemeralInstallWarnsOncePerClient() async {
        let harness = Harness(consent: .default, sessionGap: .seconds(300))
        #expect(await harness.client.ephemeralInstallWarningCount == 0, "nothing is minted before a session")

        await harness.client.track("a")
        #expect(await harness.client.ephemeralInstallWarningCount == 1)

        // A second session mints a second ephemeral id, but the client has
        // already said it.
        harness.clock.advance(by: .seconds(400))
        await harness.client.track("b")
        #expect(await harness.client.ephemeralInstallWarningCount == 1)
        await harness.client.flush()
        await harness.client.waitForFlushes()
        let events = await harness.sink.sentEvents
        #expect(events.count == 2)
        #expect(events[0].installId != events[1].installId, "two sessions, two ephemeral ids")
        await harness.tearDown()
    }

    @Test("With identity granted, no warning")
    func stableInstallDoesNotWarn() async {
        let harness = Harness(consent: .all, sessionGap: .seconds(300))
        await harness.client.track("a")
        harness.clock.advance(by: .seconds(400))
        await harness.client.track("b")
        #expect(await harness.client.ephemeralInstallWarningCount == 0)
        #expect(await harness.client.hasStableInstallIdentity == true)
        await harness.tearDown()
    }

    /// Why the warning is evaluated lazily: an app that ships the default
    /// configuration but grants `.identity` before its first session never
    /// mints an ephemeral id, and must not be told it did.
    @Test("Granting identity before the first session means no warning")
    func grantBeforeFirstSessionDoesNotWarn() async {
        let harness = Harness(consent: .default)
        let current = await harness.client.currentConsent
        await harness.client.setConsent(current.union(.identity))
        await harness.client.track("a")
        #expect(await harness.client.ephemeralInstallWarningCount == 0)
        await harness.tearDown()
    }

    /// The stored choice, not the configuration, decides: a relaunch that
    /// configures `.all` over a stored `[.usage]` still mints ephemeral ids.
    @Test("A stored consent without identity warns even when the configuration grants it")
    func storedConsentWithoutIdentityWarns() async {
        let harness = Harness(consent: .all)
        await harness.client.setConsent([.usage])
        await harness.client.shutdown()
        harness.clock.cancelAllSleepers()

        let relaunched = harness.relaunched(consent: .all)
        await relaunched.client.track("a")
        #expect(await relaunched.client.ephemeralInstallWarningCount == 1)
        await relaunched.tearDown()
    }

    /// The migration an app shipped with the default consent has to make:
    /// adding `.identity` to whatever is current. That is a pure grant, so it
    /// must not be mistaken for a revocation — the queue survives, `seq` keeps
    /// counting, and the next session runs under one persisted install UUID.
    @Test("Adding .identity to the current consent keeps the queue and seq, and stabilizes the install")
    func grantingIdentityIsMigrationSafe() async {
        let harness = Harness(consent: .default, sessionGap: .seconds(300))
        await harness.client.track("a")
        await harness.client.track("b")
        #expect(await harness.client.hasStableInstallIdentity == false)

        let current = await harness.client.currentConsent
        await harness.client.setConsent(current.union(.identity))

        #expect(await harness.client.hasStableInstallIdentity == true)
        #expect(await harness.client.currentConsent == .all)
        #expect(await harness.client.queuedEventCount == 2, "a grant must not discard the queue")

        // Two later sessions, both under the newly granted identity.
        harness.clock.advance(by: .seconds(400))
        await harness.client.track("c")
        harness.clock.advance(by: .seconds(400))
        await harness.client.track("d")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let events = await harness.sink.sentEvents
        #expect(events.map(\.name) == ["a", "b", "c", "d"])
        #expect(events.map(\.seq) == [0, 1, 2, 3], "a grant must not reset seq")
        #expect(events[2].installId == events[3].installId, "the install is now stable across sessions")
        #expect(events[0].installId != events[2].installId, "the pre-grant id was ephemeral")
        let suite = UserDefaults(suiteName: StatsIdentityStore.suiteName(appId: harness.appId))
        #expect(suite?.string(forKey: "installUUID") != nil)
        await harness.tearDown()
    }

    @Test("Disabled: nothing is captured and the queue is cleared")
    func disabledCapturesNothing() async {
        let harness = Harness()
        await harness.client.track("a")
        #expect(await harness.client.queuedEventCount == 1)

        await harness.client.setEnabled(false)
        #expect(await harness.client.isEnabled == false)
        #expect(await harness.client.queuedEventCount == 0, "opt-out clears the queue")

        await harness.client.track("b")
        await harness.client.applicationDidBecomeActive()
        await harness.client.flush()
        await harness.client.waitForFlushes()
        #expect(await harness.client.queuedEventCount == 0)
        #expect(await harness.sink.batchCount == 0)

        // And the opt-out is remembered across a relaunch.
        await harness.client.shutdown()
        harness.clock.cancelAllSleepers()
        let relaunched = harness.relaunched()
        #expect(await relaunched.client.isEnabled == false)
        await relaunched.tearDown()
    }

    @Test("A client constructed disabled queues nothing at all")
    func constructedDisabled() async {
        let harness = Harness(enabled: false)
        await harness.client.track("a")
        #expect(await harness.client.queuedEventCount == 0)
        await harness.tearDown()
    }
}
