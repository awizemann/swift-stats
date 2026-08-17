import Foundation
@testable import Stats
import StatsTesting
import Testing

/// Schema §5, §6 and §7 as the client sees them: when a flush happens, how a
/// batch is split, and what each outcome does.
@Suite("Dispatch, retry and persistence")
struct DispatchTests {
    @Test("Nothing is sent before the count threshold, and everything at it")
    func countTrigger() async {
        let harness = Harness(flushAt: 3)
        await harness.client.track("a")
        await harness.client.track("b")
        await harness.client.waitForFlushes()
        #expect(await harness.sink.batchCount == 0, "two events must not trigger a flush at flushAt: 3")

        await harness.client.track("c")
        await harness.client.waitForFlushes()
        #expect(await harness.sink.batchCount == 1)
        #expect(await harness.sink.sentEventNames == ["a", "b", "c"])
        #expect(await harness.client.queuedEventCount == 0)
        await harness.tearDown()
    }

    /// Discriminating on the interval trigger existing at all: with a high
    /// `flushAt` the only thing that can send this event is the elapsed
    /// interval, and the clock only moves because the test moves it.
    @Test("The interval trigger flushes a queue that never reaches flushAt")
    func intervalTrigger() async {
        let harness = Harness(flushAt: 100, flushInterval: .seconds(30))
        await harness.client.track("a")
        #expect(await harness.sink.batchCount == 0)

        #expect(await harness.clock.waitForSleepers(count: 1), "the interval timer must be scheduled")
        harness.clock.advance(by: .seconds(30))
        #expect(await harness.yieldUntil { await harness.sink.batchCount == 1 })
        #expect(await harness.sink.sentEventNames == ["a"])
        await harness.tearDown()
    }

    @Test("Backgrounding flushes whatever is queued")
    func backgroundTrigger() async {
        let harness = Harness(flushAt: 100)
        await harness.client.track("a")
        await harness.client.track("b")
        await harness.client.applicationDidEnterBackground()
        await harness.client.waitForFlushes()

        #expect(await harness.sink.batchCount == 1)
        #expect(await harness.client.queuedEventCount == 0)
        await harness.tearDown()
    }

    @Test("A batch never carries more than 100 events")
    func splitsByCount() async {
        let harness = Harness(flushAt: 10_000)
        for index in 0..<250 {
            await harness.client.track("event_\(index % 7)")
        }
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let batches = await harness.sink.batches
        #expect(batches.count == 3)
        #expect(batches.map(\.events.count) == [100, 100, 50])
        #expect(await harness.sink.sentEvents.count == 250)
        // Every batch gets its own id (§6), and each is uppercase.
        #expect(Set(batches.map(\.batchId)).count == 3)
        #expect(batches.allSatisfy { $0.batchId == $0.batchId.uppercased() })
        // seq is ascending across the whole run.
        #expect(await harness.sink.sentEvents.map(\.seq) == Array(0..<250))
        await harness.tearDown()
    }

    /// Discriminating on §5's "split by the byte limit *before* the count limit":
    /// these events are large enough that 100 of them blow past 256 KiB, so a
    /// count-only split would produce an over-limit batch.
    @Test("A batch never exceeds 256 KiB, even under the 100-event limit")
    func splitsByBytes() async {
        let harness = Harness(flushAt: 10_000)
        var props: [String: StatsValue] = [:]
        for index in 0..<32 {
            props[String(format: "k%02d", index)] = .string(String(repeating: "x", count: 200))
        }
        for _ in 0..<120 {
            await harness.client.track("fat_event", props: props)
        }
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let batches = await harness.sink.batches
        #expect(batches.count > 1, "these events cannot fit in one batch")
        for batch in batches {
            let size = try? batch.serialized().count
            #expect((size ?? .max) <= 262_144)
            #expect(batch.events.count <= 100)
        }
        #expect(await harness.sink.sentEvents.count == 120, "no event may be lost to splitting")
        await harness.tearDown()
    }

