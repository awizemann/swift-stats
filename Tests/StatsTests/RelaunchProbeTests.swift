import Foundation
@testable import Stats
import StatsTesting
import Testing

/// `StatsTesting.RelaunchProbe` — the helper an integrator uses to pin what a
/// relaunch does to the install id under their consent configuration.
@Suite("RelaunchProbe", .timeLimit(.minutes(1)))
struct RelaunchProbeTests {
    private static func configuration(consent: StatsConsent? = nil) -> StatsConfiguration {
        var configuration = StatsConfiguration(
            appId: "com.example.probe", installIdSalt: "salt", sink: InMemorySink(),
            clock: ManualClock()
        )
        if let consent { configuration.consent = consent }
        return configuration
    }

    @Test("Under the default consent the install id survives the relaunch and seq continues")
    func defaultConsentIsStable() async throws {
        let probe = try #require(await RelaunchProbe.installIDsAcrossRelaunch(configuration: Self.configuration()))
        #expect(probe.installIdBeforeRelaunch == probe.installIdAfterRelaunch)
        #expect(probe.isInstallIdStable)
        #expect(probe.seqBeforeRelaunch == 0)
        #expect(probe.seqAfterRelaunch == 1)
        #expect(probe.installIdBeforeRelaunch.count == 64)
    }

    @Test("Without .identity each launch gets its own install id and seq space")
    func withoutIdentityIsPerSession() async throws {
        let probe = try #require(await RelaunchProbe.installIDsAcrossRelaunch(
            configuration: Self.configuration(consent: [.usage, .diagnostics])
        ))
        #expect(probe.installIdBeforeRelaunch != probe.installIdAfterRelaunch)
        #expect(!probe.isInstallIdStable)
        #expect(probe.seqBeforeRelaunch == 0)
        #expect(probe.seqAfterRelaunch == 0)
    }

    @Test("Nothing collected means no observation")
    func noUsageIsNil() async {
        #expect(await RelaunchProbe.installIDsAcrossRelaunch(configuration: Self.configuration(consent: StatsConsent.none)) == nil)
    }

    /// Isolation: a probe is a fresh install every time, and it does not
    /// collide with a client already live for the same app id (which would own
    /// the app id and receive the probe's calls).
    @Test("Each isolated probe is a fresh install, and a live client for the app id does not interfere")
    func isolatedProbesAreIndependent() async throws {
        let harness = Harness()
        await harness.client.track("live")
        var configuration = harness.configuration
        configuration.sink = InMemorySink()

        let first = try #require(await RelaunchProbe.installIDsAcrossRelaunch(configuration: configuration))
        let second = try #require(await RelaunchProbe.installIDsAcrossRelaunch(configuration: configuration))
        #expect(first.seqBeforeRelaunch == 0, "not the live client's install")
        #expect(second.seqBeforeRelaunch == 0, "the first probe left nothing behind")
        #expect(await harness.client.queuedEventCount == 1, "the live client was not touched")
        await harness.tearDown()
    }
}
