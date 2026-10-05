import Foundation
import Synchronization

/// Per-test directories for the SDK's `UserDefaults` suite, so a test run never
/// writes to `~/Library/Preferences`.
///
/// Why a directory and not cleanup: removing a `com.wizemann.stats.<appId>`
/// domain (`removePersistentDomain(forName:)`) leaves an empty
/// `~/Library/Preferences/<suite>.plist` behind, and deleting that file is not
/// enough either — `cfprefsd` still holds the domain and writes the empty plist
/// back a few seconds later, or when the process exits. That is how ~26,000
/// `com.wizemann.stats.com.example.*` files accumulated. Pointing
/// `StatsConfiguration.identitySuiteDirectory` at one of these directories makes
/// the suite an absolute-path one (`<directory>/com.wizemann.stats.<appId>.plist`);
/// removing the directory removes it, and a deferred write into a missing
/// directory fails instead of recreating anything.
///
/// ``directory(named:)`` creates the directory and registers it for a
/// process-exit sweep, so a test that never reaches its teardown (a failing
/// `#require`, an early return, a relaunched harness nobody tore down) still
/// leaves nothing once the test process exits.
///
/// `package`: shared by this package's own tests and ``RelaunchProbe``; not
/// part of the `StatsTesting` product's public API.
package enum IsolatedDefaults {
    private struct State {
        var live: Set<URL> = []
        var sweepInstalled = false
    }

    private static let state = Mutex(State())

    /// `<temporary directory>/swift-stats-defaults-<name>`, without creating it.
    package static func path(named name: String) -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("swift-stats-defaults-\(name)", isDirectory: true)
    }

    /// Creates (if needed) and tracks the directory for `name`. Idempotent, so
    /// a relaunched client over the same name gets the same suite. It must
    /// exist before the suite is written: `cfprefsd` does not create it, and a
    /// write into a missing directory is silently lost.
    package static func directory(named name: String) -> URL {
        let url = path(named: name)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        let installSweep = state.withLock { state -> Bool in
            state.live.insert(url)
            defer { state.sweepInstalled = true }
            return !state.sweepInstalled
        }
        if installSweep {
            atexit { IsolatedDefaults.sweep() }
        }
        return url
    }

    /// Removes the directory, and with it the suite; untracks it.
    package static func remove(_ directory: URL) {
        try? FileManager.default.removeItem(at: directory)
        _ = state.withLock { $0.live.remove(directory) }
    }

    /// Removes every directory still tracked. Runs at process exit.
    package static func sweep() {
        let remaining = state.withLock { state -> Set<URL> in
            defer { state.live.removeAll() }
            return state.live
        }
        for directory in remaining { try? FileManager.default.removeItem(at: directory) }
    }
}
