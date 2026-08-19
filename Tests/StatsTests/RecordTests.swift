import Foundation
@testable import Stats
import StatsTesting
import Testing

/// `record()` — the non-suspending capture path — plus the two invariants it
/// shares with `track()`: arrival order, and a `seq` that is strictly
/// increasing (§2.2) even though it is now cached in the actor.
@Suite("record(): ordering, seq and revocation")
struct RecordTests {
    /// The headline ordering guarantee. 500 `record()` calls from one task must
    /// reach disk in call order, with `seq` ascending and no repeats.
    @Test("500 record() calls keep their call order and get ascending seq")
    func recordKeepsOrder() async {
        let harness = Harness()
        for index in 0..<500 {
            harness.client.record("event_\(index)")
        }
        await harness.client.drainRecorded()
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let events = await harness.sink.sentEvents
        #expect(events.count == 500)
        #expect(events.map(\.name) == (0..<500).map { "event_\($0)" })
        #expect(events.map(\.seq) == Array(0..<500))
        await harness.tearDown()
    }

    /// The batching the pump does, from the outside.
    ///
    /// `pumpRecorded` used to call `capture()` per entry, and `capture()` ended
    /// in `drainPending()` — so a burst of 1 000 `record()` calls cost 1 000
    /// `Task`s and 1 000 single-record appends to the queue file. It now buffers
    /// the whole batch and drains once, and the properties that had to survive
    /// that change are the ones asserted here: call order, one `seq` per event
    /// with no gaps or repeats, and every event on disk.
    ///
    /// The append *count* itself is not asserted: the store's appends are not
    /// observable from a `StatsClient` without adding a counter to its public
    /// surface, and the file a batched append produces is byte-identical to the
    /// one 1 000 separate appends produce. Order and `seq` are what a
    /// regression would break.
    @Test("A burst of 1 000 record() calls keeps its order through one drained batch")
    func recordBurstIsBatched() async {
        let harness = Harness(flushAt: 100_000)
        for index in 0..<1_000 {
            harness.client.record("event_\(index)")
        }
        await harness.client.drainRecorded()

        #expect(await harness.client.queuedEventCount == 1_000)
        await harness.client.flush()
        await harness.client.waitForFlushes()
        let events = await harness.sink.sentEvents
        #expect(events.map(\.name) == (0..<1_000).map { "event_\($0)" })
        #expect(events.map(\.seq) == Array(0..<1_000))
        await harness.tearDown()
    }

    /// The mixed case: a caller that interleaves the two calls sees one order —
    /// its own. `track()` drains what `record()` handed over before it captures.
    @Test("Interleaved record() and track() keep the caller's order")
    func interleavedOrder() async {
        let harness = Harness()
        var expected: [String] = []
        for index in 0..<40 {
            if index.isMultiple(of: 2) {
                harness.client.record("event_\(index)")
            } else {
                await harness.client.track("event_\(index)")
            }
            expected.append("event_\(index)")
        }
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let events = await harness.sink.sentEvents
        #expect(events.map(\.name) == expected)
        #expect(events.map(\.seq) == Array(0..<40))
        await harness.tearDown()
    }

    /// A `record()` that arrives before anything has prepared the actor is
    /// fine: the pump runs on the actor, which prepares on the way in.
    @Test("record() before any other call still captures")
    func recordBeforePrepare() async {
        let harness = Harness()
        harness.client.record("first")
        await harness.client.flush()
        await harness.client.waitForFlushes()
        #expect(await harness.sink.sentEvents.map(\.name) == ["first"])
        await harness.tearDown()
    }

    /// After `shutdown()` the drainer is gone and must not be resurrected.
    @Test("record() after shutdown() is dropped, not queued")
    func recordAfterShutdown() async {
        let harness = Harness()
        await harness.client.shutdown()
        harness.client.record("late")
        await harness.client.drainRecorded()
        #expect(await harness.client.queuedEventCount == 0)
        harness.clock.cancelAllSleepers()
        try? FileManager.default.removeItem(at: harness.directory)
        UserDefaults().removePersistentDomain(forName: StatsIdentityStore.suiteName(appId: harness.appId))
    }

