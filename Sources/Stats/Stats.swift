import Foundation
import os

/// Namespace for package-wide constants.
///
/// The wire contract every type in this package honors is `docs/schema.md`,
/// which is versioned independently of this SDK: `sdkVersion` names this build,
/// `schemaVersion` names the wire format that build speaks.
public enum Stats: Sendable {
    /// Version of this Swift package. Semver; `0.x` means the API may still move.
    public static let sdkVersion = "0.2.0"

    /// Version of the wire schema in `docs/schema.md` that this SDK speaks.
    ///
    /// Sent as `schema` in every batch envelope. Bumped only on a breaking
    /// change to the envelope, event or context shape.
    public static let schemaVersion = "v1"
}

/// Subsystem used by every logger in the package, so consumers can filter the
/// SDK's output with `log stream --predicate 'subsystem == "com.wizemann.stats"'`.
///
/// Loggers are declared `private nonisolated let` at file scope so actors can
/// use them synchronously regardless of the consumer's default isolation.
nonisolated enum StatsLog {
    static let subsystem = "com.wizemann.stats"
}

private nonisolated let logger = Logger(subsystem: StatsLog.subsystem, category: "Stats")

extension Stats {
    /// Emits the SDK identity to the unified log. Useful when a consumer files
    /// a bug: the version pair fully determines both the client and the wire
    /// contract in play.
    public static func logIdentity() {
        logger.debug("swift-stats \(sdkVersion, privacy: .public) speaking schema \(schemaVersion, privacy: .public)")
    }
}
