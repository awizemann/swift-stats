import Foundation

/// What an emitter must do with a batch, given the ingest response.
///
/// This is the whole of `docs/schema.md` §7's retry policy as a pure function of
/// `(statusCode, headers)` — see ``from(statusCode:headers:)``. It is a separate
/// type from the core SDK's `SinkOutcome` on purpose, and `CloudflareSink`
/// translates one to the other case-for-case:
///
///     .accepted          -> SinkOutcome.accepted
///     .retry(after:)     -> SinkOutcome.retry(after:)
///     .drop(reason:)     -> SinkOutcome.drop(reason:)
///
/// The split exists so that the part worth testing — the status table, where
/// getting a case wrong means either losing data permanently or retrying a
/// hopeless batch forever — is testable without a network, without a `StatsBatch`
/// to encode, and without waiting on the core target. `CloudflareSink` on top of
/// it is a five-line adapter with nothing to get wrong.
public enum IngestDisposition: Sendable, Equatable {
    /// 202. Durably written; delete the batch from the local queue.
    case accepted

    /// Retain the batch and retry. `after` is the server's `Retry-After` when it
    /// gave one; `nil` means "use the §7 backoff schedule".
    case retry(after: Duration?)

    /// Permanent. Drop the batch and log at `error`; it will never become valid.
    case drop(reason: String)

    /// Re-split into smaller batches with **new** `batchId`s and retry those. A
    /// distinct case from `.retry` because retrying the *same* bytes after a 413
    /// is an infinite loop — the batch is not too big by accident.
    case resplit

    /// Maps an ingest response to the required behavior, per §7's response table.
    ///
    /// - Parameters:
    ///   - statusCode: the HTTP status. A transport failure is not a status; see
    ///     ``transportFailure``.
    ///   - headers: response headers, matched case-insensitively.
    public static func from(statusCode: Int, headers: [String: String] = [:]) -> IngestDisposition {
        let lowered = Dictionary(
            headers.map { ($0.key.lowercased(), $0.value) },
            uniquingKeysWith: { _, last in last }
        )

        switch statusCode {
        case 202:
            return .accepted

        // §7 documents only 202 as success. Another 2xx is a backend that is not
        // following the contract, and treating it as success would hide that —
        // but dropping the batch over it would lose data that may well have been
        // written. Retry is the safe reading: the batch survives, and the
        // duplicate `batchId` makes a re-delivery a no-op (§6).
        case 200...299:
            return .retry(after: nil)

        case 413:
            return .resplit

        case 429:
            return .retry(after: retryAfter(from: lowered))

        case 400:
            return .drop(reason: "400 Bad Request — the batch is malformed and will never be valid.")

        case 401:
            return .drop(reason: "401 Unauthorized — the write key is missing, unknown or revoked.")

        // §7: a 3xx MUST NOT be followed automatically, because a redirect could
        // move the write key to another host. It is a permanent drop.
        case 300...399:
            return .drop(reason: "3xx redirect — refused; a redirect could move the write key.")

        // §7: "Any other 4xx (403, 404, 405, 415…) — misconfiguration. Drop the
        // batch, log at error. Treat like 400."
        case 400...499:
            return .drop(reason: "\(statusCode) — misconfiguration; treated as a permanent drop.")

        case 500...599:
            // A `Retry-After` on a 5xx is not required by §7, but honoring one
            // when present is strictly better than ignoring it.
            return .retry(after: retryAfter(from: lowered))

        default:
            // 1xx, or a status outside HTTP's range. Not a documented outcome;
            // retain rather than drop, since the alternative loses data over a
            // response nobody specified.
            return .retry(after: nil)
        }
    }

    /// A transport failure — offline, DNS, TLS, timeout. §7: retain, same as 5xx,
    /// and "never counted as a drop".
    public static let transportFailure = IngestDisposition.retry(after: nil)

    /// Parses `Retry-After` as **integer seconds**, which is the only form §7
    /// specifies ("`Retry-After` (seconds, integer)").
    ///
    /// The HTTP-date form is deliberately not parsed. It is legal HTTP but not in
    /// the schema, and misreading a date as a duration could park a batch for
    /// years — returning `nil` falls back to the §7 backoff, which is bounded at
    /// 5 minutes per attempt. A negative or absurd value is treated the same way.
    static func retryAfter(from headers: [String: String]) -> Duration? {
        guard let raw = headers["retry-after"]?.trimmingCharacters(in: .whitespaces),
              let seconds = Int(raw),
              seconds > 0
        else { return nil }
        // Cap at the §7 per-attempt ceiling of 5 minutes: a cooperative client
        // should not be talked into a longer sleep than the schedule allows.
        return .seconds(min(seconds, 300))
    }
}
