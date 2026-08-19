import Foundation
import Synchronization
import os

private nonisolated let logger = Logger(subsystem: StatsLog.subsystem, category: "Client")

/// The emitter.
///
/// An `actor`, so identity, `seq`, the session state and the queue are
/// serialized without a lock, and so no consumer can accidentally do file I/O on
/// the main actor by calling `track()` from a view.
///
/// ## Lifecycle is explicit
///
/// v1 installs **no** AppKit/UIKit observers. There is no
/// `NSApplication.didBecomeActiveNotification` subscription and no
/// `UIApplication` scene observation, for three reasons: an observer would drag a
/// UI framework into a package that is otherwise Foundation-only, notification
/// delivery is main-actor and would make the SDK's behavior depend on the
/// consumer's default isolation, and a library that silently hooks the app
/// lifecycle is exactly the kind of thing you cannot audit from the outside.
///
/// So the consumer calls two methods, typically from `scenePhase`:
///
/// ```swift
/// .onChange(of: scenePhase) { _, phase in
///     Task {
///         switch phase {
///         case .active: await stats.applicationDidBecomeActive()
///         case .background: await stats.applicationDidEnterBackground()
///         default: break
///         }
///     }
/// }
/// ```
///
/// Skipping them costs the `app_open` / `app_background` auto-events and the
/// flush-on-background; everything else still works.
public actor StatsClient {
    private let configuration: StatsConfiguration
    private let store: EventStore
    private let dispatcher: Dispatcher

    /// Opened on first use by `prepareIfNeeded()`, never in `init`.
    private var identityStore: StatsIdentityStore?
    /// `false` until `prepareIfNeeded()` has run.
    private var didPrepare = false

    private var consent: StatsConsent
    private var enabled: Bool
    /// The validated `projectId`, or `nil` when the configured one is malformed.
    /// Resolved in `prepareIfNeeded()`, because the validation logs.
    private var projectId: String?

    /// Session state. All of it is in memory: a session never survives a
    /// process restart (schema §10 — a launch always begins a session).
    private var session: Session?
    /// The install id used for the current session. Under denied `identity`
    /// consent this is a per-session ephemeral hash, so nothing is linkable
    /// across sessions (§11).
    private var sessionInstallId: String?
    /// Sampled once per session (§3).
    private var sessionContext: StatsContext?

    /// Captured-but-not-yet-appended records, in track order.
    ///
    /// This exists for one reason: two `await`s on the same actor are not
    /// guaranteed to resume in call order, so `await dispatcher.enqueue(...)`
    /// per event could write two concurrently tracked events to disk in the
    /// reverse of their `seq`. Buffering synchronously and draining the buffer
    /// makes on-disk order equal track order, always — which keeps batches
    /// `seq`-ascending (§2.2's SHOULD) and keeps drop-oldest meaningful.
    private var pending: [EventStore.Record] = []
    /// Chains the drains so the hand-off to the dispatcher is ordered too: two
    /// independent `await dispatcher.enqueue(...)` calls have no ordering
    /// guarantee, so each drain waits for the previous one before it enqueues.
    private var drainTask: Task<Void, Never>?

    // MARK: The fire-and-forget hand-off behind `record()`

    /// One `record()` call: everything needed to run the normal capture path
    /// later, including the wall clock reading taken at the *call*, so a queued
    /// entry keeps the timestamp it was recorded at.
    private struct RecordedEvent: Sendable {
        var name: String
        var props: [String: StatsValue]
        var at: Date
    }

    private struct RecordedBuffer {
        var entries: [RecordedEvent] = []
        /// True while a pump `Task` is scheduled or running, so a burst of
        /// `record()` calls creates one drainer, not one per call.
        var pumpScheduled = false
        /// Set once per overflow episode, cleared when the buffer empties —
        /// the rate limit on the "buffer full" log.
        var didLogDrop = false
        /// Cleared to 0 each time the buffer empties (this is the count the
        /// "buffer full" log reports, and it is meant to describe the current
        /// overflow episode, not the client's whole lifetime).
        var dropped = 0
        /// Never reset: the total the client has dropped since it was
        /// created, for a diagnostic (``StatsClient/recordedDiagnostics``)
        /// that must stay accurate across more than one overflow episode.
        var lifetimeDropped = 0
        /// `shutdown()` closes the door: later `record()` calls are dropped
        /// rather than resurrecting the drainer on a torn-down client.
        var isShutDown = false
    }

    /// Past this many buffered entries `record()` drops the **newest** and logs
    /// once. Dropping the newest (rather than the oldest) keeps the entries
    /// already accepted in order and keeps `record()` allocation-free at the
    /// limit; the on-disk queue's own cap (§5) is the drop-*oldest* one.
    private static let defaultMaxRecordedBuffer = 10_000

    /// An instance-level `let` rather than the old `static let`: a test needs a
    /// small cap it can overflow deterministically without allocating 10 000
    /// entries, and a `let` on an actor is readable from `record()`'s
    /// `nonisolated` context without a hop because it can never change after
    /// `init`.
    private let maxRecordedBuffer: Int

    /// `nonisolated`, because `record()` is: a `Mutex` is the only way to hand
    /// work to the actor without suspending the caller. Held for a few
    /// instructions at a time and never across an `await`.
    private nonisolated let recorded = Mutex(RecordedBuffer())

    /// Chains the pumps, so entries reach `capture()` in the order they were
    /// recorded even when several pumps are started.
    private var recordedPumpTask: Task<Void, Never>?

    /// The next `seq` to stamp, cached in the actor.
    ///
    /// `seq` used to be read *and* written through `UserDefaults` on every
    /// single event, which is an XPC round-trip to `cfprefsd` per event. It is
    /// loaded once in `prepareIfNeeded()`, incremented in memory, and persisted
    /// once per drain — **before** the records are handed to the dispatcher, so
    /// a crash between the two can only lose numbers, never repeat them. §2.2
    /// requires `seq` to be strictly increasing per install; a gap is allowed,
    /// a repeat is not.
    private var nextSeqValue = 0
    /// Bumped synchronously by every teardown that discards the queue
    /// (`setConsent` revocation, `setEnabled(false)`). A drain that is already
    /// suspended in `dispatcher.enqueue(...)` compares the value it captured
    /// with this one after the hand-off: if it changed, the events it just
    /// wrote belong to a revoked identity and the queue is discarded again.
    private var discardGeneration = 0

    /// The hashed `userId`, if `identify()` was called.
    ///
    /// Persisted **only** while `identity` consent is granted. With it denied,
    /// §2.5 says the call is "remembered in memory but never emitted" — writing
    /// the hash to disk then would let a later grant resume a linkage the person
    /// never re-authorized.
    private var userIdHash: String?

    private struct Session {
        var id: String
        /// Wall clock of the session's first event — `duration_s` is measured
        /// from it.
        var firstEventAt: Date
        /// Wall clock of the most recent event — `session_end`'s `ts`.
        var lastEventAt: Date
        /// Monotonic reading of the most recent event: the inactivity gap is
        /// measured on the monotonic clock so a device clock change cannot
        /// fabricate or suppress a session (§10).
        var lastActivity: Duration
        var didEmitAppOpen: Bool
    }

    /// Creates a client. **Cheap and non-blocking**: no disk I/O, no directory
    /// creation, no `UserDefaults` suite opened — so it is safe to call directly
    /// on the main actor during launch, with no `Task.detached` around it.
    ///
    /// Everything that touches the filesystem happens lazily inside the actor on
    /// first use (see `prepareIfNeeded()` and `EventStore.fileURL`), which is
    /// also where it belongs: an app that is configured with `consent: .none`, or
    /// opted out, must not create a directory or a defaults suite at all, and
    /// before this was lazy it created both just by being constructed.
    ///
    /// - Parameter configuration: everything, including the sink and the test
    ///   seams. Nothing is read from a global.
    public init(configuration: StatsConfiguration) {
        self.init(configuration: configuration, maxRecordedBuffer: Self.defaultMaxRecordedBuffer)
    }

    /// Test seam: same as ``init(configuration:)`` but with the `record()`
    /// buffer cap overridable, so a test can overflow it with a handful of
    /// calls instead of 10 000.
    package init(configuration: StatsConfiguration, maxRecordedBuffer: Int) {
        self.maxRecordedBuffer = maxRecordedBuffer
        self.configuration = configuration

        // The closure captures only value-typed configuration and is not called
        // here: resolving the default location runs
        // `FileManager.url(…, create: true)`, which is synchronous disk I/O that
        // *creates directories*. It runs on the `EventStore` actor, on demand.
        let appId = configuration.appId
        let storageDirectory = configuration.storageDirectory
        self.store = EventStore(
            fileURL: {
                if let storageDirectory {
                    return storageDirectory.appendingPathComponent("queue.jsonl", isDirectory: false)
                }
                if let defaultURL = try? EventStore.defaultFileURL(appId: appId) {
                    return defaultURL
                }
                // No Application Support (a sandbox oddity): fall back to a
                // temporary file rather than losing the queue entirely. It gets
                // its own subdirectory — the SDK may lock a directory it created
                // down to 0700, and doing that to `/tmp` itself is not something
                // a library should ever be one bug away from.
                logger.error("Application Support is unavailable; the queue is in a temporary directory")
                return URL(fileURLWithPath: NSTemporaryDirectory())
                    .appendingPathComponent("swift-stats-\(appId)", isDirectory: true)
                    .appendingPathComponent("queue.jsonl", isDirectory: false)
            },
            maxQueued: configuration.maxQueued,
            // Both fallbacks above are directories this SDK creates for itself;
            // a consumer-supplied `storageDirectory` is not, so its permissions
            // and backup state are left exactly as the app set them.
            ownsDirectory: storageDirectory == nil
        )
        self.dispatcher = Dispatcher(store: store, configuration: configuration)

        // Provisional: `prepareIfNeeded()` replaces these with the persisted
        // choice, which wins (§11). Until then they are what the configuration
        // asked for, and nothing can be captured without going through an entry
        // point that prepares first.
        self.consent = configuration.consent
        self.enabled = configuration.enabled
        self.projectId = configuration.projectId
    }

    /// Opens the `UserDefaults` suite, loads the persisted consent / opt-out /
    /// `userId` hash, and validates the configured ids — once, on the actor, on
    /// the first entry point that needs any of it.
    ///
    /// Synchronous on purpose. It adds no suspension point, so the ordering
    /// invariants `capture()` and `setConsent()` depend on — every synchronous
    /// teardown completing before the first `await` — are unchanged.
    private func prepareIfNeeded() {
        guard !didPrepare else { return }
        didPrepare = true

        let identity = StatsIdentityStore(
            appId: configuration.appId, salt: configuration.installIdSalt
        )
        self.identityStore = identity

        // The persisted choice wins; the configuration's values apply only the
        // first time this app runs (§11).
        self.consent = identity.storedConsent ?? configuration.consent
        self.enabled = identity.storedEnabled ?? configuration.enabled
        self.userIdHash = self.consent.contains(.identity) ? identity.userIdHash : nil
        // Read once per process, then kept in memory (see `nextSeqValue`).
        self.nextSeqValue = identity.seq

        // §0/§2 field formats the emitter can check locally. A bad value would
        // otherwise turn every batch into a permanent 400 (§7) with no local
        // signal at all.
        if configuration.appId.unicodeScalars.count > 128 || configuration.appId.isEmpty {
            logger.error("appId must be 1-128 scalars; this one will be rejected by a conforming backend")
        }
        if let projectId = configuration.projectId, !Self.isWellFormedProjectId(projectId) {
            logger.error("""
                projectId must be 1-64 scalars of [A-Za-z0-9._-] (schema §2); \
                it will not be sent, so the backend derives it from the write key
                """)
            self.projectId = nil
        }
        if !identity.isAvailable {
            logger.error("collection is disabled: the SDK could not open its own UserDefaults suite")
        }
    }

    /// The identity store, opening it on first use.
    ///
    /// `prepareIfNeeded()` is the only writer, it always assigns, and it runs to
    /// completion without suspending — so the fallback below is unreachable. It
    /// is a fallback and not a `preconditionFailure` anyway: this is a library,
    /// and an analytics SDK that can trap has no business being linked into
    /// someone's app. If the invariant is ever broken by a future edit, the host
    /// gets an error in the log and a freshly opened store, not a crash.
    private var identity: StatsIdentityStore {
        prepareIfNeeded()
        if let identityStore { return identityStore }
        logger.error("the identity store was missing after prepareIfNeeded(); reopening it")
        let reopened = StatsIdentityStore(
            appId: configuration.appId, salt: configuration.installIdSalt
        )
        identityStore = reopened
        return reopened
    }

    /// `[A-Za-z0-9._-]`, 1–64 scalars (§2).
    private static func isWellFormedProjectId(_ candidate: String) -> Bool {
        let scalars = candidate.unicodeScalars
        guard !scalars.isEmpty, scalars.count <= 64 else { return false }
        return scalars.allSatisfy { scalar in
            ("a"..."z").contains(scalar) || ("A"..."Z").contains(scalar)
                || ("0"..."9").contains(scalar) || scalar == "." || scalar == "_" || scalar == "-"
        }
    }

    // MARK: - Capture

    /// Records an event and returns once it is on disk — not once it is sent.
    ///
    /// Most call sites should use ``record(_:props:)`` instead, which does not
    /// suspend the caller at all. Use `track()` when you need the durability:
    /// it returns only once the event has been written, so an event tracked
    /// immediately before a deliberate teardown cannot be lost.
    ///
    /// Silently does nothing when the client is disabled or `usage` consent is
    /// absent. A reserved or malformed name is dropped and logged at `error`
    /// (§2.1, §12): a broken name is an emitter bug, and sending it would cost
    /// the whole batch a 400.
    public func track(_ name: String, props: [String: StatsValue] = [:]) async {
        let now = configuration.clock.wallNow()
        // Anything `record()`ed earlier by this caller has to reach `capture()`
        // first, or a `record("a"); await track("b")` pair could land as `b, a`.
        await drainRecordedIfNeeded()
        guard isCollecting else { return }
        guard isAcceptableEventName(name) else { return }
        await capture(name: name, props: props, at: now)
    }

    /// Records an event and returns **immediately**, without suspending the
    /// caller: no `await`, no actor hop, nothing to schedule around. This is the
    /// call to reach for in a button action or a view body.
    ///
    /// The event is validated and queued exactly as ``track(_:props:)`` does it
    /// — same names, same props sanitization, same consent and opt-out checks —
    /// and calls keep their arrival order, including relative to `track()` calls
    /// from the same caller. The timestamp is taken here, at the call, not when
    /// the actor gets around to it.
    ///
    /// The difference is durability: `track()` returns once the event is on
    /// disk, `record()` returns before it is. A process killed in the
    /// microseconds between the two loses the event, so use `await track()` when
    /// you specifically need "this is on disk now" — most notably right before a
    /// deliberate teardown. Everything else should use `record()`.
    ///
    /// Buffered entries are capped at 10 000. Past that the **newest** are
    /// dropped and a single rate-limited error is logged: an unbounded buffer in
    /// front of an analytics queue is a memory leak with a nice name.
    public nonisolated func record(_ name: String, props: [String: StatsValue] = [:]) {
        // `configuration` is an immutable `Sendable` `let`, so reading the clock
        // here is legal from a nonisolated context and needs no hop.
        let entry = RecordedEvent(name: name, props: props, at: configuration.clock.wallNow())

        enum Outcome { case pump, overflowed(Int), none }
        let outcome: Outcome = recorded.withLock { buffer in
            guard !buffer.isShutDown else { return .none }
            guard buffer.entries.count < maxRecordedBuffer else {
                buffer.dropped += 1
                buffer.lifetimeDropped += 1
                guard !buffer.didLogDrop else { return .none }
                buffer.didLogDrop = true
                return .overflowed(buffer.dropped)
            }
            buffer.entries.append(entry)
            guard !buffer.pumpScheduled else { return .none }
            buffer.pumpScheduled = true
            return .pump
        }

        switch outcome {
        case .overflowed(let dropped):
            logger.error("""
                record() buffer is full at \(self.maxRecordedBuffer, privacy: .public) entries; \
                dropping the newest (\(dropped, privacy: .public) so far) until it drains
                """)
        case .pump:
            // Weak, so a dropped client is deallocated rather than kept alive by
            // its own drainer.
            Task { [weak self] in await self?.drainRecorded() }
        case .none:
            break
        }
    }

    /// Returns once everything ``record(_:props:)`` has accepted so far is on
    /// disk. ``flush()``, ``waitForFlushes()`` and ``shutdown()`` call it
    /// first, so a test (or a consumer) rarely needs it directly.
    public func drainRecorded() async {
        let previous = recordedPumpTask
        let task = Task { [weak self] in
            await previous?.value
            await self?.pumpRecorded()
        }
        recordedPumpTask = task
        await task.value
        if recordedPumpTask == task { recordedPumpTask = nil }
    }

    /// Skips the `Task` allocation when there is nothing recorded and no pump in
    /// flight — the common case on the `track()` path.
    private func drainRecordedIfNeeded() async {
        let hasWork = recorded.withLock { !$0.entries.isEmpty }
        guard hasWork || recordedPumpTask != nil else { return }
        await drainRecorded()
    }

    /// Feeds buffered entries through the same capture path as `track()`, in
    /// order, until the buffer is empty.
    private func pumpRecorded() async {
        while true {
            let batch: [RecordedEvent] = recorded.withLock { buffer in
                guard !buffer.entries.isEmpty else {
                    // Atomic with the emptiness check, so a `record()` racing
                    // this either lands in the batch below or starts a new pump.
                    buffer.pumpScheduled = false
                    buffer.didLogDrop = false
                    buffer.dropped = 0
                    return []
                }
                let entries = buffer.entries
                buffer.entries.removeAll(keepingCapacity: true)
                return entries
            }
            guard !batch.isEmpty else { return }
            var didCapture = false
            for entry in batch {
                // Re-checked per entry: consent may have been revoked while this
                // batch was being drained.
                guard isCollecting else { continue }
                guard isAcceptableEventName(entry.name) else { continue }
                // `drain: false` — the whole batch is buffered and handed over
                // once, below. Draining per entry meant one `Task` and one
                // single-record `store.append` per recorded event, so a burst of
                // 1 000 `record()` calls paid 1 000 file writes instead of one.
                // Ordering is unaffected: `pending` is appended to
                // synchronously, in this loop's order, and the session
                // bookkeeping inside `capture()` still drains at a session
                // boundary so auto-events keep the order §12 fixes.
                await capture(name: entry.name, props: entry.props, at: entry.at, drain: false)
                didCapture = true
            }
            if didCapture { await drainPending() }
        }
    }

    /// §2.1 / §12. A reserved or malformed name is dropped and logged at
    /// `error`: a broken name is an emitter bug, and sending it would cost the
    /// whole batch a 400.
    private func isAcceptableEventName(_ name: String) -> Bool {
        guard !StatsEventName.isValidForApp(name) else { return true }
        if StatsEventName.reserved.contains(name) || name.hasPrefix(StatsEventName.reservedPrefix) {
            logger.error("refused reserved event name \(name, privacy: .public) (schema §12)")
        } else {
            logger.error("""
                refused malformed event name \(name, privacy: .public): \
                must match ^[a-z][a-z0-9_]*$ and be 1-64 scalars (schema §2.1)
                """)
        }
        return false
    }

    /// Attaches an opaque account identifier to every subsequent event (§2.5).
    ///
    /// The value is hashed with the install salt before it is stored or sent, so
    /// a raw identifier never leaves the device — but pass something opaque
    /// anyway. Most apps should never call this: it makes an account's events
    /// linkable, which is a real privacy cost.
    ///
    /// Under denied `identity` consent the call is remembered but never emitted,
    /// and `identify()` cannot re-enable linkage consent withheld.
    ///
    /// - Important: calling this puts the SDK's **User ID** data type in play, so
    ///   the consuming app must declare `NSPrivacyCollectedDataTypeUserID` in its
    ///   privacy manifest and nutrition label (schema §14) — the package's own
    ///   `PrivacyInfo.xcprivacy` cannot declare it, because whether it is
    ///   collected depends on whether *you* call this method.
    public func identify(userID: String) async {
        guard !userID.isEmpty else {
            logger.error("identify() was given an empty id; ignoring")
            return
        }
        prepareIfNeeded()
        // Events recorded before this call belong to the un-identified stretch,
        // so they are captured before the hash is attached.
        await drainRecordedIfNeeded()
        guard enabled else {
            logger.warning("identify() ignored: the client is opted out")
            return
        }
        let hash = identity.hashedUserId(userID)
        userIdHash = hash
        if consent.contains(.identity) { identity.userIdHash = hash }
    }

    // MARK: - Consent and opt-out

    public var currentConsent: StatsConsent {
        prepareIfNeeded()
        return consent
    }

    /// Records a consent choice.
    ///
    /// Any group going from granted to denied is a **revocation**: the local
    /// queue is discarded (not flushed) and the stored install UUID is deleted,
    /// so revocation cannot be undone into a resumed identity. Re-granting
    /// starts a new identity with `seq` back at 0 (§11).
    ///
    /// ## Asymmetry with `setEnabled(false)` — deliberate, not an oversight
    ///
    /// A consent **revocation** deletes the persisted install UUID; the master
    /// opt-out does not. See ``setEnabled(_:)`` for why, and ``reset()`` for the
    /// call that forgets the UUID without touching either switch.
    public func setConsent(_ groups: StatsConsent) async {
        prepareIfNeeded()
        let revoked = consent.subtracting(groups)
        consent = groups
        identity.storeConsent(groups)

        guard !revoked.isEmpty else { return }
        logger.info("consent revoked for one or more groups; discarding the queue and the install identity")
        // Everything synchronous happens *before* the suspension: a `track()`
        // that interleaves must not still find the revoked session identity, and
        // must not be able to stamp an event with the install id being deleted.
        pending.removeAll()
        recorded.withLock { $0.entries.removeAll() }
        endSessionState()
        identity.deleteInstallUUID()
        identity.userIdHash = nil
        userIdHash = nil
        nextSeqValue = 0
        identity.seq = 0
        // Invalidates any drain that is already suspended in
        // `dispatcher.enqueue(...)`: it discards again once it resumes.
        discardGeneration += 1
        await dispatcher.discardAll()
    }

    /// The master opt-out. `true` by default; `false` means no capture at all,
    /// whatever consent says.
    public var isEnabled: Bool {
        prepareIfNeeded()
        return enabled
    }

    /// The master opt-out. `false` clears the queue, ends the session and forgets
    /// any hashed `userId`; the choice is persisted, so it survives relaunch.
    ///
    /// ## What an opt-out keeps, and why
    ///
    /// `setEnabled(false)` **keeps the persisted install UUID**, while revoking a
    /// consent group through ``setConsent(_:)`` **deletes** it. That asymmetry is
    /// intentional:
    ///
    /// - The opt-out is a *switch*, and a person who flips it off and back on
    ///   expects the same install, not a new one. Nothing is collected while it
    ///   is off, so the retained UUID sits unused on disk and reaches no
    ///   backend — it is not an identifier "in use", it is a remembered one.
    /// - A consent revocation is a *withdrawal of permission to identify*, which
    ///   §11 requires be unresumable: keeping the UUID would let a later grant
    ///   continue a linkage the person had ended.
    ///
    /// If you want the opt-out to forget the install too, call ``reset()`` after
    /// it — that is the call that regenerates (or deletes) the UUID, and the only
    /// one that does so without changing a switch.
    public func setEnabled(_ newValue: Bool) async {
        prepareIfNeeded()
        guard newValue != enabled else { return }
        enabled = newValue
        identity.storeEnabled(newValue)
        guard !newValue else { return }
        // Disabled means the queue goes too: holding events for a person who
        // opted out and sending them if they change their mind is not opt-out.
        // Again, synchronous teardown first, then the suspension.
        pending.removeAll()
        recorded.withLock { $0.entries.removeAll() }
        endSessionState()
        // An opt-out must not leave a hashed account id behind to be re-linked on
        // the way back in.
        identity.userIdHash = nil
        userIdHash = nil
        discardGeneration += 1
        await dispatcher.discardAll()
    }

    // MARK: - Flush and reset

    /// Attempts one flush and returns when the attempt is done. A `retry`
    /// outcome leaves the batch queued and schedules the backoff; it does not
    /// keep this call waiting.
    public func flush() async {
        await drainRecordedIfNeeded()
        await dispatcher.flushNow()
    }

    /// Forgets this install: flushes what the old identity produced, then a
    /// fresh UUID, `seq` back to 0, no `userId`, and a new session on the next
    /// event. Events from before and after a reset are not linkable (§9).
    ///
    /// This is the call that **forgets the install**, which neither switch does
    /// on its own: ``setEnabled(_:)`` keeps the stored UUID and ``setConsent(_:)``
    /// only deletes it on a revocation. Pair it with an opt-out when you want
    /// "stop collecting *and* forget me".
    public func reset() async {
        prepareIfNeeded()
        // Everything recorded before the reset belongs to the old identity, so
        // it is captured (and flushed) before the identity rotates.
        await drainRecordedIfNeeded()
        await dispatcher.flushNow()
        if consent.contains(.identity) {
            _ = identity.regenerateInstallUUID(makeUUID: configuration.uuidProvider.uuid)
        } else {
            // Under denied `identity` consent there is nothing persisted to
            // replace, and writing a fresh UUID here would store an identifier
            // consent withheld.
            identity.deleteInstallUUID()
        }
        nextSeqValue = 0
        identity.seq = 0
        identity.userIdHash = nil
        userIdHash = nil
        endSessionState()
        logger.info("identity reset")
    }

    /// Returns when every flush that has already been triggered has finished.
    /// Never sleeps, and never waits on a scheduled retry or the interval timer
    /// — see `Dispatcher.waitForFlushes()`.
    public func waitForFlushes() async {
        await drainRecordedIfNeeded()
        await dispatcher.waitForFlushes()
    }

    /// Cancels the interval timer and any pending retry, leaving queued events on
    /// disk for the next launch. Call it when tearing a client down (a test's
    /// teardown, or an app that builds a client per window).
    public func shutdown() async {
        // Close the door first, then drain what was already accepted: a
        // `record()` arriving after this must not restart the drainer on a
        // client the owner believes is torn down.
        recorded.withLock { $0.isShutDown = true }
        await drainRecorded()
        recordedPumpTask = nil
        await dispatcher.shutdown()
    }

    /// Current queue depth, for diagnostics and tests.
    public var queuedEventCount: Int {
        get async { await store.count }
    }

    /// Test seam: the `record()` buffer's current depth and the total entries
    /// dropped for overflowing `maxRecordedBuffer` over the client's whole
    /// lifetime (unlike the buffer's internal `dropped`, this one is never
    /// reset when the buffer empties, so a test can read it after a drain and
    /// still get a meaningful count). `nonisolated` because the buffer itself
    /// is — no actor hop needed to read it.
    package nonisolated var recordedDiagnostics: (buffered: Int, dropped: Int) {
        recorded.withLock { ($0.entries.count, $0.lifetimeDropped) }
    }

    /// Test seam: `EventStore`'s internal diagnostics, including the number of
    /// `append()` calls that have reached it — see `EventStore.diagnostics`.
    package var storeDiagnostics: (consumedBytes: Int, isMemoryOnly: Bool, needsRewrite: Bool, dropped: Int, appends: Int) {
        get async { await store.diagnostics }
    }

    // MARK: - Lifecycle (called by the consumer, see the type's docs)

    /// The app became active. Starts a session if none is current or the
    /// inactivity gap has elapsed, and emits `app_open` once per session when
    /// that auto-event is enabled.
    public func applicationDidBecomeActive() async {
        let now = configuration.clock.wallNow()
        // Anything recorded before the app became active keeps its place ahead
        // of `app_open`.
        await drainRecordedIfNeeded()
        guard isCollecting else { return }
        await beginSessionIfNeeded(at: now)
        // §12 defines `app_open` as "the app becomes active in the foreground",
        // at most once per session start — so it is emitted here and *only* here,
        // never off the back of a `track()` in a process that never foregrounded.
        guard configuration.autoEvents.contains(.appOpen), session?.didEmitAppOpen == false else { return }
        session?.didEmitAppOpen = true
        await capture(name: "app_open", props: [:], at: now, isAuto: true)
    }

    /// The app left the foreground: emits `app_background` when enabled, then
    /// flushes — the natural flush point, and the last moment a queued batch can
    /// be sent before the process may be suspended.
    public func applicationDidEnterBackground() async {
        await drainRecordedIfNeeded()
        guard isCollecting else { return }
        if configuration.autoEvents.contains(.appBackground), session != nil {
            await capture(name: "app_background", props: [:], at: configuration.clock.wallNow(), isAuto: true)
        }
        await dispatcher.flushNow()
    }

    // MARK: - Internals

    /// `prepareIfNeeded()` FIRST, before any of the three are read: `&&` is
    /// left-to-right, so reading `enabled` before preparing would test the
    /// configuration's provisional value rather than the persisted opt-out.
    private var isCollecting: Bool {
        prepareIfNeeded()
        return enabled && consent.contains(.usage) && identity.isAvailable
    }

    /// Session bookkeeping plus the actual enqueue.
    ///
    /// `isAuto` bypasses the reserved-name check, which is the only difference
    /// between an auto-event and an app event on the wire.
    ///
    /// `drain: false` leaves the record in `pending` for the caller to hand over
    /// in one go — what the `record()` pump does for a whole batch, so a burst
    /// costs one append rather than one per event. Every other caller returns
    /// only once its record is on disk, which is what `track()` promises.
    private func capture(
        name: String, props: [String: StatsValue], at now: Date,
        isAuto: Bool = false, drain: Bool = true
    ) async {
        await beginSessionIfNeeded(at: now)
        // Re-checked after the suspension: consent or the opt-out may have
        // changed while the session was being started, and an event captured
        // against a torn-down session would carry a revoked identity.
        guard isCollecting,
              let current = session, let installId = sessionInstallId, let context = sessionContext
        else { return }

        let event = StatsEvent(
            name: name,
            ts: now,
            sessionId: current.id,
            installId: installId,
            appId: configuration.appId,
            projectId: projectId,
            seq: nextSeq(),
            // Omitted entirely when `identity` consent is absent, even though
            // `identify()` was remembered (§2.5).
            userId: consent.contains(.identity) ? userIdHash : nil,
            props: isAuto ? props : StatsProps.sanitized(props, eventName: name)
        )

        session?.lastEventAt = now
        session?.lastActivity = configuration.clock.monotonicNow()

        pending.append(EventStore.Record(event: event, context: context))
        guard drain else { return }
        await drainPending()
    }

    /// Hands the buffer to the dispatcher in order, and returns only once this
    /// caller's records are on disk.
    private func drainPending() async {
        let previous = drainTask
        let task = Task { [weak self] in
            await previous?.value
            await self?.performDrain()
        }
        drainTask = task
        await task.value
    }

    private func performDrain() async {
        while !pending.isEmpty {
            let records = pending
            pending.removeAll(keepingCapacity: true)
            // A teardown that ran while this drain was being scheduled has
            // already emptied `pending`; anything still here was captured
            // before it, under an identity that is now revoked.
            guard enabled, consent.contains(.usage) else { continue }
            let generation = discardGeneration
            // Persisted before the hand-off, never after: the numbers about to
            // reach disk must never be handed out again (§2.2).
            identity.seq = nextSeqValue
            await dispatcher.enqueue(records)
            if generation != discardGeneration {
                // `setConsent()` / `setEnabled(false)` landed *during* the
                // enqueue, so its `discardAll()` may have run before these
                // records were appended. Discard again; the teardown itself did
                // everything else synchronously before its first `await`.
                logger.info("a revocation raced an in-flight drain; discarding the queue again")
                await dispatcher.discardAll()
            }
        }
    }

    private func nextSeq() -> Int {
        prepareIfNeeded()
        let value = nextSeqValue
        nextSeqValue = value + 1
        return value
    }

    /// Starts a session on launch (first event of the process) and on the first
    /// activity after the inactivity gap (§10). No timer: the gap is evaluated
    /// here, when something is actually tracked.
    private func beginSessionIfNeeded(at now: Date) async {
        let monotonic = configuration.clock.monotonicNow()
        if let current = session, monotonic - current.lastActivity < configuration.sessionGap {
            return
        }

        let previous = session
        let newSession = Session(
            id: makeSessionId(at: now),
            firstEventAt: now,
            lastEventAt: now,
            lastActivity: monotonic,
            didEmitAppOpen: false
        )

        // Fixed ordering at a boundary (§12): session_end (previous id, lower
        // seq) first, and — critically — emitted *before* the install id and
        // context rotate, so it closes the previous session under the identity
        // and context that session actually ran with. Under denied `identity`
        // consent those differ every session (§11).
        if let previous, configuration.autoEvents.contains(.sessions) {
            let duration = previous.lastEventAt.timeIntervalSince(previous.firstEventAt)
            emitSessionEvent(
                name: "session_end",
                sessionId: previous.id,
                at: previous.lastEventAt,
                props: ["duration_s": .int(Int(duration.rounded()))]
            )
        }

        // A denied `identity` group means a fresh ephemeral install id per
        // session; a granted one means the persisted UUID's hash (§11).
        if consent.contains(.identity) {
            let uuid = identity.installUUID(makeUUID: configuration.uuidProvider.uuid)
            sessionInstallId = identity.installId(for: uuid)
        } else {
            sessionInstallId = identity.installId(for: configuration.uuidProvider.uuid())
        }

        let sampled = configuration.contextOverride ?? StatsEnvironment.sampleContext(
            bundleId: configuration.appId,
            screenMetrics: configuration.screenMetrics,
            colorScheme: configuration.colorScheme,
            isPreRelease: configuration.isPreRelease
        )
        sessionContext = consent.contains(.diagnostics) ? sampled : sampled.diagnosticsDenied()

        session = newSession

        if configuration.autoEvents.contains(.sessions) {
            emitSessionEvent(name: "session_start", sessionId: newSession.id, at: now, props: [:])
        }

        // Auto-events reach disk before the event that opened the session, in
        // the order §12 fixes.
        await drainPending()
    }

    /// Enqueues an auto-event without re-entering session bookkeeping — the
    /// session is mid-construction while these are emitted.
    private func emitSessionEvent(
        name: String, sessionId: String, at now: Date, props: [String: StatsValue]
    ) {
        guard let installId = sessionInstallId, let context = sessionContext else { return }
        let event = StatsEvent(
            name: name,
            ts: now,
            sessionId: sessionId,
            installId: installId,
            appId: configuration.appId,
            projectId: projectId,
            seq: nextSeq(),
            userId: consent.contains(.identity) ? userIdHash : nil,
            props: props
        )
        pending.append(EventStore.Record(event: event, context: context))
    }

    /// `<epochSeconds>-<8 random digits>` (§10). The leading timestamp makes ids
    /// sortable by start time, which is what makes cheap string-ordered storage
    /// useful on the backend.
    private func makeSessionId(at now: Date) -> String {
        // Clamped and zero-padded to 10 digits: §10's pattern is
        // `^[0-9]{10,}-[0-9]{8}$`, and a device with a dead battery reporting
        // 1970 (or earlier) would otherwise emit `0-40371852` or a leading `-`,
        // which §0 makes a 400 for the whole batch.
        let seconds = max(0, Int(now.timeIntervalSince1970))
        let prefix = String(format: "%010d", seconds)
        return "\(prefix)-\(configuration.randomSource.digits(count: 8))"
    }

    private func endSessionState() {
        session = nil
        sessionInstallId = nil
        sessionContext = nil
    }
}
