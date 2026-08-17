import Foundation

/// The per-batch context (schema §3): what the app was, at the time its events
/// were *tracked*.
///
/// The field list is exhaustive for `v1` and an emitter MUST NOT add ad-hoc
/// keys — app-specific dimensions belong in `props`. That is why this is a
/// closed struct with no dictionary escape hatch.
public struct StatsContext: Sendable, Hashable, Codable {
    public var sdkVersion: String
    public var appVersion: String
    public var appBuild: String
    public var bundleId: String
    public var osName: String
    public var osVersion: String
    public var deviceModel: String
    public var arch: String
    public var locale: String
    public var region: String
    public var screenWidth: Int
    public var screenHeight: Int
    public var screenScale: Double
    public var isDebug: Bool
    public var isTestFlight: Bool
    /// `light` or `dark`; omitted when not applicable or not sampled.
    public var colorScheme: String?

    public init(
        sdkVersion: String,
        appVersion: String,
        appBuild: String,
        bundleId: String,
        osName: String,
        osVersion: String,
        deviceModel: String,
        arch: String,
        locale: String,
        region: String,
        screenWidth: Int,
        screenHeight: Int,
        screenScale: Double,
        isDebug: Bool,
        isTestFlight: Bool,
        colorScheme: String? = nil
    ) {
        self.sdkVersion = sdkVersion
        self.appVersion = appVersion
        self.appBuild = appBuild
        self.bundleId = bundleId
        self.osName = osName
        self.osVersion = osVersion
        self.deviceModel = deviceModel
        self.arch = arch
        self.locale = locale
        self.region = region
        self.screenWidth = screenWidth
        self.screenHeight = screenHeight
        self.screenScale = screenScale
        self.isDebug = isDebug
        self.isTestFlight = isTestFlight
        self.colorScheme = colorScheme
    }

    private enum CodingKeys: String, CodingKey {
        case sdkVersion, appVersion, appBuild, bundleId, osName, osVersion, deviceModel,
             arch, locale, region, screenWidth, screenHeight, screenScale,
             isDebug, isTestFlight, colorScheme
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(sdkVersion, forKey: .sdkVersion)
        try container.encode(appVersion, forKey: .appVersion)
        try container.encode(appBuild, forKey: .appBuild)
        try container.encode(bundleId, forKey: .bundleId)
        try container.encode(osName, forKey: .osName)
        try container.encode(osVersion, forKey: .osVersion)
        try container.encode(deviceModel, forKey: .deviceModel)
        try container.encode(arch, forKey: .arch)
        try container.encode(locale, forKey: .locale)
        try container.encode(region, forKey: .region)
        try container.encode(screenWidth, forKey: .screenWidth)
        try container.encode(screenHeight, forKey: .screenHeight)
        try container.encode(screenScale, forKey: .screenScale)
        try container.encode(isDebug, forKey: .isDebug)
        try container.encode(isTestFlight, forKey: .isTestFlight)
        // Omit rather than send null (§0, §3).
        try container.encodeIfPresent(colorScheme, forKey: .colorScheme)
    }

    /// The context as it must be sent when the `diagnostics` consent group is
    /// denied (schema §11): the documented unknown values, which a backend MUST
    /// accept. `sdkVersion`, `appVersion`, `appBuild` and `bundleId` are always
    /// sent; `osName`, `arch`, `isDebug` and `isTestFlight` stay real because
    /// they are not identifying.
    func diagnosticsDenied() -> StatsContext {
        var reduced = self
        reduced.osVersion = String(osVersion.prefix(while: { $0 != "." }))
        reduced.deviceModel = "unknown"
        reduced.locale = String(locale.prefix(while: { $0 != "_" && $0 != "-" }))
        reduced.region = "ZZ"
        reduced.screenWidth = 0
        reduced.screenHeight = 0
        reduced.screenScale = 1.0
        reduced.colorScheme = nil
        return reduced
    }
}

/// Screen metrics for the context object, in **points**.
///
/// The core target deliberately imports neither AppKit nor UIKit: doing so
/// would drag a UI framework into a background actor's cold path and, on iOS,
/// force main-actor hops to read `UIScreen`. A consumer that wants real screen
/// metrics reads them where it already is on the main actor and passes them in;
/// the default is the schema's headless triple (`0` / `0` / `1.0`), which is a
/// legal value.
public struct StatsScreenMetrics: Sendable, Hashable {
    public var width: Int
    public var height: Int
    public var scale: Double

    public init(width: Int, height: Int, scale: Double) {
        self.width = width
        self.height = height
        self.scale = scale
    }

    /// `0` / `0` / `1.0` — what the schema prescribes for a headless emitter
    /// and for `diagnostics`-denied traffic.
    public static let headless = StatsScreenMetrics(width: 0, height: 0, scale: 1.0)
}
