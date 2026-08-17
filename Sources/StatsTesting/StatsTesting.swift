import Foundation
import Stats

/// Test seams for consumers of `Stats`.
///
/// Placeholder for P12b, which adds the in-memory sink plus the deterministic
/// clock and id-generator doubles. Nothing here may be timing-dependent: tests
/// drive the clock, they never sleep.
public enum StatsTesting: Sendable {
    /// Version of the testing helpers. Tracks the package version.
    public static let helpersVersion = Stats.sdkVersion
}
