import Foundation
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
    private let identity: StatsIdentityStore
    private let store: EventStore
    private let dispatcher: Dispatcher

    private var consent: StatsConsent
    private var enabled: Bool
    /// The validated `projectId`, or `nil` when the configured one is malformed.
    private let projectId: String?

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

    /// - Parameter configuration: everything, including the sink and the test
    ///   seams. Nothing is read from a global.
    public init(configuration: StatsConfiguration) {
        self.configuration = configuration
        self.identity = StatsIdentityStore(
            appId: configuration.appId, salt: configuration.installIdSalt
        )

        let fileURL: URL
        if let directory = configuration.storageDirectory {
            fileURL = directory.appendingPathComponent("queue.jsonl", isDirectory: false)
        } else if let defaultURL = try? EventStore.defaultFileURL(appId: configuration.appId) {
            fileURL = defaultURL
        } else {
            // No Application Support (a sandbox oddity): fall back to a
            // temporary file rather than losing the queue type entirely.
            fileURL = URL(fileURLWithPath: NSTemporaryDirectory())
                .appendingPathComponent("swift-stats-\(configuration.appId).jsonl")
            logger.error("Application Support is unavailable; the queue is in a temporary directory")
        }
        self.store = EventStore(fileURL: fileURL, maxQueued: configuration.maxQueued)
        self.dispatcher = Dispatcher(store: store, configuration: configuration)

        // The persisted choice wins; the configuration's values apply only the
        // first time this app runs (§11).
        self.consent = identity.storedConsent ?? configuration.consent
        self.enabled = identity.storedEnabled ?? configuration.enabled
        self.userIdHash = self.consent.contains(.identity) ? identity.userIdHash : nil

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
        } else {
            self.projectId = configuration.projectId
        }
        if !identity.isAvailable {
            logger.error("collection is disabled: the SDK could not open its own UserDefaults suite")
        }
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

    /// Records an event. Returns once the event is on disk — not once it is
    /// sent.
    ///
    /// Silently does nothing when the client is disabled or `usage` consent is
    /// absent. A reserved or malformed name is dropped and logged at `error`
    /// (§2.1, §12): a broken name is an emitter bug, and sending it would cost
    /// the whole batch a 400.
    public func track(_ name: String, props: [String: StatsValue] = [:]) async {
        guard isCollecting else { return }
        guard StatsEventName.isValidForApp(name) else {
            if StatsEventName.reserved.contains(name) || name.hasPrefix(StatsEventName.reservedPrefix) {
                logger.error("refused reserved event name \(name, privacy: .public) (schema §12)")
            } else {
                logger.error("""
                    refused malformed event name \(name, privacy: .public): \
                    must match ^[a-z][a-z0-9_]*$ and be 1-64 scalars (schema §2.1)
                    """)
            }
            return
        }
        await capture(name: name, props: props, at: configuration.clock.wallNow())
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
    public func identify(userID: String) async {
        guard !userID.isEmpty else {
            logger.error("identify() was given an empty id; ignoring")
            return
        }
        guard enabled else {
            logger.warning("identify() ignored: the client is opted out")
            return
        }
        let hash = identity.hashedUserId(userID)
        userIdHash = hash
        if consent.contains(.identity) { identity.userIdHash = hash }
    }

    // MARK: - Consent and opt-out

    public var currentConsent: StatsConsent { consent }

    /// Records a consent choice.
    ///
    /// Any group going from granted to denied is a **revocation**: the local
    /// queue is discarded (not flushed) and the stored install UUID is deleted,
    /// so revocation cannot be undone into a resumed identity. Re-granting
    /// starts a new identity with `seq` back at 0 (§11).
    public func setConsent(_ groups: StatsConsent) async {
        let revoked = consent.subtracting(groups)
        consent = groups
        identity.storeConsent(groups)

        guard !revoked.isEmpty else { return }
        logger.info("consent revoked for one or more groups; discarding the queue and the install identity")
        // Everything synchronous happens *before* the suspension: a `track()`
        // that interleaves must not still find the revoked session identity, and
        // must not be able to stamp an event with the install id being deleted.
        pending.removeAll()
        endSessionState()
        identity.deleteInstallUUID()
        identity.userIdHash = nil
        userIdHash = nil
        identity.seq = 0
        await dispatcher.discardAll()
    }

    /// The master opt-out. `true` by default; `false` means no capture at all,
    /// whatever consent says.
    public var isEnabled: Bool { enabled }

    public func setEnabled(_ newValue: Bool) async {
        guard newValue != enabled else { return }
        enabled = newValue
        identity.storeEnabled(newValue)
        guard !newValue else { return }
        // Disabled means the queue goes too: holding events for a person who
        // opted out and sending them if they change their mind is not opt-out.
        // Again, synchronous teardown first, then the suspension.
        pending.removeAll()
        endSessionState()
        // An opt-out must not leave a hashed account id behind to be re-linked on
        // the way back in.
        identity.userIdHash = nil
        userIdHash = nil
        await dispatcher.discardAll()
    }

    // MARK: - Flush and reset

    /// Attempts one flush and returns when the attempt is done. A `retry`
    /// outcome leaves the batch queued and schedules the backoff; it does not
    /// keep this call waiting.
    public func flush() async {
        await dispatcher.flushNow()
    }

    /// Forgets this install: flushes what the old identity produced, then a
    /// fresh UUID, `seq` back to 0, no `userId`, and a new session on the next
    /// event. Events from before and after a reset are not linkable (§9).
    public func reset() async {
        await dispatcher.flushNow()
        if consent.contains(.identity) {
            _ = identity.regenerateInstallUUID(makeUUID: configuration.uuidProvider.uuid)
        } else {
            // Under denied `identity` consent there is nothing persisted to
            // replace, and writing a fresh UUID here would store an identifier
            // consent withheld.
            identity.deleteInstallUUID()
        }
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
        await dispatcher.waitForFlushes()
    }

    /// Cancels the interval timer and any pending retry, leaving queued events on
    /// disk for the next launch. Call it when tearing a client down (a test's
    /// teardown, or an app that builds a client per window).
    public func shutdown() async {
        await dispatcher.shutdown()
    }

    /// Current queue depth, for diagnostics and tests.
    public var queuedEventCount: Int {
        get async { await store.count }
    }

    // MARK: - Lifecycle (called by the consumer, see the type's docs)

    /// The app became active. Starts a session if none is current or the
    /// inactivity gap has elapsed, and emits `app_open` once per session when
    /// that auto-event is enabled.
    public func applicationDidBecomeActive() async {
        guard isCollecting else { return }
        let now = configuration.clock.wallNow()
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
        guard isCollecting else { return }
        if configuration.autoEvents.contains(.appBackground), session != nil {
            await capture(name: "app_background", props: [:], at: configuration.clock.wallNow(), isAuto: true)
        }
        await dispatcher.flushNow()
    }

    // MARK: - Internals

    private var isCollecting: Bool { enabled && consent.contains(.usage) && identity.isAvailable }

    /// Session bookkeeping plus the actual enqueue.
    ///
    /// `isAuto` bypasses the reserved-name check, which is the only difference
    /// between an auto-event and an app event on the wire.
    private func capture(name: String, props: [String: StatsValue], at now: Date, isAuto: Bool = false) async {
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
            await dispatcher.enqueue(records)
        }
    }

    private func nextSeq() -> Int {
        let value = identity.seq
        identity.seq = value + 1
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
