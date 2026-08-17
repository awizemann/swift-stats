import Foundation

/// The three independently togglable consent groups of schema §11.
///
/// The SDK's default is `[.usage, .diagnostics]` — **opt-out by default for an
/// app**. The app is the thing with a privacy policy and a jurisdiction, and the
/// end-user opt-out it must ship is `setEnabled(false)`.
///
/// `.identity` is **not** in the default: it makes an install stable across
/// launches and lets `identify()` emit a `userId`, which changes what the
/// consumer has to disclose (§14). It has to be asked for in code.
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
    /// A stable `installId` across launches, and the `userId` field. Denied →
    /// a fresh ephemeral install id per session and no `userId` ever.
    public static let identity = StatsConsent(rawValue: 1 << 2)

    /// Everything. Note this includes `identity`, which most apps do not need.
    public static let all: StatsConsent = [.usage, .diagnostics, .identity]
    /// Collect nothing at all. **Not** the SDK default (see the type's docs);
    /// pass it explicitly when the app wants a person to opt *in* first.
    public static let none: StatsConsent = []

    /// The SDK default: usage and diagnostics, without `identity`.
    public static let `default`: StatsConsent = [.usage, .diagnostics]
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
