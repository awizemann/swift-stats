import Foundation
import Stats

/// Namespace for the Cloudflare backend adapter.
///
/// Holds the paths and version constants shared by `CloudflareSink` (which
/// posts batches to a `stats-worker` deployment's `POST /v1/events`) and
/// `StatsQuery` (which reads `GET /v1/summary` and `GET /v1/events/top`). Both
/// conform to `docs/schema.md` and to the conformance checklist in
/// `backends/README.md`.
public enum StatsCloudflare: Sendable {
    /// Version of this adapter. Tracks the package version.
    public static let adapterVersion = Stats.sdkVersion

    /// Wire schema this adapter targets.
    public static let schemaVersion = Stats.schemaVersion

    /// Default ingest path, relative to the worker's base URL.
    public static let ingestPath = "/v1/events"

    /// Default read paths, relative to the worker's base URL.
    public static let summaryPath = "/v1/summary"
    public static let topEventsPath = "/v1/events/top"
}
