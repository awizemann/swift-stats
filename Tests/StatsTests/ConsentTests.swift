import Foundation
@testable import Stats
import StatsTesting
import Testing

/// Schema §11: opt-out by default, three independent groups, and what a
/// revocation must destroy.
@Suite("Consent and opt-out")
struct ConsentTests {
    /// The product decision: per-install by default, per-user only when the app
    /// asks. The default grants `.identity`, so an app that never mentions
    /// consent gets a stable install id; a `userId` still needs `identify()`.
    @Test("The configuration default is [.usage, .diagnostics, .identity]")
    func configurationDefaultIncludesIdentity() {
        #expect(StatsConsent.default == [.usage, .diagnostics, .identity])
        #expect(StatsConsent.default.contains(.identity))
        #expect(StatsConsent.all == StatsConsent.default, ".all is kept, and now equals the default")
    }

    /// Discriminating on the *client*, not just the constant: a configuration
    /// that never mentions consent (`Harness(sdkDefaultConsent: true)` leaves the SDK's own
    /// default in place) must give one install id across two sessions, no
    /// `userId`, and no per-session warning. Under the old default the two
    /// sessions had different ids and the warning fired.
    @Test("Default configuration: a stable install across sessions, no userId, no warning")
    func defaultConfigurationIsPerInstall() async {
        let harness = Harness(sdkDefaultConsent: true, sessionGap: .seconds(300))
        #expect(await harness.client.currentConsent == [.usage, .diagnostics, .identity])
        #expect(await harness.client.hasStableInstallIdentity == true)

        await harness.client.track("a")
        harness.clock.advance(by: .seconds(400))
        await harness.client.track("b")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let events = await harness.sink.sentEvents
        #expect(events.map(\.name) == ["a", "b"])
        #expect(Set(events.map(\.sessionId)).count == 2, "two sessions")
        #expect(events[0].installId == events[1].installId, "one install across sessions")
        #expect(events.allSatisfy { $0.userId == nil }, "no userId without identify()")
        #expect(await harness.client.ephemeralInstallWarningCount == 0)
        // `diagnostics` is granted too, so the context is the real one.
        #expect(await harness.sink.batches.first?.context.deviceModel != "unknown")
        let suite = UserDefaults(suiteName: StatsIdentityStore.suiteName(appId: harness.appId))
        #expect(suite?.string(forKey: "installUUID") != nil, "the install UUID is persisted")
        await harness.tearDown()
    }

    @Test("Default configuration: the install id survives a relaunch")
    func defaultConfigurationIsStableAcrossRelaunch() async {
        let harness = Harness(sdkDefaultConsent: true)
        await harness.client.track("a")
        await harness.client.flush()
        await harness.client.waitForFlushes()
        let first = await harness.sink.sentEvents
        await harness.client.shutdown()
        harness.clock.cancelAllSleepers()

        let relaunched = harness.relaunched(sdkDefaultConsent: true, uuids: Harness.relaunchUUIDs)
        await relaunched.client.track("b")
        await relaunched.client.flush()
        await relaunched.client.waitForFlushes()
        let second = await relaunched.sink.sentEvents

        #expect(first.count == 1)
        #expect(second.count == 1)
        #expect(first.first?.sessionId != second.first?.sessionId, "a launch begins a new session")
        #expect(first.first?.installId == second.first?.installId, "the same install after a relaunch")
        #expect(second.first?.seq == 1, "seq keeps counting for the same install")
        #expect(second.first?.userId == nil)
        #expect(await relaunched.client.ephemeralInstallWarningCount == 0)
        await relaunched.tearDown()
    }

    /// Per-user stays opt-in under the new default: `userId` appears only after
    /// the app calls `identify(userID:)`.
    @Test("Default configuration: userId only after identify()")
    func defaultConfigurationUserIdNeedsIdentify() async {
        let harness = Harness(sdkDefaultConsent: true)
        await harness.client.track("before")
        await harness.client.identify(userID: "account-1")
        await harness.client.track("after")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let events = await harness.sink.sentEvents
        #expect(events.map(\.name) == ["before", "after"])
        #expect(events[0].userId == nil)
        #expect(events[1].userId != nil)
        #expect(events[1].userId != "account-1", "hashed, never the raw value")
        #expect(events[0].installId == events[1].installId)
        await harness.tearDown()
    }

