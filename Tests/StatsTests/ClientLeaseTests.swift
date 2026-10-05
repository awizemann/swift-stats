import Foundation
@testable import Stats
import StatsTesting
import Testing

/// One owner per app id; every other client forwards to it.
///
/// Two clients for one app id share the queue file and the persisted `seq`, but
/// each has its own `EventStore` actor and its own `seq` cache — so both used
/// to stamp the same numbers on different events (two events with one
/// `(installId, seq)`, which a backend deduping on that triple per §6 keeps
/// only one of) and both stores sent the same file's records. Now only the
/// owner touches them, and a second client behaves exactly like the owner
/// because it hands every call to it.
@Suite("One owner per app id, the rest forward", .timeLimit(.minutes(1)))
struct ClientLeaseTests {
    /// A second client over the harness's app id and directory, with its own
    /// sink, so a test can tell which client actually sent.
    private static func secondClient(
        for harness: Harness, consent: StatsConsent = .all
    ) -> (client: StatsClient, sink: InMemorySink) {
        let sink = InMemorySink()
        var configuration = harness.configuration
        configuration.sink = sink
        configuration.consent = consent
        return (StatsClient(configuration: configuration), sink)
    }

    /// Discriminating on `seq`: the second client used to read the persisted
    /// `seq` (1, after the first event) into its own cache while the first
    /// client's cache was also at 1, so `b` and `c` went out with one number.
    @Test("A second client's events go through the owner's queue with continuous seq")
    func secondClientForwardsCapture() async {
        let harness = Harness(flushAt: 10_000)
        let (second, secondSink) = Self.secondClient(for: harness)

        await harness.client.track("a")
        await second.track("b")
        await harness.client.track("c")
        second.record("d")
        await second.drainRecorded()
        #expect(await second.queuedEventCount == 4, "the second client reports the owner's queue")

        await second.flush()
        await second.waitForFlushes()
        let events = await harness.sink.sentEvents
        #expect(events.map(\.name) == ["a", "b", "c", "d"])
        #expect(events.map(\.seq) == [0, 1, 2, 3])
        #expect(Set(events.map(\.installId)).count == 1)
        #expect(await secondSink.batchCount == 0, "the second client's own sink is never used")

        await second.shutdown()
        await harness.tearDown()
    }

    /// The privacy case: a settings screen with its own client must opt the
    /// *app* out, not just its own handle while the owner keeps collecting.
    @Test("setEnabled(false) through a second client stops the owner collecting")
    func secondClientOptOutReachesOwner() async {
        let harness = Harness(flushAt: 10_000)
        await harness.client.track("a")

        let (settings, _) = Self.secondClient(for: harness)
        await settings.setEnabled(false)

        #expect(await harness.client.isEnabled == false)
        #expect(await harness.client.queuedEventCount == 0, "the opt-out discarded the owner's queue")
        await harness.client.track("b")
        await harness.client.flush()
        await harness.client.waitForFlushes()
        #expect(await harness.sink.batchCount == 0)

        // Consent works the same way, and reads come from the owner too.
        await settings.setEnabled(true)
        await settings.setConsent([.usage])
        #expect(await harness.client.currentConsent == [.usage])
        #expect(await settings.currentConsent == [.usage])
        #expect(await settings.hasStableInstallIdentity == false)

        await settings.shutdown()
        await harness.tearDown()
    }

    /// The second client's configuration is ignored while it forwards; once
    /// the owner is gone it owns the app id itself, and it re-reads the
    /// persisted state the old owner left — consent recorded through the old
    /// owner and the `seq` it reached — rather than the values it cached when
    /// it was first used.
    @Test("When the owner shuts down, the next call on another client takes over")
    func ownershipHandOver() async {
        let harness = Harness(flushAt: 10_000)
        await harness.client.track("a")
        // Configured `.none`: it would collect nothing if its own configuration
        // were in force.
        let (successor, successorSink) = Self.secondClient(for: harness, consent: .none)
        #expect(await successor.currentConsent == .all, "forwarded to the owner")
        #expect(await successor.isEnabled)

        // Moves the persisted `seq` past what the successor read when it was
        // first used.
        await harness.client.track("a2")
        await harness.client.setConsent(.all)
        await harness.client.shutdown()
        harness.clock.cancelAllSleepers()

        await successor.track("b")
        #expect(await successor.currentConsent == .all, "the recorded choice, re-read on taking over")
        await successor.flush()
        await successor.waitForFlushes()
        let events = await successorSink.sentEvents
        #expect(events.map(\.name) == ["a", "a2", "b"], "the old owner's queue is picked up from disk")
        #expect(events.map(\.seq) == [0, 1, 2], "seq continues from what the old owner persisted")

        // The old owner stays shut down.
        await harness.client.track("late")
        #expect(await successor.queuedEventCount == 0)
        await successor.shutdown()
        await harness.tearDown()
    }

    @Test("shutdown() hands the app id to a client created afterwards")
    func shutdownReleasesTheAppId() async {
        let harness = Harness(flushAt: 10_000)
        await harness.client.track("a")
        await harness.client.shutdown()
        harness.clock.cancelAllSleepers()

        let relaunched = harness.relaunched()
        await relaunched.client.track("b")
        await relaunched.client.flush()
        await relaunched.client.waitForFlushes()
        let events = await relaunched.sink.sentEvents
        #expect(events.map(\.name) == ["a", "b"])
        #expect(events.map(\.seq) == [0, 1])
        await relaunched.tearDown()
    }

