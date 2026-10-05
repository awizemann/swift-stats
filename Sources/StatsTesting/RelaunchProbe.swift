import Foundation
import Stats

/// Pins what a relaunch does to the install identity, so an app can assert its
/// consent configuration produces the install ids it means to.
///
/// One call runs two "launches" of a client built from your configuration:
/// each tracks one event, flushes it to an ``InMemorySink`` and shuts down —
/// a shutdown is what hands the app id to the next client in the same process
/// — and the second is built from the same configuration, exactly as a
/// relaunch would be. It returns both events' `installId` and `seq`.
///
/// ```swift
/// import Stats
/// import StatsTesting
/// import Testing
///
/// @Test func installIsStableUnderTheDefaultConsent() async throws {
///     let configuration = StatsConfiguration(
///         appId: "com.example.App", installIdSalt: "salt", sink: InMemorySink()
///     )
///     let probe = try #require(await RelaunchProbe.installIDsAcrossRelaunch(configuration: configuration))
///     #expect(probe.installIdBeforeRelaunch == probe.installIdAfterRelaunch)
/// }
///
/// @Test func installIsPerSessionWithoutIdentity() async throws {
///     var configuration = StatsConfiguration(
///         appId: "com.example.App", installIdSalt: "salt", sink: InMemorySink()
///     )
///     configuration.consent = [.usage, .diagnostics]
///     let probe = try #require(await RelaunchProbe.installIDsAcrossRelaunch(configuration: configuration))
///     #expect(probe.installIdBeforeRelaunch != probe.installIdAfterRelaunch)
/// }
/// ```
///
/// The configuration's `sink` is replaced by a fresh ``InMemorySink`` per
/// launch, so nothing reaches a real backend.
public enum RelaunchProbe {
    /// What the two launches sent.
    public struct Observation: Sendable, Equatable {
        public var installIdBeforeRelaunch: String
        public var installIdAfterRelaunch: String
        public var seqBeforeRelaunch: Int
        public var seqAfterRelaunch: Int

        /// Whether the relaunch kept the install id.
        public var isInstallIdStable: Bool { installIdBeforeRelaunch == installIdAfterRelaunch }
    }

    /// Runs the two launches and returns what they sent, or `nil` when either
    /// launch sent nothing (consent without `usage`, or opted out).
    ///
    /// - Parameters:
    ///   - configuration: the configuration under test. Its `sink` is ignored.
    ///   - eventName: the event each launch tracks.
    ///   - isolated: `true` (the default) runs the probe under a unique app id
    ///     (yours plus a random suffix) with its own temporary
    ///     `storageDirectory`, so it starts as a fresh install, cannot collide
    ///     with a client your app or another test has live for the same app id
    ///     (which would own the app id and receive the calls), and leaves
    ///     nothing behind: the directory and the SDK's `UserDefaults` suite
    ///     are removed afterwards. `false` uses the configuration as given,
    ///     including any state already persisted for its app id.
    public static func installIDsAcrossRelaunch(
        configuration: StatsConfiguration,
        eventName: String = "relaunch_probe",
        isolated: Bool = true
    ) async -> Observation? {
        var configuration = configuration
        var directory: URL?
        if isolated {
            let suffix = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
            configuration.appId = "\(configuration.appId).probe\(suffix)"
            let scratch = URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("swift-stats-probe-\(suffix)", isDirectory: true)
            configuration.storageDirectory = scratch
            directory = scratch
        }
        defer {
            if let directory {
                try? FileManager.default.removeItem(at: directory)
                UserDefaults().removePersistentDomain(forName: configuration.identitySuiteName)
            }
        }

        guard let before = await launch(configuration, eventName: eventName),
              let after = await launch(configuration, eventName: eventName)
        else { return nil }
        return Observation(
            installIdBeforeRelaunch: before.installId,
            installIdAfterRelaunch: after.installId,
            seqBeforeRelaunch: before.seq,
            seqAfterRelaunch: after.seq
        )
    }

    /// One launch: build, track, flush, shut down.
    private static func launch(_ base: StatsConfiguration, eventName: String) async -> StatsEvent? {
        var configuration = base
        let sink = InMemorySink()
        configuration.sink = sink
        let client = StatsClient(configuration: configuration)
        await client.track(eventName)
        await client.flush()
        await client.waitForFlushes()
        await client.shutdown()
        return await sink.sentEvents.last { $0.name == eventName }
    }
}
