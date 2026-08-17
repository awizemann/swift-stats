import Foundation
import os

/// Loggers are `private nonisolated let` at file scope so an actor can use them
/// synchronously whatever the consumer's default isolation is.
private nonisolated let logger = Logger(subsystem: "com.wizemann.stats", category: "StatsQuery")

// MARK: - Result types

/// One row of `GET /v1/summary` (`docs/schema.md` §8.1).
///
/// `sessions` and `activeInstalls` are **not additive across days** — a session
/// spanning midnight UTC counts in both days, and an install active on two days
/// counts twice. Summing them over a range does not give the number of distinct
/// sessions or installs in that range. The schema is explicit about this, and it
/// is the single most common way to misread these numbers.
public struct StatsSummaryRow: Sendable, Hashable, Codable {
    /// The UTC calendar day of the event timestamps counted in this row.
    public let date: StatsDay
    /// Count of `app_open` events that day. `0` if the app does not emit auto-events.
    public let opens: Int
    /// Distinct sessions with at least one event that day. Not additive.
    public let sessions: Int
    /// Distinct installs with at least one event that day. Not additive, and
    /// "installs that were active" — never "unique users".
    public let activeInstalls: Int
    /// All events that day, auto-events included.
    public let events: Int
}

/// The `GET /v1/summary` response.
public struct StatsSummary: Sendable, Hashable, Codable {
    public let schema: String
    public let projectId: String
    /// The range **actually served**, which may differ from what was asked: §8.1
    /// clamps a `to` after today, and may clamp `from` at the retention edge.
    public let from: StatsDay
    public let to: StatsDay
    public let includeDebug: Bool
    /// One row per day in the served range, ascending, zero-filled. Trustworthy
    /// as a count: §8.1 requires every day be present.
    public let rows: [StatsSummaryRow]
}

/// One row of `GET /v1/events/top` without a `name` (§8.2).
public struct StatsEventNameRow: Sendable, Hashable, Codable {
    public let name: String
    public let count: Int
    /// Distinct installs for this row. See ``StatsQuery`` on exactness.
    public let installs: Int
}

/// The `GET /v1/events/top` response without a `name`.
public struct StatsTopEvents: Sendable, Hashable, Codable {
    public let schema: String
    public let projectId: String
    public let from: StatsDay
    public let to: StatsDay
    public let includeDebug: Bool
    public let limit: Int
    /// Sorted by `count` descending, then `name` ascending.
    public let rows: [StatsEventNameRow]
}

/// A prop value in a §8.2 breakdown.
///
/// Only `string`, `bool` and absent/null appear: §8.2 omits numeric props from
/// breakdowns in `v1`, so there is deliberately no `number` case to decode into.
public enum StatsPropValue: Sendable, Hashable, Codable {
    case string(String)
    case bool(Bool)

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else {
            throw DecodingError.dataCorrupted(
                .init(
                    codingPath: decoder.codingPath,
                    debugDescription: "A v1 prop breakdown value must be a string, a bool, or null."
                )
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        }
    }
}

/// One row of `GET /v1/events/top` with a `name` (§8.2).
public struct StatsPropRow: Sendable, Hashable, Codable {
    public let prop: String
    /// `nil` is the schema's null row: it folds "the prop was present with a JSON
    /// `null`" together with "the prop was absent from that event entirely",
    /// because "the app did not report a section" is one thing to a reader.
    public let value: StatsPropValue?
    public let count: Int
    public let installs: Int
}

/// The `GET /v1/events/top` response with a `name`.
public struct StatsPropBreakdown: Sendable, Hashable, Codable {
    public let schema: String
    public let projectId: String
    public let from: StatsDay
    public let to: StatsDay
    public let includeDebug: Bool
    public let name: String?
    public let limit: Int
    /// Grouped by `prop` ascending; within a prop, `count` descending then
    /// `value` ascending, with the `nil` row last. `limit` caps rows **per prop**.
    public let rows: [StatsPropRow]
}

// MARK: - Errors

/// A read failure, mapped from the §8.3 error contract.
public enum StatsQueryError: Error, Sendable {
    /// 401. The read key is missing, invalid, or does not cover the project.
    ///
    /// One case for all three on purpose: §8 requires that an out-of-scope
    /// project be **indistinguishable** from a nonexistent one, so a conformant
    /// backend does not tell us which it was, and inventing a finer distinction
    /// here would be inventing information.
    case keyRejected

