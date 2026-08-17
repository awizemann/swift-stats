import Foundation
import Stats
import os

private nonisolated let logger = Logger(subsystem: "com.wizemann.stats", category: "CloudflareSink")

/// Posts batches to a `stats-worker` deployment's `POST /v1/events`.
///
/// The write key ships inside the app binary, which is fine by design: schema
/// §2.4 makes it append-only and scoped to exactly one project, so a leaked
/// write key can add events to that one project and nothing else. It still never
/// appears in a log line here.
public struct CloudflareSink: StatsSink {
    private let endpoint: CloudflareEndpoint
    private let writeKey: String
    private let transport: any StatsTransport

    /// - Parameters:
    ///   - endpoint: the worker's base URL. HTTPS, or loopback for development.
    ///   - writeKey: the project-scoped **write** key.
    ///   - transport: injectable for tests; defaults to `URLSessionTransport`.
    public init(
        endpoint: CloudflareEndpoint,
        writeKey: String,
        transport: any StatsTransport = URLSessionTransport()
    ) {
        self.endpoint = endpoint
        self.writeKey = writeKey
        self.transport = transport
    }

    public func send(_ batch: StatsBatch) async -> SinkOutcome {
        let body: Data
        do {
            // `batch.serialized()`, never a local `JSONEncoder`. The dispatcher
            // enforced §5's 256 KiB limit against exactly these bytes when it
            // decided how to split, so encoding differently here would put a
            // different byte count on the wire than the one that was checked.
            body = try batch.serialized()
        } catch {
            // A batch that cannot be encoded will not encode on a retry either.
            logger.error("Batch failed to encode; dropping.")
            return .drop(reason: "The batch could not be encoded as JSON.")
        }

        var request = URLRequest(url: endpoint.url(path: StatsCloudflare.ingestPath))
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        request.setValue(writeKey, forHTTPHeaderField: "X-Stats-Key")
        request.setValue(
            "swift-stats/\(Stats.sdkVersion)",
            forHTTPHeaderField: "User-Agent"
        )
        // §7: the endpoint sets no cookies and an emitter stores none.
        request.httpShouldHandleCookies = false
        // No `Content-Encoding`. §7 makes gzip optional and non-negotiated, and
        // the Cloudflare backend does not accept it — a gzipped body would be a
        // 400, which is a permanent drop.

        let response: StatsHTTPResponse
        do {
            response = try await transport.perform(request)
        } catch {
            // §7: a transport error is RETAIN, and is never counted as a drop.
            logger.debug("Ingest transport failure; retaining batch.")
            return Self.outcome(for: .transportFailure)
        }

        let disposition = IngestDisposition.from(
            statusCode: response.statusCode,
            headers: response.headers
        )
        if case .drop(let reason) = disposition {
            logger.error("Ingest dropped a batch: \(reason, privacy: .public)")
        }
        return Self.outcome(for: disposition)
    }

    /// Translates the tested §7 policy into the core SDK's vocabulary.
    ///
    /// A total, case-for-case mapping with nothing lost: `.resplit` becomes
    /// `SinkOutcome.tooLarge`, which is what makes the dispatcher halve the batch
    /// and retry the halves under new `batchId`s — §7's actual 413 requirement,
    /// rather than the permanent drop a sink without that case would have to
    /// settle for.
    static func outcome(for disposition: IngestDisposition) -> SinkOutcome {
        switch disposition {
        case .accepted:
            return .accepted
        case .retry(let after):
            return .retry(after: after)
        case .drop(let reason):
            return .drop(reason: reason)
        case .resplit:
            return .tooLarge
        }
    }
}
