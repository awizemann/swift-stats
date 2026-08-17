import Foundation

/// One ingest request body: the batch envelope of schema §1.
public struct StatsBatch: Sendable, Hashable, Codable {
    /// Always `Stats.schemaVersion` for this build.
    public var schema: String
    /// RFC 4122 UUID, **uppercase** on the wire. Stable across retries of this
    /// batch — that is what makes at-least-once delivery safe (§6).
    public var batchId: String
    /// When the emitter serialized the batch. Distinct from each event's `ts`.
    public var sentAt: Date
    /// Exactly one per batch, describing the app when the events were tracked.
    public var context: StatsContext
    /// 1–100 events (§5).
    public var events: [StatsEvent]

    public init(
        schema: String = Stats.schemaVersion,
        batchId: String,
        sentAt: Date,
        context: StatsContext,
        events: [StatsEvent]
    ) {
        self.schema = schema
        self.batchId = batchId
        self.sentAt = sentAt
        self.context = context
        self.events = events
    }

    private enum CodingKeys: String, CodingKey {
        case schema, batchId, sentAt, context, events
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schema = try container.decode(String.self, forKey: .schema)
        batchId = try container.decode(String.self, forKey: .batchId)
        let sent = try container.decode(String.self, forKey: .sentAt)
        guard let parsed = StatsTimestamp.date(from: sent) else {
            throw DecodingError.dataCorruptedError(
                forKey: .sentAt, in: container,
                debugDescription: "sentAt must be ISO 8601 UTC with milliseconds and a literal Z (schema §0)"
            )
        }
        sentAt = parsed
        context = try container.decode(StatsContext.self, forKey: .context)
        events = try container.decode([StatsEvent].self, forKey: .events)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schema, forKey: .schema)
        try container.encode(batchId, forKey: .batchId)
        try container.encode(StatsTimestamp.string(from: sentAt), forKey: .sentAt)
        try container.encode(context, forKey: .context)
        try container.encode(events, forKey: .events)
    }

    /// The exact bytes to POST: UTF-8 JSON, no BOM, `/` unescaped.
    ///
    /// A sink MUST use this rather than encoding the batch itself, so that the
    /// byte count the dispatcher enforced against the 256 KiB limit (§5) is the
    /// byte count that goes on the wire.
    public func serialized() throws -> Data {
        try StatsJSON.encoder.encode(self)
    }
}

/// The one encoder/decoder pair the package uses.
///
/// `sortedKeys` is not required by the schema (JSON objects are unordered) but
/// makes the bytes deterministic, which is what lets a test assert an exact
/// payload and lets the size check be reproducible.
nonisolated enum StatsJSON {
    static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()

    static let decoder = JSONDecoder()

    /// A single-line encoder for the JSON-lines queue file. Same settings; the
    /// separate instance exists only to make the intent obvious at call sites.
    static let lineEncoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }()
}
