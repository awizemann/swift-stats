import Foundation

/// A validated `stats-worker` base URL.
///
/// Validation happens once, here, rather than on every request: `docs/schema.md`
/// §7 requires the endpoint be HTTPS and requires an emitter to *refuse* a plain
/// `http` base URL except for `localhost`/`127.0.0.1` during development. Making
/// that a failable initializer means a misconfigured host is a configuration
/// error the consumer sees immediately, not a stream of dropped batches.
public struct CloudflareEndpoint: Sendable, Hashable {
    /// The base URL, with any trailing slash removed so path joining is exact.
    public let baseURL: URL

    public enum Failure: Error, Sendable, Equatable {
        /// A scheme other than `https`, on a host that is not loopback.
        case insecureScheme(host: String)
        /// Not an absolute URL with a scheme and host.
        case notAbsolute
    }

    public init(_ url: URL) throws {
        guard let scheme = url.scheme?.lowercased(), let host = url.host, !host.isEmpty else {
            throw Failure.notAbsolute
        }

        // The loopback exemption is exactly the two names §7 names, plus IPv6
        // loopback, which is what `localhost` resolves to on a modern Mac and so
        // is the same development case under a different spelling. Notably NOT
        // exempted: a private-range address like `192.168.x.x` or a `.local`
        // hostname — those are other machines, and a write key crossing a LAN in
        // cleartext is the thing this check is for.
        let loopback = ["localhost", "127.0.0.1", "::1", "[::1]"]
        if scheme != "https" && !loopback.contains(host.lowercased()) {
            throw Failure.insecureScheme(host: host)
        }

        var trimmed = url.absoluteString
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        guard let normalized = URL(string: trimmed) else { throw Failure.notAbsolute }
        self.baseURL = normalized
    }

    /// Convenience for a string host. Fails for an unparseable string.
    public init(string: String) throws {
        guard let url = URL(string: string) else { throw Failure.notAbsolute }
        try self.init(url)
    }

    /// Joins a library-constant path onto the validated base URL.
    ///
    /// Both fallbacks are unreachable through the public API — `baseURL` was
    /// validated to be absolute in `init`, and `path` is always one of
    /// `StatsCloudflare`'s constants — but a trap in a URL builder is a crash in
    /// a consumer's app, and returning the base URL unmodified merely produces a
    /// 404 the caller can see.
    func url(path: String, query: [URLQueryItem] = []) -> URL {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return baseURL
        }
        components.path += path
        components.queryItems = query.isEmpty ? nil : query
        return components.url ?? baseURL
    }
}
