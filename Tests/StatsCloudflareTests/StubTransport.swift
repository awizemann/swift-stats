import Foundation
@testable import StatsCloudflare

/// A `StatsTransport` that answers from a script and records what it was asked.
///
/// An actor, so the recorded requests are safe to read from the test after an
/// `await` without a lock. `StatsTransport` is declared `nonisolated protocol`
/// precisely so an actor can conform to it — a plain `protocol` would be
/// implicitly `@MainActor` under MainActor-by-default isolation and this
/// conformance would not compile.
actor StubTransport: StatsTransport {
    enum Answer: Sendable {
        case response(StatsHTTPResponse)
        case failure(any Error)
    }

    private var answers: [Answer]
    private(set) var requests: [URLRequest] = []

    init(_ answers: [Answer]) {
        self.answers = answers
    }

    /// Convenience for the common single-response case.
    init(status: Int, headers: [String: String] = [:], json: String = "") {
        self.answers = [
            .response(
                StatsHTTPResponse(
                    statusCode: status,
                    headers: headers,
                    body: Data(json.utf8)
                )
            )
        ]
    }

    init(failure: any Error) {
        self.answers = [.failure(failure)]
    }

    func perform(_ request: URLRequest) async throws -> StatsHTTPResponse {
        requests.append(request)
        guard !answers.isEmpty else {
            // Louder than returning a default: a test that makes an unexpected
            // extra request should fail on that fact, not on a decoded body.
            struct NoMoreAnswers: Error {}
            throw NoMoreAnswers()
        }
        switch answers.removeFirst() {
        case .response(let response): return response
        case .failure(let error): throw error
        }
    }

    /// The single request made, or `nil` if none was.
    var lastRequest: URLRequest? { requests.last }
}

/// A transport error distinguishable from anything the schema defines.
struct StubTransportFailure: Error {}
