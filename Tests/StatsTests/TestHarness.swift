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

    /// `sdkDefaultConsent: true` ignores `consent` and leaves
    /// `StatsConfiguration.consent` at the SDK's own default — what an app gets
    /// when its configuration never mentions consent. (A separate flag rather
    /// than an optional `consent`, because `.none` would then mean `nil`.)
    init(
        consent: StatsConsent = [.usage, .diagnostics, .identity],
        sdkDefaultConsent: Bool = false,
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
            autoEvents: autoEvents,
            storageDirectory: self.directory,
            clock: clock,
            uuidProvider: self.uuids,
            randomSource: random
        )
        if !sdkDefaultConsent { configuration.consent = consent }
        // The suite lives in a per-app-id temporary directory, never in
        // `~/Library/Preferences` (see `IsolatedDefaults`). Same app id, same
        // directory: a relaunched harness reopens the same suite. Swept at
        // process exit if a test never reaches `tearDown()`.
        configuration.identitySuiteDirectory = IsolatedDefaults.directory(appId: appId)
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

    /// A UUID sequence disjoint from ``defaultUUIDs``.
    static let relaunchUUIDs: [UUID] = (1...64).map { index in
        UUID(uuidString: String(format: "00000000-0000-4000-9000-%012d", index))!
    }

    /// A second client over the same app id and directory: "the app relaunched".
    /// The session-id digits are shifted, standing in for the fresh randomness a
    /// real relaunch gets: without it the two runs' first sessions would share an
    /// id, since the manual clock starts both in the same wall-clock second.
    ///
    /// Pass `uuids` (e.g. ``relaunchUUIDs``) when the test compares install ids
    /// across the relaunch: with the same fixed sequence, a per-session id
    /// minted after the relaunch would equal the one minted before it.
    func relaunched(
        consent: StatsConsent = [.usage, .diagnostics, .identity],
        sdkDefaultConsent: Bool = false,
        uuids: [UUID] = Harness.defaultUUIDs,
        contextOverride: StatsContext? = Harness.exampleContext
    ) -> Harness {
        Harness(
            consent: consent, sdkDefaultConsent: sdkDefaultConsent, uuids: uuids,
            appId: appId, directory: directory,
            firstDigits: 51_000_000, contextOverride: contextOverride
        )
    }

    /// Cancels scheduled work first, then releases anything still suspended on
    /// the manual clock, then removes both the queue file and the defaults suite
    /// (its whole directory — see `IsolatedDefaults`).
    func tearDown() async {
        await client.shutdown()
        clock.cancelAllSleepers()
        try? FileManager.default.removeItem(at: directory)
        IsolatedDefaults.remove(appId: appId)
    }

    // No `drive(untilBatches:)` / `yieldUntil` any more: both spent a fixed
    // yield budget waiting for progress, which a loaded parallel run could
    // exhaust before a retry task had even registered its sleep. Await the
    // progress itself instead — `ManualClock.waitForSleepers(count:)` and
    // `InMemorySink.waitForBatches(_:)` are signalled by the event.
}

extension IsolatedDefaults {
    /// The created, tracked suite directory for `appId`; idempotent.
    static func directory(appId: String) -> URL { directory(named: appId) }

    /// Removes the suite directory for `appId` (it need not exist).
    static func remove(appId: String) { remove(path(named: appId)) }
}
