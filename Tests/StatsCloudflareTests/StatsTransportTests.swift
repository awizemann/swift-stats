import Foundation
import Testing
@testable import StatsCloudflare

/// Pins the production defaults `URLSessionTransport` builds its session
/// from, so a change to any of them is a deliberate edit here rather than an
/// incidental drift in `defaultConfiguration()`.
@Suite("URLSessionTransport defaults")
struct StatsTransportTests {
    @Test("defaultConfiguration() carries the documented timeouts, service type, and cookie/cache settings")
    func defaultConfigurationValues() {
        let configuration = URLSessionTransport.defaultConfiguration()

        #expect(configuration.timeoutIntervalForRequest == 20)
        #expect(configuration.timeoutIntervalForResource == 60)
        #expect(configuration.networkServiceType == .background)
        #expect(configuration.allowsConstrainedNetworkAccess == false)
        #expect(configuration.httpCookieAcceptPolicy == .never)
        #expect(configuration.httpShouldSetCookies == false)
        #expect(configuration.urlCache == nil)
        #expect(configuration.requestCachePolicy == .reloadIgnoringLocalCacheData)
    }

    @Test("The exposed static constants match what defaultConfiguration() applies")
    func staticConstantsMatchConfiguration() {
        let configuration = URLSessionTransport.defaultConfiguration()

        #expect(URLSessionTransport.timeoutIntervalForRequest == configuration.timeoutIntervalForRequest)
        #expect(URLSessionTransport.timeoutIntervalForResource == configuration.timeoutIntervalForResource)
        #expect(URLSessionTransport.networkServiceType == configuration.networkServiceType)
        #expect(URLSessionTransport.allowsConstrainedNetworkAccess == configuration.allowsConstrainedNetworkAccess)
    }

    @Test("defaultConfiguration() honors an explicit allowsConstrainedNetworkAccess / allowsExpensiveNetworkAccess override")
    func defaultConfigurationHonorsOverrides() {
        let configuration = URLSessionTransport.defaultConfiguration(
            allowsConstrainedNetworkAccess: true,
            allowsExpensiveNetworkAccess: false
        )

        #expect(configuration.allowsConstrainedNetworkAccess == true)
        #expect(configuration.allowsExpensiveNetworkAccess == false)
        // Everything else still comes from the same baseline.
        #expect(configuration.timeoutIntervalForRequest == URLSessionTransport.timeoutIntervalForRequest)
    }
}
