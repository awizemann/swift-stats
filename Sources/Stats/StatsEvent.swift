import Foundation
import os

private nonisolated let logger = Logger(subsystem: StatsLog.subsystem, category: "Event")

/// One tracked event, exactly as it goes on the wire (schema §2).
///
/// The type is a faithful mirror of the schema table: `projectId`, `userId` and
/// `props` are omitted from the JSON when absent/empty, and `ts` encodes as the
/// §0 timestamp string.
public struct StatsEvent: Sendable, Hashable, Codable {
    /// Lowercase snake_case, 1–64 scalars (§2.1).
    public var name: String
    /// Wall clock at `track()` time — never at flush time (§2).
    public var ts: Date
    /// `<epochSeconds>-<8 digits>` (§10).
    public var sessionId: String
    /// 64 lowercase hex chars (§9).
    public var installId: String
    /// The emitting app's bundle identifier.
    public var appId: String
    /// Optional and advisory: the backend derives the authoritative value from
    /// the write key's scope (§2.4).
    public var projectId: String?
    /// Strictly increasing per install, in track order (§2.2).
    public var seq: Int
    /// Present only under `identify()` + `identity` consent (§2.5).
    public var userId: String?
    /// Flat, already-sanitized properties (§2.3).
    public var props: [String: StatsValue]

    public init(
        name: String,
        ts: Date,
        sessionId: String,
        installId: String,
        appId: String,
        projectId: String? = nil,
        seq: Int,
        userId: String? = nil,
        props: [String: StatsValue] = [:]
    ) {
        self.name = name
        self.ts = ts
        self.sessionId = sessionId
        self.installId = installId
        self.appId = appId
        self.projectId = projectId
        self.seq = seq
        self.userId = userId
        self.props = props
    }

    private enum CodingKeys: String, CodingKey {
        case name, ts, sessionId, installId, appId, projectId, seq, userId, props
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        let timestamp = try container.decode(String.self, forKey: .ts)
        guard let parsed = StatsTimestamp.date(from: timestamp) else {
            throw DecodingError.dataCorruptedError(
                forKey: .ts, in: container,
                debugDescription: "ts must be ISO 8601 UTC with milliseconds and a literal Z (schema §0)"
            )
        }
        ts = parsed
        sessionId = try container.decode(String.self, forKey: .sessionId)
        installId = try container.decode(String.self, forKey: .installId)
        appId = try container.decode(String.self, forKey: .appId)
        projectId = try container.decodeIfPresent(String.self, forKey: .projectId)
        seq = try container.decode(Int.self, forKey: .seq)
        userId = try container.decodeIfPresent(String.self, forKey: .userId)
        props = try container.decodeIfPresent([String: StatsValue].self, forKey: .props) ?? [:]
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(StatsTimestamp.string(from: ts), forKey: .ts)
        try container.encode(sessionId, forKey: .sessionId)
        try container.encode(installId, forKey: .installId)
        try container.encode(appId, forKey: .appId)
        // Emitters SHOULD omit rather than send null (§0).
        try container.encodeIfPresent(projectId, forKey: .projectId)
        try container.encode(seq, forKey: .seq)
        try container.encodeIfPresent(userId, forKey: .userId)
        if !props.isEmpty {
            try container.encode(props, forKey: .props)
        }
    }
}

// MARK: - Names

/// Validation for event names and prop keys (schema §2.1, §2.3, §12).
public nonisolated enum StatsEventName {
    /// The four names the schema reserves for emitter-produced auto-events.
    public static let reserved: Set<String> = ["app_open", "app_background", "session_start", "session_end"]
    /// Prefix reserved for future schema-level events.
    public static let reservedPrefix = "stats_"

    static let maxNameScalars = 64
    static let maxKeyScalars = 40

    /// `^[a-z][a-z0-9_]*$` with a scalar-count bound.
    static func isWellFormed(_ candidate: String, maxScalars: Int) -> Bool {
        var scalars = candidate.unicodeScalars.makeIterator()
        guard let first = scalars.next(), ("a"..."z").contains(first) else { return false }
        var count = 1
        while let scalar = scalars.next() {
            count += 1
            guard count <= maxScalars else { return false }
            let isLower = ("a"..."z").contains(scalar)
            let isDigit = ("0"..."9").contains(scalar)
            guard isLower || isDigit || scalar == "_" else { return false }
        }
        return count <= maxScalars
    }

    /// True for a name an app may pass to `track()`: well-formed, not one of
    /// the four reserved names, not `stats_`-prefixed.
    public static func isValidForApp(_ name: String) -> Bool {
        isWellFormed(name, maxScalars: maxNameScalars)
            && !reserved.contains(name)
            && !name.hasPrefix(reservedPrefix)
    }
}

// MARK: - Props sanitization

/// Enforces §2.3 by *truncating and dropping*, never by discarding the event.
///
/// Every adjustment is logged at `warning` (as §2.3 requires) — and only the
/// key is logged, never the value, so a log capture can never leak a property.
nonisolated enum StatsProps {
    static let maxKeys = 32
    static let maxStringScalars = 200

    static func sanitized(_ raw: [String: StatsValue], eventName: String) -> [String: StatsValue] {
        guard !raw.isEmpty else { return [:] }

        var kept: [String: StatsValue] = [:]
        kept.reserveCapacity(min(raw.count, maxKeys))

        for key in raw.keys.sorted(by: statsUTF8Ascending) {
            guard let value = raw[key] else { continue }

            guard StatsEventName.isWellFormed(key, maxScalars: StatsEventName.maxKeyScalars) else {
                logger.warning("""
                    dropped prop with non-conforming key on \(eventName, privacy: .public) \
                    (must match ^[a-z][a-z0-9_]*$, 1-40 scalars)
                    """)
                continue
            }
            guard !value.isNonFinite else {
                logger.warning("dropped non-finite numeric prop \(key, privacy: .public) on \(eventName, privacy: .public)")
                continue
            }
            // The 32-key cap keeps the first 32 in byte-wise ascending key
            // order, so this emitter and a truncating backend agree (§2.3).
            guard kept.count < maxKeys else {
                logger.warning("dropped prop \(key, privacy: .public) on \(eventName, privacy: .public): over the 32-key limit")
                continue
            }

            if let scalarCount = value.stringScalarCount, scalarCount > maxStringScalars,
               case .string(let string) = value {
                logger.warning("truncated prop \(key, privacy: .public) on \(eventName, privacy: .public) to 200 scalars")
                let truncated = String(String.UnicodeScalarView(string.unicodeScalars.prefix(maxStringScalars)))
                kept[key] = .string(truncated)
            } else {
                kept[key] = value
            }
        }
        return kept
    }
}
