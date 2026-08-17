import Foundation
import Testing
@testable import StatsCloudflare

/// `docs/schema.md` §8 — the read contract, driven through a stubbed transport.
@Suite("StatsQuery — the §8 read contract")
struct StatsQueryTests {

    static let endpoint = try! CloudflareEndpoint(string: "https://stats.example.com")
    static let readKey = "rk_stats_test_read_key"
    static let from = StatsDay("2026-08-01")!
    static let to = StatsDay("2026-08-03")!

    static func query(_ transport: StubTransport) -> StatsQuery {
        StatsQuery(endpoint: endpoint, readKey: readKey, transport: transport)
    }

    // The §8.1 example response, verbatim from the schema.
    static let summaryJSON = """
    {
      "schema": "v1",
      "projectId": "overwatch",
      "from": "2026-08-01",
      "to": "2026-08-03",
      "includeDebug": false,
      "rows": [
        { "date": "2026-08-01", "opens": 412, "sessions": 388, "activeInstalls": 96, "events": 5104 },
        { "date": "2026-08-02", "opens": 377, "sessions": 351, "activeInstalls": 91, "events": 4712 },
        { "date": "2026-08-03", "opens": 0,   "sessions": 0,   "activeInstalls": 0,  "events": 0    }
      ]
    }
    """

    // MARK: Summary

    @Test("Decodes the §8.1 example response")
    func decodesSummary() async throws {
        let transport = StubTransport(status: 200, json: Self.summaryJSON)
        let summary = try await Self.query(transport).summary(
            projectId: "overwatch", from: Self.from, to: Self.to
        )

        #expect(summary.schema == "v1")
        #expect(summary.projectId == "overwatch")
        #expect(summary.from == Self.from)
        #expect(summary.to == Self.to)
        #expect(summary.includeDebug == false)
        #expect(summary.rows.count == 3)
        #expect(summary.rows[0].date == StatsDay("2026-08-01"))
        #expect(summary.rows[0].opens == 412)
        #expect(summary.rows[0].sessions == 388)
        #expect(summary.rows[0].activeInstalls == 96)
        #expect(summary.rows[0].events == 5104)
        // The zero-filled day is a real row with real zeros, not an absence.
        #expect(summary.rows[2].events == 0)
    }

    @Test("Builds the documented URL and sends the read key as a header")
    func buildsRequest() async throws {
        let transport = StubTransport(status: 200, json: Self.summaryJSON)
        _ = try await Self.query(transport).summary(
            projectId: "overwatch", from: Self.from, to: Self.to
        )

        let request = await transport.lastRequest
        let url = try #require(request?.url)
        #expect(url.path == "/v1/summary")
        #expect(request?.httpMethod == "GET")

        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let params = Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
        #expect(params["projectId"] == "overwatch")
        #expect(params["from"] == "2026-08-01")
        #expect(params["to"] == "2026-08-03")
        #expect(params["includeDebug"] == "false")

        #expect(request?.value(forHTTPHeaderField: "X-Stats-Read-Key") == Self.readKey)
        // The key must NOT be in the URL: a URL reaches proxy logs, crash reports
        // and os_log metadata, and a key in any of those is a leaked key.
        #expect(!url.absoluteString.contains(Self.readKey))
    }

    @Test("includeDebug: true is sent through")
    func includeDebug() async throws {
        let transport = StubTransport(status: 200, json: Self.summaryJSON)
        _ = try await Self.query(transport).summary(
            projectId: "overwatch", from: Self.from, to: Self.to, includeDebug: true
        )
        let url = try #require(await transport.lastRequest?.url)
        #expect(url.absoluteString.contains("includeDebug=true"))
    }

    // MARK: Error mapping (§8.3)

    @Test("401 maps to keyRejected")
    func keyRejected() async throws {
        let transport = StubTransport(
            status: 401,
            json: #"{"error":"unauthorized","message":"Missing, invalid, or out-of-scope key."}"#
        )
        await #expect(throws: StatsQueryError.self) {
            _ = try await Self.query(transport).summary(
                projectId: "overwatch", from: Self.from, to: Self.to
            )
        }

