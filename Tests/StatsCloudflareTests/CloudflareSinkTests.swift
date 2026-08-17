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

    /// A minimal but genuinely valid §1 envelope.
    static func makeBatch() -> StatsBatch {
        StatsBatch(
            batchId: "8B0B8AF0-3E9F-4F9F-9F1D-4E45B0A9C0D1",
            sentAt: Date(timeIntervalSince1970: 1_786_928_400),
            context: StatsContext(
                sdkVersion: Stats.sdkVersion,
                appVersion: "1.4.2",
                appBuild: "318",
                bundleId: "com.wizemann.Overwatch",
                osName: "macOS",
                osVersion: "15.4.1",
                deviceModel: "Mac15,3",
                arch: "arm64",
                locale: "en_US",
                region: "US",
                screenWidth: 1512,
                screenHeight: 982,
                screenScale: 2.0,
                isDebug: false,
                isTestFlight: false,
                colorScheme: "dark"
            ),
            events: [
                StatsEvent(
                    name: "project_opened",
                    ts: Date(timeIntervalSince1970: 1_786_928_391),
                    sessionId: "1786012978-40371852",
                    installId: String(repeating: "a", count: 64),
                    appId: "com.wizemann.Overwatch",
                    seq: 41,
                    props: ["section": "analytics", "cached": true]
                )
            ]
        )
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
            // §7's actual 413 requirement: re-split with new batchIds, which is
            // what `.tooLarge` asks the dispatcher to do. A `.drop` here would
            // silently discard an oversized batch instead.
            (413, "tooLarge"),
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
            case .tooLarge: actual = "tooLarge"
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
