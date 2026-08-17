import Foundation

/// One value in an event's `props` map.
///
/// The schema (§2.3) allows exactly `string`, `number`, `bool` and `null`;
/// nested objects and arrays are not representable on purpose, so an app
/// *cannot* build a payload a backend would have to reject with 400.
///
/// `null` is meaningful: it means "the app explicitly reports no value here"
/// and is preserved distinctly from an absent key.
public enum StatsValue: Sendable, Hashable, Codable {
    case string(String)
    case int(Int)
    case double(Double)
    case bool(Bool)
    case null

    // MARK: Codable

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let bool = try? container.decode(Bool.self) {
            self = .bool(bool)
        } else if let int = try? container.decode(Int.self) {
            self = .int(int)
        } else if let double = try? container.decode(Double.self) {
            self = .double(double)
        } else if let string = try? container.decode(String.self) {
            self = .string(string)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "props values must be string, number, bool or null (schema §2.3)"
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .int(let value): try container.encode(value)
        case .double(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    /// True when the value is a number that JSON cannot represent. Such a
    /// property is dropped by the emitter rather than emitted (schema §0).
    var isNonFinite: Bool {
        if case .double(let value) = self { return !value.isFinite }
        return false
    }

    /// The scalar count of a string value, used for the 200-scalar cap.
    var stringScalarCount: Int? {
        if case .string(let value) = self { return value.unicodeScalars.count }
        return nil
    }
}

// MARK: - Literal ergonomics
//
// These exist so a call site reads `["section": "analytics", "count": 3,
// "cached": true, "kind": nil]` with no wrapping ceremony — the schema's value
// domain expressed as Swift literals.

extension StatsValue: ExpressibleByStringLiteral {
    public init(stringLiteral value: String) { self = .string(value) }
}

extension StatsValue: ExpressibleByIntegerLiteral {
    public init(integerLiteral value: Int) { self = .int(value) }
}

extension StatsValue: ExpressibleByFloatLiteral {
    public init(floatLiteral value: Double) { self = .double(value) }
}

extension StatsValue: ExpressibleByBooleanLiteral {
    public init(booleanLiteral value: Bool) { self = .bool(value) }
}

extension StatsValue: ExpressibleByNilLiteral {
    public init(nilLiteral: ()) { self = .null }
}

// MARK: - Byte-wise ordering

/// Byte-wise ascending comparison over UTF-8 bytes (schema §0).
///
/// Not `<` on `String`, which is Unicode-canonical-equivalence ordering over
/// UTF-16 — a Swift and a JS emitter would then disagree about which 32 prop
/// keys survive truncation, and the schema requires them to agree.
nonisolated func statsUTF8Ascending(_ lhs: String, _ rhs: String) -> Bool {
    lhs.utf8.lexicographicallyPrecedes(rhs.utf8)
}