    /// 400. `code` is the backend's stable snake_case machine code (`invalid_range`,
    /// `range_too_large`, `invalid_limit`, …); `message` is human text.
    case badRequest(code: String, message: String)

    /// 404 — an unknown *path* only. In practice: a base URL pointing at the
    /// wrong host, or a backend that does not serve `v1`.
    case pathNotFound

    /// 429. Retry after `retryAfter` when present, else the §7 backoff.
    case rateLimited(retryAfter: Duration?)

    /// 5xx. Retry with the §7 backoff.
    case serverError(statusCode: Int)

    /// A status the read contract does not define.
    case unexpectedStatus(Int)

    /// Offline, DNS, TLS, timeout. Retriable.
    case transport(any Error)

    /// The response was not the documented JSON shape.
    case malformedResponse(any Error)

    /// The caller passed a range the schema forbids, caught before any request is
    /// made — `to` before `from`, or a span over 400 days.
    case invalidRange(String)
}

// MARK: - StatsQuery

/// Reads `GET /v1/summary` and `GET /v1/events/top` from a `stats-worker`
/// deployment.
///
/// **The read key must not ship in a client app.** §8 requires it not be
/// embeddable in a shipped binary — it is not a write key, and it reads every
/// project it is scoped to. Load it from the Keychain or a server-side secret
/// store at runtime. Nothing in this type ever logs it.
///
/// **On exactness.** The Cloudflare/D1 backend computes distinct counts with
/// `COUNT(DISTINCT …)`, so `sessions` and `activeInstalls` on every summary row
/// are exact, as is `installs` for any `/v1/events/top` range inside the
/// backend's raw retention (90 days). For a `top` range reaching further back the
/// backend answers `installs` from per-day rollups, where distinct counts are not
/// additive, and the number becomes an upper bound. See
/// `backends/cloudflare/README.md`.
public struct StatsQuery: Sendable {
    /// §8.1: a span longer than this is `400` / `range_too_large`. Checked
    /// client-side too, so an obvious mistake costs no round trip.
    public static let maxRangeDays = 400

    private let endpoint: CloudflareEndpoint
    private let readKey: String
    private let transport: any StatsTransport

    /// - Parameters:
    ///   - endpoint: the worker's base URL.
    ///   - readKey: the project-scoped **read** key. Never logged.
    ///   - transport: injectable for tests; defaults to `URLSessionTransport`.
    public init(
        endpoint: CloudflareEndpoint,
        readKey: String,
        transport: any StatsTransport = URLSessionTransport()
    ) {
        self.endpoint = endpoint
        self.readKey = readKey
        self.transport = transport
    }

    // MARK: Requests

    /// `GET /v1/summary` — per-day counts over an inclusive UTC day range.
    public func summary(
        projectId: String,
        from: StatsDay,
        to: StatsDay,
        includeDebug: Bool = false
    ) async throws -> StatsSummary {
        try validate(from: from, to: to)
        return try await get(
            path: StatsCloudflare.summaryPath,
            query: rangeQuery(projectId: projectId, from: from, to: to, includeDebug: includeDebug),
            as: StatsSummary.self
        )
    }

    /// `GET /v1/events/top` without `name` — the top event names by count.
    ///
    /// - Parameter limit: 1–100. Caps the total number of rows.
    public func topEvents(
        projectId: String,
        from: StatsDay,
        to: StatsDay,
        limit: Int = 20,
        includeDebug: Bool = false
    ) async throws -> StatsTopEvents {
        try validate(from: from, to: to)
        var query = rangeQuery(projectId: projectId, from: from, to: to, includeDebug: includeDebug)
        query.append(URLQueryItem(name: "limit", value: String(limit)))
        return try await get(path: StatsCloudflare.topEventsPath, query: query, as: StatsTopEvents.self)
    }

    /// `GET /v1/events/top` with `name` — the breakdown of one event's props.
    ///
    /// An event name that was never emitted is **not** an error: it returns an
    /// empty `rows` (§8.2).
    ///
    /// - Parameter limit: 1–100. Caps rows **per prop**, so a breakdown of 5
    ///   props at `limit: 20` can return up to 100 rows.
    public func propBreakdown(
        projectId: String,
        name: String,
        from: StatsDay,
        to: StatsDay,
        limit: Int = 20,
        includeDebug: Bool = false
    ) async throws -> StatsPropBreakdown {
        try validate(from: from, to: to)
        var query = rangeQuery(projectId: projectId, from: from, to: to, includeDebug: includeDebug)
        query.append(URLQueryItem(name: "name", value: name))
        query.append(URLQueryItem(name: "limit", value: String(limit)))
        return try await get(path: StatsCloudflare.topEventsPath, query: query, as: StatsPropBreakdown.self)
    }

