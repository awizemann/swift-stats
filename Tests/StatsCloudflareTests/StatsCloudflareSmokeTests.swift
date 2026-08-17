import Testing
import Stats
@testable import StatsCloudflare

@Suite("StatsCloudflare scaffold")
struct StatsCloudflareSmokeTests {
    @Test("The adapter targets the same schema version as the core")
    func schemaVersionsAgree() {
        #expect(StatsCloudflare.schemaVersion == Stats.schemaVersion)
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