    /// The upgrade path: an app that shipped on the old default
    /// (`[.usage, .diagnostics]`) and never called `setConsent` has nothing
    /// persisted, so the next launch on the new default becomes per-install.
    @Test("Upgrade: no setConsent recorded → the new default applies at next launch")
    func upgradeWithoutRecordedConsentBecomesPerInstall() async {
        let harness = Harness(consent: [.usage, .diagnostics])
        await harness.client.track("a")
        await harness.client.shutdown()
        harness.clock.cancelAllSleepers()

        let relaunched = harness.relaunched(sdkDefaultConsent: true)
        #expect(await relaunched.client.currentConsent == .default)
        #expect(await relaunched.client.hasStableInstallIdentity == true)
        await relaunched.tearDown()
    }

    /// Under the SDK default `identity` is granted, so the `identify()` hash is
    /// persisted and a relaunch keeps sending it without a second call.
    @Test("Default configuration: identify() then relaunch → the hash is still sent")
    func defaultConfigurationIdentifySurvivesRelaunch() async {
        let harness = Harness(sdkDefaultConsent: true)
        await harness.client.identify(userID: "account-1")
        await harness.client.track("a")
        await harness.client.flush()
        await harness.client.waitForFlushes()
        let firstUserId = await harness.sink.sentEvents.first?.userId
        await harness.client.shutdown()
        harness.clock.cancelAllSleepers()

        let relaunched = harness.relaunched(sdkDefaultConsent: true, uuids: Harness.relaunchUUIDs)
        await relaunched.client.track("b")
        await relaunched.client.flush()
        await relaunched.client.waitForFlushes()
        let second = await relaunched.sink.sentEvents

        #expect(firstUserId != nil)
        #expect(second.first?.userId == firstUserId, "no second identify() was needed")
        await relaunched.tearDown()
    }

    /// The 0.2.0 upgrade for an app that calls `identify()` but never recorded
    /// consent: suppressed before (identity denied, hash never on disk), sent
    /// after the upgrade once `identify()` runs again.
    @Test("Upgrade: identify() with no recorded consent — userId suppressed before, emitted after")
    func upgradeIdentifyWithoutRecordedConsentNowEmits() async {
        let harness = Harness(consent: [.usage, .diagnostics])   // the 0.2.0 default
        await harness.client.identify(userID: "account-1")
        await harness.client.track("a")
        await harness.client.flush()
        await harness.client.waitForFlushes()
        #expect(await harness.sink.sentEvents.first?.userId == nil, "suppressed on the old default")
        await harness.client.shutdown()
        harness.clock.cancelAllSleepers()

        let relaunched = harness.relaunched(sdkDefaultConsent: true, uuids: Harness.relaunchUUIDs)
        await relaunched.client.track("before_identify")
        await relaunched.client.identify(userID: "account-1")
        await relaunched.client.track("after_identify")
        await relaunched.client.flush()
        await relaunched.client.waitForFlushes()

        let events = await relaunched.sink.sentEvents
        #expect(events.map(\.name) == ["before_identify", "after_identify"])
        #expect(events[0].userId == nil, "the 0.2.0 hash was never persisted")
        #expect(events[1].userId != nil, "the new default emits it")
        let suite = UserDefaults(suiteName: StatsIdentityStore.suiteName(appId: harness.appId))
        #expect(suite?.string(forKey: "userIdHash") != nil, "and persists it")
        await relaunched.tearDown()
    }

    /// A choice recorded via `setConsent` wins over the new default, so an app
    /// that recorded `[.usage, .diagnostics]` (including via `.default` on
    /// 0.2.0) stays per-session after upgrading.
    @Test("Upgrade: recorded [.usage, .diagnostics] stays per-session under the new default")
    func upgradeRecordedConsentStaysPerSession() async {
        let harness = Harness(consent: [.usage, .diagnostics])
        await harness.client.setConsent([.usage, .diagnostics])
        await harness.client.track("a")
        await harness.client.flush()
        await harness.client.waitForFlushes()
        let first = await harness.sink.sentEvents
        await harness.client.shutdown()
        harness.clock.cancelAllSleepers()

        let relaunched = harness.relaunched(sdkDefaultConsent: true, uuids: Harness.relaunchUUIDs)
        #expect(await relaunched.client.currentConsent == [.usage, .diagnostics])
        #expect(await relaunched.client.hasStableInstallIdentity == false)
        await relaunched.client.track("b")
        await relaunched.client.flush()
        await relaunched.client.waitForFlushes()
        let second = await relaunched.sink.sentEvents

        #expect(first.first?.installId != nil)
        #expect(first.first?.installId != second.first?.installId)
        #expect(await relaunched.client.ephemeralInstallWarningCount == 1)
        let suite = UserDefaults(suiteName: StatsIdentityStore.suiteName(appId: harness.appId))
        #expect(suite?.string(forKey: "installUUID") == nil)
        await relaunched.tearDown()
    }

