import Foundation
@testable import Stats
import StatsTesting
import Testing

/// What the SDK is allowed to touch on disk, and when.
///
/// Two properties live here, both of which used to be wrong:
///
/// * `StatsClient.init` does **no** disk I/O. It used to resolve the queue path
///   through `FileManager.url(for: .applicationSupportDirectory, create: true)`
///   and open a `UserDefaults` suite, both synchronous, on whatever thread the
///   consumer constructed the client on — which for an app configuring stats in
///   `App.init` is the main actor, during launch.
/// * The queue file is owner-only. An atomic `Data.write` replaces the file, so
///   the mode has to be re-applied on every write, not once at creation.
@Suite("Storage: lazy construction and file permissions")
struct StorageTests {
    /// A directory path that does not exist yet, cleaned up by the caller.
    private static func scratchDirectory() -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("swift-stats-storage-\(UUID().uuidString)", isDirectory: true)
    }

    private static func configuration(
        appId: String, directory: URL, consent: StatsConsent, sink: InMemorySink, clock: ManualClock
    ) -> StatsConfiguration {
        var configuration = StatsConfiguration(
            appId: appId,
            installIdSalt: "test-salt",
            sink: sink,
            flushAt: 1_000,
            consent: consent,
            storageDirectory: directory,
            clock: clock,
            uuidProvider: FixedUUIDProvider(Harness.defaultUUIDs),
            randomSource: FixedRandomSource()
        )
        var context = Harness.exampleContext
        context.bundleId = appId
        configuration.contextOverride = context
        return configuration
    }

    /// Discriminating: the storage directory does not exist when the test starts,
    /// so if `init` resolves and creates anything, `fileExists` is `true` before
    /// a single event has been tracked. The cheap read-only accessors are
    /// exercised too — a consumer showing an opt-out toggle reads `isEnabled` at
    /// launch, and that must not create storage either.
    @Test("init creates nothing on disk; the first track() does")
    func initIsLazy() async {
        let directory = Self.scratchDirectory()
        let appId = "com.example.lazy\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
        defer {
            try? FileManager.default.removeItem(at: directory)
            UserDefaults().removePersistentDomain(forName: StatsIdentityStore.suiteName(appId: appId))
        }

        let sink = InMemorySink()
        let clock = ManualClock()
        let client = StatsClient(
            configuration: Self.configuration(
                appId: appId, directory: directory, consent: .default, sink: sink, clock: clock
            )
        )

        #expect(
            !FileManager.default.fileExists(atPath: directory.path),
            "init must not create the storage directory"
        )

        // Reading state, and asking the queue how deep it is, are all still free.
        #expect(await client.isEnabled)
        #expect(await client.currentConsent == [.usage, .diagnostics])
        #expect(await client.queuedEventCount == 0)
        #expect(
            !FileManager.default.fileExists(atPath: directory.path),
            "reading consent, the opt-out and the queue depth must not create storage"
        )

        // The first capture is what creates it.
        await client.track("a")
        #expect(FileManager.default.fileExists(atPath: directory.path))
        #expect(
            FileManager.default.fileExists(
                atPath: directory.appendingPathComponent("queue.jsonl").path
            )
        )

        await client.shutdown()
        clock.cancelAllSleepers()
    }

    /// `applicationDidBecomeActive()` is the other capture entry point, and with
    /// `sessions` enabled it queues `session_start` — so it must create storage
    /// too, and not before it is called.
    @Test("applicationDidBecomeActive() is the other point storage may appear")
    func lifecycleEntryPointCreatesStorage() async {
        let directory = Self.scratchDirectory()
        let appId = "com.example.lazylife\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
        defer {
            try? FileManager.default.removeItem(at: directory)
            UserDefaults().removePersistentDomain(forName: StatsIdentityStore.suiteName(appId: appId))
        }

        let sink = InMemorySink()
        let clock = ManualClock()
        var configuration = Self.configuration(
            appId: appId, directory: directory, consent: .default, sink: sink, clock: clock
        )
        configuration.autoEvents = [.appOpen, .sessions]
        let client = StatsClient(configuration: configuration)

        #expect(!FileManager.default.fileExists(atPath: directory.path))
        await client.applicationDidBecomeActive()
        #expect(FileManager.default.fileExists(atPath: directory.path))
        #expect(await client.queuedEventCount > 0)

        await client.shutdown()
        clock.cancelAllSleepers()
    }

    /// The strongest form: with `.none` recorded, nothing is collected, so
    /// nothing may be created at all — not by `init`, and not by a `track()`
    /// either. Before construction was lazy, `init` created the directory
    /// regardless of consent.
    @Test("With consent .none, not even a track() creates storage")
    func consentNoneCreatesNothing() async {
        let directory = Self.scratchDirectory()
        let appId = "com.example.lazynone\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
        defer {
            try? FileManager.default.removeItem(at: directory)
            UserDefaults().removePersistentDomain(forName: StatsIdentityStore.suiteName(appId: appId))
        }

        let sink = InMemorySink()
        let clock = ManualClock()
        let client = StatsClient(
            configuration: Self.configuration(
                appId: appId, directory: directory, consent: .none, sink: sink, clock: clock
            )
        )

        await client.track("a")
        await client.applicationDidBecomeActive()
        await client.flush()
        await client.waitForFlushes()

        #expect(!FileManager.default.fileExists(atPath: directory.path))
        #expect(await sink.batchCount == 0)

        await client.shutdown()
        clock.cancelAllSleepers()
    }

    /// Discriminating on the *re-application*, not just on creation: the file is
    /// first created by an append and then rewritten atomically when a batch is
    /// removed. A `chmod` done once at creation passes the first check and fails
    /// the second, because `Data.write(options: .atomic)` renames a fresh
    /// temporary file over the old one with the umask's 0644.
    @Test("The queue file is 0600, and stays 0600 across an atomic rewrite")
    func queueFileIsOwnerOnly() async throws {
        let harness = Harness(flushAt: 1_000)
        let queue = harness.directory.appendingPathComponent("queue.jsonl")

        await harness.client.track("a")
        await harness.client.track("b")

        func mode() throws -> Int {
            let attributes = try FileManager.default.attributesOfItem(atPath: queue.path)
            let permissions = try #require(attributes[.posixPermissions] as? NSNumber)
            return permissions.intValue & 0o777
        }

        #expect(try mode() == 0o600, "created owner-only")

        // Flush one batch: the removal rewrites the whole file atomically.
        await harness.client.flush()
        await harness.client.waitForFlushes()
        #expect(await harness.sink.batchCount == 1)
        #expect(try mode() == 0o600, "still owner-only after the atomic rewrite")

        // And the directory the SDK created for itself is owner-only too.
        let directoryAttributes = try FileManager.default.attributesOfItem(
            atPath: harness.directory.path
        )
        let directoryMode = try #require(directoryAttributes[.posixPermissions] as? NSNumber)
        #expect(directoryMode.intValue & 0o777 == 0o700)

        await harness.tearDown()
    }
}