    // MARK: Plumbing

    private func validate(from: StatsDay, to: StatsDay) throws {
        guard from <= to else {
            throw StatsQueryError.invalidRange("`from` must not be after `to`.")
        }
        guard StatsDay.daysInclusive(from: from, to: to) <= Self.maxRangeDays else {
            throw StatsQueryError.invalidRange(
                "A range may span at most \(Self.maxRangeDays) days."
            )
        }
    }

    private func rangeQuery(
        projectId: String,
        from: StatsDay,
        to: StatsDay,
        includeDebug: Bool
    ) -> [URLQueryItem] {
        [
            URLQueryItem(name: "projectId", value: projectId),
            URLQueryItem(name: "from", value: from.description),
            URLQueryItem(name: "to", value: to.description),
            // Sent explicitly even for the default. §8.1 defaults it to `false`,
            // but a request that says what it means does not change behavior if a
            // backend ever gets the default wrong.
            URLQueryItem(name: "includeDebug", value: includeDebug ? "true" : "false"),
        ]
    }

    private func get<T: Decodable>(
        path: String,
        query: [URLQueryItem],
        as type: T.Type
    ) async throws -> T {
        var request = URLRequest(url: endpoint.url(path: path, query: query))
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // The read key travels in a header, never in the query string: a URL ends
        // up in proxy logs, crash reports and `os_log` metadata, and a key in one
        // of those is a leaked key.
        request.setValue(readKey, forHTTPHeaderField: "X-Stats-Read-Key")
        request.httpShouldHandleCookies = false

        let response: StatsHTTPResponse
        do {
            response = try await transport.perform(request)
        } catch {
            // The URL is logged, the key is not — it was never in the URL.
            logger.warning("Stats read transport failure for \(path, privacy: .public)")
            throw StatsQueryError.transport(error)
        }

        switch response.statusCode {
        case 200:
            do {
                return try JSONDecoder().decode(type, from: response.body)
            } catch {
                logger.error("Stats read returned an undecodable body for \(path, privacy: .public)")
                throw StatsQueryError.malformedResponse(error)
            }

        case 400:
            let error = Self.decodeError(response.body)
            throw StatsQueryError.badRequest(code: error.code, message: error.message)

        case 401:
            // Never log the key, not even a prefix or a length.
            logger.error("Stats read key rejected for \(path, privacy: .public)")
            throw StatsQueryError.keyRejected

        case 404:
            throw StatsQueryError.pathNotFound

        case 429:
            throw StatsQueryError.rateLimited(
                retryAfter: IngestDisposition.retryAfter(from: response.headers)
            )

        case 500...599:
            throw StatsQueryError.serverError(statusCode: response.statusCode)

        default:
            throw StatsQueryError.unexpectedStatus(response.statusCode)
        }
    }

    /// §8.3: `{"error": "<machine_code>", "message": "<human text>"}`.
    ///
    /// Falls back rather than throwing: a backend that returns a 400 with a body
    /// we cannot parse is still unambiguously telling us the request was bad, and
    /// surfacing that as a decoding error would misclassify a permanent failure
    /// as a mystery.
    static func decodeError(_ body: Data) -> (code: String, message: String) {
        struct Payload: Decodable {
            let error: String?
            let message: String?
        }
        guard let payload = try? JSONDecoder().decode(Payload.self, from: body) else {
            return ("bad_request", "The backend rejected the request.")
        }
        return (payload.error ?? "bad_request", payload.message ?? "The backend rejected the request.")
    }
}

extension StatsDay {
    /// Whole days from `from` to `to`, inclusive of both ends. `from == to` is 1.
    static func daysInclusive(from: StatsDay, to: StatsDay) -> Int {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let start = calendar.date(from: DateComponents(year: from.year, month: from.month, day: from.day))!
        let end = calendar.date(from: DateComponents(year: to.year, month: to.month, day: to.day))!
        return (calendar.dateComponents([.day], from: start, to: end).day ?? 0) + 1
    }
}