    /// The opt-out from a stable install is explicit and keeps working: the
    /// install id stays per-session across a relaunch too.
    @Test("Explicit [.usage, .diagnostics]: per-session ids across a relaunch, nothing persisted")
    func explicitOptOutStaysPerSessionAcrossRelaunch() async {
        let harness = Harness(consent: [.usage, .diagnostics])
        await harness.client.track("a")
        await harness.client.flush()
        await harness.client.waitForFlushes()
        let first = await harness.sink.sentEvents
        #expect(await harness.client.ephemeralInstallWarningCount == 1)
        await harness.client.shutdown()
        harness.clock.cancelAllSleepers()

        let relaunched = harness.relaunched(consent: [.usage, .diagnostics], uuids: Harness.relaunchUUIDs)
        await relaunched.client.track("b")
        await relaunched.client.flush()
        await relaunched.client.waitForFlushes()
        let second = await relaunched.sink.sentEvents

        #expect(first.first?.installId != nil)
        #expect(first.first?.installId != second.first?.installId)
        #expect(await relaunched.client.ephemeralInstallWarningCount == 1, "each client says it once")
        #expect(await relaunched.client.hasStableInstallIdentity == false)
        let suite = UserDefaults(suiteName: StatsIdentityStore.suiteName(appId: harness.appId))
        #expect(suite?.string(forKey: "installUUID") == nil)
        await relaunched.tearDown()
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

    /// Only `setConsent` persists a choice, so an app that never called it is
    /// governed by whatever its configuration says on each launch.
    @Test("Without a setConsent call, a changed configuration applies on relaunch")
    func configuredConsentAppliesUntilSetConsent() async {
        let harness = Harness(consent: [.usage, .diagnostics])
        await harness.client.track("a")
        await harness.client.shutdown()
        harness.clock.cancelAllSleepers()

        let relaunched = harness.relaunched(consent: .all)
        #expect(await relaunched.client.currentConsent == .all)
        #expect(await relaunched.client.hasStableInstallIdentity == true)
        await relaunched.tearDown()
    }

    // MARK: - Stable install identity

    /// The per-session-install warning is said at the first ephemeral mint,
    /// once per client. For an app that explicitly denies identity — and has no
    /// auto-events at all — a plain `track()` is enough to trigger it.
    @Test("Explicitly denied identity warns once at the first ephemeral install id, not again next session")
    func ephemeralInstallWarnsOncePerClient() async {
        let harness = Harness(consent: [.usage, .diagnostics], sessionGap: .seconds(300))
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

    /// Why the warning is evaluated lazily: an app that configures identity
    /// denied but grants `.identity` before its first session never mints an
    /// ephemeral id, and must not be told it did.
    @Test("Granting identity before the first session means no warning")
    func grantBeforeFirstSessionDoesNotWarn() async {
        let harness = Harness(consent: [.usage, .diagnostics])
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

    /// The migration an app with identity denied (for instance one that
    /// recorded `[.usage, .diagnostics]` via `setConsent`) makes to get a
    /// stable install: adding `.identity` to whatever is current. That is a
    /// pure grant, so it must not be mistaken for a revocation — the queue
    /// survives, and the next session runs under one persisted install UUID.
    ///
    /// `seq` is per install id (§2.2), and the pre-grant id was a per-session
    /// ephemeral one with its own `seq` space (§6, §11). So the two pre-grant
    /// events are 0 and 1 under the ephemeral id, and the stable install starts
    /// its own count at 0. This used to assert `[0, 1, 2, 3]` — one counter
    /// running across both ids, which is exactly the chain a backend could
    /// follow from an ephemeral session into the stable install.
    @Test("Adding .identity to the current consent keeps the queue, and stabilizes the install")
    func grantingIdentityIsMigrationSafe() async {
        let harness = Harness(consent: [.usage, .diagnostics], sessionGap: .seconds(300))
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
        #expect(events.map(\.seq) == [0, 1, 0, 1], "each install id has its own seq space")
        #expect(events[2].installId == events[3].installId, "the install is now stable across sessions")
        #expect(events[0].installId != events[2].installId, "the pre-grant id was ephemeral")
        let suite = UserDefaults(suiteName: StatsIdentityStore.suiteName(appId: harness.appId))
        #expect(suite?.string(forKey: "installUUID") != nil)
        await harness.tearDown()
    }

    /// §11 / §6: under denied `identity` each session's ephemeral install id
    /// has its own `seq` space. A counter that ran on across sessions — and was
    /// persisted across launches — let a backend chain the "unlinkable"
    /// sessions back together: session two's first `seq` is session one's last
    /// plus one.
    @Test("Denied identity: seq restarts at 0 for every ephemeral id and is never persisted")
    func ephemeralSeqSpace() async {
        let harness = Harness(
            consent: [.usage, .diagnostics], autoEvents: [.sessions], sessionGap: .seconds(300)
        )
        await harness.client.track("a")
        await harness.client.track("b")
        harness.clock.advance(by: .seconds(400))
        await harness.client.track("c")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let events = await harness.sink.sentEvents
        #expect(events.map(\.name) == ["session_start", "a", "b", "session_end", "session_start", "c"])
        // `session_end` closes the first session under the first id, so it is
        // that id's next number; the second id starts over.
        #expect(events.map(\.seq) == [0, 1, 2, 3, 0, 1])
        #expect(events[3].installId == events[0].installId)
        #expect(events[4].installId != events[0].installId)
        let suite = UserDefaults(suiteName: StatsIdentityStore.suiteName(appId: harness.appId))
        #expect((suite?.integer(forKey: "seq") ?? 0) == 0, "an ephemeral seq is never written to disk")
        await harness.client.shutdown()
        harness.clock.cancelAllSleepers()

        // A relaunch is a new session, so a new ephemeral id starting at 0.
        let relaunched = harness.relaunched(consent: [.usage, .diagnostics], uuids: Harness.relaunchUUIDs)
        await relaunched.client.track("d")
        await relaunched.client.flush()
        await relaunched.client.waitForFlushes()
        #expect(await relaunched.sink.sentEvents.map(\.seq) == [0])
        await relaunched.tearDown()
    }

    /// §11: a state that collects nothing must send nothing either. A queue
    /// left by an earlier launch (here: written under `.usage`, then a recorded
    /// `.none` whose revocation discard is bypassed by writing the stored choice
    /// directly, as a configured downgrade or a failed delete would leave it)
    /// used to go out on the next `flush()`, because `flush()` never looked at
    /// consent.
    @Test("flush() and reset() never send while collection is off; the leftover queue is discarded")
    func flushAndResetRespectCollectingState() async {
        let harness = Harness(flushAt: 10_000)
        await harness.client.track("a")
        await harness.client.shutdown()
        harness.clock.cancelAllSleepers()

        // Consent `.none` recorded without going through `setConsent`.
        let suite = UserDefaults(suiteName: StatsIdentityStore.suiteName(appId: harness.appId))
        suite?.set(StatsConsent.none.rawValue, forKey: "consent")
        suite?.set(true, forKey: "consentRecorded")

        let relaunched = harness.relaunched()
        await relaunched.client.flush()
        await relaunched.client.waitForFlushes()
        await relaunched.client.reset()
        await relaunched.client.waitForFlushes()
        #expect(await relaunched.sink.batchCount == 0, "nothing is sent while collection is off")
        #expect(await relaunched.client.queuedEventCount == 0, "and the leftover queue is discarded")
        await relaunched.client.shutdown()
        relaunched.clock.cancelAllSleepers()

        // Opted out instead of consent-less: the same.
        let other = Harness(flushAt: 10_000)
        await other.client.track("a")
        await other.client.shutdown()
        other.clock.cancelAllSleepers()
        UserDefaults(suiteName: StatsIdentityStore.suiteName(appId: other.appId))?.set(false, forKey: "enabled")
        let reopened = other.relaunched()
        await reopened.client.flush()
        await reopened.client.waitForFlushes()
        #expect(await reopened.sink.batchCount == 0)
        #expect(await reopened.client.queuedEventCount == 0)
        await reopened.tearDown()
        await relaunched.tearDown()
    }

    /// Backgrounding is the flush most apps rely on, so it gets the same rule
    /// as `flush()`: under a stored opt-out the leftover queue is discarded,
    /// never sent.
    @Test("applicationDidEnterBackground() under a stored opt-out sends nothing and discards the leftover queue")
    func backgroundRespectsOptOut() async {
        let harness = Harness(flushAt: 10_000)
        await harness.client.track("a")
        await harness.client.shutdown()
        harness.clock.cancelAllSleepers()
        UserDefaults(suiteName: StatsIdentityStore.suiteName(appId: harness.appId))?.set(false, forKey: "enabled")

        let relaunched = harness.relaunched()
        await relaunched.client.applicationDidEnterBackground()
        await relaunched.client.waitForFlushes()
        #expect(await relaunched.sink.batchCount == 0)
        #expect(await relaunched.client.queuedEventCount == 0)
        await relaunched.tearDown()
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
