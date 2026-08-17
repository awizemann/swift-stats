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

    /// - Parameter session: defaults to an ephemeral session so nothing is
    ///   cached to disk and no cookie store is created — `docs/schema.md` §7
    ///   requires the endpoint set no cookies and the emitter store none.
    public init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.ephemeral
            configuration.httpCookieAcceptPolicy = .never
            configuration.httpShouldSetCookies = false
            configuration.urlCache = nil
            configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
            self.session = URLSession(configuration: configuration)
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
