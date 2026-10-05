import Foundation
import Stats

/// Test seams for consumers of `Stats`, and what this package's own tests use.
///
/// Nothing here is timing-dependent: `ManualClock` advances only when a test
/// says so, so backoff and interval flushes are driven, never awaited — and
/// progress (`ManualClock.waitForSleepers(count:)`,
/// `InMemorySink.waitForBatches(_:)`) is signalled, not polled.
/// `RelaunchProbe` pins what a relaunch does to the install id under a given
/// configuration.
public enum StatsTesting: Sendable {
    /// Version of the testing helpers. Tracks the package version.
    public static let helpersVersion = Stats.sdkVersion
}
