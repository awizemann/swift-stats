import Foundation
@testable import Stats
import StatsTesting
import Testing

/// A sink that parks every `send` until the test answers it, so a test can
/// tear the client down while a request is "on the wire".
actor GatedSink: StatsSink {
    private var waiting: [CheckedContinuation<SinkOutcome, Never>] = []
    private var parkWaiters: [CheckedContinuation<Void, Never>] = []
    private(set) var sends = 0

    func send(_ batch: StatsBatch) async -> SinkOutcome {
        sends += 1
        return await withCheckedContinuation { continuation in
            waiting.append(continuation)
            let arrived = parkWaiters
            parkWaiters.removeAll()
            for waiter in arrived { waiter.resume() }
        }
    }

    var parked: Int { waiting.count }

    /// Suspends until a `send` is parked here — signalled by `send` itself,
    /// so the test awaits progress instead of spending a yield budget on it.
    func waitUntilParked() async {
        guard waiting.isEmpty else { return }
        await withCheckedContinuation { parkWaiters.append($0) }
    }

    func release(with outcome: SinkOutcome) {
        for continuation in waiting { continuation.resume(returning: outcome) }
        waiting.removeAll()
    }
}

/// `shutdown()` and `discardAll()` cancel pending work, but a request already
/// in `sink.send` cannot be recalled — and its answer used to be applied as if
/// nothing had happened: a `.retry` scheduled a backoff that fired after the
/// teardown, and left `retryNotBefore` set so a re-enabled client could not
/// flush until it expired.
///
/// No yield budgets: every wait here is on a signal (`waitUntilParked`, the
/// dispatcher's `shutdownStarted`) and every negative check reads dispatcher
/// state once the flush has finished.
@Suite("Teardown during an in-flight send", .timeLimit(.minutes(1)))
struct TeardownDuringSendTests {
    private struct Fixture {
        let appId: String
        let directory: URL
        let clock: ManualClock
        let sink: GatedSink
        let client: StatsClient

        init() {
            appId = "com.example.gated\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
            directory = URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("swift-stats-gated-\(UUID().uuidString)", isDirectory: true)
            clock = ManualClock()
            sink = GatedSink()
            var configuration = StatsConfiguration(
                appId: appId,
                installIdSalt: Harness.salt,
                sink: sink,
                flushAt: 10_000,
                flushInterval: .seconds(30),
                consent: [.usage, .diagnostics, .identity],
                storageDirectory: directory,
                clock: clock,
                uuidProvider: FixedUUIDProvider(Harness.defaultUUIDs),
                randomSource: FixedRandomSource()
            )
            var context = Harness.exampleContext
            context.bundleId = appId
            configuration.contextOverride = context
            client = StatsClient(configuration: configuration)
        }

        func tearDown() async {
            await sink.release(with: .accepted)
            await client.shutdown()
            clock.cancelAllSleepers()
            try? FileManager.default.removeItem(at: directory)
            UserDefaults().removePersistentDomain(forName: StatsIdentityStore.suiteName(appId: appId))
        }
    }

    @Test("A retry answered after shutdown() schedules nothing")
    func retryAfterShutdownIsIgnored() async {
        let fixture = Fixture()
        await fixture.client.track("a")
        let dispatcher = await fixture.client.dispatcher

        let flush = Task { await fixture.client.flush() }
        await fixture.sink.waitUntilParked()
        let shutdown = Task { await fixture.client.shutdown() }
        // Only once the dispatcher has cancelled its pending work is the
        // in-flight answer "late".
        await dispatcher.shutdownStarted.wait()

        await fixture.sink.release(with: .retry(after: nil))
        await shutdown.value
        await flush.value

        #expect(await dispatcher.isRetryScheduled == false, "no retry may outlive shutdown()")
        await fixture.tearDown()
    }

    @Test("A retry answered after a discard schedules nothing and leaves no backoff behind")
    func retryAfterDiscardIsIgnored() async {
        let fixture = Fixture()
        await fixture.client.track("a")
        let dispatcher = await fixture.client.dispatcher

        let flush = Task { await fixture.client.flush() }
        await fixture.sink.waitUntilParked()
        await fixture.client.setEnabled(false)
        await fixture.sink.release(with: .retry(after: nil))
        await flush.value

        #expect(await dispatcher.isRetryScheduled == false, "no retry for a batch that was discarded")

        // Re-enabled, the next flush goes out at once: no backoff window from
        // the discarded batch is still in force. (With one, this flush would
        // return without sending, and `waitUntilParked` would time out.)
        await fixture.client.setEnabled(true)
        await fixture.client.track("b")
        let second = Task { await fixture.client.flush() }
        await fixture.sink.waitUntilParked()
        await fixture.sink.release(with: .accepted)
        await second.value
        #expect(await fixture.sink.sends == 2)
        #expect(await fixture.client.queuedEventCount == 0)
        await fixture.tearDown()
    }
}
