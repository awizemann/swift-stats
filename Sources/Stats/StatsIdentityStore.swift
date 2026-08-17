import CryptoKit
import Foundation
import os

private nonisolated let logger = Logger(subsystem: StatsLog.subsystem, category: "Identity")

/// The SDK's own persisted state: the install UUID, `seq`, consent, the opt-out
/// flag and the hashed `userId`.
///
/// Lives in a **dedicated `UserDefaults` suite** named after the app id, never
/// `.standard` — so it cannot collide with app keys, is trivial to inspect, and
/// `reset()` can wipe it wholesale. This is the only required-reason API the SDK
/// touches (CA92.1, §9).
///
/// `@unchecked Sendable` because `UserDefaults` is documented thread-safe but
/// not marked `Sendable`. Access is synchronous on purpose: these are small
/// scalar reads on the client actor, and making them `async` would add
/// suspension points that widen the window between capture and disk for no gain.
struct StatsIdentityStore: @unchecked Sendable {
    private let defaults: UserDefaults
    /// `false` when the dedicated suite could not be opened. §9 allows the
    /// identifier to live in the SDK's own suite and nowhere else, so the SDK
    /// fails **closed**: no suite, no collection — never a silent fallback to
    /// `UserDefaults.standard`, which would write the install id into the app's
    /// own defaults domain.
    let isAvailable: Bool
    private let suiteName: String
    private let salt: String

    private enum Key {
        static let installUUID = "installUUID"
        static let seq = "seq"
        static let consent = "consent"
        static let consentRecorded = "consentRecorded"
        static let enabled = "enabled"
        static let userIdHash = "userIdHash"
    }

    /// Suite name derived from the app id, so two apps in one process (or a test
    /// per app id) never share identity state.
    static func suiteName(appId: String) -> String { "com.wizemann.stats.\(appId)" }

    init(appId: String, salt: String) {
        let suiteName = Self.suiteName(appId: appId)
        self.suiteName = suiteName
        if let suite = UserDefaults(suiteName: suiteName) {
            self.defaults = suite
            self.isAvailable = true
        } else {
            logger.error("the SDK's UserDefaults suite could not be opened; collection is disabled")
            self.defaults = UserDefaults(suiteName: "com.wizemann.stats.unavailable") ?? .standard
            self.isAvailable = false
        }
        self.salt = salt
    }

    // MARK: Install identity

    /// The persisted raw UUID, creating one on first run.
    ///
    /// The **raw UUID** is what is persisted and it never goes on the wire; the
    /// hash is derived at use time (§9).
    func installUUID(makeUUID: () -> UUID) -> UUID {
        if let stored = defaults.string(forKey: Key.installUUID), let uuid = UUID(uuidString: stored) {
            return uuid
        }
        let fresh = makeUUID()
        defaults.set(fresh.uuidString, forKey: Key.installUUID)
        logger.info("generated a fresh install identity")
        return fresh
    }

    func regenerateInstallUUID(makeUUID: () -> UUID) -> UUID {
        let fresh = makeUUID()
        defaults.set(fresh.uuidString, forKey: Key.installUUID)
        return fresh
    }

    /// Deletes the stored UUID, so a resumed identity is impossible after a
    /// consent revocation (§11).
    func deleteInstallUUID() {
        defaults.removeObject(forKey: Key.installUUID)
    }

    /// `installId = lowercaseHex(SHA256(uuidString + salt))` — uppercase RFC
    /// 4122 UUID string, no separator, UTF-8 (§9).
    func installId(for uuid: UUID) -> String {
        Self.hash(uuid.uuidString, salt: salt)
    }

    static func hash(_ value: String, salt: String) -> String {
        let digest = SHA256.hash(data: Data((value + salt).utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    // MARK: seq

    /// Monotonic per install, never reset within an install — it survives
    /// relaunch, which is why it is persisted rather than held in memory (§2.2).
    var seq: Int {
        get { defaults.integer(forKey: Key.seq) }
        nonmutating set { defaults.set(newValue, forKey: Key.seq) }
    }

    // MARK: Consent and opt-out

    /// `nil` when this app has never recorded a choice, so a configuration's
    /// initial value applies exactly once.
    var storedConsent: StatsConsent? {
        guard defaults.bool(forKey: Key.consentRecorded) else { return nil }
        return StatsConsent(rawValue: defaults.integer(forKey: Key.consent))
    }

    func storeConsent(_ consent: StatsConsent) {
        defaults.set(consent.rawValue, forKey: Key.consent)
        defaults.set(true, forKey: Key.consentRecorded)
    }

    var storedEnabled: Bool? {
        defaults.object(forKey: Key.enabled) as? Bool
    }

    func storeEnabled(_ enabled: Bool) {
        defaults.set(enabled, forKey: Key.enabled)
    }

    // MARK: userId

    /// Already hashed with the install salt before it is stored, so even the
    /// SDK's own defaults file never holds the app's raw account identifier.
    var userIdHash: String? {
        get { defaults.string(forKey: Key.userIdHash) }
        nonmutating set {
            if let newValue {
                defaults.set(newValue, forKey: Key.userIdHash)
            } else {
                defaults.removeObject(forKey: Key.userIdHash)
            }
        }
    }

    /// Hashes an app-supplied account identifier with the install salt (§2.5),
    /// warning first if it looks like something a person could be contacted by.
    func hashedUserId(_ raw: String) -> String {
        if raw.contains("@") {
            logger.warning("""
                identify() was given a value containing "@" — it looks like a raw address. \
                It is hashed before it leaves the device, but pass an opaque id instead (schema §2.5).
                """)
        }
        return Self.hash(raw, salt: salt)
    }

    /// Wipes everything this suite holds. Used by `reset()`.
    func removeAll() {
        defaults.removePersistentDomain(forName: suiteName)
    }
}
