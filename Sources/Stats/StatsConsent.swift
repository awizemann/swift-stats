import Foundation

/// The three independently togglable consent groups of schema §11.
///
/// The SDK's default is `[.usage, .diagnostics, .identity]`: **per-install by
/// default, per-user only when the app asks**. Each install gets a stable,
/// salted, random install id that persists across sessions and launches, and
/// no `userId` is ever sent unless the app calls `identify(userID:)`. The app —
/// not the package — is the thing with a privacy policy and a jurisdiction, and
/// the end-user opt-out it must ship is `setEnabled(false)`.
///
/// Pass `[.usage, .diagnostics]` to opt out of a stable install: every session
/// then gets its own install id, so install-based metrics (installs, active
/// installs, first-seen installs, retention) count **sessions**.
///
/// Pass `.none` to collect nothing at all until a person says yes — with `.none`
/// recorded there is no queue, no install id and no context.
public struct StatsConsent: OptionSet, Sendable, Hashable, Codable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    /// Event names, `props`, sessions, auto-events. Denied → nothing is emitted
    /// at all, whatever the other groups say.
    public static let usage = StatsConsent(rawValue: 1 << 0)
    /// The context object's diagnostic fields. Denied → the documented unknown
    /// values are sent instead (the context field itself is required).
    public static let diagnostics = StatsConsent(rawValue: 1 << 1)
    /// A stable `installId` across sessions and launches, and permission for the
    /// `userId` field. Granted by default.
    ///
    /// Granted, the install id is per-install; a `userId` is added only once the
    /// app calls `identify(userID:)`. Denied → a fresh install id per session
    /// and no `userId` ever, even after `identify()`, which means install-based
    /// metrics (installs, active installs, first-seen installs, retention)
    /// count sessions.
    public static let identity = StatsConsent(rawValue: 1 << 2)

    /// Every group. Identical to ``default``; kept as a name for "everything".
    public static let all: StatsConsent = [.usage, .diagnostics, .identity]
    /// Collect nothing at all. **Not** the SDK default (see the type's docs);
    /// pass it explicitly when the app wants a person to opt *in* first.
    public static let none: StatsConsent = []

    /// The SDK default: usage, diagnostics and identity — a stable per-install
    /// id, and no `userId` unless the app calls `identify(userID:)`. Pass
    /// `[.usage, .diagnostics]` instead for per-session install ids.
    public static let `default`: StatsConsent = [.usage, .diagnostics, .identity]
}

/// The auto-events of schema §12, all opt-in and default off.
///
/// These four names are reserved: an app cannot emit them through `track()`,
/// only by enabling them here.
public struct StatsAutoEvents: OptionSet, Sendable, Hashable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    /// `app_open`, at most once per session start.
    public static let appOpen = StatsAutoEvents(rawValue: 1 << 0)
    /// `app_background` — also the natural flush trigger.
    public static let appBackground = StatsAutoEvents(rawValue: 1 << 1)
    /// `session_start` and `session_end` as a pair: a `session_end` without its
    /// `session_start` would be unreadable, so the schema's two session events
    /// are one flag.
    public static let sessions = StatsAutoEvents(rawValue: 1 << 2)

    public static let all: StatsAutoEvents = [.appOpen, .appBackground, .sessions]
    public static let none: StatsAutoEvents = []
}
