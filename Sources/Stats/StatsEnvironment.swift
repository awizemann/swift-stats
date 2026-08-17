#if canImport(Darwin)
import Darwin
#endif
import Foundation
import os

private nonisolated let logger = Logger(subsystem: StatsLog.subsystem, category: "Environment")

/// Samples the context object (schema §3) from the process.
///
/// Everything here is `Bundle` / `ProcessInfo` / `Locale` / `uname` / `sysctl`.
/// None of it is a required-reason API — in particular there is no
/// `systemUptime`, no free disk space, no file timestamp, and no active-keyboard
/// query, so the bundled manifest's single `UserDefaults` (CA92.1) entry stays
/// truthful (§13, §14).
nonisolated enum StatsEnvironment {
    /// Called once per session, off the main actor. ~microseconds: two Bundle
    /// dictionary reads, a `uname`, one `sysctlbyname`, two `Locale` reads.
    static func sampleContext(
        bundleId: String,
        screenMetrics: StatsScreenMetrics,
        colorScheme: String?,
        isPreRelease: Bool?
    ) -> StatsContext {
        let info = Bundle.main.infoDictionary
        let appVersion = info?["CFBundleShortVersionString"] as? String ?? "0"
        let appBuild = info?["CFBundleVersion"] as? String ?? "0"
        // §3 caps these at 32 scalars and `deviceModel` at 64. They come from the
        // consumer's Info.plist and from `sysctl`, so the SDK cannot fix them —
        // but §0 makes an over-long field a **400 for the whole batch**, which is
        // a permanent drop. Without this line the only symptom would be every
        // batch vanishing with no local signal at all.
        warnIfOverLimit(appVersion, limit: 32, field: "appVersion (CFBundleShortVersionString)")
        warnIfOverLimit(appBuild, limit: 32, field: "appBuild (CFBundleVersion)")

        return StatsContext(
            sdkVersion: Stats.sdkVersion,
            appVersion: appVersion,
            appBuild: appBuild,
            bundleId: bundleId,
            osName: osName,
            osVersion: osVersion,
            deviceModel: deviceModel,
            arch: arch,
            locale: locale,
            region: region,
            screenWidth: screenMetrics.width,
            screenHeight: screenMetrics.height,
            screenScale: screenMetrics.scale,
            isDebug: isDebug,
            isTestFlight: isPreRelease ?? isTestFlightFallback,
            colorScheme: colorScheme
        )
    }

    /// Logs a §3 context field that exceeds its documented scalar limit. The
    /// value itself is never logged — only the field name and the two counts.
    private static func warnIfOverLimit(_ value: String, limit: Int, field: String) {
        let count = value.unicodeScalars.count
        guard count > limit else { return }
        logger.warning("""
            context field \(field, privacy: .public) is \(count, privacy: .public) scalars, over \
            the schema §3 limit of \(limit, privacy: .public); a conforming backend will reject \
            every batch with 400
            """)
    }

    /// One of the schema's closed set. iPadOS is reported as `iOS`: telling them
    /// apart needs `UIDevice.userInterfaceIdiom`, i.e. UIKit on the main actor,
    /// and the schema lets a backend keep an unknown-but-plausible value
    /// verbatim rather than have the SDK pull in a UI framework for one string.
    static var osName: String {
        #if os(macOS)
        "macOS"
        #elseif os(visionOS)
        "visionOS"
        #elseif os(tvOS)
        "tvOS"
        #elseif os(watchOS)
        "watchOS"
        #elseif os(iOS)
        "iOS"
        #else
        "unknown"
        #endif
    }

    /// Marketing version, not the Darwin kernel version. A trailing `.0` patch
    /// is dropped, so this reads `18.2` and not `18.2.0`.
    static var osVersion: String {
        let version = ProcessInfo.processInfo.operatingSystemVersion
        if version.patchVersion == 0 {
            return "\(version.majorVersion).\(version.minorVersion)"
        }
        return "\(version.majorVersion).\(version.minorVersion).\(version.patchVersion)"
    }

    /// Raw model identifier: `Mac15,3`, `iPhone16,2`.
    ///
    /// On macOS `uname` reports the *architecture* (`arm64`), so the model comes
    /// from the `hw.model` sysctl; on the embedded platforms `uname`'s `machine`
    /// is already the model identifier.
    static var deviceModel: String {
        #if os(macOS)
        return sysctlString("hw.model") ?? "unknown"
        #elseif canImport(Darwin)
        var info = utsname()
        guard uname(&info) == 0 else { return "unknown" }
        let machine = withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw)
        }
        return machine.isEmpty ? "unknown" : machine
        #else
        return "unknown"
        #endif
    }

    static var arch: String {
        #if arch(arm64)
        // arm64e is not distinguishable at compile time on the platforms we
        // support today; `arm64` is the honest answer for a normal build.
        "arm64"
        #elseif arch(x86_64)
        "x86_64"
        #elseif arch(wasm32)
        "wasm32"
        #else
        "unknown"
        #endif
    }

    /// POSIX-ish BCP 47 with an underscore: `en_US`, `pt_BR`, or bare `de`.
    static var locale: String {
        let identifier = Locale.current.identifier
        // A modern `Locale.identifier` can carry keywords (`en_US@calendar=...`)
        // and the schema's ≤ 32 scalars has no room for them.
        let base = identifier.prefix(while: { $0 != "@" })
        let normalized = base.replacingOccurrences(of: "-", with: "_")
        return normalized.isEmpty ? "en" : String(normalized.unicodeScalars.prefix(32))
    }

    /// ISO 3166-1 alpha-2, uppercase; `ZZ` when unknown. From the device region
    /// setting — never from an IP address (§13).
    static var region: String {
        guard let region = Locale.current.region?.identifier, region.count == 2 else { return "ZZ" }
        return region.uppercased()
    }

    static var isDebug: Bool {
        #if DEBUG
        true
        #else
        false
        #endif
    }

    /// "Pre-release install" — a TestFlight build, or a sandbox receipt on
    /// macOS.
    ///
    /// The SDK cannot answer this honestly on its own any more:
    /// `Bundle.appStoreReceiptURL` (the classic `lastPathComponent ==
    /// "sandboxReceipt"` check) is deprecated in favor of StoreKit's
    /// `AppTransaction`, and importing StoreKit would add a framework and an
    /// `await` to a cold path for one boolean. So the value comes from the
    /// consumer via `StatsConfiguration.isPreRelease`, and defaults to `false` —
    /// a legal value that under-reports rather than lying the other way.
    static let isTestFlightFallback = false

    #if os(macOS)
    private static func sysctlString(_ name: String) -> String? {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var buffer = [UInt8](repeating: 0, count: size)
        guard sysctlbyname(name, &buffer, &size, nil, 0) == 0 else { return nil }
        return String(decoding: buffer)
    }
    #endif
}

extension String {
    /// Decodes a NUL-terminated C string out of a raw byte buffer.
    fileprivate init(decoding bytes: some Sequence<UInt8>) {
        let trimmed = Array(bytes.prefix(while: { $0 != 0 }))
        self = String(decoding: trimmed, as: UTF8.self)
    }
}