    @Test("A retry keeps the batch, backs off from 1 s doubling, and reuses the batchId")
    func retryBackoffAndIdempotency() async {
        let harness = Harness(
            flushAt: 10_000,
            outcomes: [.retry(after: nil), .retry(after: nil), .accepted]
        )
        await harness.client.track("a")

        await harness.client.flush()
        await harness.client.waitForFlushes()
        #expect(await harness.client.queuedEventCount == 1, "a retry retains the batch")

        // A flush during the backoff window must be a no-op: §7's wait is not a
        // suggestion, and re-sending the same failing batch immediately is what
        // turns a backend outage into a client-driven flood.
        await harness.client.flush()
        await harness.client.waitForFlushes()
        #expect(await harness.sink.batchCount == 1, "no send during the backoff window")

        // Attempt 2, driven by the scheduled retry.
        #expect(await harness.drive(untilBatches: 2, step: .seconds(1)))
        #expect(await harness.client.queuedEventCount == 1)

        // Attempt 3 succeeds.
        #expect(await harness.drive(untilBatches: 3, step: .seconds(2)))
        #expect(await harness.yieldUntil { await harness.client.queuedEventCount == 0 },
                "acceptance deletes the batch")

        let batches = await harness.sink.batches
        #expect(batches.count == 3)
        #expect(Set(batches.map(\.batchId)).count == 1, "§6: a retried batch reuses its batchId")
        #expect(batches.allSatisfy { $0.events.count == 1 })

