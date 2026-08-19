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
/// ## Removal is a marker, not a rewrite
///
/// Removing the head used to rewrite the whole remaining file. Draining a 10k
/// backlog in batches of 100 therefore wrote ~250 MB — O(n²) in the queue depth,
/// on exactly the device that already failed to reach the network. Instead a
/// sidecar file, `queue.head`, records how many *leading bytes of the queue file
/// are already consumed*; removal updates memory plus that ~16-byte marker, and
/// the queue file itself is only rewritten ("compacted") once the dead prefix has
/// grown to at least the size of the live remainder. That bounds the total bytes
/// rewritten to O(1) per removed record, amortized.
///
/// ## Why the marker is a byte offset, and why appends never touch it
///
/// The marker is `"<consumedBytes> <fileSizeWhenWritten>\n"`, and it is read as
/// valid only when
///
/// * `0 <= consumedBytes <= fileSizeWhenWritten <= actualSize`, and
/// * `consumedBytes == 0` or the byte just before it is a newline — i.e. the
///   offset really is a line boundary of *this* file.
///
/// A byte offset is what makes an append free. **Appends only ever grow the
/// file, and never move a byte that precedes the current offset**, so a marker
/// written before an append is still exactly true after it: the prefix it
/// describes is untouched, it still ends on a newline, and the recorded size is
/// still `<= ` the (now larger) actual size. So `append` writes no marker at
/// all — no `stat`, no atomic write, no rename, no `chmod` per event.
///
/// A line *count* could not have that property: the count is only meaningful
/// together with the file it was counted in, so every append had to rewrite the
/// marker, and a crash between "the file grew" and "the marker caught up" left a
/// mismatch that loaded as *nothing consumed* — replaying records the backend had
/// already accepted, under fresh batch ids. With an offset there is no window:
/// the marker is written only by paths that *shrink or replace* the file, and
/// those either write it successfully or delete it.
///
/// Every other failure still fails safe. A marker that cannot be parsed, points
/// past the end of the file, or does not land on a line boundary is ignored and
/// the queue is read from byte zero. The worst case is re-reading records that
/// were already dropped for the cap, which the load-time cap truncation then
/// removes again — never skipping a record that was never sent.
///
/// All I/O happens inside this actor, i.e. never on the main actor.
actor EventStore {
    /// One queue line.
    struct Record: Sendable, Codable, Hashable {
        var event: StatsEvent
        var context: StatsContext
    }

    /// A queued record, the store-local id used to remove it later, and the
    /// number of bytes the record occupies in the queue file (its encoded line
    /// plus the newline).
    ///
    /// The length is carried here because it is only cheaply known where the
    /// line is encoded, and every consumed-byte update — a cap drop, a
    /// `remove(through:)`, a dropped unencodable head — is the sum of the
    /// lengths of the entries it removed. `0` means "not on disk in this
    /// shape", which happens only while the store is memory-only or already
    /// knows it must rewrite; the rewrite recomputes every length.
    private struct Entry {
        var id: Int
        var record: Record
        var byteLength: Int
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
    /// True when the directory holding the queue file belongs to this SDK (the
    /// default `Application Support/<appId>/swift-stats` path, or the temporary
    /// fallback's own subdirectory). Only then may this store impose `0700` and
    /// `isExcludedFromBackup` on it: a consumer-supplied `storageDirectory` may
    /// be shared with the app's own data, and silently locking it down — or
    /// pulling it out of the user's backup — is not this package's call.
    private let ownsDirectory: Bool
    private let maxQueued: Int
    /// The live records. A slice, not an array, because dropping the head is
    /// what the cap does on *every* append past 10k: `Array.removeFirst` moves
    /// the remaining 10k elements each time, while `dropFirst` on a slice only
    /// advances an index. The dead prefix of the underlying buffer is released by
    /// `rebaseIfNeeded()`, on the same "once the dead half matches the live half"
    /// rule the file uses, so the amortized cost per dropped record stays O(1).
    private var entries: ArraySlice<Entry> = []
    private var nextID = 0
    private var didLoad = false
    /// Set when a disk write failed, or when the file was found in a shape this
    /// store's bookkeeping cannot describe, so the next mutation rewrites the
    /// whole file from memory instead of leaving the two permanently divergent.
    private var needsRewrite = false

    /// Leading *bytes* of the queue file that no longer correspond to an entry:
    /// removed by `remove(through:)` or dropped for the cap, but not yet erased.
    /// Always a line boundary of the queue file. The invariant, whenever the last
    /// disk write succeeded and the store is disk-backed, is
    /// `fileSize == consumedBytes + liveBytes`.
    private var consumedBytes = 0
    /// Bytes the live entries occupy in the queue file — the sum of their
    /// `byteLength`s, maintained incrementally so neither compaction nor the
    /// marker needs a `stat`.
    private var liveBytes = 0
    /// Total records ever dropped for the cap, used only to rate-limit the log.
    private var totalDropped = 0
    /// Number of `append(_:)` calls that have actually reached this store, i.e.
    /// batches, not records — the metric that shows the batching `StatsClient`
    /// does upstream is working: a burst of `record()` calls costs one of these
    /// per drained buffer, not one per event.
    private var totalAppends = 0
    /// Consecutive failed disk writes. Three in a row means the disk is not
    /// merely busy (full volume, read-only container, deleted directory), and
    /// retrying per event only burns I/O and fills the log.
    private var writeFailureStreak = 0
    /// True while the queue is memory-only: appends skip the disk entirely.
    private var isMemoryOnly = false
    /// Appends since the last disk probe, so a recovered disk is noticed without
    /// probing on every event.
    private var appendsSinceProbe = 0
    /// True once this process has set (or tried and failed to set) the
    /// backup-exclusion flag on the queue directory, so `ensureDirectory()`
    /// only pays for `setResourceValues` once per process.
    private var didExcludeFromBackup = false

    /// Failed writes tolerated before falling back to memory.
    private static let maxWriteFailures = 3
    /// Appends between disk probes while memory-only.
    private static let probeInterval = 100
    /// Cap-drop warnings are logged on the first drop and every this-many after.
    private static let dropLogInterval = 1_000
    /// Refuse to read a queue file larger than this. 10k records of the largest
    /// plausible shape is ~5 MB, so 64 MiB is not a backlog — it is corruption or
    /// an unbounded-growth bug, and reading it would cost that much RSS on a
    /// launch path. Such a file is discarded rather than tail-read: a tail read
    /// would resume from a line boundary nobody can trust, and the queue holds
    /// disposable analytics.
    static let defaultMaxLoadBytes = 64 << 20
    private let maxLoadBytes: Int

    init(
        fileURL: @escaping @Sendable () -> URL,
        maxQueued: Int,
        ownsDirectory: Bool = true,
        maxLoadBytes: Int = EventStore.defaultMaxLoadBytes
    ) {
        self.resolveFileURL = fileURL
        self.maxQueued = maxQueued
        self.ownsDirectory = ownsDirectory
        self.maxLoadBytes = maxLoadBytes
    }

    /// The queue file, resolved once, lazily, on the actor.
    private var fileURL: URL {
        if let cachedFileURL { return cachedFileURL }
        let resolved = resolveFileURL()
        cachedFileURL = resolved
        return resolved
    }

    /// The consumed-prefix marker, `queue.head` beside `queue.jsonl`.
    private var headURL: URL {
        fileURL.deletingPathExtension().appendingPathExtension("head")
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

    /// Internal test seam: the state a behavioural assertion cannot see from the
    /// file alone. Not part of any public API.
    var diagnostics: (consumedBytes: Int, isMemoryOnly: Bool, needsRewrite: Bool, dropped: Int, appends: Int) {
        (consumedBytes, isMemoryOnly, needsRewrite, totalDropped, totalAppends)
    }

    /// Appends and returns the resulting queue depth.
    ///
    /// The bytes reach the queue file before this returns, so a queued event
    /// survives the process being killed. It is *not* `fsync`ed — a kernel panic
    /// or power loss can still lose the last write, which is the deliberate
    /// trade: one `fsync` per `track()` would put a disk flush on a UI code path
    /// for data that is, by design, disposable.
    ///
    /// At the cap this appends one line and moves an in-memory counter. It never
    /// rewrites the file per event, and — see the type's doc comment — never
    /// writes the marker either: growing the file cannot invalidate an offset
    /// into its prefix.
    func append(_ newRecords: [Record]) -> Int {
        loadIfNeeded()
        guard !newRecords.isEmpty else { return entries.count }
        totalAppends += 1

        // Encoded first, because an `Entry` carries the length of the line it
        // occupies and that is only known here. Skipped while memory-only: there
        // is no file for the lengths to describe, and the recovery rewrite
        // recomputes all of them.
        let encoded = isMemoryOnly ? nil : encodeLines(newRecords)
        if !isMemoryOnly, encoded == nil {
            // Not a disk problem: rewriting will hit the same encoder. The
            // records live in memory and the file is left as it is.
            needsRewrite = true
        }
        for (offset, record) in newRecords.enumerated() {
            let length = encoded?.lengths[offset] ?? 0
            entries.append(Entry(id: nextID, record: record, byteLength: length))
            liveBytes += length
            nextID += 1
        }

        if entries.count > maxQueued {
            // Drop-oldest past the cap (§5): the newest events are the ones a
            // reader is waiting for, and the oldest are the likeliest to be past
            // the retention ceiling anyway. The dropped lines stay on disk as
            // part of the consumed prefix until a compaction erases them — and
            // the marker is deliberately *not* refreshed here, so a relaunch may
            // re-read some already-dropped lines. That is the safe direction:
            // the load-time cap truncation drops them again.
            let dropped = entries.count - maxQueued
            consume(dropped)
            noteDrops(dropped)
        }

        if isMemoryOnly {
            // The records are held in memory only; the file, whatever state it is
            // in, must be fully rewritten once the disk comes back.
            needsRewrite = true
            appendsSinceProbe += newRecords.count
            if appendsSinceProbe >= Self.probeInterval { probeDisk() }
            return entries.count
        }

        guard let encoded else { return entries.count }

        if needsRewrite {
            // A rewrite reconciles memory and disk in one pass, consumed prefix
            // included, so the drop bookkeeping above needs nothing extra.
            rewrite()
            return entries.count
        }

        appendLines(encoded.data)
        if !needsRewrite, shouldCompact { rewrite() }
        return entries.count
    }

    /// The next batch to attempt: head records that share one context, bounded
    /// by 100 events and 256 KiB of serialized envelope (§5).
    ///
    /// The byte limit is enforced *before* the count limit, as §5 requires: 100
    /// events with 32 long props each do not fit.
    func nextBatch(maxEvents: Int, maxBytes: Int, batchId: String, sentAt: Date) -> Pending? {
        loadIfNeeded()

        // A head record that cannot be encoded can never ship, so it is dropped
        // and the next one considered. A loop rather than recursion: with a
        // corrupt prefix this can run up to `maxQueued` times, and that many
        // frames on the actor's stack is a crash, not a drop. The whole dead
        // prefix is consumed in one go, so the marker is written once.
        var unencodable = 0
        defer { if unencodable > 0 { consumeHead(unencodable) } }

        while unencodable < entries.count {
            let first = entries[entries.startIndex + unencodable]

            // Envelope cost with an empty `events` array, measured once. Adding
            // the n-th item costs its own encoded bytes plus one comma — exact,
            // because the encoder's output is deterministic (`sortedKeys`).
            guard let envelopeBytes = serializedSize(
                batchId: batchId, sentAt: sentAt, context: first.record.context, events: []
            ) else {
                logger.error("dropped a queued event whose context could not be encoded")
                unencodable += 1
                continue
            }

            var events: [StatsEvent] = []
            var lastID = first.id
            var remaining = maxBytes - envelopeBytes
            var headFailedToEncode = false
            for entry in entries[(entries.startIndex + unencodable)...] {
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
                        headFailedToEncode = true
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
            if headFailedToEncode {
                unencodable += 1
                continue
            }
            guard !events.isEmpty else { return nil }
            return Pending(
                context: first.record.context, events: events,
                firstID: first.id, lastID: lastID, recordCount: events.count
            )
        }
        return nil
    }

    /// Removes every record up to and including `id` — what "the batch was
    /// accepted (or permanently dropped)" means.
    ///
    /// By id rather than by position, so that a head shift during the flush (the
    /// drop-oldest cap, a `removeAll` from an opt-out) can only ever make this
    /// remove *fewer* records, never someone else's.
    ///
    /// Cost is the marker write, not the queue file, except on the compactions
    /// that erase the accumulated prefix.
    func remove(through id: Int) {
        loadIfNeeded()
        var removed = 0
        for entry in entries {
            guard entry.id <= id else { break }
            removed += 1
        }
        guard removed > 0 else { return }
        consume(removed)
        persistConsumedPrefix()
    }

    /// The id of the record currently at the head, or `nil` when empty.
    var headID: Int? {
        loadIfNeeded()
        return entries.first?.id
    }

    /// Erases the consumed prefix now. Cheap to call when idle (shutdown), and
    /// it doubles as a disk probe while memory-only.
    func compact() {
        loadIfNeeded()
        if isMemoryOnly {
            probeDisk()
        } else if consumedBytes > 0 || needsRewrite {
            rewrite()
        }
    }

    /// Drops `count` head entries, marking their bytes consumed.
    private func consumeHead(_ count: Int) {
        guard count > 0, !entries.isEmpty else { return }
        consume(min(count, entries.count))
        persistConsumedPrefix()
    }

    /// Moves `count` head entries from live to consumed, in memory only.
    ///
    /// The byte arithmetic is the whole point of `Entry.byteLength`: the
    /// consumed offset advances by exactly the bytes those lines occupy, so it
    /// stays on a line boundary of the file.
    private func consume(_ count: Int) {
        var bytes = 0
        for entry in entries.prefix(count) { bytes += entry.byteLength }
        entries = entries.dropFirst(count)
        rebaseIfNeeded()
        consumedBytes += bytes
        liveBytes -= bytes
    }

    /// Records a removal on disk: a marker write normally, a compaction once the
    /// dead prefix is at least as large as what is left, a full rewrite while
    /// memory and disk are known to have diverged.
    private func persistConsumedPrefix() {
        if isMemoryOnly {
            needsRewrite = true
            // Removals are per-batch, not per-event, so probing on each is cheap.
            probeDisk()
            return
        }
        if needsRewrite || shouldCompact {
            rewrite()
        } else {
            writeHead()
        }
    }

    /// Releases the buffer the dropped head still pins, once it has grown to the
    /// size of what is live. Copying `entries.count` elements only after that
    /// many have been dropped is the same amortization the file compaction uses.
    private func rebaseIfNeeded() {
        // Every rebase produces a slice based at 0, so `startIndex` is exactly
        // the number of dead slots the buffer still holds.
        let dead = entries.startIndex
        guard dead > 0, dead >= entries.count else { return }
        entries = ArraySlice(Array(entries))
    }

    /// Compact once at least half of the file's bytes are dead. Because the
    /// rewrite costs `liveBytes` and only runs when `consumedBytes` has grown to
    /// match it, the amortized cost per removed record is O(1).
    private var shouldCompact: Bool {
        consumedBytes > 0 && consumedBytes >= liveBytes
    }

    /// One warning per burst, then one per `dropLogInterval`: at the cap this is
    /// otherwise a log line per tracked event, forever.
    private func noteDrops(_ count: Int) {
        let before = totalDropped
        totalDropped += count
        guard before == 0 || before / Self.dropLogInterval != totalDropped / Self.dropLogInterval
        else { return }
        logger.warning(
            "queue is at its \(self.maxQueued, privacy: .public)-event cap; dropped \(self.totalDropped, privacy: .public) oldest event(s) so far"
        )
    }

    /// Discards everything and deletes the file — opt-out and consent
    /// revocation both require this (§11), and they require *discarding*, not
    /// flushing.
    func removeAll() {
        entries = []
        didLoad = true
        consumedBytes = 0
        liveBytes = 0
        // Memory and disk are both empty, so nothing is pending reconciliation
        // even if the disk was failing a moment ago.
        needsRewrite = false
        // Marker validity: both files are gone, and a marker without a queue
        // file is ignored on load anyway. The queue file is deleted *first*, so
        // an interruption between the two cannot leave an offset next to a file
        // it does not describe.
        for url in [fileURL, headURL] {
            do {
                if FileManager.default.fileExists(atPath: url.path) {
                    try FileManager.default.removeItem(at: url)
                }
            } catch {
                logger.error("could not delete the queue file: \(error.localizedDescription, privacy: .public)")
                // An opt-out or revocation must not leave the discarded events on
                // disk to be loaded and sent by the next launch. If the file
                // cannot be unlinked, try to empty it in place; if even that
                // fails, flag a rewrite so the next mutation replaces it with the
                // (empty) in-memory queue instead of appending after stale data.
                if url == fileURL {
                    do {
                        try Data().write(to: url, options: .atomic)
                    } catch {
                        needsRewrite = true
                    }
                }
            }
        }
    }

    // MARK: - Disk

    private func loadIfNeeded() {
        guard !didLoad else { return }
        didLoad = true
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            // No queue file means no consumed prefix; a marker left behind by a
            // deleted queue would only be misleading.
            discardHead()
            return
        }
        let size = (try? FileManager.default.attributesOfItem(atPath: fileURL.path)[.size])
            .flatMap { $0 as? NSNumber }?.intValue
        if let size, size > maxLoadBytes {
            logger.error(
                "queue file is \(size, privacy: .public) bytes, past the \(self.maxLoadBytes, privacy: .public)-byte ceiling; discarding it and starting empty"
            )
            try? FileManager.default.removeItem(at: fileURL)
            discardHead()
            return
        }
        do {
            let data = try Data(contentsOf: fileURL)
            let skip = consumedPrefix(of: data)
            var loaded: [(record: Record, length: Int)] = []
            var malformed = 0
            // A line whose bytes belong to no entry — an empty line, or a torn
            // trailing line — breaks the `fileSize == consumedBytes + liveBytes`
            // invariant, so the file is normalized below rather than trusted.
            var unaccounted = false
            var offset = data.startIndex + skip
            while offset < data.endIndex {
                let terminator = data[offset...].firstIndex(of: UInt8(ascii: "\n"))
                let lineEnd = terminator ?? data.endIndex
                let line = data[offset..<lineEnd]
                // The newline belongs to the line it terminates; a final line
                // without one is a torn write, and its bytes are unaccounted for.
                let length = lineEnd - offset + (terminator == nil ? 0 : 1)
                if line.isEmpty {
                    unaccounted = true
                } else if let record = try? StatsJSON.decoder.decode(Record.self, from: Data(line)) {
                    loaded.append((record, length))
                    if terminator == nil { unaccounted = true }
                } else {
                    malformed += 1
                    unaccounted = true
                }
                offset = lineEnd + (terminator == nil ? 0 : 1)
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
            entries = ArraySlice(loaded.map { item in
                defer { nextID += 1 }
                return Entry(id: nextID, record: item.record, byteLength: item.length)
            })
            consumedBytes = skip
            liveBytes = entries.reduce(0) { $0 + $1.byteLength }
            logger.debug("loaded \(self.entries.count, privacy: .public) queued event(s)")
            // Normalize: anything that leaves bytes on disk belonging to no live
            // entry has to be erased here, or the consumed offset would stop
            // being a line boundary of a file this store can describe. A large
            // dead prefix is likewise work better done once here than on every
            // later mutation.
            //
            // Marker validity after this branch: `rewrite()` replaces the file
            // and deletes the marker. Without it, `consumedBytes` is exactly the
            // offset the (still valid) marker on disk records.
            if malformed > 0 || didTruncate || unaccounted || shouldCompact {
                rewrite()
            }
        } catch {
            logger.error("could not read the queue file: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// The marker's consumed-byte offset, or 0 when it is absent, unparseable,
    /// or does not describe the queue file that was just read.
    ///
    /// Validation is deliberately narrow. The offset must fall inside the file
    /// *and* land immediately after a newline, so a marker that outlived its
    /// file can only be accepted when it happens to point at a real line
    /// boundary. The second field is the file's size when the marker was written:
    /// the file may only have *grown* since (appends are the only writer that
    /// leaves a marker in place), so a recorded size larger than the actual one
    /// means the file was replaced and the marker is stale.
    private func consumedPrefix(of data: Data) -> Int {
        // Read at most 65 bytes: a marker is ~20, and a foreign or corrupt file
        // in a consumer-supplied directory must not be read whole on launch.
        guard let handle = try? FileHandle(forReadingFrom: headURL) else { return 0 }
        defer { try? handle.close() }
        guard let markerData = try? handle.read(upToCount: 65), !markerData.isEmpty else { return 0 }
        guard markerData.count <= 64, let text = String(data: markerData, encoding: .utf8) else {
            logger.warning("ignoring an unreadable queue head marker")
            return 0
        }
        let fields = text.split(whereSeparator: { $0 == " " || $0 == "\n" })
        guard let first = fields.first, let consumed = Int(first),
              consumed >= 0, consumed <= data.count
        else {
            logger.warning("ignoring a queue head marker that does not match the queue file")
            return 0
        }
        // Exactly two fields, always: every writer in this package emits both,
        // and a one-field marker would skip the replaced-file check — the
        // strongest of the three validations — on exactly the kind of foreign
        // or hand-edited file that most needs it.
        guard fields.count == 2, let recordedSize = Int(fields[1]),
              recordedSize >= consumed, recordedSize <= data.count
        else {
            logger.warning("ignoring a queue head marker whose file has been replaced")
            return 0
        }
        guard consumed == 0 || data[data.startIndex + consumed - 1] == UInt8(ascii: "\n") else {
            logger.warning("ignoring a queue head marker that does not land on a line boundary")
            return 0
        }
        return consumed
    }

    /// Encodes a group of records into the bytes they will occupy, plus each
    /// one's length. `nil` when the encoder refuses a record: that is not a disk
    /// problem, and a rewrite would hit it again.
    private func encodeLines(_ newRecords: [Record]) -> (data: Data, lengths: [Int])? {
        var data = Data()
        var lengths: [Int] = []
        lengths.reserveCapacity(newRecords.count)
        do {
            for record in newRecords {
                let line = try StatsJSON.lineEncoder.encode(record)
                data.append(line)
                data.append(UInt8(ascii: "\n"))
                lengths.append(line.count + 1)
            }
        } catch {
            logger.error("could not encode a queued event: \(error.localizedDescription, privacy: .public)")
            return nil
        }
        return (data, lengths)
    }

    /// One `write(2)` at the end of the file for the whole group: appending does
    /// not get more expensive as the queue grows, and it writes no marker.
    ///
    /// Marker validity: this only ever *appends*, so every byte before
    /// `consumedBytes` is untouched and the existing marker (offset plus a size
    /// that is now smaller than the file's) stays true. The one path that does
    /// not append — recreating a file that vanished — resets the offset and
    /// deletes the marker before returning.
    private func appendLines(_ lines: Data) {
        var recreated = false
        let expectedEnd = UInt64(consumedBytes + liveBytes - lines.count)
        var toWrite = lines
        let wrote = performWrite("append to the queue file") {
            if let handle = FileHandle(forWritingAtPath: self.fileURL.path) {
                defer { try? handle.close() }
                let end = try handle.seekToEnd()
                if end != expectedEnd {
                    // The file is not the size this store's bookkeeping says it
                    // is: a write was torn by a kill, or something else touched
                    // the file. `seekToEnd` already told us for free, so no
                    // `stat` is needed. A leading newline keeps a torn partial
                    // line from merging with the first record written here —
                    // the fragment becomes its own malformed line, which the
                    // loader skips, instead of swallowing a good record.
                    if end > 0 { toWrite = Data([UInt8(ascii: "\n")]) + toWrite }
                    // The extra bytes belong to no entry, so the byte
                    // bookkeeping is off until a rewrite normalizes the file.
                    self.needsRewrite = true
                }
                try handle.write(contentsOf: toWrite)
            } else {
                // No file to append to: what lands on disk is exactly these
                // records, so any consumed prefix described a file that is gone.
                recreated = true
                try lines.write(to: self.fileURL, options: .atomic)
                self.restrictPermissions(of: self.fileURL)
            }
        }
        if wrote, recreated {
            // The stale marker is deleted, not just ignored: an offset from the
            // old file could otherwise land on a line boundary of the new one
            // and skip live records that were never sent.
            consumedBytes = 0
            discardHead()
            // Anything older than this group now exists only in memory, so
            // `liveBytes` overstates the file until the rewrite fixes both.
            if liveBytes != lines.count { needsRewrite = true }
        }
        // The records stay in memory, so they are not lost until the process is;
        // the flag makes the next mutation rewrite the file so memory and disk
        // cannot stay divergent.
        if !wrote { needsRewrite = true }
    }

    /// Rewrites the whole file atomically, dropping the consumed prefix with it.
    /// Only reached on compaction, on load normalization, and to reconcile after
    /// a failed write — never once per appended event.
    ///
    /// Marker validity: the file is replaced, so every previous offset is
    /// meaningless. `consumedBytes` goes to zero and the marker is deleted, in
    /// that order and only after the new file is on disk.
    private func rewrite() {
        var data = Data()
        var rebuilt: [Entry] = []
        rebuilt.reserveCapacity(entries.count)
        do {
            for entry in entries {
                let line = try StatsJSON.lineEncoder.encode(entry.record)
                data.append(line)
                data.append(UInt8(ascii: "\n"))
                var rewritten = entry
                rewritten.byteLength = line.count + 1
                rebuilt.append(rewritten)
            }
        } catch {
            needsRewrite = true
            logger.error("could not encode the queue: \(error.localizedDescription, privacy: .public)")
            return
        }
        let wrote = performWrite("rewrite the queue file") {
            try data.write(to: self.fileURL, options: .atomic)
            self.restrictPermissions(of: self.fileURL)
        }
        guard wrote else {
            needsRewrite = true
            return
        }
        needsRewrite = false
        entries = ArraySlice(rebuilt)
        liveBytes = data.count
        consumedBytes = 0
        discardHead()
    }

    /// Persists the consumed-byte offset, tagged with the queue file's size as
    /// this store knows it — no `stat`, because `consumedBytes + liveBytes` *is*
    /// that size whenever the store is disk-backed and in sync, which is the
    /// only state this is called from.
    private func writeHead() {
        guard consumedBytes > 0 else {
            discardHead()
            return
        }
        let marker = Data("\(consumedBytes) \(consumedBytes + liveBytes)\n".utf8)
        guard writeMarker(marker) else {
            // The offset advanced in memory but not on disk. Nothing is lost —
            // the marker still on disk is older, so a relaunch replays records
            // that were already accepted rather than skipping live ones — but
            // memory and disk have diverged, so the next mutation reconciles
            // them with a rewrite.
            needsRewrite = true
            return
        }
    }

    /// Removes the marker, which is how "nothing is consumed" is recorded: an
    /// absent marker and a zero offset mean the same thing to the loader, and a
    /// deleted file cannot be mistaken for a description of a file that was
    /// replaced under it.
    private func discardHead() {
        try? FileManager.default.removeItem(at: headURL)
        guard FileManager.default.fileExists(atPath: headURL.path) else { return }
        // Could not delete it. Overwrite it with an explicit "nothing consumed"
        // so a stale offset cannot survive beside a file it no longer describes.
        // If even that fails, the marker is almost certainly unreadable as well
        // (a directory, a hostile mode), which the loader already treats as
        // absent — so this is logged and not escalated to a rewrite loop.
        _ = writeMarker(Data("0 \(liveBytes)\n".utf8))
    }

    /// Writes the marker file. Deliberately **not** routed through
    /// `performWrite`: a marker that cannot be written costs a replay of records
    /// that were already sent, while degrading the whole store to memory-only
    /// over it would cost every unsent event on the next launch.
    private func writeMarker(_ marker: Data) -> Bool {
        do {
            try ensureDirectory()
            try marker.write(to: headURL, options: .atomic)
            restrictPermissions(of: headURL)
            return true
        } catch {
            logger.error(
                "could not update the queue head marker: \(error.localizedDescription, privacy: .public)"
            )
            return false
        }
    }

    /// Attempts a full rewrite to find out whether the disk works again.
    private func probeDisk() {
        appendsSinceProbe = 0
        rewrite()
    }

    /// Runs a disk write, counting failures so that a disk which is not coming
    /// back (full volume, read-only container) costs one log line and no further
    /// I/O rather than a failed write and an error per tracked event.
    @discardableResult
    private func performWrite(_ what: String, _ body: () throws -> Void) -> Bool {
        do {
            try ensureDirectory()
            try body()
            writeFailureStreak = 0
            if isMemoryOnly {
                isMemoryOnly = false
                logger.notice("the queue file is writable again; resuming disk-backed queueing")
            }
            return true
        } catch {
            writeFailureStreak += 1
            if isMemoryOnly {
                // Already degraded and already logged; a failed probe is expected.
                return false
            }
            if writeFailureStreak >= Self.maxWriteFailures {
                isMemoryOnly = true
                logger.error(
                    "could not \(what, privacy: .public): \(error.localizedDescription, privacy: .public) — \(Self.maxWriteFailures, privacy: .public) consecutive failures, queueing in memory only from here"
                )
            } else {
                logger.error("could not \(what, privacy: .public): \(error.localizedDescription, privacy: .public)")
            }
            return false
        }
    }

    /// Creates the directory holding the queue file, and — only when this SDK
    /// owns that directory — locks it down and excludes it from backups.
    ///
    /// A consumer-supplied `storageDirectory` gets neither treatment: it may be
    /// a directory the app also uses for its own data, and a library has no
    /// business changing its permissions or pulling it out of the user's backup
    /// behind the app's back. It is still *created* if missing, with default
    /// attributes, so the queue works out of the box; the files this store
    /// writes into it are `0600` either way.
    private func ensureDirectory() throws {
        let directory = fileURL.deletingLastPathComponent()
        if !FileManager.default.fileExists(atPath: directory.path) {
            // 0700 on the directory the SDK owns. `withIntermediateDirectories`
            // applies these attributes only to directories it actually creates,
            // so an existing `Application Support` is left alone.
            try FileManager.default.createDirectory(
                at: directory,
                withIntermediateDirectories: true,
                attributes: ownsDirectory ? [.posixPermissions: 0o700] : nil
            )
            if ownsDirectory { excludeFromBackupIfNeeded(directory) }
        } else if ownsDirectory, !didExcludeFromBackup {
            // The directory predates this process (a prior launch already
            // created it) but nothing in *this* process has yet confirmed the
            // backup-exclusion flag is set on it — set it once per process
            // rather than on every write.
            excludeFromBackupIfNeeded(directory)
        }
    }

    /// Excludes the `swift-stats` directory from iCloud/iTunes/Finder backups.
    ///
    /// The queue file holds unflushed events — including a hashed `userId` for
    /// an install that has not yet sent them — and every record in it is, by
    /// this store's own design (see the type-level doc comment), disposable:
    /// regenerated by future tracking, or simply lost, without breaking the
    /// SDK. Apple's guidance is that data an app can regenerate or that is
    /// purely transient should be excluded from backups so it does not
    /// needlessly consume the user's backup storage or (for iCloud backup)
    /// leave analytics payloads sitting in a backup archive. There is nothing
    /// here a restore should ever bring back.
    ///
    /// Only ever applied to a directory this SDK created for itself — see
    /// `ensureDirectory()`.
    ///
    /// Best-effort and set at most once per process: `setResourceValues` is a
    /// cheap call, but there is no reason to pay it on every `track()` when the
    /// flag, once set, persists with the directory. A failure (e.g. a
    /// filesystem that cannot express the resource key) is logged and never
    /// thrown — losing the backup exclusion is not a reason to lose the event.
    private func excludeFromBackupIfNeeded(_ directory: URL) {
        guard !didExcludeFromBackup else { return }
        didExcludeFromBackup = true
        var url = directory
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        do {
            try url.setResourceValues(values)
        } catch {
            logger.error(
                "could not exclude the queue directory from backups: \(error.localizedDescription, privacy: .public)"
            )
        }
    }

    /// Owner-only (0600) on the files this store writes.
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
    /// 0644 file under `~/Library/Application Support`. Applied whoever owns the
    /// directory: this is the SDK's own file either way.
    private func restrictPermissions(of url: URL) {
        do {
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600], ofItemAtPath: url.path
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