    /// `seq` is cached in the actor now, so the thing that must still hold is
    /// the §2.2 invariant: what is on disk was persisted **before** the records
    /// were handed on, so a crash can leave a gap but never a repeat.
    @Test("seq is persisted before the records reach the dispatcher")
    func seqPersistedBeforeHandoff() async {
        let harness = Harness()
        for index in 0..<5 {
            await harness.client.track("event_\(index)")
        }
        let suite = UserDefaults(suiteName: StatsIdentityStore.suiteName(appId: harness.appId))
        #expect(suite?.integer(forKey: "seq") == 5, "the next seq was persisted before the hand-off")

        await harness.client.flush()
        await harness.client.waitForFlushes()
        await harness.client.shutdown()
        harness.clock.cancelAllSleepers()

        // "The process died and came back": the next install must not reissue a
        // number the first one already used.
        let relaunched = harness.relaunched()
        await relaunched.client.track("after")
        await relaunched.client.flush()
        await relaunched.client.waitForFlushes()
        #expect(await relaunched.sink.sentEvents.first?.seq == 5)
        await relaunched.tearDown()
    }

    /// The race this closes: a drain that has already copied its records and is
    /// suspended inside `dispatcher.enqueue(...)` when `setEnabled(false)` runs
    /// its teardown, so `discardAll()` lands *before* the append. The events
    /// would end up on disk under a revoked identity, and nothing would ever
    /// remove them.
    ///
    /// Driven deterministically: a burst of concurrent `track()` calls keeps
    /// several drains in flight at once — the store actor is the suspension they
    /// queue behind — and the revoking task yields a different number of times
    /// before it revokes, walking the teardown across the scheduling points the
    /// capture path has. No sleeping, no wall-clock timing.
    @Test("A revocation racing in-flight drains leaves nothing on disk", arguments: [0, 1, 2, 3, 5, 8, 13, 21])
    func revocationRacingDrainLeavesNothing(yields: Int) async {
        // flushAt above anything tracked here, so the queue is only ever
        // emptied by the revocation — never by a send.
        let harness = Harness(flushAt: 100_000)
        let burst = Task {
            await withTaskGroup(of: Void.self) { group in
                for index in 0..<200 {
                    group.addTask { await harness.client.track("event_\(index)") }
                }
            }
        }
        for _ in 0..<yields { await Task.yield() }
        await harness.client.setEnabled(false)
        await burst.value

        #expect(
            await harness.client.queuedEventCount == 0,
            "an event survived the opt-out at yields=\(yields)"
        )
        #expect(await harness.sink.batchCount == 0)
        await harness.tearDown()
    }

    /// Same shape for a consent revocation, which additionally deletes the
    /// install identity — an event landing after it would carry an id the
    /// person has withdrawn.
    @Test("A consent revocation racing in-flight drains leaves nothing on disk", arguments: [0, 1, 2, 3, 5, 8, 13, 21])
    func consentRevocationRacingDrain(yields: Int) async {
        let harness = Harness(flushAt: 100_000)
        let burst = Task {
            await withTaskGroup(of: Void.self) { group in
                for index in 0..<200 {
                    group.addTask { await harness.client.track("event_\(index)") }
                }
            }
        }
        for _ in 0..<yields { await Task.yield() }
        await harness.client.setConsent(.none)
        await burst.value

        #expect(
            await harness.client.queuedEventCount == 0,
            "an event survived the revocation at yields=\(yields)"
        )
        await harness.tearDown()
    }

    /// The `maxRecordedBuffer` cap, driven small so it can actually be
    /// overflowed by a modest burst.
    ///
    /// What is *not* assumed here: that the pump `Task` cannot run until the
    /// calling loop finishes. It can — Swift's cooperative pool has more than
    /// one thread, so a `record()` burst issued with no `await` between calls
    /// can still race a pump that started draining the buffer on another
    /// thread. That means the split between "buffered", "dropped" and
    /// "already drained to disk" for any given call in the burst is not
    /// deterministic.
    ///
    /// What *is* deterministic, because `record()`'s buffer only ever grows
    /// under the lock when it is under `maxRecordedBuffer` and the mutex makes
    /// accept-or-drop atomic per call: every one of the `N` calls is either
    /// accepted (and eventually reaches disk, since nothing here revokes
    /// consent or shuts the client down) or dropped, never both and never
    /// neither. So after everything drains, `queuedEventCount + dropped == N`
    /// always holds, the buffer never holds more than the cap at any instant,
    /// and the on-disk cap independently never trips (it is far larger than 5).
    @Test("record() drops the newest past a small maxRecordedBuffer; accepted + dropped always equals the burst size")
    func recordCapOverflowsDeterministically() async {
        let harness = Harness()
        let client = StatsClient(configuration: harness.configuration, maxRecordedBuffer: 5)

        for index in 0..<20 {
            client.record("event_\(index)")
        }

        // However the race landed, the buffer itself never exceeded the cap.
        #expect(client.recordedDiagnostics.buffered <= 5)

        await client.drainRecorded()
        let dropped = client.recordedDiagnostics.dropped
        let delivered = await client.queuedEventCount
        #expect(delivered + dropped == 20, "every record() call is accounted for as accepted or dropped, never both")
        #expect(client.recordedDiagnostics.buffered == 0, "the drain emptied the buffer")
        let storeDiagnostics = await client.storeDiagnostics
        #expect(storeDiagnostics.dropped == 0, "nothing was dropped by the on-disk cap — it is far above 20")

        await client.shutdown()
        await harness.tearDown()
    }

    /// The batching payoff, made observable: `EventStore.append(_:)` is called
    /// once per *drained batch*, not once per `record()`. A burst of 1 000
    /// synchronous calls should cost a handful of `append()` invocations, far
    /// below the 1 000 it would cost without the buffering `StatsClient` does
    /// upstream — and every event must still land, in order.
    @Test("A 1 000 record() burst reaches disk in far fewer than 1 000 append() calls, in order")
    func recordBurstBatchesAppends() async {
        let harness = Harness(flushAt: 100_000)
        for index in 0..<1_000 {
            harness.client.record("event_\(index)")
        }
        await harness.client.drainRecorded()

        #expect(await harness.client.queuedEventCount == 1_000)
        let diagnostics = await harness.client.storeDiagnostics
        #expect(diagnostics.appends < 50, "expected batched appends, got \(diagnostics.appends)")

        await harness.client.flush()
        await harness.client.waitForFlushes()
        let events = await harness.sink.sentEvents
        #expect(events.map(\.name) == (0..<1_000).map { "event_\($0)" })
        #expect(events.map(\.seq) == Array(0..<1_000))
        await harness.tearDown()
    }

    /// The revocation teardown has to reach the `record()` buffer too: entries
    /// accepted but not yet drained were captured under the identity being
    /// revoked, and a pump that resumes afterwards must not put them on disk.
    @Test("An opt-out drops record()ed events that had not been drained yet", arguments: [0, 1, 2, 3, 5, 8])
    func optOutDropsBufferedRecords(yields: Int) async {
        let harness = Harness(flushAt: 100_000)
        for index in 0..<200 {
            harness.client.record("event_\(index)")
        }
        for _ in 0..<yields { await Task.yield() }
        await harness.client.setEnabled(false)
        await harness.client.drainRecorded()

        #expect(
            await harness.client.queuedEventCount == 0,
            "a buffered record() survived the opt-out at yields=\(yields)"
        )
        #expect(await harness.sink.batchCount == 0)
        await harness.tearDown()
    }
}
