import Testing
@testable import StatsCloudflare

/// `docs/schema.md` §7's response table, which is the emitter's retry policy.
///
/// These are the highest-stakes assertions in the target: a status mapped to
/// `.drop` that should retry loses data permanently, and one mapped to `.retry`
/// that should drop retries a hopeless batch until the 24-hour ceiling — or, with
/// a bad key, turns the app into a self-inflicted DoS. Each case below fails on
/// exactly the mistake a hand-written `if` chain tends to make.
@Suite("IngestDisposition — §7 response table")
struct IngestDispositionTests {

    @Test("202 is accepted")
    func accepted() {
        #expect(IngestDisposition.from(statusCode: 202) == .accepted)
    }

    @Test("400 and 401 are permanent drops")
    func permanentDrops() {
        // A retry here is the specific bug §7 calls out: "retrying a bad key is a
        // self-inflicted DoS", and a 400 batch "will never become valid".
        for status in [400, 401] {
            guard case .drop = IngestDisposition.from(statusCode: status) else {
                Issue.record("\(status) must be a permanent drop")
                continue
            }
        }
    }

    @Test("413 asks for a re-split rather than a plain retry")
    func payloadTooLarge() {
        // Discriminating: `.retry` here would resend the same oversized bytes
        // forever, since the batch is not too big by accident.
        #expect(IngestDisposition.from(statusCode: 413) == .resplit)
    }

    @Test("Any other 4xx is treated like 400")
    func otherClientErrors() {
        for status in [402, 403, 404, 405, 409, 415, 418, 422, 451, 499] {
            guard case .drop = IngestDisposition.from(statusCode: status) else {
                Issue.record("\(status) must be dropped like a 400")
                continue
            }
        }
    }

    @Test("A 3xx is refused, not followed")
    func redirectsAreDropped() {
        // §7: a redirect could move the write key to another host.
        for status in [301, 302, 303, 307, 308] {
            guard case .drop = IngestDisposition.from(statusCode: status) else {
                Issue.record("\(status) must be dropped, never followed")
                continue
            }
        }
    }

    @Test("5xx is retained and retried")
    func serverErrorsRetry() {
        for status in [500, 502, 503, 504, 599] {
            #expect(IngestDisposition.from(statusCode: status) == .retry(after: nil))
        }
    }

    @Test("A transport failure retains, exactly like a 5xx")
    func transportFailureRetries() {
        // §7: "Transport error / timeout … Retain. Same as 5xx. Never counted as
        // a drop."
        #expect(IngestDisposition.transportFailure == .retry(after: nil))
    }

    @Test("A 2xx that is not 202 retains rather than assuming success")
    func unexpectedSuccessRetries() {
        // §7 documents only 202 as success. Dropping on a 200 would discard a
        // batch that may not have been written; retrying is safe because a
        // duplicate `batchId` is a no-op (§6).
        #expect(IngestDisposition.from(statusCode: 200) == .retry(after: nil))
        #expect(IngestDisposition.from(statusCode: 204) == .retry(after: nil))
    }

    @Suite("429 and Retry-After")
    struct RetryAfterTests {
        @Test("429 honors an integer Retry-After")
        func honorsRetryAfter() {
            let disposition = IngestDisposition.from(
                statusCode: 429,
                headers: ["Retry-After": "30"]
            )
            #expect(disposition == .retry(after: .seconds(30)))
        }

        @Test("Retry-After is matched case-insensitively")
        func caseInsensitiveHeader() {
            // Discriminating: a `headers["Retry-After"]` lookup against a
            // lowercased dictionary silently misses and falls back to the
            // backoff, which looks like it works.
            #expect(
                IngestDisposition.from(statusCode: 429, headers: ["retry-after": "12"])
                    == .retry(after: .seconds(12))
            )
            #expect(
                IngestDisposition.from(statusCode: 429, headers: ["RETRY-AFTER": "12"])
                    == .retry(after: .seconds(12))
            )
        }

        @Test("429 without Retry-After falls back to the backoff schedule")
        func missingRetryAfter() {
            #expect(IngestDisposition.from(statusCode: 429) == .retry(after: nil))
        }

        @Test("A non-integer Retry-After is ignored, not misread")
        func httpDateIsIgnored() {
            // The HTTP-date form is legal HTTP but not in the schema. Misreading
            // it as a duration could park a batch for years, so it must fall back
            // to the bounded §7 backoff.
            for value in ["Wed, 21 Oct 2026 07:28:00 GMT", "1.5", "soon", "", "-5", "0"] {
                #expect(
                    IngestDisposition.from(statusCode: 429, headers: ["retry-after": value])
                        == .retry(after: nil),
                    "Retry-After: \(value) must be ignored"
                )
            }
        }

        @Test("Retry-After is capped at the §7 per-attempt ceiling of 5 minutes")
        func capped() {
            #expect(
                IngestDisposition.from(statusCode: 429, headers: ["retry-after": "86400"])
                    == .retry(after: .seconds(300))
            )
        }

        @Test("Surrounding whitespace is tolerated")
        func trimsWhitespace() {
            #expect(
                IngestDisposition.from(statusCode: 429, headers: ["retry-after": " 45 "])
                    == .retry(after: .seconds(45))
            )
        }

        @Test("A 5xx also honors Retry-After when present")
        func serverErrorHonorsRetryAfter() {
            #expect(
                IngestDisposition.from(statusCode: 503, headers: ["retry-after": "7"])
                    == .retry(after: .seconds(7))
            )
        }
    }
}
