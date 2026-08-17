import Testing
import Stats
@testable import StatsCloudflare

@Suite("StatsCloudflare scaffold")
struct StatsCloudflareSmokeTests {
    /// `StatsCloudflare.schemaVersion` is *defined* as `Stats.schemaVersion`, so
    /// comparing the two asserted nothing: it was true by construction and would
    /// have stayed true through a wire-breaking bump of both. The literal is the
    /// actual contract — `docs/schema.md` is `v1`, and the Worker's
    /// `SCHEMA_VERSION` in `validate.ts` serves `v1` only.
    @Test("The adapter and the core both target wire schema v1")
    func schemaVersionsAgree() {
        #expect(Stats.schemaVersion == "v1")
        #expect(StatsCloudflare.schemaVersion == "v1")
        #expect(Stats.sdkVersion == "0.1.0")
        #expect(StatsCloudflare.adapterVersion == Stats.sdkVersion)
    }

    /// Discriminating: the paths are the contract in docs/schema.md §7–§8.
    /// A rename on either side breaks this before it breaks a deployment.
    @Test("Documented endpoint paths are stable")
    func endpointPaths() {
        #expect(StatsCloudflare.ingestPath == "/v1/events")
        #expect(StatsCloudflare.summaryPath == "/v1/summary")
        #expect(StatsCloudflare.topEventsPath == "/v1/events/top")
    }
}
