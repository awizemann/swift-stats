import Foundation
@testable import Stats
import StatsTesting
import Testing

/// What the queue file and its `queue.head` marker are allowed to cost.
///
/// Three production failures are pinned here, all of them O(queue) work on a
/// per-event path:
///
/// * At the cap, every `track()` used to rewrite the whole file (~5 MB at 10k)
///   and log a warning.
/// * `remove(through:)` rewrote the remaining file per accepted batch, so
///   draining a 10k backlog in batches of 100 wrote ~250 MB.
/// * After a failed write the store retried a full rewrite — and logged an
///   error — on every later append, forever.
@Suite("Queue file: consumed-prefix marker, compaction, degraded disk")
struct QueueFileTests {
    // MARK: - Fixtures

    private static func scratchDirectory() -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("swift-stats-queue-\(UUID().uuidString)", isDirectory: true)
    }

    private static func store(
        in directory: URL, maxQueued: Int = 10_000, maxLoadBytes: Int = EventStore.defaultMaxLoadBytes
    ) -> EventStore {
        let url = directory.appendingPathComponent("queue.jsonl", isDirectory: false)
        return EventStore(fileURL: { url }, maxQueued: maxQueued, maxLoadBytes: maxLoadBytes)
    }

    /// A record whose encoded line is the same length whatever `seq` is, so a
    /// test can make two different files come out byte-for-byte the same size —
    /// the coincidence that a size-tagged marker alone cannot survive.
    private static func fixedWidthRecord(_ seq: Int) -> EventStore.Record {
        makeRecord(seq, String(format: "e%04d", seq))
    }

    private static func record(_ seq: Int) -> EventStore.Record {
        makeRecord(seq, "e\(seq)")
    }

    private static func makeRecord(_ seq: Int, _ name: String) -> EventStore.Record {
        EventStore.Record(
            event: StatsEvent(
                name: name,
                ts: Date(timeIntervalSince1970: 1_700_000_000),
                sessionId: "1700000000-40371852",
                installId: String(repeating: "a", count: 64),
                appId: "com.example.queue",
                seq: seq
            ),
            context: Harness.exampleContext
        )
    }

    private static func lineCount(_ url: URL) -> Int {
        guard let data = try? Data(contentsOf: url) else { return 0 }
        return data.split(separator: UInt8(ascii: "\n")).count
    }

    /// The byte offset just past the `count`-th line of the file — the value the
    /// consumed-prefix marker is expected to hold once that many records have
    /// been removed or dropped.
    private static func offset(afterLines count: Int, in url: URL) -> Int {
        guard let data = try? Data(contentsOf: url) else { return 0 }
        var offset = data.startIndex
        var seen = 0
        while seen < count, let newline = data[offset...].firstIndex(of: UInt8(ascii: "\n")) {
            offset = newline + 1
            seen += 1
        }
        return offset - data.startIndex
    }

    private static func fileSize(_ url: URL) -> Int {
        (try? FileManager.default.attributesOfItem(atPath: url.path)[.size])
            .flatMap { $0 as? NSNumber }?.intValue ?? 0
    }

    /// Every live record's name, in queue order.
    private static func names(of store: EventStore) async -> [String] {
        guard let batch = await store.nextBatch(
            maxEvents: 100_000, maxBytes: 64 << 20, batchId: "b", sentAt: Date(timeIntervalSince1970: 0)
        ) else { return [] }
        return batch.events.map(\.name)
    }

    private static func markerFields(_ url: URL) -> [Int]? {
        guard let data = try? Data(contentsOf: url), let text = String(data: data, encoding: .utf8)
        else { return nil }
        return text.split(whereSeparator: { $0 == " " || $0 == "\n" }).compactMap { Int($0) }
    }

    // MARK: - The cap

    /// Discriminating: with a rewrite per append the file would hold exactly
    /// `maxQueued` lines. Here every appended line is still on disk and only an
    /// in-memory counter moved, which is the whole point — the append path never
    /// pays for the queue depth, and (since an offset into an untouched prefix
    /// stays true when the file only grows) never writes the marker either.
    @Test("At the cap, an append writes one line and touches nothing else")
    func capDoesNotRewritePerAppend() async throws {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = directory.appendingPathComponent("queue.jsonl")
        let head = directory.appendingPathComponent("queue.head")
        let store = Self.store(in: directory, maxQueued: 5)

        for seq in 0..<8 { _ = await store.append([Self.record(seq)]) }

        #expect(await store.count == 5)
        #expect(Self.lineCount(queue) == 8, "all eight appended lines are still on disk")
        let diagnostics = await store.diagnostics
        #expect(diagnostics.consumedBytes == Self.offset(afterLines: 3, in: queue))
        #expect(diagnostics.dropped == 3)
        #expect(
            !FileManager.default.fileExists(atPath: head.path),
            "an append never writes the marker: growing the file cannot invalidate an offset into its prefix"
        )
        #expect(!diagnostics.needsRewrite)

        // Not writing the marker on a cap drop is the safe direction: a relaunch
        // re-reads the dropped lines and the load-time cap drops them again.
        let reopened = Self.store(in: directory, maxQueued: 5)
        #expect(await reopened.count == 5)
        #expect(await Self.names(of: reopened) == (3..<8).map { "e\($0)" })
    }

    /// The dead prefix is not allowed to grow without bound: once it reaches the
    /// size of what is live, one compaction erases it.
    @Test("The dead prefix is compacted once it reaches half the file")
    func capCompactsAtThreshold() async {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = directory.appendingPathComponent("queue.jsonl")
        let store = Self.store(in: directory, maxQueued: 5)

        for seq in 0..<10 { _ = await store.append([Self.record(seq)]) }

        #expect(await store.count == 5)
        #expect(Self.lineCount(queue) == 5, "the consumed prefix was erased in one rewrite")
        #expect(await store.diagnostics.consumedBytes == 0)
    }

    // MARK: - Removal

    @Test("remove(through:) moves the marker and only compacts at the threshold")
    func removeUpdatesMarkerThenCompacts() async throws {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = directory.appendingPathComponent("queue.jsonl")
        let head = directory.appendingPathComponent("queue.head")
        let store = Self.store(in: directory)

        _ = await store.append((0..<10).map(Self.record))
        #expect(Self.lineCount(queue) == 10)

        // Ids are 0...9: this removes three of ten, a fifth of the file.
        await store.remove(through: 2)
        #expect(await store.count == 7)
        #expect(Self.lineCount(queue) == 10, "removal must not rewrite the file")
        #expect(await store.diagnostics.consumedBytes == Self.offset(afterLines: 3, in: queue))
        #expect(
            Self.markerFields(head) == [Self.offset(afterLines: 3, in: queue), Self.fileSize(queue)],
            "the marker is the consumed byte offset, tagged with the file size it was written against"
        )

        // Now seven of ten are dead, past the half-the-file threshold.
        await store.remove(through: 6)
        #expect(await store.count == 3)
        #expect(Self.lineCount(queue) == 3)
        #expect(await store.diagnostics.consumedBytes == 0)
        #expect(
            !FileManager.default.fileExists(atPath: head.path),
            "a compaction deletes the marker rather than leaving an offset beside a file it no longer describes"
        )
    }

    @Test("compact() erases the prefix on demand")
    func explicitCompact() async {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = directory.appendingPathComponent("queue.jsonl")
        let store = Self.store(in: directory)

        _ = await store.append((0..<10).map(Self.record))
        await store.remove(through: 1)
        #expect(Self.lineCount(queue) == 10)

        await store.compact()
        #expect(Self.lineCount(queue) == 8)
        #expect(await store.count == 8)
    }

    @Test("removeAll deletes the queue file and its marker")
    func removeAllDeletesBothFiles() async {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = directory.appendingPathComponent("queue.jsonl")
        let head = directory.appendingPathComponent("queue.head")
        let store = Self.store(in: directory)

        _ = await store.append((0..<10).map(Self.record))
        await store.remove(through: 0)
        #expect(FileManager.default.fileExists(atPath: head.path))

        await store.removeAll()
        #expect(!FileManager.default.fileExists(atPath: queue.path))
        #expect(!FileManager.default.fileExists(atPath: head.path))
        #expect(await store.count == 0)
    }

    /// An opt-out or consent revocation calls `removeAll()`. If the queue file
    /// cannot be unlinked (here: a read-only directory), the discarded events
    /// must still not survive to the next launch: the store flags a rewrite so
    /// the next mutation replaces the stale file instead of appending after it.
    @Test("removeAll on an undeletable queue file does not resurrect revoked events")
    func removeAllWithUndeletableFileDoesNotLeakEvents() async throws {
        let directory = Self.scratchDirectory()
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
            try? FileManager.default.removeItem(at: directory)
        }
        let queue = directory.appendingPathComponent("queue.jsonl")
        let store = Self.store(in: directory)
        _ = await store.append((0..<10).map(Self.record))
        #expect(Self.lineCount(queue) == 10)

        // Unlink needs write permission on the directory; take it away so both
        // the delete and the atomic (temp-file + rename) truncation fail.
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: directory.path)
        await store.removeAll()
        #expect(await store.count == 0)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)

        // The next mutation rewrites from the (now empty + new) memory state:
        // only the new record may be on disk, never the ten revoked ones.
        _ = await store.append([Self.makeRecord(99, "fresh")])
        #expect(Self.lineCount(queue) == 1)
        #expect(await Self.names(of: Self.store(in: directory)) == ["fresh"])
    }

    // MARK: - Load

    @Test("A one-field marker is rejected: the replaced-file check is not optional")
    func oneFieldMarkerIsIgnored() async {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = directory.appendingPathComponent("queue.jsonl")
        let head = directory.appendingPathComponent("queue.head")
        let store = Self.store(in: directory)
        _ = await store.append((0..<10).map(Self.record))
        await store.remove(through: 2)

        // A plausible offset on a real line boundary, but without the size tag.
        try? Data("\(Self.offset(afterLines: 3, in: queue))\n".utf8).write(to: head)
        #expect(await Self.store(in: directory).count == 10)
    }

    @Test("An oversized marker file is ignored without being read whole")
    func oversizedMarkerIsIgnored() async {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let head = directory.appendingPathComponent("queue.head")
        let store = Self.store(in: directory)
        _ = await store.append((0..<10).map(Self.record))
        await store.remove(through: 2)

        try? Data(repeating: UInt8(ascii: "1"), count: 1 << 20).write(to: head)
        #expect(await Self.store(in: directory).count == 10)
    }


    @Test("A relaunch honours the marker and skips the consumed prefix")
    func loadHonoursMarker() async throws {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = Self.store(in: directory)
        _ = await store.append((0..<10).map(Self.record))
        await store.remove(through: 2)

        let reopened = Self.store(in: directory)
        #expect(await reopened.count == 7)
        let batch = try #require(
            await reopened.nextBatch(
                maxEvents: 100, maxBytes: 262_144, batchId: "b", sentAt: Date(timeIntervalSince1970: 0)
            )
        )
        #expect(batch.events.first?.name == "e3", "the first surviving record, not the first line")
        #expect(batch.events.count == 7)
    }

    /// The crash window that a line-count marker could not close, and the reason
    /// the marker is a byte offset.
    ///
    /// Sequence: remove a batch (marker written), append more (file grows,
    /// marker deliberately untouched), then the process dies. With a
    /// size-tagged *line count*, the grown file no longer matched the marker, so
    /// the whole file was replayed — re-sending records the backend had already
    /// accepted, under fresh batch ids. With an offset the marker written before
    /// the append is still exactly true after it.
    ///
    /// The split is ten-of-thirty rather than twenty-of-thirty on purpose: at
    /// twenty the dead prefix reaches the compaction threshold and the file is
    /// rewritten, which erases the marker and hides the bug.
    @Test("A removal followed by an append loads exactly the survivors, with no duplicates")
    func appendAfterRemoveKeepsTheMarkerValid() async throws {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = directory.appendingPathComponent("queue.jsonl")
        let head = directory.appendingPathComponent("queue.head")
        let store = Self.store(in: directory)

        _ = await store.append((0..<30).map(Self.record))
        await store.remove(through: 9)          // ten accepted, twenty live
        let sizeAtMarker = Self.fileSize(queue)
        _ = await store.append((30..<35).map(Self.record))

        #expect(Self.lineCount(queue) == 35, "still no rewrite")
        #expect(
            Self.markerFields(head) == [Self.offset(afterLines: 10, in: queue), sizeAtMarker],
            "the append left the marker alone: it describes a prefix the append could not move"
        )
        #expect(sizeAtMarker < Self.fileSize(queue), "and the file it was tagged with has since grown")

        // "The process died here." Nothing re-reads the ten accepted records,
        // and nothing skips the twenty-five that were never sent.
        let reopened = Self.store(in: directory)
        #expect(await reopened.count == 25, "the ten accepted records must not come back")
        #expect(await Self.names(of: reopened) == (10..<35).map { "e\($0)" })
    }

    /// The same shape as the flush loop itself: accept a batch, keep tracking,
    /// accept another, keep tracking, relaunch.
    @Test("Interleaved removals and appends survive a relaunch exactly")
    func interleavedRemovesAndAppends() async throws {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = directory.appendingPathComponent("queue.jsonl")
        let store = Self.store(in: directory)

        _ = await store.append((0..<20).map(Self.record))
        await store.remove(through: 4)
        _ = await store.append((20..<25).map(Self.record))
        await store.remove(through: 9)
        _ = await store.append((25..<30).map(Self.record))

        #expect(await store.count == 20)
        #expect(Self.lineCount(queue) == 30, "no compaction fired at these ratios")
        #expect(await store.diagnostics.consumedBytes == Self.offset(afterLines: 10, in: queue))

        let reopened = Self.store(in: directory)
        #expect(await reopened.count == 20)
        let batch = try #require(
            await reopened.nextBatch(
                maxEvents: 100, maxBytes: 262_144, batchId: "b", sentAt: Date(timeIntervalSince1970: 0)
            )
        )
        #expect(batch.events.map(\.name) == (10..<30).map { "e\($0)" })
    }

    @Test("A corrupt marker is ignored, and nothing readable is skipped")
    func corruptMarkerIsIgnored() async {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let head = directory.appendingPathComponent("queue.head")
        let store = Self.store(in: directory)
        _ = await store.append((0..<10).map(Self.record))
        await store.remove(through: 2)

        try? Data("not a marker at all".utf8).write(to: head)
        // Re-reading from line zero replays three already-sent records, which is
        // the deliberate trade: a marker nobody can parse must not silently eat
        // the queue.
        #expect(await Self.store(in: directory).count == 10)
    }

    /// The size tag records how big the file was when the marker was written.
    /// The file may only have grown since — appends are the only writer that
    /// leaves a marker in place — so a tag larger than the file means the file
    /// was replaced under it.
    @Test("A marker tagged with a size the file never reached is ignored")
    func staleMarkerIsIgnored() async {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let head = directory.appendingPathComponent("queue.head")
        let store = Self.store(in: directory)
        _ = await store.append((0..<10).map(Self.record))
        await store.remove(through: 2)

        try? Data("3 999999\n".utf8).write(to: head)
        #expect(await Self.store(in: directory).count == 10)
    }

    /// A marker pointing past the end of the file — a truncated file, or a marker
    /// that outlived a longer one — is not a description of this file, so it is
    /// ignored rather than trusted into skipping live records.
    @Test("A marker past the end of the file is ignored")
    func markerPastTheEndIsIgnored() async throws {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = directory.appendingPathComponent("queue.jsonl")
        let head = directory.appendingPathComponent("queue.head")
        let store = Self.store(in: directory)
        _ = await store.append((0..<10).map(Self.record))

        let size = Self.fileSize(queue)
        try Data("\(size + 1) \(size + 1)\n".utf8).write(to: head)

        #expect(await Self.store(in: directory).count == 10)
    }

    /// An offset that lands in the middle of a line cannot have come from this
    /// file, whatever the size tag says: the byte before a consumed prefix is
    /// always the newline that ended it.
    @Test("A marker that does not land on a line boundary is ignored")
    func markerOffLineBoundaryIsIgnored() async throws {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = directory.appendingPathComponent("queue.jsonl")
        let head = directory.appendingPathComponent("queue.head")
        let store = Self.store(in: directory)
        _ = await store.append((0..<10).map(Self.record))

        let midLine = Self.offset(afterLines: 3, in: queue) - 20
        try Data("\(midLine) \(Self.fileSize(queue))\n".utf8).write(to: head)

        #expect(await Self.store(in: directory).count == 10)
    }

    /// A marker at exactly the end of the file means everything readable is
    /// already consumed — legal, and normalized to an empty file on load.
    @Test("A marker at the end of the file loads an empty queue")
    func markerAtEndLoadsEmpty() async throws {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = directory.appendingPathComponent("queue.jsonl")
        let head = directory.appendingPathComponent("queue.head")
        let store = Self.store(in: directory)
        _ = await store.append((0..<10).map(Self.record))

        let size = Self.fileSize(queue)
        try Data("\(size) \(size)\n".utf8).write(to: head)

        let reopened = Self.store(in: directory)
        #expect(await reopened.count == 0)
        #expect(Self.lineCount(queue) == 0, "load normalizes the file it fully consumed")
        #expect(await reopened.diagnostics.consumedBytes == 0)
        #expect(
            !FileManager.default.fileExists(atPath: head.path),
            "and the marker goes with it"
        )
    }

    @Test("A queue file past the byte ceiling is discarded, not read")
    func loadByteCeiling() async {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = directory.appendingPathComponent("queue.jsonl")
        let writer = Self.store(in: directory)
        _ = await writer.append((0..<10).map(Self.record))
        #expect(Self.lineCount(queue) == 10)

        // The same file, read by a store whose ceiling it now exceeds.
        let reopened = Self.store(in: directory, maxLoadBytes: 64)
        #expect(await reopened.count == 0)
        #expect(
            !FileManager.default.fileExists(atPath: queue.path),
            "a file too large to read is removed, so it cannot be appended to either"
        )
    }

    // MARK: - A disk that does not work

    /// A path whose parent is a regular file: creating the directory fails, so
    /// every write fails, the way a full volume or a read-only container does.
    @Test("Repeated write failures degrade to memory, then recover")
    func degradesToMemoryAndRecovers() async throws {
        let root = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let blocker = root.appendingPathComponent("swift-stats", isDirectory: false)
        try Data("not a directory".utf8).write(to: blocker)
        let queue = blocker.appendingPathComponent("queue.jsonl", isDirectory: false)
        let store = EventStore(fileURL: { queue }, maxQueued: 10_000)

        for seq in 0..<3 { _ = await store.append([Self.record(seq)]) }
        var diagnostics = await store.diagnostics
        #expect(diagnostics.isMemoryOnly, "three consecutive failures is enough")
        #expect(await store.count == 3, "the events are still queued in memory")

        // Further appends do not touch the disk at all: no file appears, the
        // events keep accumulating, and there is no per-event error log.
        for seq in 3..<60 { _ = await store.append([Self.record(seq)]) }
        #expect(await store.count == 60)
        #expect(!FileManager.default.fileExists(atPath: queue.path))
        diagnostics = await store.diagnostics
        #expect(diagnostics.isMemoryOnly)
        #expect(diagnostics.needsRewrite, "the file still has to be reconciled once it works")

        // The disk comes back.
        try FileManager.default.removeItem(at: blocker)
        await store.compact()

        diagnostics = await store.diagnostics
        #expect(!diagnostics.isMemoryOnly, "a successful write leaves the degraded mode")
        #expect(!diagnostics.needsRewrite)
        #expect(Self.lineCount(queue) == 60, "everything held in memory reached the disk")
        #expect(await store.count == 60)
        let mode = try #require(
            (try FileManager.default.attributesOfItem(atPath: queue.path)[.posixPermissions] as? NSNumber)?.intValue
        )
        #expect(mode & 0o777 == 0o600)
    }

    /// The probe is what lets a long-running process recover without a removal or
    /// a shutdown: one attempt per 100 appends, not one per append.
    @Test("Memory-only mode re-probes the disk as appends accumulate")
    func memoryOnlyReprobesOnAppend() async throws {
        let root = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let blocker = root.appendingPathComponent("swift-stats", isDirectory: false)
        try Data("not a directory".utf8).write(to: blocker)
        let queue = blocker.appendingPathComponent("queue.jsonl", isDirectory: false)
        let store = EventStore(fileURL: { queue }, maxQueued: 10_000)

        for seq in 0..<3 { _ = await store.append([Self.record(seq)]) }
        #expect(await store.diagnostics.isMemoryOnly)

        try FileManager.default.removeItem(at: blocker)
        for seq in 3..<110 { _ = await store.append([Self.record(seq)]) }

        #expect(await store.diagnostics.isMemoryOnly == false)
        #expect(await store.count == 110)
        #expect(Self.lineCount(queue) == 110)
    }

    // MARK: - The marker across the paths that replace the file

    /// Regression (data loss). The queue file vanishes — a purge, a user
    /// emptying a container — so the next append recreates it from the group it
    /// is writing. The consumed offset is reset, but the *marker on disk* still
    /// described the old file. With fixed-width records the new file is exactly
    /// the same size as the old one, so a size tag alone cannot tell them apart
    /// and the stale offset lands on a real line boundary of the new file: the
    /// next launch would skip three live records that were never sent.
    ///
    /// The fix is that the recreate path deletes the marker rather than merely
    /// resetting the counter.
    @Test("A recreated queue file does not inherit the old marker")
    func recreatedFileDropsTheStaleMarker() async throws {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = directory.appendingPathComponent("queue.jsonl")
        let head = directory.appendingPathComponent("queue.head")
        let store = Self.store(in: directory)

        // Two-digit `seq` values throughout, so the encoded lines really are
        // the same width and the two files really do come out the same size.
        _ = await store.append((10..<20).map(Self.fixedWidthRecord))
        let sizeBefore = Self.fileSize(queue)
        await store.remove(through: 2)
        let staleMarker = try #require(Self.markerFields(head))

        // The file disappears, and exactly as many bytes come back.
        try FileManager.default.removeItem(at: queue)
        _ = await store.append((20..<30).map(Self.fixedWidthRecord))
        #expect(Self.fileSize(queue) == sizeBefore, "the coincidence this test exists for")
        #expect(
            !FileManager.default.fileExists(atPath: head.path),
            "the marker described a file that no longer exists"
        )
        // It really would have validated: same size, and a line boundary.
        #expect(staleMarker.first == Self.offset(afterLines: 3, in: queue))

        let reopened = Self.store(in: directory)
        #expect(await Self.names(of: reopened) == (20..<30).map { String(format: "e%04d", $0) })

        // The records that only existed in memory are still recoverable: the
        // recreate marked the store as needing a rewrite.
        #expect(await store.diagnostics.needsRewrite)
        await store.compact()
        let afterCompact = Self.store(in: directory)
        #expect(
            await Self.names(of: afterCompact)
                == (13..<30).map { String(format: "e%04d", $0) }
        )
    }

    /// A marker that cannot be written must cost duplicates, never data.
    ///
    /// The head path is made immutable, so both writing and deleting it fail
    /// while the queue file itself stays perfectly writable. The store must not
    /// degrade to memory-only over it (that would lose every unsent event on the
    /// next launch), and the next mutation must reconcile the two by rewriting.
    @Test("A marker that cannot be written loses nothing")
    func markerWriteFailureLosesNothing() async throws {
        let directory = Self.scratchDirectory()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let queue = directory.appendingPathComponent("queue.jsonl")
        let head = directory.appendingPathComponent("queue.head")
        defer { try? FileManager.default.removeItem(at: directory) }
        defer { try? FileManager.default.setAttributes([.immutable: false], ofItemAtPath: head.path) }

        try Data("not a marker\n".utf8).write(to: head)
        try FileManager.default.setAttributes([.immutable: true], ofItemAtPath: head.path)

        let store = Self.store(in: directory)
        _ = await store.append((0..<10).map(Self.record))
        await store.remove(through: 2)

        var diagnostics = await store.diagnostics
        #expect(!diagnostics.isMemoryOnly, "a marker is not worth degrading the queue over")
        #expect(diagnostics.needsRewrite, "memory and disk diverged, so the next mutation reconciles them")

        // "The process died here": the unwritable marker still holds someone
        // else's bytes, so it is ignored and the three accepted records replay.
        // Duplicates are the deliberate trade; losing the seven is not.
        #expect(await Self.names(of: Self.store(in: directory)) == (0..<10).map { "e\($0)" })

        // The next mutation rewrites, which is what converges the two.
        _ = await store.append([Self.record(10)])
        diagnostics = await store.diagnostics
        #expect(!diagnostics.needsRewrite)
        #expect(Self.lineCount(queue) == 8, "seven survivors plus the new record")
        #expect(await Self.names(of: Self.store(in: directory)) == (3..<11).map { "e\($0)" })
    }

    /// A write torn by a kill leaves a partial last line. The next append must
    /// not glue its first record onto that fragment — two records merged into
    /// one malformed line would cost both, and (with a line-counting marker)
    /// desynchronize the prefix as well.
    ///
    /// `seekToEnd` already reports the real end of the file, so the check costs
    /// no extra syscall: an end that disagrees with this store's own byte
    /// bookkeeping gets a newline first.
    @Test("A torn trailing line costs exactly that one record")
    func tornTrailingLineThenAppend() async throws {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = directory.appendingPathComponent("queue.jsonl")
        let store = Self.store(in: directory)

        _ = await store.append((0..<3).map(Self.record))

        // The tail of the last line never made it to disk.
        var data = try Data(contentsOf: queue)
        data.removeLast(5)
        try data.write(to: queue)

        _ = await store.append((3..<5).map(Self.record))
        #expect(
            await store.diagnostics.needsRewrite,
            "the file is not the size the store's bookkeeping says, so it is normalized next"
        )

        let reopened = Self.store(in: directory)
        #expect(
            await Self.names(of: reopened) == ["e0", "e1", "e3", "e4"],
            "only the torn record is lost; the append that followed it is intact"
        )
        #expect(Self.lineCount(queue) == 4, "and the load normalized the file")
    }

    // MARK: - A queue file that exists but cannot be read or written

    /// Regression (data loss). On iOS a file with complete protection cannot be
    /// read before first unlock; `0000` stands in for that here. The load used to
    /// fail, mark the store loaded-and-empty anyway, and the next append — whose
    /// `FileHandle(forWritingAtPath:)` returned `nil` for *any* error — took the
    /// "no file" branch and atomically replaced the backlog with that one group.
    ///
    /// Now a failed load leaves the store unloaded: appends wait in memory, no
    /// batch is handed out, nothing replaces the file, and the load is retried
    /// on the next operation.
    @Test("An unreadable queue file is never replaced; appends wait in memory until it loads")
    func unreadableQueueIsNotReplaced() async throws {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = directory.appendingPathComponent("queue.jsonl")
        let writer = Self.store(in: directory)
        _ = await writer.append((0..<3).map(Self.record))
        await writer.remove(through: 0)

        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: queue.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: queue.path) }

        let store = Self.store(in: directory)
        _ = await store.append((3..<5).map(Self.record))
        #expect(await store.count == 2, "the new records are held in memory")
        #expect(await Self.names(of: store).isEmpty, "nothing is sent before the backlog is known")
        await store.compact()
        await store.remove(through: 100)

        // "First unlock."
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: queue.path)
        #expect(Self.lineCount(queue) == 3, "the file was never replaced while it was unreadable")
        #expect(await Self.names(of: store) == ["e1", "e2", "e3", "e4"], "backlog first, then what waited")
        #expect(await Self.names(of: Self.store(in: directory)) == ["e1", "e2", "e3", "e4"])
    }

    /// What is held while unloaded obeys the cap like anything else, and the
    /// merge keeps the newest `maxQueued` across file and memory: the file's
    /// records are older, so they absorb the overflow first.
    @Test("Held records obey the cap while unloaded, and the merge keeps the newest")
    func heldRecordsCapAndMerge() async throws {
        // The merge overflows into the file's records.
        do {
            let directory = Self.scratchDirectory()
            defer { try? FileManager.default.removeItem(at: directory) }
            let queue = directory.appendingPathComponent("queue.jsonl")
            _ = await Self.store(in: directory, maxQueued: 5).append((0..<4).map(Self.record))
            try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: queue.path)

            let store = Self.store(in: directory, maxQueued: 5)
            _ = await store.append((4..<7).map(Self.record))
            #expect(await store.count == 3)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: queue.path)
            #expect(await Self.names(of: store) == ["e2", "e3", "e4", "e5", "e6"])
            #expect(await Self.names(of: Self.store(in: directory)) == ["e2", "e3", "e4", "e5", "e6"])
        }
        // The held records alone overflow the cap.
        do {
            let directory = Self.scratchDirectory()
            defer { try? FileManager.default.removeItem(at: directory) }
            let queue = directory.appendingPathComponent("queue.jsonl")
            _ = await Self.store(in: directory, maxQueued: 5).append((0..<4).map(Self.record))
            try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: queue.path)

            let store = Self.store(in: directory, maxQueued: 5)
            _ = await store.append((4..<11).map(Self.record))
            #expect(await store.count == 5, "drop-oldest applies to the held records too")
            #expect(await store.diagnostics.dropped == 2)
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: queue.path)
            #expect(await Self.names(of: store) == ["e6", "e7", "e8", "e9", "e10"])
            #expect(await Self.names(of: Self.store(in: directory)) == ["e6", "e7", "e8", "e9", "e10"])
        }
    }

    /// A file that is never going to be readable must not keep every event in
    /// memory for good. Past both bounds — enough attempts, over enough time —
    /// it is moved aside (kept, not deleted) and a fresh queue starts with
    /// what was held. Discriminating on the bounds: three attempts in no time
    /// are not enough on their own.
    @Test("A queue file that stays unreadable is moved aside, and a fresh queue starts")
    func permanentlyUnreadableIsQuarantined() async throws {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = directory.appendingPathComponent("queue.jsonl")
        let aside = directory.appendingPathComponent("queue.unreadable")
        _ = await Self.store(in: directory).append((0..<3).map(Self.record))
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: queue.path)

        let clock = ManualClock()
        let store = EventStore(
            fileURL: { queue }, maxQueued: 10_000,
            clock: clock, quarantineAttempts: 3, quarantineAfter: .seconds(60)
        )
        for seq in 3..<6 { _ = await store.append([Self.record(seq)]) }
        #expect(!FileManager.default.fileExists(atPath: aside.path), "three quick failures are not permanent")

        clock.advance(by: .seconds(61))
        _ = await store.append([Self.record(6)])
        #expect(FileManager.default.fileExists(atPath: aside.path), "moved aside, not deleted")
        #expect(await Self.names(of: store) == ["e3", "e4", "e5", "e6"])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: aside.path)
        #expect(Self.lineCount(aside) == 3, "the old backlog is intact beside the new queue")

        // The next launch loads the new queue fine, so the set-aside file —
        // unsent events, of no further use — is deleted.
        #expect(await Self.names(of: Self.store(in: directory)) == ["e3", "e4", "e5", "e6"])
        #expect(!FileManager.default.fileExists(atPath: aside.path))
    }

    /// An opt-out or revocation discards the queue — every copy of it,
    /// including one set aside as unreadable.
    @Test("removeAll deletes queue.unreadable too")
    func removeAllDeletesQuarantinedQueue() async throws {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let aside = directory.appendingPathComponent("queue.unreadable")
        let store = Self.store(in: directory)
        _ = await store.append([Self.record(0)])
        try Data("{\"left\":\"over\"}\n".utf8).write(to: aside)

        await store.removeAll()
        #expect(!FileManager.default.fileExists(atPath: aside.path))
        #expect(!FileManager.default.fileExists(atPath: directory.appendingPathComponent("queue.jsonl").path))
    }

    /// The data-protection exemption: on iOS a protected file fails with
    /// `EPERM` until first unlock, and that must only ever be waited out.
    @Test("EPERM on an embedded platform counts as data protection; EACCES and macOS do not")
    func dataProtectionClassification() {
        func readError(_ posix: Int32) -> NSError {
            NSError(domain: NSCocoaErrorDomain, code: NSFileReadNoPermissionError, userInfo: [
                NSUnderlyingErrorKey: NSError(domain: NSPOSIXErrorDomain, code: Int(posix))
            ])
        }
        #expect(EventStore.mayBeDataProtection(readError(EPERM), isEmbedded: true))
        #expect(!EventStore.mayBeDataProtection(readError(EACCES), isEmbedded: true))
        #expect(!EventStore.mayBeDataProtection(readError(EPERM), isEmbedded: false))
        let bare = NSError(domain: NSCocoaErrorDomain, code: NSFileReadNoPermissionError)
        #expect(EventStore.mayBeDataProtection(bare, isEmbedded: true), "no POSIX code to tell: assume protection")
    }

    /// Asking whether anything is queued, and discarding, must not create the
    /// directory — a client that collects nothing does both.
    @Test("count and removeAll create no directory")
    func readingCreatesNothing() async {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = Self.store(in: directory)
        #expect(await store.count == 0)
        await store.removeAll()
        #expect(!FileManager.default.fileExists(atPath: directory.path))
    }

    /// The append path's half of the same bug: a file that exists but refuses a
    /// write handle (`EACCES`, `EPERM`) is not a missing file, and must not be
    /// "recreated" from the one group being appended. Only `ENOENT` recreates.
    @Test("A queue file that refuses a write handle is not recreated from one group")
    func unwritableQueueIsNotRecreated() async throws {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = directory.appendingPathComponent("queue.jsonl")
        let store = Self.store(in: directory)
        _ = await store.append((0..<3).map(Self.record))

        try FileManager.default.setAttributes([.posixPermissions: 0o400], ofItemAtPath: queue.path)
        _ = await store.append([Self.record(3)])
        #expect(await store.diagnostics.needsRewrite, "the write failed, so memory and disk are reconciled later")

        // "The process died here": the backlog is intact on disk.
        #expect(await Self.names(of: Self.store(in: directory)) == ["e0", "e1", "e2"])

        // And once the file is writable the next mutation reconciles the two.
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: queue.path)
        _ = await store.append([Self.record(4)])
        #expect(await Self.names(of: Self.store(in: directory)) == ["e0", "e1", "e2", "e3", "e4"])
    }

    /// Regression (crash window). A rewrite used to replace the queue file and
    /// only then delete the marker. Killed between the two, the old marker sat
    /// beside the new file — and when the new file is at least as large as the
    /// old one (a rewrite that also reconciles appended records) and the old
    /// offset happens to land on a line boundary (fixed-width records), it
    /// validates and the next launch skips records that were never sent.
    ///
    /// The marker is now invalidated *before* the replace, so the same kill
    /// replays (duplicates, which §6 dedupes) instead of skipping.
    @Test("A rewrite killed after the replace replays rather than skips")
    func rewriteCrashWindowReplays() async throws {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = directory.appendingPathComponent("queue.jsonl")
        let head = directory.appendingPathComponent("queue.head")
        let store = Self.store(in: directory)

        _ = await store.append((10..<20).map(Self.fixedWidthRecord))
        await store.remove(through: 2)
        #expect(Self.markerFields(head) != nil, "three records consumed, recorded in the marker")

        // A torn tail, so the next append leaves the store needing a rewrite.
        let handle = try FileHandle(forWritingTo: queue)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data("xx".utf8))
        try handle.close()
        _ = await store.append((20..<26).map(Self.fixedWidthRecord))
        #expect(await store.diagnostics.needsRewrite)

        await store.crashAfterNextReplaceForTesting()
        await store.compact()

        // "The process died here", with the new file in place.
        let expected = (13..<26).map { String(format: "e%04d", $0) }
        #expect(await Self.names(of: Self.store(in: directory)) == expected)
    }

    // MARK: - Unencodable records

    private static func unencodableRecord(_ seq: Int) -> EventStore.Record {
        EventStore.Record(
            event: StatsEvent(
                name: "e\(seq)",
                ts: Date(timeIntervalSince1970: 1_700_000_000),
                sessionId: "1700000000-40371852",
                installId: String(repeating: "a", count: 64),
                appId: "com.example.queue",
                seq: seq,
                // JSON has no NaN, and the encoder is left at its default
                // `.throw` strategy — so this record cannot be encoded at all.
                // `StatsProps.sanitized` drops such a value, so reaching the
                // store with one means a record built by hand or by a future
                // caller that skipped sanitization.
                props: ["x": .double(.nan)]
            ),
            context: Harness.exampleContext
        )
    }

    /// Regression: `nextBatch` used to call itself after dropping an unencodable
    /// head, so a corrupt prefix put up to `maxQueued` frames on the actor's
    /// stack — a crash rather than a drop. It is a loop now, and the whole dead
    /// prefix is consumed in one go.
    @Test("A long run of unencodable heads is dropped in one pass, without recursing")
    func unencodableHeadsAreDroppedInALoop() async {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = Self.store(in: directory)

        _ = await store.append((0..<5_000).map(Self.unencodableRecord))
        _ = await store.append([Self.record(5_000)])
        #expect(await store.count == 5_001)

        let batch = await store.nextBatch(
            maxEvents: 100, maxBytes: 262_144, batchId: "b", sentAt: Date(timeIntervalSince1970: 0)
        )
        #expect(batch?.events.map(\.name) == ["e5000"], "the one shippable record, after 5 000 drops")
        #expect(await store.count == 1, "and the dead prefix is gone")
    }

    /// The same, with nothing left behind it: the loop terminates on an empty
    /// queue rather than spinning.
    @Test("A queue of nothing but unencodable records drains to empty")
    func allUnencodableDrainsToEmpty() async {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = Self.store(in: directory)

        _ = await store.append((0..<1_000).map(Self.unencodableRecord))
        let batch = await store.nextBatch(
            maxEvents: 100, maxBytes: 262_144, batchId: "b", sentAt: Date(timeIntervalSince1970: 0)
        )
        #expect(batch?.recordCount == nil)
        #expect(await store.count == 0)
    }

    // MARK: - Backup exclusion

    /// The queue directory holds unflushed events, including a hashed `userId`
    /// for an install that has not yet sent them, and everything in it is
    /// disposable by design — nothing a backup should ever restore. On
    /// APFS/HFS+ (what a real macOS/iOS install uses), `createDirectory`
    /// followed by the first `append` must leave `isExcludedFromBackup == true`
    /// on the directory.
    ///
    /// Tolerant rather than flaky: some CI/tmp filesystems cannot express the
    /// resource key at all, in which case `resourceValues(forKeys:)` itself
    /// throws or returns `nil`, and this is skipped with a reason instead of
    /// failing.
    @Test("The queue directory is excluded from backups after the first append")
    func queueDirectoryIsExcludedFromBackups() async throws {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = Self.store(in: directory)

        _ = await store.append([Self.record(0)])

        var directoryURL = directory
        let values: URLResourceValues
        do {
            values = try directoryURL.resourceValues(forKeys: [.isExcludedFromBackupKey])
        } catch {
            // The filesystem under this CI/tmp mount cannot express the key —
            // not a regression in this SDK.
            return
        }
        guard let isExcluded = values.isExcludedFromBackup else {
            return
        }
        #expect(isExcluded, "the queue directory should be excluded from backups")
    }

    /// The mirror image, and the reason `ownsDirectory` exists: a consumer's own
    /// `storageDirectory` is not this SDK's to lock down. It may be shared with
    /// the app's data, so its mode is left exactly as the app set it and it is
    /// never pulled out of the user's backup. Only the file this store writes
    /// into it is restricted, to 0600.
    @Test("A consumer-supplied directory keeps its permissions and its backup state")
    func consumerDirectoryIsLeftAlone() async throws {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755]
        )
        let queue = directory.appendingPathComponent("queue.jsonl", isDirectory: false)
        let store = EventStore(fileURL: { queue }, maxQueued: 10_000, ownsDirectory: false)

        _ = await store.append([Self.record(0)])

        let directoryMode = try #require(
            (try FileManager.default.attributesOfItem(atPath: directory.path)[.posixPermissions] as? NSNumber)?
                .intValue
        )
        #expect(directoryMode & 0o777 == 0o755, "the SDK must not re-mode a directory it does not own")
        let fileMode = try #require(
            (try FileManager.default.attributesOfItem(atPath: queue.path)[.posixPermissions] as? NSNumber)?
                .intValue
        )
        #expect(fileMode & 0o777 == 0o600, "its own file is still owner-only")

        var directoryURL = directory
        // Tolerant in the same way as the test above: a filesystem that cannot
        // express the key tells us nothing either way.
        if let values = try? directoryURL.resourceValues(forKeys: [.isExcludedFromBackupKey]),
           let isExcluded = values.isExcludedFromBackup {
            #expect(!isExcluded, "a consumer's directory must not be taken out of their backup")
        }
    }

    /// Not owning it does not mean refusing to create it: a consumer that points
    /// at a directory that does not exist yet still gets a working queue, just
    /// with default attributes.
    @Test("A consumer-supplied directory is still created when missing")
    func consumerDirectoryIsCreatedWhenMissing() async {
        let directory = Self.scratchDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let queue = directory
            .appendingPathComponent("nested", isDirectory: true)
            .appendingPathComponent("queue.jsonl", isDirectory: false)
        let store = EventStore(fileURL: { queue }, maxQueued: 10_000, ownsDirectory: false)

        _ = await store.append([Self.record(0)])

        #expect(Self.lineCount(queue) == 1)
        #expect(await store.diagnostics.isMemoryOnly == false)
    }
}
