import Foundation
@testable import Stats
import StatsTesting

/// One isolated client per test: its own app id (hence its own UserDefaults
/// suite), its own queue file, its own manual clock and scripted sink.
///
/// Isolation is what lets the suite run in parallel and lets a test assert on
/// persisted state without another test's leftovers.
final class Harness: Sendable {
    let appId: String
    let directory: URL
    let clock: ManualClock
    let uuids: FixedUUIDProvider
    let random: FixedRandomSource
    let sink: InMemorySink
    let configuration: StatsConfiguration
    let client: StatsClient

    static let salt = "test-salt"

    /// A context with fixed values, so encoding assertions do not depend on the
    /// machine running the tests. Matches the schema §4 example.
    static let exampleContext = StatsContext(
        sdkVersion: "0.2.0",
        appVersion: "1.4.2",
        appBuild: "318",
        bundleId: "com.wizemann.Overwatch",
        osName: "macOS",
        osVersion: "15.4.1",
        deviceModel: "Mac15,3",
        arch: "arm64",
        locale: "en_US",
        region: "US",
        screenWidth: 1512,
        screenHeight: 982,
        screenScale: 2.0,
        isDebug: false,
        isTestFlight: false,
        colorScheme: "dark"
    )

    init(
        consent: StatsConsent = [.usage, .diagnostics, .identity],
        autoEvents: StatsAutoEvents = .none,
        flushAt: Int = 1_000,
        flushInterval: Duration = .seconds(30),
        maxQueued: Int = 10_000,
        sessionGap: Duration = .seconds(300),
        enabled: Bool = true,
        outcomes: [SinkOutcome] = [],
        defaultOutcome: SinkOutcome = .accepted,
        uuids: [UUID] = Harness.defaultUUIDs,
        appId: String = "com.example.t\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))",
        directory: URL? = nil,
        firstDigits: Int = 40_371_852,
        contextOverride: StatsContext? = Harness.exampleContext
    ) {
        self.appId = appId
        self.directory = directory ?? URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("swift-stats-tests-\(appId)", isDirectory: true)
        self.clock = ManualClock()
        self.uuids = FixedUUIDProvider(uuids)
        self.random = FixedRandomSource(firstDigits: firstDigits)
        self.sink = InMemorySink(outcomes: outcomes, defaultOutcome: defaultOutcome)
        var context = contextOverride
        context?.bundleId = appId
        var configuration = StatsConfiguration(
            appId: appId,
            projectId: "overwatch",
            installIdSalt: Harness.salt,
            sink: sink,
            flushAt: flushAt,
            flushInterval: flushInterval,
            maxQueued: maxQueued,
            sessionGap: sessionGap,
            enabled: enabled,
            consent: consent,
            autoEvents: autoEvents,
            storageDirectory: self.directory,
            clock: clock,
            uuidProvider: self.uuids,
            randomSource: random
        )
        // `package`, not part of the public init: see StatsConfiguration.
        configuration.contextOverride = context
        self.configuration = configuration
        self.client = StatsClient(configuration: configuration)
    }

    /// Distinct, stable UUIDs — a fresh install id and batch ids that a test can
    /// assert on.
    static let defaultUUIDs: [UUID] = (1...64).map { index in
        UUID(uuidString: String(format: "00000000-0000-4000-8000-%012d", index))!
    }

    /// A second client over the same app id and directory: "the app relaunched".
    /// The session-id digits are shifted, standing in for the fresh randomness a
    /// real relaunch gets: without it the two runs' first sessions would share an
    /// id, since the manual clock starts both in the same wall-clock second.
    func relaunched(
        consent: StatsConsent = [.usage, .diagnostics, .identity],
        contextOverride: StatsContext? = Harness.exampleContext
    ) -> Harness {
        Harness(
            consent: consent, appId: appId, directory: directory,
            firstDigits: 51_000_000, contextOverride: contextOverride
        )
    }

    /// Cancels scheduled work first, then releases anything still suspended on
    /// the manual clock, then removes both the queue file and the defaults suite.
    func tearDown() async {
        await client.shutdown()
        clock.cancelAllSleepers()
        try? FileManager.default.removeItem(at: directory)
        UserDefaults().removePersistentDomain(forName: StatsIdentityStore.suiteName(appId: appId))
    }

    /// Advances the clock in steps until the sink has received `count` batches.
    ///
    /// Stepping repeatedly (rather than advancing once) removes the only race a
    /// manual clock has: a sleeper that has not registered yet cannot be advanced
    /// past, and a later step catches it. Still no real waiting — the clock only
    /// moves because this moves it.
    @discardableResult
    func drive(untilBatches count: Int, step: Duration, maxSteps: Int = 200) async -> Bool {
        for _ in 0..<maxSteps {
            if await sink.batchCount >= count { return true }
            clock.advance(by: step)
            // Several yields per step: under a parallel test run the retry task
            // may not have been scheduled yet, and a single yield is not enough
            // to let it register its next sleep.
            for _ in 0..<8 { await Task.yield() }
        }
        return await sink.batchCount >= count
    }

    /// Yields until `condition` holds. Polls with `Task.yield()` and never
    /// sleeps, so it cannot be a source of flakiness by timing — only by a real
    /// failure to make progress, which surfaces as a returned `false`.
    @discardableResult
    func yieldUntil(_ condition: @Sendable () async -> Bool, maxYields: Int = 10_000) async -> Bool {
        for _ in 0..<maxYields {
            if await condition() { return true }
            await Task.yield()
        }
        return false
    }
}
