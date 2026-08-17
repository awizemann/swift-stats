// ============================================================================
//  NOT YET COMPILED — excluded from the `StatsCloudflare` target in Package.swift
// ============================================================================
//
//  This file conforms to `StatsSink` from `Sources/Stats`, which at the time of
//  writing contains only the P12a placeholder. The core protocol and its
//  supporting types are being written concurrently, to exactly this contract:
//
//      public nonisolated protocol StatsSink: Sendable {
//          func send(_ batch: StatsBatch) async -> SinkOutcome
//      }
//      public enum SinkOutcome: Sendable {
//          case accepted
//          case retry(after: Duration?)
//          case drop(reason: String)
//      }
//      public struct StatsBatch: Sendable, Codable { ... }
//
//  Rather than duplicate those types here — which would produce a redeclaration
//  conflict the moment the core lands, and would let this file compile against a
//  shape the core does not actually have — the file is written against the real
//  names and excluded from the build.
//
//  TO ENABLE, once `Sources/Stats` defines `StatsSink`, `SinkOutcome` and
//  `StatsBatch`:
//
//    1. Delete the `exclude:` entry for this file on the `StatsCloudflare`
//       target in Package.swift.
//    2. Delete the `exclude:` entry for `CloudflareSinkTests.swift` on the
//       `StatsCloudflareTests` target.
//    3. `swift build --target StatsCloudflare && swift test`
//
//  Everything genuinely worth testing here is already built and tested:
//  `IngestDisposition.from(statusCode:headers:)` is the whole of §7's retry
//  policy as a pure function, and `IngestDispositionTests` covers it. What
//  remains below is request construction plus a case-for-case translation of
//  `IngestDisposition` into `SinkOutcome`.
//
// ============================================================================

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
            let encoder = JSONEncoder()
            // Not `.sortedKeys` and not `.prettyPrinted`: §5's 256 KiB limit is on
            // the serialized bytes, so the encoding must stay as compact as the
            // emitter assumed when it split the batch.
            body = try encoder.encode(batch)
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
    /// One lossy step, called out because it matters: `IngestDisposition` has a
    /// distinct `.resplit` case for 413, but `SinkOutcome` does not, so a 413
    /// becomes `.drop`. That follows the agreed core contract (413 drops), and it
    /// is safe — dropping loses one oversized batch, whereas retrying the same
    /// bytes would loop forever. It does forgo §7's preferred behavior of
    /// re-splitting into smaller batches with new `batchId`s. If `SinkOutcome`
    /// ever gains a re-split case, this is the one line to change.
    static func outcome(for disposition: IngestDisposition) -> SinkOutcome {
        switch disposition {
        case .accepted:
            return .accepted
        case .retry(let after):
            return .retry(after: after)
        case .drop(let reason):
            return .drop(reason: reason)
        case .resplit:
            return .drop(
                reason: "413 Payload Too Large — the batch exceeds 256 KiB and cannot be re-split here."
            )
        }
    }
}
