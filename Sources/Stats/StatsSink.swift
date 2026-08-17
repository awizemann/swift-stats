import Foundation

/// What a sink says happened to a batch.
///
/// The four cases are exactly the four behaviors schema §7's response table
/// prescribes for the emitter, collapsed to the only distinctions the
/// dispatcher can act on. Mapping HTTP status codes onto them is the sink's
/// job, and the mapping is normative:
///
/// | Sink sees | Returns |
/// |---|---|
/// | 202 | `.accepted` |
/// | 400, 401, any other 4xx, 3xx | `.drop(reason:)` |
/// | 413 | `.tooLarge` — the dispatcher halves the batch and reissues `batchId`s |
/// | 429 | `.retry(after: Retry-After)` |
/// | 5xx, transport error, timeout | `.retry(after: nil)` |
public enum SinkOutcome: Sendable, Hashable {
    /// Durably accepted. The dispatcher deletes the batch from the local queue.
    case accepted
    /// Retain and retry. `after` is the server's `Retry-After` when it sent
    /// one; `nil` means "use the backoff schedule".
    case retry(after: Duration?)
    /// The body was over the byte limit. The dispatcher halves the batch and
    /// retries the halves as **new** batches with new `batchId`s (§7's 413 row,
    /// §6); a single event that cannot be split is dropped and logged at `error`.
    case tooLarge
    /// Permanently undeliverable. The dispatcher deletes the batch and logs at
    /// `error`. `reason` is a short machine-ish string for the log — never
    /// event data.
    case drop(reason: String)
}

/// A transport for batches.
///
/// Declared `nonisolated protocol` so an actor can conform (the whole point of
/// the seam: a real sink holds a `URLSession`, a test sink holds an array).
///
/// **Sinks never throw.** Every transport failure must be mapped to a
/// `SinkOutcome`, because the dispatcher's decision — delete, retain, or drop —
/// is schema-normative and cannot be derived from an arbitrary Swift error.
public nonisolated protocol StatsSink: Sendable {
    func send(_ batch: StatsBatch) async -> SinkOutcome
}
