import Foundation

/// Everything a `StatsClient` needs, decided once at launch.
///
/// A value type with no hidden globals: two clients with two configurations can
/// coexist in one process (different suites, different queue files), which is
/// what makes the test suite able to run in parallel.
public struct StatsConfiguration: Sendable {
    /// The app's bundle identifier. Goes on the wire as each event's `appId`,
    /// and derives the UserDefaults suite name and the queue file path.
    public var appId: String

    /// Advisory tenant key (§2.4). The backend derives the authoritative value
    /// from the write key's scope; sending it is useful in local logs, and a
    /// mismatch with the key's scope is a permanent 400 — so leave it `nil`
    /// unless you are sure it matches.
    public var projectId: String?

    /// The per-app constant that salts the install-id hash (§9). Not a secret
    /// and provides no security on its own; its only job is to stop the same
    /// random UUID from being correlatable across two apps or backends.
    public var installIdSalt: String

    /// The transport. Sinks never throw; see `StatsSink`.
    public var sink: any StatsSink

    /// Flush when this many events are queued.
    public var flushAt: Int

    /// Flush when this much time has passed since the last flush and at least
    /// one event is queued.
    public var flushInterval: Duration

    /// Local queue cap; past it the **oldest** events are dropped (§5).
    public var maxQueued: Int

    /// Inactivity gap that starts a new session (§10). Default 30 minutes on
    /// macOS, 5 minutes on iOS and every other platform — a desktop app sits
    /// open and idle, a phone app is backgrounded constantly.
    public var sessionGap: Duration

    /// Master opt-out. `false` means no capture at all and a cleared queue,
    /// regardless of consent. Persisted, so it survives relaunch.
    public var enabled: Bool

    /// Initial consent, used only the first time this app runs (afterwards the
    /// persisted choice wins).
    ///
    /// Default `[.usage, .diagnostics]`: the package is **opt-out by default for
    /// an app**, because the app — not the package — is the thing with a privacy
    /// policy and a jurisdiction, and the end-user opt-out it must ship is
    /// `setEnabled(false)`. `.identity` is deliberately **not** in the default:
    /// granting it means a stable install id and a `userId`, which changes what
    /// the consumer has to disclose (§14), so it has to be asked for in code.
    ///
    /// Pass `.none` for collect-nothing-until-asked; with `.none` recorded,
    /// nothing at all is collected — no queue, no install id, no context.
    public var consent: StatsConsent

    /// Which of the four reserved auto-events to emit. Default none (§12).
    public var autoEvents: StatsAutoEvents

    /// Directory for the JSON-lines queue file. Default:
    /// `Application Support/<bundleId>/swift-stats/`.
    public var storageDirectory: URL?

    /// Real screen metrics, if the consumer wants them in the context. The core
    /// never imports AppKit or UIKit; see `StatsScreenMetrics`.
    public var screenMetrics: StatsScreenMetrics

    /// `light` / `dark`, if the consumer samples it. Omitted from the wire when
    /// `nil` (§3).
    public var colorScheme: String?

    /// The context's `isTestFlight` ("pre-release install"). Supplied by the
    /// consumer because the SDK cannot detect it without StoreKit — see
    /// `StatsEnvironment.isTestFlightFallback`. `nil` sends `false`.
    public var isPreRelease: Bool?

    /// Longest a batch may be retained before it is dropped and logged at
    /// `error` (§7's 24-hour retention ceiling).
    public var retentionCeiling: Duration

    /// Backoff cap per attempt (§7's 5 minutes).
    public var backoffCap: Duration

    /// Backoff base (§7's 1 second, doubling, full jitter).
    public var backoffBase: Duration

    // MARK: Seams

    public var clock: any StatsClock
    public var uuidProvider: any StatsUUIDProvider
    public var randomSource: any StatsRandomSource

    /// Overrides the app version/build/os/device sampling. Injected by this
    /// package's own tests so the encoding assertions do not depend on the
    /// machine running them; in production the values come from `Bundle` /
    /// `ProcessInfo` / `uname`.
    ///
    /// `package`, not `public`: it is a test seam, and a consumer that could set
    /// it could make every event claim an app version, OS and device the install
    /// is not running — which is a data-integrity hole, not a feature.
    package var contextOverride: StatsContext?

    /// The platform default inactivity gap (§10).
    public static var defaultSessionGap: Duration {
        #if os(macOS)
        .seconds(30 * 60)
        #else
        .seconds(5 * 60)
        #endif
    }

    public init(
        appId: String,
        projectId: String? = nil,
        installIdSalt: String,
        sink: any StatsSink,
        flushAt: Int = 20,
        flushInterval: Duration = .seconds(30),
        maxQueued: Int = 10_000,
        sessionGap: Duration = StatsConfiguration.defaultSessionGap,
        enabled: Bool = true,
        consent: StatsConsent = .default,
        autoEvents: StatsAutoEvents = .none,
        storageDirectory: URL? = nil,
        screenMetrics: StatsScreenMetrics = .headless,
        colorScheme: String? = nil,
        isPreRelease: Bool? = nil,
        retentionCeiling: Duration = .seconds(24 * 60 * 60),
        backoffCap: Duration = .seconds(5 * 60),
        backoffBase: Duration = .seconds(1),
        clock: any StatsClock = SystemStatsClock(),
        uuidProvider: any StatsUUIDProvider = SystemUUIDProvider(),
        randomSource: any StatsRandomSource = SystemRandomSource()
    ) {
        self.appId = appId
        self.projectId = projectId
        self.installIdSalt = installIdSalt
        self.sink = sink
        self.flushAt = max(1, flushAt)
        self.flushInterval = flushInterval
        self.maxQueued = max(1, maxQueued)
        self.sessionGap = sessionGap
        self.enabled = enabled
        self.consent = consent
        self.autoEvents = autoEvents
        self.storageDirectory = storageDirectory
        self.screenMetrics = screenMetrics
        self.colorScheme = colorScheme
        self.isPreRelease = isPreRelease
        self.retentionCeiling = retentionCeiling
        self.backoffCap = backoffCap
        self.backoffBase = backoffBase
        self.clock = clock
        self.uuidProvider = uuidProvider
        self.randomSource = randomSource
        self.contextOverride = nil
    }
}
