// ============================================================================
//  NOT YET COMPILED — excluded from `StatsCloudflareTests` in Package.swift
// ============================================================================
//
//  Paired with Sources/StatsCloudflare/CloudflareSink.swift, which needs
//  `StatsSink`, `SinkOutcome` and `StatsBatch` from `Sources/Stats`. Remove both
//  `exclude:` entries in Package.swift once those exist, then `swift test`.
//
//  The §7 status table these tests lean on is ALREADY covered, and covered
//  without needing the core types, by `IngestDispositionTests`. What is left here
//  is the request construction and the `IngestDisposition -> SinkOutcome`
//  translation.
//
//  The `makeBatch()` helper below is a placeholder: `StatsBatch`'s initializer is
//  the other agent's to define, so fill it in from the real one at merge time.
// ============================================================================

import Foundation
import Testing
import Stats
@testable import StatsCloudflare

@Suite("CloudflareSink — §7 ingest")
struct CloudflareSinkTests {

    static let endpoint = try! CloudflareEndpoint(string: "https://stats.example.com")
    static let writeKey = "sk_stats_test_write_key"

    static func sink(_ transport: StubTransport) -> CloudflareSink {
        CloudflareSink(endpoint: endpoint, writeKey: writeKey, transport: transport)
    }

    /// TODO(merge): build a real `StatsBatch` with the core's initializer.
    static func makeBatch() -> StatsBatch {
        fatalError("Fill in from the core StatsBatch initializer at merge time.")
    }

    @Test("Posts to /v1/events with the write key and a JSON content type")
    func buildsRequest() async throws {
        let transport = StubTransport(status: 202, json: #"{"accepted":1}"#)
        _ = await Self.sink(transport).send(Self.makeBatch())

        let request = try #require(await transport.lastRequest)
        #expect(request.url?.path == "/v1/events")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "X-Stats-Key") == Self.writeKey)
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json; charset=utf-8")
        // §7: gzip is optional and non-negotiated, and this backend rejects it
        // with a 400 — which is a permanent drop. So the emitter must never set it.
        #expect(request.value(forHTTPHeaderField: "Content-Encoding") == nil)
        // The read key must never be sent to the ingest endpoint.
        #expect(request.value(forHTTPHeaderField: "X-Stats-Read-Key") == nil)
        // The key must not be in the URL, only the header.
        #expect(request.url?.absoluteString.contains(Self.writeKey) == false)
    }

    @Test("202 accepts, so the emitter deletes the batch")
    func accepts() async {
        let outcome = await Self.sink(StubTransport(status: 202)).send(Self.makeBatch())
        guard case .accepted = outcome else {
            Issue.record("202 must be .accepted")
            return
        }
    }

    @Test("Every §7 status maps to the documented outcome")
    func statusMapping() async {
        // The exhaustive table lives in IngestDispositionTests; this asserts the
        // translation into SinkOutcome does not lose or invert a case.
        let expectations: [(Int, String)] = [
            (202, "accepted"),
            (400, "drop"),
            (401, "drop"),
            (403, "drop"),
            (413, "drop"),   // see CloudflareSink.outcome(for:) on the lossy step
            (429, "retry"),
            (500, "retry"),
            (503, "retry"),
        ]
        for (status, expected) in expectations {
            let outcome = await Self.sink(StubTransport(status: status)).send(Self.makeBatch())
            let actual: String
            switch outcome {
            case .accepted: actual = "accepted"
            case .retry: actual = "retry"
            case .drop: actual = "drop"
            }
            #expect(actual == expected, "status \(status)")
        }
    }

    @Test("429 passes Retry-After through to the outcome")
    func retryAfter() async {
        let transport = StubTransport(status: 429, headers: ["Retry-After": "30"])
        let outcome = await Self.sink(transport).send(Self.makeBatch())
        guard case .retry(let after) = outcome else {
            Issue.record("429 must retry")
            return
        }
        #expect(after == .seconds(30))
    }

    @Test("A transport failure retains the batch and is never a drop")
    func transportFailureRetains() async {
        let outcome = await Self.sink(StubTransport(failure: StubTransportFailure())).send(Self.makeBatch())
        guard case .retry = outcome else {
            Issue.record("A transport failure must retain, per §7")
            return
        }
    }
}
