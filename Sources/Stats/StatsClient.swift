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
///
/// ## One owner per app id; every other client forwards to it
///
/// Create one client per app id and share it — that is the cheap, obvious
/// shape. But a second client for the same app id (a settings screen that
/// builds its own, a per-window client) is safe too: the queue file and the
/// persisted `seq` belong to the app id, so only one client may own them, and
/// any other client for that app id **forwards every call to the owner**. `track`, `record`, `identify`, `forgetUser`, `setConsent`, `setEnabled`,
/// `reset`, `flush`, the lifecycle calls and the read-only state all behave
/// exactly as if they had been made on the owner, so an opt-out made through
/// any handle is the opt-out. The forwarding client's own configuration (its
/// sink, consent, clock …) is ignored while it forwards, and it says so once,
/// at `warning`.
///
/// The first client to be used becomes the owner. When the owner is shut down
/// or deallocated, the next call on any other client claims ownership, and that
/// client re-reads the persisted consent, opt-out and `seq` before it acts —
/// and from then on sends with **its own** configuration (sink, clock, auto
/// events …). A call that reaches an owner while it is shutting down is not
/// dropped: it waits for the shutdown to finish (as long as the in-flight send,
/// so bounded by the sink's request timeout) and goes to the next owner.
/// A client that was itself ``shutdown()`` stays shut down and never forwards.
///
/// Across handles, events keep **arrival order** at the owner, and each keeps
/// the timestamp of the call that made it — a `record()` through a forwarding
/// client is stamped by that client's clock, when it was called.
///
/// Two clients for **different** app ids must not share a `storageDirectory`.
/// That is not forwarded — the second app's events would go out as the first
/// app — so the later client is refused: every call on it does nothing. The
/// first ordinary call is logged at `error`, then one in every 100; every
/// `setConsent`, `setEnabled(false)` and `reset()` is logged at `fault`,
/// because the choice it carries cannot be applied to another app's queue.
public actor StatsClient {
    private let configuration: StatsConfiguration
    private let store: EventStore
    /// Internal (not private) only so tests can reach its seams.
    let dispatcher: Dispatcher

    /// Opened on first use by `prepareIfNeeded()`, never in `init`.
    private var identityStore: StatsIdentityStore?
    /// `false` until `prepareIfNeeded()` has run.
    private var didPrepare = false

    /// Identifies this client in `StatsClientRegistry`. `nonisolated` so
    /// `deinit` and `record()` can use it without a hop.
    private nonisolated let leaseToken = StatsClientRegistry.makeToken()
    /// The registry keys this client owns or forwards for: its app id and an
    /// explicit storage directory.
    private nonisolated let registryKeys: [String]
    /// Shared with this client's store and dispatcher, and registered with
    /// its claim: set when this client is gone (see `QueueRevocation`).
    private nonisolated let revocation: QueueRevocation
    /// True while this client owns its app id — claimed by `role()`, given up
    /// by `shutdown()` or `deinit`.
    private var holdsLease = false
    /// Set by `shutdown()`. Terminal: a torn-down client does nothing, because
    /// the app id it owned may already belong to another client.
    private var isShutDown = false
    /// The forwarding warning is said once per client.
    private var didWarnForwarding = false
    /// Set at the start of `shutdown()`: from here on a forwarded call is not
    /// run here but handed back (see `runIfOwner`), even while the shutdown
    /// is still waiting for drains and an in-flight send.
    private var isClosing = false
    /// Fired at the very end of `shutdown()`, after the app id is released —
    /// what a forwarding client waits for before it resolves again.
    nonisolated let shutDownSignal = OneShotSignal()

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
    struct RecordedEvent: Sendable {
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
    /// The next `seq` of the current session's **ephemeral** install id, or
    /// `nil` while the session runs under the stable one (or none is running).
    ///
    /// §6 and §11: each per-session ephemeral id has its own `seq` space,
    /// starting at 0 and held in memory only. One counter running across them —
    /// let alone a persisted one — would let a backend chain the sessions that
    /// denied `identity` exists to keep apart: session two would start at
    /// session one's last `seq` plus one. Rotated together with
    /// `sessionInstallId`, so `session_end` still takes its number from the id
    /// it is stamped with.
    private var ephemeralNextSeq: Int?
    /// How many times this client has warned that its install id is
    /// per-session. At most 1: the warning is said once per client, the first
    /// time a session mints an ephemeral id. Internal so tests can assert on
    /// exactly that, which a log line alone would not let them do.
    private(set) var ephemeralInstallWarningCount = 0
    /// Bumped synchronously by every teardown that discards the queue
    /// (`setConsent` revocation, `setEnabled(false)`). A drain that is already
    /// suspended in `dispatcher.enqueue(...)` compares the value it captured
    /// with this one after the hand-off: if it changed, the events it just
    /// wrote belong to a revoked identity and the queue is discarded again.
    private var discardGeneration = 0

    /// The hashed `userId`, if `identify()` was called.
    ///
    /// Persisted **only** if `identity` consent is granted when `identify()` is
    /// called. With it denied the hash is kept in memory only and not emitted
    /// (§2.5); writing it to disk then would let a grant on a later launch
    /// resume a linkage the person never re-authorized. A grant later in the
    /// *same process* does make the in-memory hash appear on the events that
    /// follow — it is still not persisted, so it is gone after a relaunch.
    private var userIdHash: String?

    private struct Session {
        var id: String
        /// Wall clock of the most recent event — `session_end`'s `ts`.
        var lastEventAt: Date
        /// Monotonic reading of the session's first event. `duration_s` is
        /// `lastActivity - firstActivity`: on the wall clock a user setting the
        /// device time back mid-session made it negative.
        var firstActivity: Duration
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
        let revocation = QueueRevocation()
        self.revocation = revocation
        self.registryKeys = StatsClientRegistry.keys(for: configuration)
        self.store = EventStore(
            fileURL: {
                if let storageDirectory {
                    return storageDirectory.appendingPathComponent("queue.jsonl", isDirectory: false)
                }
                if let defaultURL = EventStore.defaultFileURL(appId: appId) {
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
            ownsDirectory: storageDirectory == nil,
            clock: configuration.clock,
            revocation: revocation
        )
        self.dispatcher = Dispatcher(store: store, configuration: configuration, revocation: revocation)

        // Provisional: `prepareIfNeeded()` replaces these with the persisted
        // choice, which wins (§11). Until then they are what the configuration
        // asked for, and nothing can be captured without going through an entry
        // point that prepares first.
        self.consent = configuration.consent
        self.enabled = configuration.enabled
        self.projectId = configuration.projectId
    }

    /// A client dropped without `shutdown()` gives its app id up here. It
    /// revokes its store and dispatcher **first**: a flush of this client's may
    /// still be running (its `Task` holds the dispatcher, not the client), and
    /// it must stop before the next owner can start on the same file.
    deinit {
        revocation.revoke()
        StatsClientRegistry.release(token: leaseToken)
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
            suiteName: configuration.identitySuiteName, salt: configuration.installIdSalt
        )
        self.identityStore = identity

        loadPersistedState(from: identity)

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

    /// A persisted choice wins; the configuration's values apply until one
    /// exists. Only `setConsent` / `setEnabled` persist (§11). `seq` is read
    /// here and then kept in memory (see `nextSeqValue`).
    ///
    /// Run at first use and again whenever this client becomes the owner: a
    /// client that forwarded for a while holds values from before the previous
    /// owner changed them.
    private func loadPersistedState(from identity: StatsIdentityStore) {
        consent = identity.storedConsent ?? configuration.consent
        enabled = identity.storedEnabled ?? configuration.enabled
        userIdHash = consent.contains(.identity) ? identity.userIdHash : nil
        nextSeqValue = identity.seq
    }

    /// What a public call on this client does.
    private enum Role {
        /// This client owns the app id: act.
        case owner
        /// Another client does: hand the call to it.
        case forward(StatsClient)
        /// Shut down: do nothing.
        case inactive
        /// Another client, for a **different** app id, owns this client's
        /// `storageDirectory`. Forwarding would send this app's events as that
        /// app; owning would put two stores on one file. So: nothing, loudly.
        case refused
    }

    /// Resolves the role for one call. Claims ownership when no live client
    /// owns any of this client's keys — on first use, or after the owner went
    /// away — and then re-reads the persisted state. Never awaits: the
    /// registry lock is held only inside `resolve`, never across a suspension.
    private func role() -> Role {
        prepareIfNeeded()
        if isShutDown { return .inactive }
        if holdsLease { return .owner }
        switch StatsClientRegistry.resolve(registryKeys, token: leaseToken, client: self, revocation: revocation) {
        case .claimed:
            holdsLease = true
            loadPersistedState(from: identity)
            return .owner
        case .directoryConflict:
            return .refused
        case .owner(let owner):
            if !didWarnForwarding {
                didWarnForwarding = true
                logger.warning("""
                    another StatsClient already owns this appId (or storageDirectory); this client \
                    forwards every call to it, and its own configuration is ignored while it does. \
                    Share one client per appId.
                    """)
            }
            return .forward(owner)
        }
    }

    /// Where one public call goes.
    private enum Route<T> {
        /// The owner ran it; here is its result.
        case forwarded(T)
        /// This client is the owner: run it here.
        case mine
        /// Do nothing (shut down, or refused).
        case skip
    }

    /// Resolves `role()` and, for a forwarding client, runs `body` on the
    /// owner. An owner that is shutting down hands the call back once its
    /// shutdown has finished and the app id is free, and this resolves again —
    /// claiming ownership itself, or finding the new owner — so a call that
    /// lands in that window is applied rather than dropped. That matters most
    /// for `setConsent` / `setEnabled`. Each pass waits for one owner's
    /// shutdown to complete, so the loop ends.
    private func route<T: Sendable>(
        _ call: String, privacy: Bool = false,
        _ body: @Sendable (isolated StatsClient) async -> T
    ) async -> Route<T> {
        while true {
            switch role() {
            case .owner: return .mine
            case .inactive: return .skip
            case .refused:
                logRefusal(call, privacy: privacy)
                return .skip
            case .forward(let owner):
                if let value = await owner.runIfOwner(body) { return .forwarded(value) }
            }
        }
    }

    /// Runs a call forwarded from another client, if this client still owns
    /// its app id. `nil` means "not here": either it is shutting down — then
    /// only after that shutdown has finished and released the app id — or it
    /// no longer owns it. Never awaits a forwarding client, so forwarding
    /// cannot deadlock.
    func runIfOwner<T: Sendable>(_ body: @Sendable (isolated StatsClient) async -> T) async -> T? {
        guard holdsLease, !isClosing, !isShutDown else {
            if isClosing || isShutDown { await shutDownSignal.wait() }
            return nil
        }
        return await body(self)
    }

    /// Non-privacy calls on a refused client counted so far — the rate limit on
    /// their log line.
    private var refusedCalls = 0
    /// A refused client logs its first non-privacy call and then one in every
    /// this many: once per `track()` would bury everything else in the log.
    private static let refusalLogInterval = 100

    /// A refused client says why it did nothing: for ordinary calls on the
    /// first and then every `refusalLogInterval`-th, and for **every** privacy
    /// call at `fault`, since the person's choice was not applied.
    private func logRefusal(_ call: String, privacy: Bool) {
        if !privacy {
            refusedCalls += 1
            guard refusedCalls == 1 || refusedCalls % Self.refusalLogInterval == 0 else { return }
        }
        if privacy {
            logger.fault("""
                \(call, privacy: .public) was NOT applied: this StatsClient's storageDirectory \
                belongs to a StatsClient for a different appId, so this client does nothing. \
                Give each appId its own storageDirectory.
                """)
        } else {
            logger.error("""
                \(call, privacy: .public) did nothing (\(self.refusedCalls, privacy: .public) refused \
                call(s) so far): this StatsClient's storageDirectory belongs to a StatsClient for a \
                different appId. Give each appId its own storageDirectory.
                """)
        }
    }

    /// True for the one client that may touch this app id's queue and state.
    /// For the owner-only paths below, which a public entry point has already
    /// routed through `route()`.
    private var isLive: Bool {
        holdsLease && !isShutDown
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
            suiteName: configuration.identitySuiteName, salt: configuration.installIdSalt
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
        guard case .mine = await route("track()", { await $0.track(name, props: props) }) else { return }
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

        // Another client owns the app id: hand the call straight to it, still
        // without a hop, and with the timestamp taken at *this* call. Only with
        // nothing of our own buffered, though — entries already waiting here
        // reach the owner through the pump, and a direct hand-off would
        // overtake them. An owner that has started shutting down refuses, and
        // the entry is buffered here instead, for the pump to re-route.
        let owner: StatsClient? = recorded.withLock { buffer in
            guard !buffer.isShutDown, buffer.entries.isEmpty, !buffer.pumpScheduled else { return nil }
            return StatsClientRegistry.liveOwner(of: registryKeys, excluding: leaseToken)
        }
        if let owner, owner.acceptForwarded([entry], capped: true) { return }
        bufferRecorded(entry)
    }

    /// `record()`'s own buffer: append under the cap, schedule one pump.
    private nonisolated func bufferRecorded(_ entry: RecordedEvent) {
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
            logOverflow(dropped)
        case .pump:
            // Weak, so a dropped client is deallocated rather than kept alive by
            // its own drainer.
            Task { [weak self] in await self?.drainRecorded() }
        case .none:
            break
        }
    }

    private nonisolated func logOverflow(_ dropped: Int) {
        logger.error("""
            record() buffer is full at \(self.maxRecordedBuffer, privacy: .public) entries; \
            dropping the newest (\(dropped, privacy: .public) so far) until it drains
            """)
    }

    /// Takes another client's recorded-but-not-captured entries into this
    /// client's `record()` buffer, behind anything already there, and
    /// schedules a pump if none is, so they reach disk even when the caller
    /// does not drain.
    ///
    /// `capped` applies this client's `record()` cap — for a single call
    /// forwarded straight from another client's `record()`, which has not been
    /// accepted anywhere yet; past the cap it is dropped and logged exactly as
    /// this client's own `record()` would. Uncapped — entries a forwarding
    /// client already accepted into its own buffer — they are never dropped.
    ///
    /// Returns `false` only when this client's buffer is closed (it is shutting
    /// down): nothing was taken, and the caller keeps the entries to re-route.
    nonisolated func acceptForwarded(_ entries: [RecordedEvent], capped: Bool) -> Bool {
        enum Outcome { case closed, accepted(pump: Bool), overflowed(Int?) }
        let outcome: Outcome = recorded.withLock { buffer in
            guard !buffer.isShutDown else { return .closed }
            if capped, buffer.entries.count + entries.count > maxRecordedBuffer {
                buffer.dropped += entries.count
                buffer.lifetimeDropped += entries.count
                guard !buffer.didLogDrop else { return .overflowed(nil) }
                buffer.didLogDrop = true
                return .overflowed(buffer.dropped)
            }
            buffer.entries.append(contentsOf: entries)
            guard !buffer.pumpScheduled else { return .accepted(pump: false) }
            buffer.pumpScheduled = true
            return .accepted(pump: true)
        }
        switch outcome {
        case .closed:
            return false
        case .overflowed(let dropped):
            if let dropped { logOverflow(dropped) }
            return true
        case .accepted(let pump):
            if pump { Task { [weak self] in await self?.drainRecorded() } }
            return true
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
        // A forwarding client's `record()` calls land in the owner's buffer,
        // so "everything accepted so far is on disk" includes draining that.
        _ = await route("drainRecorded()") { await $0.drainRecorded() }
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
            // Recorded here before an owner existed (or before this one took
            // over): hand them on in order, with their call-time timestamps.
            switch await route("record()", { owner -> Bool in
                guard owner.acceptForwarded(batch, capped: false) else { return false }
                await owner.drainRecorded()
                return true
            }) {
            case .forwarded(true), .skip:
                continue
            case .forwarded(false):
                // The owner closed between the routing and the hand-off: put
                // the batch back, ahead of anything newer, and route it again.
                recorded.withLock { $0.entries.insert(contentsOf: batch, at: 0) }
                continue
            case .mine:
                break
            }
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
        // The refused string is logged as a length and a hash, never verbatim:
        // a name that fails validation is, by definition, not one of the app's
        // constant identifiers, and may well be user content passed by mistake.
        let scalars = name.unicodeScalars.count
        if StatsEventName.reserved.contains(name) || name.hasPrefix(StatsEventName.reservedPrefix) {
            logger.error("""
                refused a reserved event name (\(scalars, privacy: .public) scalars, \
                \(name, privacy: .private(mask: .hash))) (schema §12)
                """)
        } else {
            logger.error("""
                refused a malformed event name (\(scalars, privacy: .public) scalars, \
                \(name, privacy: .private(mask: .hash))): \
                must match ^[a-z][a-z0-9_]*$ and be 1-64 scalars (schema §2.1)
                """)
        }
        return false
    }

    /// Attaches an opaque account identifier to every subsequent event (§2.5).
    ///
    /// The value is hashed with the install salt before it is stored or sent, so
    /// a raw identifier never leaves the device — but pass something opaque
    /// anyway. This is what turns per-install analytics into per-user ones:
    /// without it no `userId` is ever sent. Most apps should never call it — it
    /// makes an account's events linkable, which is a real privacy cost.
    ///
    /// Under denied `identity` consent the hash is kept in memory and not
    /// emitted, and `identify()` cannot re-enable linkage consent withheld. If
    /// `.identity` is granted later in the same process, events from then on
    /// carry it; it is not persisted, so after a relaunch it is gone until
    /// `identify()` is called again.
    ///
    /// On sign-out, call ``forgetUser()``: it stops attaching the hash without
    /// touching the install, the queue or the session. (``setEnabled(_:)`` off
    /// and on again would also drop the hash, but it discards the queue and ends
    /// the session too; ``reset()`` forgets the install as well.) A backend
    /// erasing the account looks it up by ``StatsConfiguration/hashedUserId(_:)``.
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
        // Events recorded before this call belong to the un-identified stretch,
        // so they are captured before the hash is attached.
        await drainRecordedIfNeeded()
        guard case .mine = await route("identify(userID:)", { await $0.identify(userID: userID) }) else { return }
        guard enabled else {
            logger.warning("identify() ignored: the client is opted out")
            return
        }
        let hash = identity.hashedUserId(userID)
        userIdHash = hash
        if consent.contains(.identity) { identity.userIdHash = hash }
    }

    /// Stops attaching the hashed `userId` from ``identify(userID:)`` — the
    /// sign-out call (§2.5). Events from now on carry no `userId` until
    /// `identify()` is called again, in this launch or a later one: the hash is
    /// cleared from memory **and** from the SDK's defaults suite.
    ///
    /// It forgets the *account*, not the *install*, and changes nothing else:
    ///
    /// - The install UUID, `seq`, consent and the opt-out are untouched, so the
    ///   install's metrics carry on as one install across the sign-out.
    /// - The current session continues — no `session_end` / `session_start`.
    /// - The queue is kept. Events already captured, and events accepted by
    ///   ``record(_:props:)`` before this call (drained first, as `identify()`
    ///   does), keep the `userId` they were recorded under and are sent as
    ///   normal. To keep them from being sent, use ``setEnabled(_:)`` or a
    ///   consent revocation instead, which discard the queue.
    ///
    /// It applies to calls ordered after it returns. A `record()` made
    /// concurrently from another task may land on either side of the drain,
    /// and so may still carry the id.
    ///
    /// Safe to call when nothing was identified, and it still clears the hash
    /// when the client is opted out or `.identity` is denied — a remembered
    /// in-memory hash must not reappear on a later grant. Like every call, a
    /// second client for the same app id forwards it to the owner; on a client
    /// that was itself ``shutdown()`` it does nothing.
    ///
    /// This is a client-side unlink only; it does not delete anything a backend
    /// already holds. To erase the account there, the app's server sends
    /// ``StatsConfiguration/hashedUserId(_:)`` for that account.
    public func forgetUser() async {
        // Events recorded before this call belong to the identified stretch, so
        // they are captured — under the hash — before it is cleared.
        await drainRecordedIfNeeded()
        // `privacy`: a refused client logs this at `fault` — the person signed
        // out and the unlink was not applied.
        guard case .mine = await route("forgetUser()", privacy: true, { await $0.forgetUser() }) else { return }
        // No `enabled` / consent guard: clearing is always allowed, and
        // `identify()` under denied consent keeps an in-memory hash that a later
        // grant would otherwise start emitting.
        // The read spares a defaults write (and the file rewrite behind it)
        // on the common nothing-to-forget path. Read and write are synchronous
        // on the actor, so no other call can store a hash in between.
        if identity.userIdHash != nil { identity.userIdHash = nil }
        userIdHash = nil
    }

    // MARK: - Consent and opt-out

    public var currentConsent: StatsConsent {
        get async {
            if case .forwarded(let value) = await route("currentConsent", { await $0.currentConsent }) { return value }
            return consent
        }
    }

    /// Whether sessions started from now on carry a stable `installId`.
    ///
    /// `true` means the current consent includes `.identity`, so each new
    /// session uses the hash of the stored install UUID, which persists across
    /// sessions and launches. `false` means each new session mints its own
    /// ephemeral install id, so install-based metrics (installs, active
    /// installs, first-seen installs, retention) count sessions.
    ///
    /// It reports the policy, not the id already in use. It reflects the
    /// current — possibly persisted — consent, so it changes after
    /// ``setConsent(_:)``, but a grant made mid-session does not re-stamp that
    /// session: its events keep the per-session id until the next session
    /// starts. And the stored UUID is not permanent: revoking **any** consent
    /// group deletes it, so the next identified session mints a new one.
    /// `identify(userID:)` plays no part in any of this.
    public var hasStableInstallIdentity: Bool {
        get async {
            if case .forwarded(let value) = await route("hasStableInstallIdentity", { await $0.hasStableInstallIdentity }) { return value }
            return consent.contains(.identity)
        }
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
        // Through any handle, the choice is the owner's: a settings screen
        // with its own client must opt the app out, not itself.
        // A forwarding client hands over what it recorded first, so those
        // events meet the choice in the order they were made.
        if !holdsLease { await drainRecordedIfNeeded() }
        // Any consent call is a privacy choice: refused, it is logged at fault.
        guard case .mine = await route("setConsent(_:)", privacy: true, { await $0.setConsent(groups) })
        else { return }
        guard isLive else { return }
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
        get async {
            if case .forwarded(let value) = await route("isEnabled", { await $0.isEnabled }) { return value }
            return enabled
        }
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
        if !holdsLease { await drainRecordedIfNeeded() }
        guard case .mine = await route("setEnabled(_:)", privacy: !newValue, { await $0.setEnabled(newValue) })
        else { return }
        guard isLive, newValue != enabled else { return }
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
    ///
    /// Sends nothing while the client is not collecting: opted out or without
    /// `usage` consent, a queue left from an earlier launch is discarded
    /// instead (§11).
    public func flush() async {
        await drainRecordedIfNeeded()
        guard case .mine = await route("flush()", { await $0.flush() }) else { return }
        guard await mayFlush() else { return }
        await dispatcher.flushNow()
    }

    /// Forgets this install: flushes what the old identity produced, then a
    /// fresh UUID, `seq` back to 0, no `userId`, and a new session on the next
    /// event. Events from before and after a reset are not linkable (§9).
    ///
    /// This is the call that **forgets the install**, which neither switch does
    /// on its own: ``setEnabled(_:)`` keeps the stored UUID and ``setConsent(_:)``
    /// only deletes it on a revocation. Pair it with an opt-out when you want
    /// "stop collecting *and* forget me". While not collecting, the old
    /// identity's queue is discarded rather than flushed (§9 allows either).
    public func reset() async {
        // Everything recorded before the reset belongs to the old identity, so
        // it is captured (and flushed) before the identity rotates.
        await drainRecordedIfNeeded()
        guard case .mine = await route("reset()", privacy: true, { await $0.reset() }) else { return }
        if await mayFlush() { await dispatcher.flushNow() }
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
        guard case .mine = await route("waitForFlushes()", { await $0.waitForFlushes() }) else { return }
        await dispatcher.waitForFlushes()
    }

    /// Cancels the interval timer and any pending retry, waits for an in-flight
    /// flush, and leaves queued events on disk for the next launch — then gives
    /// up ownership of the app id, so the next call on another client (or a
    /// client created afterwards) takes over (see "One owner per app id" on
    /// the type). On a client that forwards, it only hands over what this
    /// client had buffered and stops it; the owner is not shut down.
    ///
    /// While an owner's shutdown runs, a call forwarded to it from another
    /// client waits for the shutdown to finish — which takes as long as the
    /// in-flight send, so it is bounded by the sink's request timeout — and
    /// then goes to the next owner.
    ///
    /// Terminal: a shut-down client captures, sends, forwards and changes
    /// nothing. Call it when tearing a client down for good — a test's
    /// teardown, or an app replacing its client. It is not a pause.
    public func shutdown() async {
        // Forwarded calls stop being run here from this point: they wait for
        // the end of this shutdown and then go to whoever owns the app id
        // next, instead of reaching a client that would drop them.
        isClosing = true
        if holdsLease { StatsClientRegistry.markClosing(token: leaseToken) }
        defer { shutDownSignal.fire() }
        // Close the door first, then drain what was already accepted: a
        // `record()` arriving after this must not restart the drainer on a
        // client the owner believes is torn down.
        recorded.withLock { $0.isShutDown = true }
        await drainRecorded()
        recordedPumpTask = nil
        // From here on every entry point is a no-op; a drain already past its
        // checks finishes before the claim is released.
        isShutDown = true
        await drainTask?.value
        await dispatcher.shutdown()
        if holdsLease {
            holdsLease = false
            // Revoked before the release, as in `deinit`: nothing of this
            // client's may touch the file once another client can own it.
            revocation.revoke()
            StatsClientRegistry.release(token: leaseToken)
        }
    }

    /// Current queue depth, for diagnostics and tests — the owner's, through
    /// any client for the app id. `0` once this client is shut down.
    public var queuedEventCount: Int {
        get async {
            switch await route("queuedEventCount", { await $0.queuedEventCount }) {
            case .forwarded(let count): return count
            case .skip: return 0
            case .mine: return await store.count
            }
        }
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
        get async {
            if case .forwarded(let value) = await route("storeDiagnostics", { await $0.storeDiagnostics }) { return value }
            return await store.diagnostics
        }
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
        guard case .mine = await route("applicationDidBecomeActive()", { await $0.applicationDidBecomeActive() }) else { return }
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
        guard case .mine = await route("applicationDidEnterBackground()", { await $0.applicationDidEnterBackground() }) else { return }
        guard await mayFlush() else { return }
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
        return isLive && enabled && consent.contains(.usage) && identity.isAvailable
    }

    /// Whether a flush may send, decided **before** it does — `flush()`,
    /// `reset()` and `applicationDidEnterBackground()` all ask.
    ///
    /// A queue can outlive the state that allowed it: written by an earlier
    /// launch, then a stored opt-out or a stored consent without `usage` (a
    /// revocation discard that failed, a choice written while another client
    /// held the queue). Sending it would put events on the wire from a state
    /// that §11 says collects nothing, so a flush never sends unless the client
    /// is collecting right now.
    ///
    /// When collection is off by a *choice* — opted out, or `usage` not
    /// granted — the leftover queue is discarded rather than held. Holding it
    /// would send it the moment the person opted back in, which is exactly
    /// what `setEnabled(false)` and a revocation exist to prevent (§11
    /// discards on revocation, never flushes). When it is off only because the
    /// SDK's own suite could not be opened, nothing is known about the choice,
    /// so the queue is held.
    ///
    /// A *configured* consent that drops a group in an app update (with no
    /// `setConsent` call) is still not a revocation: the install UUID is kept.
    /// Only the queue rule above applies to it.
    private func mayFlush() async -> Bool {
        guard isLive else { return false }
        if isCollecting { return true }
        guard !enabled || !consent.contains(.usage) else { return false }
        // Nothing queued, nothing to discard — and no reason to touch the
        // disk at all: a client that collects nothing calls this on every
        // `flush()` and background. (Asking the store only checks for a file;
        // the queue location is resolved without creating directories.)
        guard await store.count > 0 else { return false }
        pending.removeAll()
        discardGeneration += 1
        await dispatcher.discardAll()
        return false
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
        if let ephemeral = ephemeralNextSeq {
            ephemeralNextSeq = ephemeral + 1
            return ephemeral
        }
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
            lastEventAt: now,
            firstActivity: monotonic,
            lastActivity: monotonic,
            didEmitAppOpen: false
        )

        // Fixed ordering at a boundary (§12): session_end (previous id, lower
        // seq) first, and — critically — emitted *before* the install id and
        // context rotate, so it closes the previous session under the identity
        // and context that session actually ran with. Under denied `identity`
        // consent those differ every session (§11).
        if let previous, configuration.autoEvents.contains(.sessions) {
            let duration = (previous.lastActivity - previous.firstActivity).timeInterval
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
            ephemeralNextSeq = nil
        } else {
            sessionInstallId = identity.installId(for: configuration.uuidProvider.uuid())
            // A fresh id, so a fresh `seq` space (§6).
            ephemeralNextSeq = 0
            warnEphemeralInstallOnce()
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

    /// Says once per client that the install id it just minted is per-session.
    ///
    /// The default consent grants `identity`, so this fires only for an app
    /// whose consent denies it (configured or recorded) — it gets a fresh
    /// install id every session, and install-based metrics that silently count
    /// sessions. Evaluated here, at the first mint, rather than at
    /// configuration time: that is the only point at which it is certainly
    /// true. An app that grants `.identity` before its first session, or that
    /// starts disabled and never opens one, is never warned.
    private func warnEphemeralInstallOnce() {
        guard ephemeralInstallWarningCount == 0 else { return }
        ephemeralInstallWarningCount += 1
        logger.warning("""
            identity consent is not granted, so installId is per-session: \
            install-based metrics (installs, active installs, first-seen installs, retention) \
            will count sessions. Grant .identity (the default consent includes it) for a stable install; \
            identify() is not needed
            """)
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
        ephemeralNextSeq = nil
        sessionContext = nil
    }
}

/// Which client owns each app id — and each consumer-supplied storage
/// directory — in this process (see "One owner per app id" on
/// ``StatsClient``). A process-wide `Mutex`, because the clients are separate
/// actors and a claim has to be atomic across them. The lock is only ever held
/// for a dictionary lookup: never across an `await`.
nonisolated enum StatsClientRegistry {
    private struct Owner {
        var token: Int
        /// Weak: the registry must not keep a dropped client alive. `nil`
        /// means the owner was deallocated and its `deinit` has not released
        /// the entry yet.
        weak var client: StatsClient?
        /// The owner's store-and-dispatcher flag, so a claimant that finds the
        /// owner already gone stops them itself, under this lock, before it
        /// starts on the same file — closing the window between "the weak
        /// reference is nil" and "the owner's `deinit` has run".
        var revocation: QueueRevocation
        /// Set when the owner starts shutting down. It still owns the file
        /// until its shutdown finishes, so a claimant must wait (it is still
        /// returned by `resolve`), but `record()` no longer hands entries to it.
        var isClosing = false
    }

    private struct State {
        var nextToken = 0
        var owners: [String: Owner] = [:]
    }

    private static let state = Mutex(State())

    static func makeToken() -> Int {
        state.withLock { state in
            state.nextToken += 1
            return state.nextToken
        }
    }

    /// What a client owns or forwards for: its app id, which names the
    /// `UserDefaults` suite (and the default queue location), plus an explicit
    /// storage directory, which holds a queue file whatever app id uses it.
    static func keys(for configuration: StatsConfiguration) -> [String] {
        var keys = ["appId:\(configuration.appId)"]
        if let directory = configuration.storageDirectory {
            keys.append("directory:\(directory.standardizedFileURL.path)")
        }
        return keys
    }

    enum Resolution {
        /// The caller now owns every one of its keys.
        case claimed
        /// A live client owns the caller's app id: forward to it.
        case owner(StatsClient)
        /// A live client owns only the caller's storage directory — so it is
        /// a client for a different app id, which must not be forwarded to.
        case directoryConflict
    }

    private static func isAppIdKey(_ key: String) -> Bool { key.hasPrefix("appId:") }

    /// The live owner of the caller's app id, or a refusal when only its
    /// storage directory is taken (by another app id), or — when neither is —
    /// a claim of all its keys. All or nothing, so an owner always owns its
    /// whole key set and never has anyone to forward to: forwarding is one hop
    /// and cannot loop.
    static func resolve(
        _ keys: [String], token: Int, client: StatsClient, revocation: QueueRevocation
    ) -> Resolution {
        state.withLock { state in
            func liveOther(_ key: String) -> StatsClient? {
                guard let owner = state.owners[key], owner.token != token else { return nil }
                return owner.client
            }
            for key in keys where isAppIdKey(key) {
                if let live = liveOther(key) { return .owner(live) }
            }
            for key in keys where !isAppIdKey(key) {
                if liveOther(key) != nil { return .directoryConflict }
            }
            for key in keys {
                // A dead owner's work is stopped before its file changes hands.
                if let owner = state.owners[key], owner.token != token { owner.revocation.revoke() }
                state.owners[key] = Owner(token: token, client: client, revocation: revocation)
            }
            return .claimed
        }
    }

    /// The live, not-closing owner of the caller's app id, without claiming:
    /// `record()`'s synchronous hand-off. A closing owner is skipped, so the
    /// entry is buffered here and routed (and, if need be, waits) via the pump.
    static func liveOwner(of keys: [String], excluding token: Int) -> StatsClient? {
        state.withLock { state in
            for key in keys where isAppIdKey(key) {
                if let owner = state.owners[key], owner.token != token, !owner.isClosing,
                   let live = owner.client {
                    return live
                }
            }
            return nil
        }
    }

    /// Marks `token`'s entries as closing (see `Owner.isClosing`).
    static func markClosing(token: Int) {
        state.withLock { state in
            for (key, owner) in state.owners where owner.token == token {
                state.owners[key]?.isClosing = true
            }
        }
    }

    /// Internal test seam: whether `key`'s owner is shutting down.
    static func isClosing(_ key: String) -> Bool {
        state.withLock { $0.owners[key]?.isClosing ?? false }
    }

    /// Releases whatever `token` owns. A no-op for a token that owns nothing —
    /// including one whose keys a later claimant has already taken over.
    static func release(token: Int) {
        state.withLock { state in
            state.owners = state.owners.filter { $0.value.token != token }
        }
    }
}
