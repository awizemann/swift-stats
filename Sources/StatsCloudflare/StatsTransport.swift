import Foundation

/// The HTTP seam.
///
/// Both the sink and the reader talk to the network only through this, so a test
/// drives real status codes and real header dictionaries without a server and
/// without timing. `nonisolated protocol` deliberately: a conforming type may be
/// an actor, and an actor cannot conform to a protocol that is implicitly
/// `@MainActor` in a consumer that opted into MainActor-by-default isolation.
public nonisolated protocol StatsTransport: Sendable {
    /// Performs `request` and returns the response.
    ///
    /// Throws only for a *transport* failure (offline, DNS, TLS, timeout). Any
    /// HTTP status, including 5xx, is a successful return — the status is data
    /// here, and mapping it to behavior is `IngestDisposition`'s job, not the
    /// transport's.
    func perform(_ request: URLRequest) async throws -> StatsHTTPResponse
}

/// A response, reduced to what the schema's contracts actually read.
public struct StatsHTTPResponse: Sendable {
    public let statusCode: Int
    /// Lowercased header field names, so a lookup cannot miss on casing.
    public let headers: [String: String]
    public let body: Data

    public init(statusCode: Int, headers: [String: String] = [:], body: Data = Data()) {
        self.statusCode = statusCode
        self.headers = Dictionary(
            headers.map { ($0.key.lowercased(), $0.value) },
            // Last wins; HTTP allows repeats and any of them satisfies the
            // integer-seconds contract we read for.
            uniquingKeysWith: { _, last in last }
        )
        self.body = body
    }

    public func header(_ name: String) -> String? {
        headers[name.lowercased()]
    }
}

/// The production transport.
public struct URLSessionTransport: StatsTransport {
    private let session: URLSession

    /// A request must not pin the dispatcher's single flush slot (schema §5:
    /// batches are sent one at a time) waiting on a connection that has
    /// stalled — 20s is generous for a small JSON envelope over a live
    /// connection and short enough that a stuck request gives the slot back
    /// well before the caller's own retry/backoff would have moved on anyway.
    public static let timeoutIntervalForRequest: TimeInterval = 20
    /// Bounds the whole exchange, including any body upload/download, in case
    /// a connection keeps making slow forward progress without ever going
    /// fully idle (which is what `timeoutIntervalForRequest` catches). One
    /// minute is still short relative to how infrequently a batch is sent.
    public static let timeoutIntervalForResource: TimeInterval = 60
    /// Marks analytics traffic as background-priority so it never competes
    /// with the host app's own network requests for bandwidth or radio
    /// wake-ups — the batch getting to the backend a little later costs
    /// nothing, but a delayed screen load because analytics claimed the link
    /// first would be a regression the SDK caused.
    public static let networkServiceType: URLRequest.NetworkServiceType = .background
    /// Declines to send analytics at all under the user's Low Data Mode /
    /// constrained-network setting. `URLSession` surfaces a blocked request as
    /// a `URLError` (`.notConnectedToInternet` on most platforms), which the
    /// transport already treats as a transport failure and `IngestDisposition`
    /// already maps to "retain and retry later" — so this setting fails
    /// closed into the queue rather than the batch quietly never leaving.
    public static let allowsConstrainedNetworkAccess = false
    /// Analytics may still use an expensive link (cellular, a metered hotspot)
    /// by default — only Low Data Mode / constrained-network settings hold it
    /// back (see `allowsConstrainedNetworkAccess`). Pass `false` to also defer
    /// to "expensive" network warnings if your app wants analytics to be the
    /// first thing that backs off.
    public static let allowsExpensiveNetworkAccess = true

    /// Builds the configuration `URLSessionTransport` uses by default, so a
    /// consumer supplying their own `URLSession` can start from the same
    /// baseline (and a test can assert these values without duplicating them).
    ///
    /// Ephemeral rather than the shared/default configuration: nothing is
    /// cached to disk and no cookie store is created — `docs/schema.md` §7
    /// requires the endpoint set no cookies and the emitter store none.
    ///
    /// - Parameters:
    ///   - allowsConstrainedNetworkAccess: under the user's Low Data Mode /
    ///     constrained-network setting, the default (`false`) sends nothing at
    ///     all — the batch stays in the local queue, subject to its own caps
    ///     (oldest dropped past the cap). Pass `true` to send anyway.
    ///   - allowsExpensiveNetworkAccess: defaults to `true` (analytics may use
    ///     an expensive link, e.g. cellular). Pass `false` to hold back there
    ///     too.
    public static func defaultConfiguration(
        allowsConstrainedNetworkAccess: Bool = Self.allowsConstrainedNetworkAccess,
        allowsExpensiveNetworkAccess: Bool = Self.allowsExpensiveNetworkAccess
    ) -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieAcceptPolicy = .never
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = timeoutIntervalForRequest
        configuration.timeoutIntervalForResource = timeoutIntervalForResource
        configuration.networkServiceType = networkServiceType
        configuration.allowsConstrainedNetworkAccess = allowsConstrainedNetworkAccess
        configuration.allowsExpensiveNetworkAccess = allowsExpensiveNetworkAccess
        return configuration
    }

    /// - Parameters:
    ///   - session: defaults to a session built from ``defaultConfiguration()``.
    ///   - allowsConstrainedNetworkAccess: only consulted when `session` is
    ///     `nil` — it feeds the default session's configuration. See
    ///     ``defaultConfiguration(allowsConstrainedNetworkAccess:allowsExpensiveNetworkAccess:)``.
    ///   - allowsExpensiveNetworkAccess: same caveat as above.
    public init(
        session: URLSession? = nil,
        allowsConstrainedNetworkAccess: Bool = Self.allowsConstrainedNetworkAccess,
        allowsExpensiveNetworkAccess: Bool = Self.allowsExpensiveNetworkAccess
    ) {
        if let session {
            self.session = session
        } else {
            self.session = URLSession(configuration: Self.defaultConfiguration(
                allowsConstrainedNetworkAccess: allowsConstrainedNetworkAccess,
                allowsExpensiveNetworkAccess: allowsExpensiveNetworkAccess
            ))
        }
    }

    public func perform(_ request: URLRequest) async throws -> StatsHTTPResponse {
        // `docs/schema.md` §7: a 3xx MUST NOT be followed automatically, because a
        // redirect could move the write key to another host. `URLSession` follows
        // redirects by default, so declining them needs an explicit delegate —
        // without it the status this method returns could never be a 3xx and the
        // rule would be quietly unenforceable.
        let (data, response) = try await session.data(for: request, delegate: RedirectBlocker())
        guard let http = response as? HTTPURLResponse else {
            throw URLError(.badServerResponse)
        }
        var headers: [String: String] = [:]
        for (key, value) in http.allHeaderFields {
            if let key = key as? String, let value = value as? String {
                headers[key.lowercased()] = value
            }
        }
        return StatsHTTPResponse(statusCode: http.statusCode, headers: headers, body: data)
    }
}

/// Declines every redirect, so the 3xx surfaces as a status instead of being
/// followed. Stateless, hence safe to share.
private final class RedirectBlocker: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest
    ) async -> URLRequest? {
        nil
    }
}