        // Full jitter with a fraction of 1.0 makes the schedule its ceiling:
        // 1 s then 2 s. (The 30 s entries are the interval timer.)
        let backoffs = harness.clock.requestedSleeps.filter { $0 != .seconds(30) }
        #expect(backoffs == [.seconds(1), .seconds(2)])
        await harness.tearDown()
    }

    @Test("A 429's Retry-After is honored verbatim instead of the backoff schedule")
    func retryAfterHonored() async {
        let harness = Harness(flushAt: 10_000, outcomes: [.retry(after: .seconds(7))])
        await harness.client.track("a")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        #expect(harness.clock.requestedSleeps.contains(.seconds(7)))
        #expect(await harness.client.queuedEventCount == 1)
        await harness.tearDown()
    }

    /// Discriminating: 30 minutes is longer than `backoffCap` (5 minutes) and
    /// shorter than `retentionCeiling` (24 hours). The old clamp to `backoffCap`
    /// turned it into 300 s, so a backend shedding load got hammered every five
    /// minutes by exactly the clients it had asked to stay away. §7 caps the
    /// *schedule* at 5 minutes; a server's explicit instruction is honored up to
    /// the batch's retention ceiling.
    @Test("A server Retry-After past the backoff cap is honored up to the retention ceiling")
    func retryAfterHonoredPastBackoffCap() async {
        let harness = Harness(flushAt: 10_000, outcomes: [.retry(after: .seconds(1_800))])
        await harness.client.track("a")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        #expect(harness.clock.requestedSleeps.contains(.seconds(1_800)))
        #expect(
            !harness.clock.requestedSleeps.contains(.seconds(300)),
            "the hint must not be truncated to the backoff cap"
        )
        #expect(await harness.client.queuedEventCount == 1)
        await harness.tearDown()
    }

    /// The floor and the ceiling that do remain. A hint of zero is a request
    /// loop, not a wait, so it is floored at `backoffBase`; a hint past the
    /// retention ceiling could only park the batch until it expired unattempted.
    @Test("A Retry-After is floored at the backoff base and ceilinged at the retention ceiling", arguments: [
        (Duration.seconds(0), Duration.seconds(1)),
        (Duration.milliseconds(1), Duration.seconds(1)),
        (Duration.seconds(48 * 60 * 60), Duration.seconds(24 * 60 * 60))
    ])
    func retryAfterClamps(hint: Duration, expected: Duration) async {
        let harness = Harness(flushAt: 10_000, outcomes: [.retry(after: hint)])
        await harness.client.track("a")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        // The interval timer also sleeps (30 s); the retry is the other one.
        let backoffs = harness.clock.requestedSleeps.filter { $0 != .seconds(30) }
        #expect(backoffs.contains(expected), "hint \(hint) should schedule \(expected)")
        await harness.tearDown()
    }

    @Test("Backoff is capped, so a long outage does not schedule an hour-long wait")
    func backoffCap() async {
        let harness = Harness(
            flushAt: 10_000,
            outcomes: Array(repeating: .retry(after: nil), count: 12)
        )
        await harness.client.track("a")
        await harness.client.flush()
        await harness.client.waitForFlushes()
        for attempt in 1..<12 {
            #expect(await harness.drive(untilBatches: attempt + 1, step: .seconds(60)))
        }
        let backoffs = harness.clock.requestedSleeps.filter { $0 != .seconds(30) }
        #expect(backoffs.count >= 11)
        #expect(backoffs.allSatisfy { $0 <= .seconds(300) }, "§7 caps a single wait at 5 minutes")
        // 1, 2, 4, 8… doubling until the 5-minute ceiling, then flat.
        #expect(backoffs.prefix(4) == [.seconds(1), .seconds(2), .seconds(4), .seconds(8)])
        #expect(backoffs.last == .seconds(300))
        await harness.tearDown()
    }

    /// §7's 413 row: re-split into smaller batches with **new** batch ids, rather
    /// than retrying a body the backend will never accept.
    @Test("A 413 re-splits the batch under new batch ids")
    func tooLargeResplits() async {
        let harness = Harness(flushAt: 10_000, outcomes: [.tooLarge])
        for index in 0..<8 {
            await harness.client.track("e\(index)")
        }
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let batches = await harness.sink.batches
        #expect(batches.first?.events.count == 8)
        #expect(batches.dropFirst().allSatisfy { $0.events.count <= 4 }, "the batch is halved")
        #expect(await harness.sink.sentEvents.count == 8 + 8, "every event still ships after the split")
        #expect(await harness.client.queuedEventCount == 0)
        // §6: a re-split batch is a new batch, so it must not reuse the id.
        #expect(Set(batches.map(\.batchId)).count == batches.count)
        await harness.tearDown()
    }

    @Test("A single event a backend calls too large is dropped, not retried forever")
    func tooLargeSingleEventDropped() async {
        let harness = Harness(flushAt: 10_000, outcomes: [.tooLarge, .tooLarge, .tooLarge])
        await harness.client.track("only")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        #expect(await harness.client.queuedEventCount == 0)
        #expect(await harness.sink.batchCount == 1)
        await harness.tearDown()
    }

    @Test("A drop outcome deletes the batch and never retries it")
    func dropDeletes() async {
        let harness = Harness(flushAt: 10_000, outcomes: [.drop(reason: "400 bad_schema")])
        await harness.client.track("a")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        #expect(await harness.client.queuedEventCount == 0)
        #expect(await harness.sink.batchCount == 1)

        // A second flush has nothing to send: the batch is gone, not retained.
        await harness.client.flush()
        await harness.client.waitForFlushes()
        #expect(await harness.sink.batchCount == 1)
        await harness.tearDown()
    }

    @Test("Events past the retention ceiling are dropped rather than retried forever")
    func retentionCeiling() async {
        let harness = Harness(flushAt: 10_000, outcomes: [.retry(after: nil)])
        await harness.client.track("a")
        await harness.client.flush()
        await harness.client.waitForFlushes()
        #expect(await harness.client.queuedEventCount == 1)

        // 24 h of failed attempts later, the batch is past §7's ceiling. The
        // ceiling is measured on the monotonic clock from the first failed
        // attempt, not from the event's `ts`, so an offline device is not
        // punished for having been offline before it ever tried.
        harness.clock.advance(by: .seconds(24 * 60 * 60 + 1))
        await harness.client.flush()
        await harness.client.waitForFlushes()
        #expect(await harness.client.queuedEventCount == 0)
        #expect(await harness.sink.batchCount == 1, "the expired batch is dropped, not sent again")
        await harness.tearDown()
    }

    @Test("Queued events survive a relaunch and are sent by the new client")
    func persistenceAcrossRestart() async {
        let first = Harness(flushAt: 10_000)
        await first.client.track("a")
        await first.client.track("b")
        #expect(await first.sink.batchCount == 0)
        await first.client.shutdown()
        first.clock.cancelAllSleepers()

        // The relaunch is a *new version* of the app: §1 forbids re-stamping a
        // queued batch with a newer context, so the events must still report the
        // version that produced them. This is what makes the test discriminating
        // — with one shared context override it would pass either way.
        var newerContext = Harness.exampleContext
        newerContext.appVersion = "2.0.0"
        newerContext.appBuild = "999"
        let second = first.relaunched(contextOverride: newerContext)

        #expect(await second.client.queuedEventCount == 2, "the queue is loaded from disk")
        await second.client.flush()
        await second.client.waitForFlushes()
        #expect(await second.sink.sentEventNames == ["a", "b"])
        #expect(await second.sink.batches.first?.context.appVersion == "1.4.2")
        #expect(await second.sink.batches.first?.context.appBuild == "318")
        await second.tearDown()
    }

    @Test("Past the queue cap the oldest events are dropped, the newest kept")
    func capDropsOldest() async {
        let harness = Harness(flushAt: 10_000, maxQueued: 3)
        for index in 0..<5 {
            await harness.client.track("e\(index)")
        }
        #expect(await harness.client.queuedEventCount == 3)

        await harness.client.flush()
        await harness.client.waitForFlushes()
        #expect(await harness.sink.sentEventNames == ["e2", "e3", "e4"])
        await harness.tearDown()
    }

    @Test("The cap survives a relaunch: an over-cap file is trimmed on load")
    func capAppliedOnLoad() async {
        let first = Harness(flushAt: 10_000, maxQueued: 10)
        for index in 0..<8 {
            await first.client.track("e\(index)")
        }
        await first.client.shutdown()
        first.clock.cancelAllSleepers()

        let second = Harness(flushAt: 10_000, maxQueued: 3, appId: first.appId, directory: first.directory)
        #expect(await second.client.queuedEventCount == 3)
        await second.client.flush()
        await second.client.waitForFlushes()
        #expect(await second.sink.sentEventNames == ["e5", "e6", "e7"])
        await second.tearDown()
    }

    /// One event that alone exceeds 256 KiB cannot be split, so §5 says drop it.
    /// Unreachable through `track()` — 32 props × 200 scalars is ~7 KB — so the
    /// store and dispatcher are driven directly.
    @Test("A single event over the byte limit is dropped instead of blocking the queue")
    func oversizedSingleEventDropped() async throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("swift-stats-oversized-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("queue.jsonl")
        let store = EventStore(fileURL: { url }, maxQueued: 100)
        let sink = InMemorySink()
        let clock = ManualClock()
        let configuration = StatsConfiguration(
            appId: "com.example.oversized", installIdSalt: "s", sink: sink,
            clock: clock, uuidProvider: FixedUUIDProvider(Harness.defaultUUIDs),
            randomSource: FixedRandomSource()
        )
        let dispatcher = Dispatcher(store: store, configuration: configuration)

        func event(named name: String, props: [String: StatsValue]) -> EventStore.Record {
            EventStore.Record(
                event: StatsEvent(
                    name: name, ts: clock.wallNow(), sessionId: "1786012978-40371852",
                    installId: "a", appId: "com.example.oversized", seq: 0, props: props
                ),
                context: Harness.exampleContext
            )
        }
        let huge = event(named: "huge", props: ["blob": .string(String(repeating: "x", count: 300_000))])
        await dispatcher.enqueue([huge, event(named: "small", props: [:])])
        await dispatcher.flushNow()
        await dispatcher.waitForFlushes()

        #expect(await sink.sentEventNames == ["small"], "the oversized event is dropped, the next one still ships")
        #expect(await store.count == 0)
        await dispatcher.shutdown()
        clock.cancelAllSleepers()
    }

    /// Discriminating on §1: a batch MUST NOT contain events for more than one
    /// `(appId, installId)` pair. With `identity` denied every session gets a
    /// fresh ephemeral install id while the context bytes stay identical, so a
    /// dispatcher that split on context alone would build a mixed batch — which a
    /// conforming backend answers with 400, permanently dropping it.
    @Test("A batch never mixes two install ids")
    func oneInstallIdPerBatch() async {
        let harness = Harness(
            consent: [.usage, .diagnostics], flushAt: 10_000, sessionGap: .seconds(300)
        )
        await harness.client.track("a")
        harness.clock.advance(by: .seconds(400))
        await harness.client.track("b")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let batches = await harness.sink.batches
        #expect(await harness.sink.sentEventNames == ["a", "b"])
        for batch in batches {
            #expect(Set(batch.events.map(\.installId)).count == 1)
            #expect(Set(batch.events.map(\.appId)).count == 1)
            #expect(batch.events.allSatisfy { $0.appId == batch.context.bundleId },
                    "§3: bundleId must equal every event's appId")
        }
        await harness.tearDown()
    }

    @Test("Events of one session go out as a single batch")
    func oneBatchPerSession() async {
        let harness = Harness(flushAt: 10_000)
        await harness.client.track("a")
        await harness.client.track("b")
        await harness.client.flush()
        await harness.client.waitForFlushes()

        let batches = await harness.sink.batches
        #expect(batches.count == 1)
        #expect(batches.first?.events.count == 2)
        #expect(Set(batches[0].events.map(\.sessionId)).count == 1)
        await harness.tearDown()
    }
}