    /// A storage directory is a key of its own, but a client for a *different*
    /// app id must not forward to its owner — its events would go out as the
    /// owner's app. Nor may it own the directory too (two stores, one file).
    /// So it is refused: nothing it is asked to do happens, including the
    /// privacy calls, which it logs at `fault` because it cannot honour them.
    @Test("A different app id on an owned storage directory is refused, not forwarded")
    func sharedStorageDirectory() async {
        let harness = Harness(flushAt: 10_000)
        let otherAppId = "com.example.shared\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
        defer { UserDefaults().removePersistentDomain(forName: StatsIdentityStore.suiteName(appId: otherAppId)) }
        let otherSink = InMemorySink()
        var configuration = harness.configuration
        configuration.appId = otherAppId
        configuration.sink = otherSink
        let other = StatsClient(configuration: configuration)

        await harness.client.track("a")
        await other.track("b")
        other.record("c")
        await other.drainRecorded()
        await other.flush()
        await other.setEnabled(false)
        await other.setConsent(.none)
        await other.reset()
        #expect(await other.queuedEventCount == 0)

        // The owner is untouched: its queue, its switches, its sink.
        #expect(await harness.client.isEnabled)
        #expect(await harness.client.currentConsent == .all)
        await harness.client.flush()
        await harness.client.waitForFlushes()
        let events = await harness.sink.sentEvents
        #expect(events.map(\.name) == ["a"])
        #expect(Set(events.map(\.appId)) == [harness.appId])
        #expect(await otherSink.batchCount == 0)
        await other.shutdown()
        await harness.tearDown()
    }

    /// The window inside the owner's `shutdown()`: it has stopped acting but
    /// still owns the app id while it waits for an in-flight send. A forwarded
    /// call used to reach it there and be dropped — an opt-out made through a
    /// settings screen's client simply vanished. Now it waits for the shutdown
    /// to finish, and the forwarding client takes over and applies it.
    @Test("setConsent through a second client during the owner's shutdown is applied, not dropped")
    func setConsentDuringOwnerShutdown() async {
        let harness = Harness(flushAt: 10_000)
        let gated = GatedSink()
        var configuration = harness.configuration
        configuration.sink = gated
        let owner = StatsClient(configuration: configuration)
        let settings = harness.client

        await owner.track("a")
        let flush = Task { await owner.flush() }
        await gated.waitUntilParked()
        let shutdown = Task { await owner.shutdown() }
        // The owner is now inside `shutdown()`, waiting for the send.
        await owner.dispatcher.shutdownStarted.wait()

        let consent = Task { await settings.setConsent(.none) }
        // The forwarded call is parked on the owner's shutdown, not dropped.
        await owner.shutDownSignal.waitForWaiters(1)
        await gated.release(with: .accepted)
        await shutdown.value
        await flush.value
        await consent.value

        let suite = UserDefaults(suiteName: StatsIdentityStore.suiteName(appId: harness.appId))
        #expect(suite?.bool(forKey: "consentRecorded") == true)
        #expect(suite?.integer(forKey: "consent") == StatsConsent.none.rawValue)
        #expect(await settings.currentConsent == .none)
        await settings.track("b")
        await settings.flush()
        await settings.waitForFlushes()
        #expect(await harness.sink.batchCount == 0, "the revocation is honoured")
        #expect(await settings.queuedEventCount == 0)
        await harness.tearDown()
    }

    /// A client dropped without `shutdown()` releases the app id when it is
    /// deallocated. (Its queue is on disk, so the next owner sends it.)
    @Test("A deallocated owner releases the app id")
    func deinitReleasesTheAppId() async {
        let harness = Harness(flushAt: 10_000)
        var transient: StatsClient? = StatsClient(configuration: harness.configuration)
        await transient?.track("a")
        transient = nil

        await harness.client.track("b")
        await harness.client.flush()
        await harness.client.waitForFlushes()
        #expect(await harness.sink.sentEventNames == ["a", "b"])
        await harness.tearDown()
    }

    /// The deallocation case with a flush still running. The flush `Task`
    /// holds the dispatcher, not the client, so `deinit` runs mid-send — and
    /// releasing the app id there used to leave two senders on one file: the
    /// old dispatcher removed the batch it had sent and went on to send the
    /// next, while the new owner loaded the same file.
    @Test("A deallocated owner's in-flight flush stops: no further send, no write")
    func deinitStopsInFlightDispatcher() async {
        let harness = Harness(flushAt: 10_000)
        let gated = GatedSink()
        var configuration = harness.configuration
        configuration.sink = gated
        configuration.flushAt = 1
        var doomed: StatsClient? = StatsClient(configuration: configuration)

        await doomed?.track("a")
        // The count trigger put `a` on the wire.
        await gated.waitUntilParked()
        await doomed?.track("b")
        let queue = harness.directory.appendingPathComponent("queue.jsonl")
        let before = try? Data(contentsOf: queue)
        // Held past the client's lifetime, to await the flushes it left running.
        let orphaned = await doomed?.dispatcher
        doomed = nil

        // The answer arrives after the client is gone.
        await gated.release(with: .accepted)
        await orphaned?.waitForFlushes()
        #expect(await gated.sends == 1, "the old dispatcher sends nothing more")
        #expect((try? Data(contentsOf: queue)) == before, "and does not touch the file")
        #expect(
            !FileManager.default.fileExists(atPath: harness.directory.appendingPathComponent("queue.head").path),
            "no consumed-prefix marker was written for the acceptance"
        )

        // The new owner sends everything (`a` again: a duplicate §6 dedupes).
        await harness.client.flush()
        await harness.client.waitForFlushes()
        #expect(await harness.sink.sentEventNames == ["a", "b"])
        await harness.tearDown()
    }
}
