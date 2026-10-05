import Foundation
import Stats

/// A sink that records what it was asked to send and answers from a script.
///
/// An `actor`, which is the point of `StatsSink` being a `nonisolated protocol`:
/// a sink that accumulates state has to be isolated, and a protocol that is
/// implicitly `@MainActor` in a consumer module with
/// `defaultIsolation(MainActor.self)` could not be conformed to by one.
public actor InMemorySink: StatsSink {
    /// Every batch handed to `send`, in order — including repeat attempts of a
    /// retried batch, so a test can assert that a retry reused its `batchId`.
    public private(set) var batches: [StatsBatch] = []

    /// Outcomes to return, consumed front to back. When empty, `defaultOutcome`
    /// applies.
    private var scripted: [SinkOutcome]
    private var defaultOutcome: SinkOutcome

    public init(outcomes: [SinkOutcome] = [], defaultOutcome: SinkOutcome = .accepted) {
        self.scripted = outcomes
        self.defaultOutcome = defaultOutcome
    }

    /// `waitForBatches(_:)` callers, resumed by `send` once enough batches
    /// have arrived.
    private var batchWaiters: [(count: Int, continuation: CheckedContinuation<Void, Never>)] = []

    public func send(_ batch: StatsBatch) async -> SinkOutcome {
        batches.append(batch)
        let ready = batchWaiters.filter { $0.count <= batches.count }
        batchWaiters.removeAll { $0.count <= batches.count }
        for waiter in ready { waiter.continuation.resume() }
        if scripted.isEmpty { return defaultOutcome }
        return scripted.removeFirst()
    }

    /// Suspends until at least `count` batches have been sent — signalled by
    /// `send` itself, so a test awaits progress instead of spending a yield
    /// budget on it. A batch that never comes is a hang, which a test's time
    /// limit turns into a failure.
    public func waitForBatches(_ count: Int) async {
        guard batches.count < count else { return }
        await withCheckedContinuation { continuation in
            batchWaiters.append((count, continuation))
        }
    }

    // MARK: Inspection

    /// Every event across every batch, in the order it was sent.
    public var sentEvents: [StatsEvent] {
        batches.flatMap(\.events)
    }

    public var sentEventNames: [String] {
        sentEvents.map(\.name)
    }

    public var batchCount: Int { batches.count }

    /// Replaces the script mid-test — e.g. "fail twice, then start accepting".
    public func setOutcomes(_ outcomes: [SinkOutcome], defaultOutcome: SinkOutcome? = nil) {
        scripted = outcomes
        if let defaultOutcome { self.defaultOutcome = defaultOutcome }
    }

    public func reset() {
        batches.removeAll()
    }
}
