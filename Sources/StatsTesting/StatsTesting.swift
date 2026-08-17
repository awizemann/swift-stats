import Foundation
import Stats

/// Test seams for consumers of `Stats`, and what this package's own tests use.
///
/// Nothing here is timing-dependent: `ManualClock` advances only when a test
/// says so, so backoff and interval flushes are driven, never awaited.
public enum StatsTesting: Sendable {
    /// Version of the testing helpers. Tracks the package version.
    public static let helpersVersion = Stats.sdkVersion
}