        // And it is specifically `.keyRejected` — a conformant backend cannot tell
        // us whether the project was out of scope or nonexistent (§8), so there is
        // one case and it must be this one.
        let again = StubTransport(status: 401, json: "{}")
        do {
            _ = try await Self.query(again).summary(
                projectId: "overwatch", from: Self.from, to: Self.to
            )
            Issue.record("Expected a throw")
        } catch StatsQueryError.keyRejected {
            // expected
        }
    }

    @Test("400 surfaces the backend's stable machine code")
    func badRequestCode() async throws {
        let transport = StubTransport(
            status: 400,
            json: #"{"error":"range_too_large","message":"A range may span at most 400 days."}"#
        )
        do {
            _ = try await Self.query(transport).summary(
                projectId: "overwatch", from: Self.from, to: Self.to
            )
            Issue.record("Expected a throw")
        } catch StatsQueryError.badRequest(let code, let message) {
            // The code is what a caller branches on, so losing it (by collapsing
            // every 400 into one case) is the failure this catches.
            #expect(code == "range_too_large")
            #expect(message.contains("400 days"))
        }
    }

    @Test("An unparseable 400 body still reports a bad request")
    func badRequestWithGarbageBody() async throws {
        let transport = StubTransport(status: 400, json: "<html>not json</html>")
        do {
            _ = try await Self.query(transport).summary(
                projectId: "overwatch", from: Self.from, to: Self.to
            )
            Issue.record("Expected a throw")
        } catch StatsQueryError.badRequest(let code, _) {
            // Misclassifying this as `.malformedResponse` would make a permanent
            // failure look like a mystery worth retrying.
            #expect(code == "bad_request")
        }
    }

    @Test("429 carries Retry-After")
    func rateLimited() async throws {
        let transport = StubTransport(status: 429, headers: ["Retry-After": "42"], json: "{}")
        do {
            _ = try await Self.query(transport).summary(
                projectId: "overwatch", from: Self.from, to: Self.to
            )
            Issue.record("Expected a throw")
        } catch StatsQueryError.rateLimited(let retryAfter) {
            #expect(retryAfter == .seconds(42))
        }
    }

    @Test("404 is a path problem, not an empty result")
    func pathNotFound() async throws {
        let transport = StubTransport(status: 404, json: #"{"error":"not_found","message":"Unknown path."}"#)
        do {
            _ = try await Self.query(transport).summary(
                projectId: "overwatch", from: Self.from, to: Self.to
            )
            Issue.record("Expected a throw")
        } catch StatsQueryError.pathNotFound {
            // expected
        }
    }

    @Test("5xx is a retriable server error")
    func serverError() async throws {
        let transport = StubTransport(status: 503, json: "{}")
        do {
            _ = try await Self.query(transport).summary(
                projectId: "overwatch", from: Self.from, to: Self.to
            )
            Issue.record("Expected a throw")
        } catch StatsQueryError.serverError(let status) {
            #expect(status == 503)
        }
    }

    @Test("A transport failure is distinct from an HTTP error")
    func transportFailure() async throws {
        let transport = StubTransport(failure: StubTransportFailure())
        do {
            _ = try await Self.query(transport).summary(
                projectId: "overwatch", from: Self.from, to: Self.to
            )
            Issue.record("Expected a throw")
        } catch StatsQueryError.transport {
            // expected
        }
    }

    @Test("A 200 with the wrong shape is a decoding failure, not silent zeros")
    func malformedResponse() async throws {
        let transport = StubTransport(status: 200, json: #"{"schema":"v1"}"#)
        do {
            _ = try await Self.query(transport).summary(
                projectId: "overwatch", from: Self.from, to: Self.to
            )
            Issue.record("Expected a throw")
        } catch StatsQueryError.malformedResponse {
            // expected
        }
    }

    // MARK: Client-side range validation

    @Test("A `to` before `from` fails without a round trip")
    func rejectsInvertedRange() async throws {
        let transport = StubTransport(status: 200, json: Self.summaryJSON)
        do {
            _ = try await Self.query(transport).summary(
                projectId: "overwatch", from: StatsDay("2026-08-05")!, to: StatsDay("2026-08-01")!
            )
            Issue.record("Expected a throw")
        } catch StatsQueryError.invalidRange {
            // And nothing was sent — the whole point of checking locally.
            #expect(await transport.requests.isEmpty)
        }
    }

    @Test("A span over 400 days fails locally, and exactly 400 does not")
    func rejectsOversizedRange() async throws {
        let tooLong = StubTransport(status: 200, json: Self.summaryJSON)
        do {
            _ = try await Self.query(tooLong).summary(
                projectId: "overwatch", from: StatsDay("2025-01-01")!, to: StatsDay("2026-02-05")!
            )
            Issue.record("Expected a throw")
        } catch StatsQueryError.invalidRange {
            #expect(await tooLong.requests.isEmpty)
        }

        // The other side of the boundary must go through, or the client is
        // stricter than the contract.
        let exactly400 = StubTransport(status: 200, json: Self.summaryJSON)
        _ = try await Self.query(exactly400).summary(
            projectId: "overwatch", from: StatsDay("2025-01-01")!, to: StatsDay("2026-02-04")!
        )
        #expect(await exactly400.requests.count == 1)
    }

    // MARK: /v1/events/top

    @Test("Decodes the §8.2 example without a name")
    func decodesTopEvents() async throws {
        let json = """
        {
          "schema": "v1", "projectId": "overwatch",
          "from": "2026-08-01", "to": "2026-08-03", "includeDebug": false,
          "name": null, "limit": 20,
          "rows": [
            { "name": "app_open",       "count": 789, "installs": 96 },
            { "name": "project_opened", "count": 512, "installs": 88 }
          ]
        }
        """
        let transport = StubTransport(status: 200, json: json)
        let top = try await Self.query(transport).topEvents(
            projectId: "overwatch", from: Self.from, to: Self.to
        )

        #expect(top.limit == 20)
        #expect(top.rows.map(\.name) == ["app_open", "project_opened"])
        #expect(top.rows[0].count == 789)
        #expect(top.rows[0].installs == 96)

        let url = try #require(await transport.lastRequest?.url)
        #expect(url.path == "/v1/events/top")
        #expect(url.absoluteString.contains("limit=20"))
        // No `name` parameter at all — sending `name=` would ask for the breakdown
        // of an event literally named "", which is a different request.
        #expect(!url.absoluteString.contains("name="))
    }

    @Test("Decodes the §8.2 example with a name, including the null row")
    func decodesPropBreakdown() async throws {
        let json = """
        {
          "schema": "v1", "projectId": "overwatch",
          "from": "2026-08-01", "to": "2026-08-03", "includeDebug": false,
          "name": "project_opened", "limit": 20,
          "rows": [
            { "prop": "cached",  "value": true,        "count": 400, "installs": 80 },
            { "prop": "section", "value": "analytics", "count": 301, "installs": 71 },
            { "prop": "section", "value": "overview",  "count": 188, "installs": 63 },
            { "prop": "section", "value": null,        "count": 23,  "installs": 9  }
          ]
        }
        """
        let transport = StubTransport(status: 200, json: json)
        let breakdown = try await Self.query(transport).propBreakdown(
            projectId: "overwatch", name: "project_opened", from: Self.from, to: Self.to
        )

        #expect(breakdown.name == "project_opened")
        #expect(breakdown.rows.count == 4)
        // A bool prop decodes as `.bool`, not as the string "true" — the two are
        // different prop values and collapsing them loses information.
        #expect(breakdown.rows[0].value == .bool(true))
        #expect(breakdown.rows[1].value == .string("analytics"))
        // The null row is `nil`, and is last.
        #expect(breakdown.rows[3].value == nil)
        #expect(breakdown.rows[3].count == 23)

        let url = try #require(await transport.lastRequest?.url)
        #expect(url.absoluteString.contains("name=project_opened"))
    }

    @Test("An unknown event name is an empty breakdown, not an error")
    func unknownNameIsEmpty() async throws {
        let json = """
        {
          "schema": "v1", "projectId": "overwatch",
          "from": "2026-08-01", "to": "2026-08-03", "includeDebug": false,
          "name": "never_emitted", "limit": 20, "rows": []
        }
        """
        let transport = StubTransport(status: 200, json: json)
        let breakdown = try await Self.query(transport).propBreakdown(
            projectId: "overwatch", name: "never_emitted", from: Self.from, to: Self.to
        )
        #expect(breakdown.rows.isEmpty)
    }

    @Test("A numeric breakdown value is rejected rather than silently coerced")
    func numericPropValueRejected() async throws {
        // §8.2 omits numeric props from breakdowns in v1, so there is no `.number`
        // case. A backend that sent one is not conformant, and quietly turning it
        // into the string "6" would hide that.
        let json = """
        {
          "schema": "v1", "projectId": "overwatch",
          "from": "2026-08-01", "to": "2026-08-03", "includeDebug": false,
          "name": "project_opened", "limit": 20,
          "rows": [{ "prop": "tile_count", "value": 6, "count": 10, "installs": 3 }]
        }
        """
        let transport = StubTransport(status: 200, json: json)
        do {
            _ = try await Self.query(transport).propBreakdown(
                projectId: "overwatch", name: "project_opened", from: Self.from, to: Self.to
            )
            Issue.record("Expected a throw")
        } catch StatsQueryError.malformedResponse {
            // expected
        }
    }
}

@Suite("CloudflareEndpoint — §7 transport requirements")
struct CloudflareEndpointTests {

    @Test("Accepts HTTPS")
    func acceptsHTTPS() throws {
        let endpoint = try CloudflareEndpoint(string: "https://stats.example.com")
        #expect(endpoint.baseURL.absoluteString == "https://stats.example.com")
    }

    @Test("Refuses plain http on a non-loopback host")
    func refusesInsecure() {
        // §7: "An emitter MUST refuse a plain-`http` base URL except for
        // `localhost`/`127.0.0.1` during development." A write key over cleartext
        // is the thing being prevented.
        #expect(throws: CloudflareEndpoint.Failure.insecureScheme(host: "stats.example.com")) {
            _ = try CloudflareEndpoint(string: "http://stats.example.com")
        }
        // A LAN address is another machine, so it gets no exemption either.
        #expect(throws: (any Error).self) {
            _ = try CloudflareEndpoint(string: "http://192.168.1.10:8787")
        }
    }

    @Test("Allows plain http on loopback for development")
    func allowsLoopback() throws {
        for host in ["http://localhost:8787", "http://127.0.0.1:8787"] {
            _ = try CloudflareEndpoint(string: host)
        }
    }

    @Test("Rejects a URL with no host")
    func rejectsRelative() {
        #expect(throws: (any Error).self) { _ = try CloudflareEndpoint(string: "/v1/events") }
        #expect(throws: (any Error).self) { _ = try CloudflareEndpoint(string: "not a url at all") }
    }

    @Test("Normalizes a trailing slash so paths do not double up")
    func normalizesTrailingSlash() throws {
        // Without normalization this yields `https://host//v1/summary`, which a
        // strict router 404s.
        let endpoint = try CloudflareEndpoint(string: "https://stats.example.com/")
        #expect(endpoint.url(path: "/v1/summary").absoluteString == "https://stats.example.com/v1/summary")
    }

    @Test("Preserves a base path prefix")
    func preservesBasePath() throws {
        let endpoint = try CloudflareEndpoint(string: "https://example.com/stats")
        #expect(endpoint.url(path: "/v1/summary").absoluteString == "https://example.com/stats/v1/summary")
    }
}
