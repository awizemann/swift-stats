import Foundation
import os

private nonisolated let logger = Logger(subsystem: StatsLog.subsystem, category: "Dispatcher")

/// Decides *when* to send and what to do with the answer.
///
/// The three flush triggers of the plan — count, interval, background — plus the
/// normative retry policy of schema §7: exponential from 1 s, doubling, full
/// jitter, capped at 5 minutes per attempt, one request in flight, a 24-hour
/// retention ceiling, permanent drops deleted immediately.
///
/// Concurrency shape: exactly one flush runs at a time, enforced by chaining
/// each flush onto the previous one's `Task`. That is stronger than a "busy"
/// flag — a `flush()` caller awaits *its own* work rather than returning while
/// someone else's flush is mid-flight, which is what a consumer calling
/// `flush()` on background actually means.
actor Dispatcher {
    private let store: EventStore
    private let configuration: StatsConfiguration
    private var flushTask: Task<Void, Never>?
    private var flushGeneration = 0
    private var timerTask: Task<Void, Never>?
    private var retryTask: Task<Void, Never>?
    private var lastFlushAt: Duration?
    private var consecutiveRetries = 0
    /// The batch a `retry` outcome left at the head of the queue: its id and its
    /// exact event count. Both are pinned so the next attempt sends *the same
    /// batch* — §6 requires the `batchId` to survive a retry, and dedupe by
    /// `batchId` would silently swallow any events we appended to it in the
    /// meantime.
    private var retainedBatch: (batchId: String, firstID: Int, lastID: Int, recordCount: Int)?
    /// Monotonic reading before which no *automatic* trigger may flush: it is
    /// what makes the §7 backoff a real wait rather than a suggestion a chatty
    /// app can talk over.
    private var retryNotBefore: Duration?
    /// Monotonic reading of the first *attempt* on the batch currently at the
    /// head. §7's 24-hour ceiling is a retention ceiling on delivery attempts,
    /// not on how old an event is: a device that was offline for two days should
    /// still get to try, so the ceiling starts when the first attempt failed.
    private var firstAttemptAt: Duration?
    /// Set by a `.tooLarge` outcome: the next attempt sends at most this many
    /// events, as a new batch with a new id (§7's 413 row).
    private var splitBudget: Int?

    private var clock: any StatsClock { configuration.clock }
    private static let maxEventsPerBatch = 100
    private static let maxBytesPerBatch = 262_144

    init(store: EventStore, configuration: StatsConfiguration) {
        self.store = store
        self.configuration = configuration
    }

    // MARK: Triggers

    /// Appends one event and applies the count and interval triggers.
    ///
    /// The event is on disk before this returns; the flush it may trigger is
    /// not awaited, so `track()` never blocks on the network.
    func enqueue(_ records: [EventStore.Record]) async {
        let depth = await store.append(records)

        if isBackingOff {
            // A retry is scheduled; sending the same failing batch now would
            // defeat the backoff and, under an outage, hammer the backend at
            // event rate.
            return
        }
        if depth >= configuration.flushAt {
            startFlush()
            return
        }
        if let last = lastFlushAt, clock.monotonicNow() - last >= configuration.flushInterval {
            startFlush()
            return
        }
        if lastFlushAt == nil {
            // First event of the process: start the interval from here, so the
            // first flush is one interval after the first event and not
            // immediate.
            lastFlushAt = clock.monotonicNow()
        }
        scheduleIntervalFlush()
    }

    /// Awaits a flush attempt. Used by `StatsClient.flush()`, by
    /// `applicationDidEnterBackground()` and by `reset()`.
    func flushNow() async {
        await startFlush().value
    }

    /// Discards the queue without sending — opt-out and consent revocation.
    ///
    /// An in-flight flush is cancelled too: a request already on the wire cannot
    /// be recalled, but `performFlush` checks cancellation between batches, so
    /// revocation stops the *next* batch from being sent. `retainedBatch` is
    /// cleared because the events it pinned no longer exist.
    func discardAll() async {
        cancelPendingWork()
        flushTask?.cancel()
        retainedBatch = nil
        retryNotBefore = nil
        firstAttemptAt = nil
        splitBudget = nil
        consecutiveRetries = 0
        await store.removeAll()
    }

    /// Awaits the flush chain — every send that has already been triggered.
    ///
    /// Deliberately does **not** await the interval timer or a scheduled retry:
    /// those are *waiting* by design, and awaiting a wait would turn a test into
    /// a deadlock (with a `ManualClock`) or a sleep (with the real one). A test
    /// drives those forward by advancing its clock.
    func waitForFlushes() async {
        for _ in 0..<64 {
            guard let flush = flushTask else { return }
            let generation = flushGeneration
            await flush.value
            // `Task` is a value type, so identity is tracked with a counter:
            // if nothing newer was chained on, the queue is drained.
            if flushGeneration == generation {
                flushTask = nil
                return
            }
        }
        logger.error("waitForFlushes gave up after 64 rounds — flushes are chaining indefinitely")
    }

    /// Cancels the interval timer and any scheduled retry. Queued events stay on
    /// disk; the next launch picks them up.
    func shutdown() async {
        cancelPendingWork()
        // Cancel the in-flight flush too, and wait for it: otherwise its
        // `store.remove` lands after the owner believed the client was torn down.
        flushTask?.cancel()
        await flushTask?.value
        flushTask = nil
    }

    /// True while a scheduled retry's delay has not elapsed.
    private var isBackingOff: Bool {
        guard let retryNotBefore else { return false }
        return clock.monotonicNow() < retryNotBefore
    }

    private func cancelPendingWork() {
        timerTask?.cancel()
        timerTask = nil
        retryTask?.cancel()
        retryTask = nil
    }

    @discardableResult
    private func startFlush(force: Bool = false) -> Task<Void, Never> {
        // Chain, do not fork: `previous?.value` is what makes "at most one
        // request in flight" (§7) true even under a burst of triggers.
        let previous = flushTask
        flushGeneration += 1
        let generation = flushGeneration
        let task = Task { [weak self] in
            await previous?.value
            await self?.performFlush(force: force)
            // Release the chain once nothing newer was queued behind us, so a
            // burst of triggers cannot retain an unbounded list of Tasks.
            await self?.finishedFlush(generation: generation)
        }
        flushTask = task
        return task
    }

    private func finishedFlush(generation: Int) {
        if flushGeneration == generation { flushTask = nil }
    }

    private func scheduleIntervalFlush() {
        guard timerTask == nil else { return }
        let interval = configuration.flushInterval
        timerTask = Task { [weak self, clock] in
            try? await clock.sleep(for: interval)
            guard !Task.isCancelled else { return }
            await self?.intervalElapsed()
        }
    }

    private func intervalElapsed() async {
        timerTask = nil
        guard !isBackingOff, await store.count > 0 else { return }
        startFlush()
    }

    // MARK: The flush itself

    private func performFlush(force: Bool) async {
        // An automatic or consumer-initiated flush must not talk over a scheduled
        // retry: §7's backoff is a wait, and the alternative is re-sending the
        // same failing batch at event rate during an outage.
        if !force, isBackingOff { return }
        lastFlushAt = clock.monotonicNow()

        // §7's retention ceiling: 24 hours of *attempts* on this batch, after
        // which it is dropped and logged at error. Measured on the monotonic
        // clock from the first failed attempt, so a device with a wrong clock or
        // a long offline stretch is not punished for it (§10).
        if let firstAttemptAt, clock.monotonicNow() - firstAttemptAt >= configuration.retentionCeiling,
           let pinned = retainedBatch {
            logger.error("""
                dropped \(pinned.recordCount, privacy: .public) event(s) after 24h of failed \
                delivery attempts (the §7 retention ceiling)
                """)
            await store.remove(through: pinned.lastID)
            retainedBatch = nil
            self.firstAttemptAt = nil
            retryNotBefore = nil
            consecutiveRetries = 0
        }

        while !Task.isCancelled {
            // Uppercase per §1; a backend accepts either case but MUST NOT be
            // relied on to normalize.
            // A retained batch is only still "the same batch" if the head has not
            // moved under it (the drop-oldest cap, or a discard). If it has, its
            // pinned id would label a different set of events, and a backend
            // deduping on `batchId` would 202 them into oblivion (§6).
            if let retained = retainedBatch, await store.headID != retained.firstID {
                logger.warning("the retained batch's head moved; issuing a fresh batchId")
                retainedBatch = nil
                firstAttemptAt = nil
            }
            let batchId = retainedBatch?.batchId
                ?? configuration.uuidProvider.uuid().uuidString.uppercased()
            var maxEvents = retainedBatch.map { min($0.recordCount, Self.maxEventsPerBatch) }
                ?? Self.maxEventsPerBatch
            if let splitBudget { maxEvents = min(maxEvents, splitBudget) }
            let sentAt = clock.wallNow()
            guard let pending = await store.nextBatch(
                maxEvents: maxEvents,
                maxBytes: Self.maxBytesPerBatch,
                batchId: batchId,
                sentAt: sentAt
            ) else {
                retainedBatch = nil
                return
            }

            let batch = StatsBatch(
                batchId: batchId, sentAt: sentAt, context: pending.context, events: pending.events
            )

            // The one case the schema says cannot be split or sent (§5).
            if pending.events.count == 1,
               let size = try? batch.serialized().count, size > Self.maxBytesPerBatch {
                logger.error("""
                    dropped a single event of \(size, privacy: .public) bytes: it cannot be split \
                    under the 256 KiB batch limit
                    """)
                await store.remove(through: pending.lastID)
                retainedBatch = nil
                continue
            }

            switch await configuration.sink.send(batch) {
            case .accepted:
                await store.remove(through: pending.lastID)
                consecutiveRetries = 0
                retainedBatch = nil
                retryNotBefore = nil
                firstAttemptAt = nil
                splitBudget = nil

            case .drop(let reason):
                // 400 / 401 / other 4xx / 3xx: the batch will never become
                // valid, so retrying is pure self-harm (§7).
                logger.error("""
                    dropped \(pending.events.count, privacy: .public) event(s) permanently: \
                    \(reason, privacy: .public)
                    """)
                await store.remove(through: pending.lastID)
                consecutiveRetries = 0
                retainedBatch = nil
                retryNotBefore = nil
                firstAttemptAt = nil
                splitBudget = nil

            case .tooLarge:
                // §7's 413: re-split into smaller batches with **new** batch ids
                // (§6 — a re-split batch is a new batch), rather than retrying a
                // body the backend will never accept.
                retainedBatch = nil
                firstAttemptAt = nil
                if pending.events.count == 1 {
                    logger.error("dropped a single event the backend rejected as too large; it cannot be split")
                    await store.remove(through: pending.lastID)
                    splitBudget = nil
                } else {
                    splitBudget = max(1, pending.events.count / 2)
                    logger.warning("""
                        413: re-splitting into batches of at most \
                        \(self.splitBudget ?? 1, privacy: .public) event(s)
                        """)
                }
                continue

            case .retry(let after):
                // Retained, not requeued: the events were never removed from the
                // store, so the next attempt rebuilds the identical batch —
                // same events, same `batchId` (§6), so a backend that already
                // durably wrote it answers 202 for the duplicate.
                retainedBatch = (
                    batchId: batch.batchId, firstID: pending.firstID,
                    lastID: pending.lastID, recordCount: pending.recordCount
                )
                if firstAttemptAt == nil { firstAttemptAt = clock.monotonicNow() }
                consecutiveRetries += 1
                scheduleRetry(after: after)
                return
            }
        }
    }

    /// Exponential from `backoffBase`, doubling, **full jitter**, capped at
    /// `backoffCap` (§7). Full jitter (uniform in `0...delay`) rather than
    /// half — it is what stops a fleet of clients that all went offline at once
    /// from returning in lockstep.
    private func scheduleRetry(after serverHint: Duration?) {
        let delay: Duration
        if let serverHint {
            // A 429's `Retry-After` is authoritative; jittering it would ignore a
            // server that told us exactly when to come back.
            //
            // Only the FLOOR is clamped: a hint of `0` (or a negative one) is not
            // a wait, it is an unthrottled request loop driven by a remote value.
            // The ceiling is the §7 retention ceiling, not `backoffCap` — §7 says
            // "wait `Retry-After` if present, ELSE the backoff schedule", so the
            // 5-minute cap bounds the schedule, not the server's instruction.
            // Clamping to 5 minutes meant a backend shedding load with
            // `Retry-After: 1800` was hammered every 5 minutes by exactly the
            // clients it had asked to stay away. Past the retention ceiling the
            // batch is dropped anyway, so honoring a longer hint could only park
            // it until it expired unattempted.
            delay = min(max(serverHint, configuration.backoffBase), configuration.retentionCeiling)
        } else {
            let exponent = min(max(consecutiveRetries - 1, 0), 16)
            let uncapped = configuration.backoffBase * Double(1 << exponent)
            let capped = min(uncapped, configuration.backoffCap)
            // Full jitter, floored at the base: a uniform draw over `0...capped`
            // includes zero, and a zero-second "wait" is a request loop, not a
            // backoff.
            delay = max(configuration.backoffBase, capped * configuration.randomSource.fraction())
        }
        logger.warning("""
            retrying in \(delay.formattedSeconds, privacy: .public)s \
            (attempt \(self.consecutiveRetries, privacy: .public))
            """)

        retryNotBefore = clock.monotonicNow() + delay
        retryTask?.cancel()
        retryTask = Task { [weak self, clock] in
            try? await clock.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self?.retryElapsed()
        }
    }

    private func retryElapsed() async {
        retryTask = nil
        retryNotBefore = nil
        // `force`: this *is* the scheduled retry, so it must not be gated by the
        // backoff window it was scheduled against.
        startFlush(force: true)
    }
}

extension Duration {
    /// Seconds as a `Double`, for `Date` arithmetic.
    var timeInterval: TimeInterval {
        Double(components.seconds) + Double(components.attoseconds) * 1e-18
    }

    var formattedSeconds: String {
        String(format: "%.2f", timeInterval)
    }
}
