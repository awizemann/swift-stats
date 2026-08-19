import Foundation
import Testing
@testable import Stats

@Suite("Stats package scaffold")
struct StatsSmokeTests {
    @Test("SDK and schema versions are the documented values")
    func versions() {
        #expect(Stats.sdkVersion == "0.2.0")
        // docs/schema.md is the contract; the constant must match its heading.
        #expect(Stats.schemaVersion == "v1")
    }

    /// Discriminating: fails if the `.copy("Resources/PrivacyInfo.xcprivacy")`
    /// rule is dropped from Package.swift, which would silently ship the
    /// package without its privacy manifest.
    @Test("The privacy manifest is bundled with the Stats target")
    func privacyManifestIsBundled() throws {
        let url = try #require(
            Bundle.module.url(forResource: "PrivacyInfo", withExtension: "xcprivacy"),
            "PrivacyInfo.xcprivacy is missing from the Stats resource bundle"
        )
        let data = try Data(contentsOf: url)
        let plist = try #require(
            try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
        )

        #expect(plist["NSPrivacyTracking"] as? Bool == false)
        #expect((plist["NSPrivacyTrackingDomains"] as? [Any])?.isEmpty == true)

        let collected = try #require(plist["NSPrivacyCollectedDataTypes"] as? [[String: Any]])
        let types = collected.compactMap { $0["NSPrivacyCollectedDataType"] as? String }
        #expect(types.sorted() == [
            "NSPrivacyCollectedDataTypeOtherDiagnosticData",
            "NSPrivacyCollectedDataTypeProductInteraction"
        ])
        // Nothing may be declared linked-to-identity or used for tracking.
        #expect(collected.allSatisfy { $0["NSPrivacyCollectedDataTypeLinked"] as? Bool == false })
        #expect(collected.allSatisfy { $0["NSPrivacyCollectedDataTypeTracking"] as? Bool == false })

        let accessed = try #require(plist["NSPrivacyAccessedAPITypes"] as? [[String: Any]])
        #expect(accessed.count == 1, "Only UserDefaults may be a required-reason API")
        #expect(accessed.first?["NSPrivacyAccessedAPIType"] as? String
                == "NSPrivacyAccessedAPICategoryUserDefaults")
        #expect(accessed.first?["NSPrivacyAccessedAPITypeReasons"] as? [String] == ["CA92.1"])
    }
}
