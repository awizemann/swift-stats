import Foundation
@testable import Stats
import StatsTesting
import Testing

/// A sink that notices two requests being in flight at once.
///
/// The overlap detection has to survive a suspension inside `send`, which is
/// where a real HTTP request spends all its time and where the only interesting
/// interleavings happen — so the counter is incremented, then the sink yields
/// repeatedly, then it decrements. An `actor`, so the counter itself cannot race.
actor OverlapDetectingSink: StatsSink {
    private var inFlight = 0
    /// The high-water mark. §7 allows exactly one, so anything above 1 is a bug.
    private(set) var maxInFlight = 0
    private(set) var sends = 0
    /// Every `batchId` handed to `send`, in order.
    private(set) var batchIds: [String] = []

    /// How many times `send` yields while "in flight". Enough that a forked
    /// second flush would be scheduled and enter `send` before the first returns.
    private let yields: Int

    init(yields: Int = 32) {
        self.yields = yields
    }

    func send(_ batch: StatsBatch) async -> SinkOutcome {
        inFlight += 1
        sends += 1
        maxInFlight = max(maxInFlight, inFlight)
        batchIds.append(batch.batchId)
        for _ in 0..<yields { await Task.yield() }
        inFlight -= 1
        return .accepted
    }
}

/// §7: "At most **one request in flight** per client."
///
/// The dispatcher gets this by chaining each flush onto the previous one's
/// `Task` rather than forking. That is one line, it is easy to "simplify" into a
/// `Task { }` with a busy flag, and nothing else in the suite would have noticed:
/// every other dispatch test drives one trigger at a time, and a forked flush
/// still delivers every event, just with two requests on the wire.
@Suite("Concurrency: one request in flight")
struct ConcurrencyTests {
    private static func makeClient(
        appId: String, directory: URL, sink: any StatsSink, clock: ManualClock, flushAt: Int
    ) -> StatsClient {
        var configuration = StatsConfiguration(
            appId: appId,
            installIdSalt: "test-salt",
            sink: sink,
            flushAt: flushAt,
            flushInterval: .seconds(30),
            consent: [.usage, .diagnostics, .identity],
            storageDirectory: directory,
            clock: clock,
            uuidProvider: FixedUUIDProvider(
                (1...512).map { UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", $0))! }
            ),
            randomSource: FixedRandomSource()
        )
        var context = Harness.exampleContext
        context.bundleId = appId
        configuration.contextOverride = context
        return StatsClient(configuration: configuration)
    }

    /// Two `flush()` calls fired concurrently, over a queue deep enough to need
    /// several batches, so the two flushes have real work to overlap on. This is
    /// the case a consumer hits by calling `flush()` from two places at once; the
    /// harder one is below.
    @Test("Two concurrent flush() calls never put two requests on the wire")
    func concurrentFlushesSerialize() async {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("swift-stats-overlap-\(UUID().uuidString)", isDirectory: true)
        let appId = "com.example.overlap\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
        defer {
            try? FileManager.default.removeItem(at: directory)
            UserDefaults().removePersistentDomain(forName: StatsIdentityStore.suiteName(appId: appId))
        }

        let sink = OverlapDetectingSink()
        let clock = ManualClock()
        // flushAt above the queue depth, so nothing flushes until we say so and
        // the whole queue is present when the two flushes start.
        let client = Self.makeClient(
            appId: appId, directory: directory, sink: sink, clock: clock, flushAt: 10_000
        )

        // 250 events is three batches at §5's 100-event limit.
        for index in 0..<250 {
            await client.track("event_\(index)")
        }
        #expect(await client.queuedEventCount == 250)

        async let first: Void = client.flush()
        async let second: Void = client.flush()
        _ = await (first, second)
        await client.waitForFlushes()

        #expect(await sink.maxInFlight == 1, "§7 allows exactly one request in flight")
        #expect(await sink.sends >= 3, "250 events is at least three batches, so there was work to overlap")
        #expect(await client.queuedEventCount == 0)

        await client.shutdown()
        clock.cancelAllSleepers()
    }

    /// The other way two flushes get triggered at once: the count trigger firing
    /// off the back of concurrent `track()` calls while a consumer-initiated
    /// flush is already running. `enqueue` calls `startFlush()` without awaiting
    /// it, so this is the path where a fork would actually be invisible.
    @Test("The count trigger firing during a flush does not fork a second request")
    func countTriggerDuringFlushSerializes() async {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("swift-stats-overlap2-\(UUID().uuidString)", isDirectory: true)
        let appId = "com.example.overlap2\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
        defer {
            try? FileManager.default.removeItem(at: directory)
            UserDefaults().removePersistentDomain(forName: StatsIdentityStore.suiteName(appId: appId))
        }

        let sink = OverlapDetectingSink()
        let clock = ManualClock()
        // Every 5th event trips the count trigger, so tracking 60 events fires it
        // a dozen times while earlier flushes are still suspended in `send`.
        let client = Self.makeClient(
            appId: appId, directory: directory, sink: sink, clock: clock, flushAt: 5
        )

        await withTaskGroup(of: Void.self) { group in
            for index in 0..<60 {
                group.addTask { await client.track("event_\(index)") }
            }
        }
        await client.flush()
        await client.waitForFlushes()

        #expect(await sink.maxInFlight == 1, "§7 allows exactly one request in flight")
        #expect(await sink.sends >= 2, "the count trigger fired more than once")
        #expect(await client.queuedEventCount == 0)
        // §6: two concurrent sends of the same batch would show up as a repeated
        // batchId even if the overlap counter happened not to catch them.
        let ids = await sink.batchIds
        #expect(Set(ids).count == ids.count, "no batchId was sent twice")

        await client.shutdown()
        clock.cancelAllSleepers()
    }
}
