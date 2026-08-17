import Foundation
import os

private nonisolated let logger = Logger(subsystem: StatsLog.subsystem, category: "EventStore")

/// The durable queue: one JSON object per line in
/// `Application Support/<bundleId>/swift-stats/queue.jsonl`.
///
/// Why a file and not memory: an in-memory queue loses everything on a kill,
/// which is exactly when you most want the events. Why JSON lines and not a
/// single JSON array: appending one line is one `write(2)` at the end of the
/// file, so the cost of `track()` does not grow with the queue depth, and a
/// truncated tail (power loss mid-write) costs one event instead of the file.
///
/// Each line carries the event **and the context that was current when it was
/// tracked**, because schema §1 forbids re-stamping a queued batch with a newer
/// context. That duplicates ~300 bytes per event on disk and is worth it: the
/// alternative is a second file to keep in sync.
///
/// All I/O happens inside this actor, i.e. never on the main actor.
actor EventStore {
    /// One queue line.
    struct Record: Sendable, Codable, Hashable {
        var event: StatsEvent
        var context: StatsContext
    }

    /// A queued record plus the store-local id used to remove it later.
    private struct Entry {
        var id: Int
        var record: Record
    }

    /// A batch the dispatcher may attempt, tagged with the id range it covers.
    struct Pending: Sendable {
        var context: StatsContext
        var events: [StatsEvent]
        /// Store-local id of the batch's first record — the dispatcher uses it to
        /// notice that the head moved under a retained batch.
        var firstID: Int
        /// Store-local id of the batch's last record. Removal is by id, never by
        /// position: an `append` that trips the drop-oldest cap, or a `removeAll`
        /// followed by fresh events, shifts the head while a flush is suspended in
        /// `sink.send`, and a positional `removeFirst` would then delete events
        /// that were never sent.
        var lastID: Int
        var recordCount: Int
    }

    /// Resolves the queue file's location. A closure rather than a `URL` so that
    /// `FileManager.url(for:.applicationSupportDirectory, create: true)` — which
    /// is synchronous disk I/O, and creates a directory — happens inside this
    /// actor on first use rather than on whatever thread built the client.
    private let resolveFileURL: @Sendable () -> URL
    private var cachedFileURL: URL?
    private let maxQueued: Int
    private var entries: [Entry] = []
    private var nextID = 0
    private var didLoad = false
    /// Set when a disk write failed, so the next mutation rewrites the whole file
    /// from memory instead of leaving the two permanently divergent.
    private var needsRewrite = false

    init(fileURL: @escaping @Sendable () -> URL, maxQueued: Int) {
        self.resolveFileURL = fileURL
        self.maxQueued = maxQueued
    }

    /// The queue file, resolved once, lazily, on the actor.
    private var fileURL: URL {
        if let cachedFileURL { return cachedFileURL }
        let resolved = resolveFileURL()
        cachedFileURL = resolved
        return resolved
    }

    /// The default location. `Application Support` rather than `Caches`: the
    /// system may evict a cache at any moment, and a dropped queue is data loss.
    static func defaultFileURL(appId: String) throws -> URL {
        let base = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        )
        return base
            .appendingPathComponent(appId, isDirectory: true)
            .appendingPathComponent("swift-stats", isDirectory: true)
            .appendingPathComponent("queue.jsonl", isDirectory: false)
    }

    var count: Int {
        loadIfNeeded()
        return entries.count
    }

    /// Appends and returns the resulting queue depth.
    ///
    /// The bytes reach the queue file before this returns, so a queued event
    /// survives the process being killed. It is *not* `fsync`ed — a kernel panic
    /// or power loss can still lose the last write, which is the deliberate
    /// trade: one `fsync` per `track()` would put a disk flush on a UI code path
    /// for data that is, by design, disposable.
    func append(_ newRecords: [Record]) -> Int {
        loadIfNeeded()
        guard !newRecords.isEmpty else { return entries.count }
        for record in newRecords {
            entries.append(Entry(id: nextID, record: record))
            nextID += 1
        }

        if entries.count > maxQueued {
            // Drop-oldest past the cap (§5): the newest events are the ones a
            // reader is waiting for, and the oldest are the likeliest to be past
            // the retention ceiling anyway.
            let overflow = entries.count - maxQueued
            entries.removeFirst(overflow)
            logger.warning("queue is at its \(self.maxQueued, privacy: .public)-event cap; dropped \(overflow, privacy: .public) oldest")
            rewrite()
            return entries.count
        }

        if needsRewrite {
            rewrite()
        } else {
            appendLines(for: newRecords)
        }
        return entries.count
    }

    /// The next batch to attempt: head records that share one context, bounded
    /// by 100 events and 256 KiB of serialized envelope (§5).
    ///
    /// The byte limit is enforced *before* the count limit, as §5 requires: 100
    /// events with 32 long props each do not fit.
    func nextBatch(maxEvents: Int, maxBytes: Int, batchId: String, sentAt: Date) -> Pending? {
        loadIfNeeded()
        guard let first = entries.first else { return nil }

        // Envelope cost with an empty `events` array, measured once. Adding the
        // n-th item costs its own encoded bytes plus one comma — exact, because
        // the encoder's output is deterministic (`sortedKeys`).
        guard let envelopeBytes = serializedSize(
            batchId: batchId, sentAt: sentAt, context: first.record.context, events: []
        ) else {
            // The context itself will not encode. Nothing built from it can ship,
            // so drop the head rather than spin on it forever.
            logger.error("dropped a queued event whose context could not be encoded")
            removeFirstEntry()
            return nextBatch(maxEvents: maxEvents, maxBytes: maxBytes, batchId: batchId, sentAt: sentAt)
        }

        var events: [StatsEvent] = []
        var lastID = first.id
        var remaining = maxBytes - envelopeBytes
        for entry in entries {
            // One context per batch, and never more than one (appId, installId)
            // pair or projectId (§1) — a backend MUST reject a mixed batch with
            // 400, which is a permanent drop. Context equality alone is not
            // enough: under denied `identity` consent every session gets a fresh
            // ephemeral install id while the context bytes stay identical.
            guard entry.record.context == first.record.context,
                  entry.record.event.installId == first.record.event.installId,
                  entry.record.event.appId == first.record.event.appId,
                  entry.record.event.projectId == first.record.event.projectId
            else { break }
            guard events.count < maxEvents else { break }
            guard let eventBytes = try? StatsJSON.encoder.encode(entry.record.event).count else {
                if events.isEmpty {
                    logger.error("dropped a queued event that could not be encoded")
                    removeFirstEntry()
                    return nextBatch(maxEvents: maxEvents, maxBytes: maxBytes, batchId: batchId, sentAt: sentAt)
                }
                break
            }
            let separator = events.isEmpty ? 0 : 1
            // Plain arithmetic against a remaining budget: no sentinel, so no
            // overflow can turn an over-limit batch into an under-limit one.
            if eventBytes + separator > remaining {
                if events.isEmpty {
                    // A single event that alone exceeds the limit cannot be
                    // split; the dispatcher drops it and logs at error (§5).
                    return Pending(
                        context: first.record.context, events: [entry.record.event],
                        firstID: entry.id, lastID: entry.id, recordCount: 1
                    )
                }
                break
            }
            remaining -= eventBytes + separator
            events.append(entry.record.event)
            lastID = entry.id
        }
        guard !events.isEmpty else { return nil }
        return Pending(
            context: first.record.context, events: events,
            firstID: first.id, lastID: lastID, recordCount: events.count
        )
    }

    /// Removes every record up to and including `id` — what "the batch was
    /// accepted (or permanently dropped)" means.
    ///
    /// By id rather than by position, so that a head shift during the flush (the
    /// drop-oldest cap, a `removeAll` from an opt-out) can only ever make this
    /// remove *fewer* records, never someone else's.
    func remove(through id: Int) {
        loadIfNeeded()
        let survivors = entries.drop(while: { $0.id <= id })
        guard survivors.count != entries.count else { return }
        entries = Array(survivors)
        rewrite()
    }

    /// The id of the record currently at the head, or `nil` when empty.
    var headID: Int? {
        loadIfNeeded()
        return entries.first?.id
    }

    private func removeFirstEntry() {
        guard !entries.isEmpty else { return }
        entries.removeFirst()
        rewrite()
    }

    /// Discards everything and deletes the file — opt-out and consent
    /// revocation both require this (§11), and they require *discarding*, not
    /// flushing.
    func removeAll() {
        entries.removeAll()
        didLoad = true
        do {
            if FileManager.default.fileExists(atPath: fileURL.path) {
                try FileManager.default.removeItem(at: fileURL)
            }
        } catch {
            logger.error("could not delete the queue file: \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - Disk

    private func loadIfNeeded() {
        guard !didLoad else { return }
        didLoad = true
        guard FileManager.default.fileExists(atPath: fileURL.path) else { return }
        do {
            let data = try Data(contentsOf: fileURL)
            var loaded: [Record] = []
            var malformed = 0
            for line in data.split(separator: UInt8(ascii: "\n")) where !line.isEmpty {
                if let record = try? StatsJSON.decoder.decode(Record.self, from: Data(line)) {
                    loaded.append(record)
                } else {
                    malformed += 1
                }
            }
            if malformed > 0 {
                // A partial trailing line is the expected case after a kill
                // mid-write; anything else means a format change.
                logger.warning("skipped \(malformed, privacy: .public) unreadable queue line(s)")
            }
            var didTruncate = false
            if loaded.count > maxQueued {
                loaded.removeFirst(loaded.count - maxQueued)
                didTruncate = true
            }
            entries = loaded.map { record in
                defer { nextID += 1 }
                return Entry(id: nextID, record: record)
            }
            logger.debug("loaded \(loaded.count, privacy: .public) queued event(s)")
            if malformed > 0 || didTruncate {
                // Normalize the file so a partial line or an over-cap backlog is
                // not re-parsed on every launch.
                rewrite()
            }
        } catch {
            logger.error("could not read the queue file: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// One `write(2)` at the end of the file for the whole group: appending does
    /// not get more expensive as the queue grows.
    private func appendLines(for newRecords: [Record]) {
        do {
            try ensureDirectory()
            var lines = Data()
            for record in newRecords {
                lines.append(try StatsJSON.lineEncoder.encode(record))
                lines.append(UInt8(ascii: "\n"))
            }
            if let handle = FileHandle(forWritingAtPath: fileURL.path) {
                defer { try? handle.close() }
                try handle.seekToEnd()
                try handle.write(contentsOf: lines)
            } else {
                try lines.write(to: fileURL, options: .atomic)
                restrictPermissions()
            }
        } catch {
            // The records stay in memory, so they are not lost until the process
            // is; the flag makes the next mutation rewrite the file so memory and
            // disk cannot stay divergent.
            needsRewrite = true
            logger.error("could not append to the queue file: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Rewrites the whole file atomically. Only used on removal, which is
    /// per-batch rather than per-event, so the O(queue) cost is amortized.
    private func rewrite() {
        do {
            try ensureDirectory()
            var data = Data()
            for entry in entries {
                data.append(try StatsJSON.lineEncoder.encode(entry.record))
                data.append(UInt8(ascii: "\n"))
            }
            try data.write(to: fileURL, options: .atomic)
            restrictPermissions()
            needsRewrite = false
        } catch {
            needsRewrite = true
            logger.error("could not rewrite the queue file: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func ensureDirectory() throws {
        let directory = fileURL.deletingLastPathComponent()
        if !FileManager.default.fileExists(atPath: directory.path) {
            // 0700 on the directory the SDK owns. `withIntermediateDirectories`
            // applies these attributes only to directories it actually creates,
            // so an existing `Application Support` is left alone.
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        }
    }

    /// Owner-only (0600) on the queue file.
    ///
    /// Necessary on every write, not once at creation: `Data.write(options:
    /// .atomic)` writes a *new* temporary file and renames it over the old one,
    /// so the replacement carries the process umask's 0644 rather than inheriting
    /// the mode of the file it replaced. Best-effort — a failure here must not
    /// cost the write that just succeeded, and the file holds queued events, not
    /// a secret.
    ///
    /// The queue file has no `installId` an attacker could not derive anyway, but
    /// it does carry event names, `props` and a hashed `userId` for an install
    /// that has not yet flushed, and on macOS another user's process can read a
    /// 0644 file under `~/Library/Application Support`.
    private func restrictPermissions() {
        do {
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600], ofItemAtPath: fileURL.path
            )
        } catch {
            logger.error(
                "could not restrict the queue file's permissions: \(error.localizedDescription, privacy: .public)"
            )
        }
    }

    private func serializedSize(
        batchId: String, sentAt: Date, context: StatsContext, events: [StatsEvent]
    ) -> Int? {
        let batch = StatsBatch(batchId: batchId, sentAt: sentAt, context: context, events: events)
        return try? batch.serialized().count
    }
}
