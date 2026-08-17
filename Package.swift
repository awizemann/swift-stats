// swift-tools-version: 6.2
import PackageDescription

let swiftSettings: [SwiftSetting] = [
    .swiftLanguageMode(.v6),
    .enableUpcomingFeature("ExistentialAny")
]

// swift-stats builds in Swift 6 language mode with zero dependencies.
//
// Deliberately NO `.defaultIsolation(MainActor.self)`: a library must be
// explicit about its own isolation so it behaves identically whether the
// consumer opts into MainActor-by-default or not. Every declaration here
// states its isolation (`nonisolated`, `actor`, `@MainActor`) in the source.
let package = Package(
    name: "swift-stats",
    platforms: [.macOS(.v15), .iOS(.v18)],
    products: [
        .library(name: "Stats", targets: ["Stats"]),
        .library(name: "StatsCloudflare", targets: ["StatsCloudflare"]),
        .library(name: "StatsTesting", targets: ["StatsTesting"])
    ],
    targets: [
        .target(
            name: "Stats",
            resources: [
                .copy("Resources/PrivacyInfo.xcprivacy")
            ],
            swiftSettings: swiftSettings
        ),
        .target(
            name: "StatsCloudflare",
            dependencies: ["Stats"],
            swiftSettings: swiftSettings
        ),
        .target(
            name: "StatsTesting",
            dependencies: ["Stats"],
            swiftSettings: swiftSettings
        ),
        .testTarget(
            name: "StatsTests",
            dependencies: ["Stats", "StatsTesting"],
            swiftSettings: swiftSettings
        ),
        .testTarget(
            name: "StatsCloudflareTests",
            dependencies: ["StatsCloudflare", "StatsTesting"],
            swiftSettings: swiftSettings
        )
    ]
)
