#if canImport(XCTest)
import XCTest
@testable import VoicePracticeCore

private actor StubAppleFoundationModelClient: AppleFoundationModelClient {
    var state: AppleFoundationModelAvailability
    var replies: [Result<String, Error>]
    private(set) var prompts: [String] = []

    init(state: AppleFoundationModelAvailability = .available, replies: [Result<String, Error>] = []) {
        self.state = state
        self.replies = replies
    }

    func availability(localeIdentifier: String) async -> AppleFoundationModelAvailability { state }

    func respond(to prompt: String, maxTokens: Int) async throws -> String {
        prompts.append(prompt)
        guard !replies.isEmpty else { return "Ready." }
        return try replies.removeFirst().get()
    }

    func recordedPrompts() -> [String] { prompts }
}

private actor BlockingAppleFoundationModelClient: AppleFoundationModelClient {
    private var continuation: CheckedContinuation<String, Error>?
    private(set) var callCount = 0

    func availability(localeIdentifier: String) async -> AppleFoundationModelAvailability { .available }

    func respond(to prompt: String, maxTokens: Int) async throws -> String {
        callCount += 1
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation = $0 }
        } onCancel: {
            Task { await self.finish(.failure(CancellationError())) }
        }
    }

    func finish(_ result: Result<String, Error>) {
        let pending = continuation
        continuation = nil
        pending?.resume(with: result)
    }
}

private actor ReusedRequestAppleFoundationModelClient: AppleFoundationModelClient {
    private var continuations: [CheckedContinuation<String, Error>] = []

    func availability(localeIdentifier: String) async -> AppleFoundationModelAvailability { .available }

    func respond(to prompt: String, maxTokens: Int) async throws -> String {
        try await withCheckedThrowingContinuation { continuations.append($0) }
    }

    var callCount: Int { continuations.count }

    func finish(call index: Int, with result: Result<String, Error>) {
        continuations[index].resume(with: result)
    }
}

private enum StubSessionError: Error { case failed }

final class AppleFoundationModelServiceTests: XCTestCase {
    func testAvailabilityStatesHaveStablePublicCodes() async {
        let cases: [(AppleFoundationModelAvailability, String)] = [
            (.available, "APPLE_MODEL_AVAILABLE"),
            (.deviceNotEligible, "APPLE_MODEL_UNSUPPORTED_DEVICE"),
            (.appleIntelligenceNotEnabled, "APPLE_INTELLIGENCE_DISABLED"),
            (.modelNotReady, "APPLE_MODEL_NOT_READY"),
            (.unsupportedLocale, "APPLE_MODEL_UNSUPPORTED_LOCALE"),
            (.platformUnsupported, "APPLE_MODEL_PLATFORM_UNSUPPORTED")
        ]
        for (state, code) in cases {
            let service = AppleFoundationModelService(client: StubAppleFoundationModelClient(state: state))
            let availability = await service.availability(localeIdentifier: "en-US")
            XCTAssertEqual(availability.code, code)
        }
    }

    func testTwoTurnsUseExplicitVersionedBoundedContext() async throws {
        let client = StubAppleFoundationModelClient(replies: [.success("First reply"), .success("Second reply")])
        let service = AppleFoundationModelService(client: client)
        _ = try await service.chat(requestID: "turn-1", messages: [
            ChatMessage(role: "system", content: "Coach in English."),
            ChatMessage(role: "user", content: "First question")
        ], localeIdentifier: "en-US", maxTokens: 120)
        let second = try await service.chat(requestID: "turn-2", messages: [
            ChatMessage(role: "system", content: "Coach in English."),
            ChatMessage(role: "user", content: "First question"),
            ChatMessage(role: "assistant", content: "First reply"),
            ChatMessage(role: "user", content: "Second question")
        ], localeIdentifier: "en-US", maxTokens: 120)

        XCTAssertEqual(second.text, "Second reply")
        XCTAssertEqual(second.contextVersion, AppleFoundationModelService.contextVersion)
        let prompts = await client.recordedPrompts()
        XCTAssertEqual(prompts.count, 2)
        XCTAssertTrue(prompts[1].contains("VOICE_PRACTICE_CONTEXT_V1"))
        XCTAssertTrue(prompts[1].contains("First reply"))
        XCTAssertLessThanOrEqual(prompts[1].count, AppleFoundationModelService.maxContextCharacters)
    }

    func testSessionErrorsAreSanitized() async {
        let client = StubAppleFoundationModelClient(replies: [.failure(StubSessionError.failed)])
        let service = AppleFoundationModelService(client: client)
        do {
            _ = try await service.chat(requestID: "error", messages: [ChatMessage(role: "user", content: "Hello")], localeIdentifier: "en-US", maxTokens: 80)
            XCTFail("Expected stable session error")
        } catch let error as AppleFoundationModelError {
            XCTAssertEqual(error.errorCode, "APPLE_MODEL_SESSION_ERROR")
        } catch {
            XCTFail("Unexpected private error: \(type(of: error))")
        }
    }

    func testCancellationInvalidatesLateResult() async {
        let client = BlockingAppleFoundationModelClient()
        let service = AppleFoundationModelService(client: client)
        let task = Task {
            try await service.chat(requestID: "turn-cancel", messages: [ChatMessage(role: "user", content: "Hello")], localeIdentifier: "en-US", maxTokens: 80)
        }
        while await client.callCount == 0 { await Task.yield() }
        await service.cancel(requestID: "turn-cancel")
        await client.finish(.success("late private reply"))
        do {
            _ = try await task.value
            XCTFail("Cancelled work must never deliver a late result")
        } catch let error as AppleFoundationModelError {
            XCTAssertEqual(error.errorCode, "APPLE_MODEL_CANCELLED")
        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    func testReusedRequestIDCannotLetStaleCompletionCancelReplacement() async throws {
        let client = ReusedRequestAppleFoundationModelClient()
        let service = AppleFoundationModelService(client: client)
        let first = Task {
            try await service.chat(requestID: "reused", messages: [ChatMessage(role: "user", content: "First")], localeIdentifier: "en-US", maxTokens: 80)
        }
        while await client.callCount < 1 { await Task.yield() }
        let replacement = Task {
            try await service.chat(requestID: "reused", messages: [ChatMessage(role: "user", content: "Replacement")], localeIdentifier: "en-US", maxTokens: 80)
        }
        while await client.callCount < 2 { await Task.yield() }

        await client.finish(call: 0, with: .success("stale reply"))
        do {
            _ = try await first.value
            XCTFail("Superseded work must not deliver a result")
        } catch let error as AppleFoundationModelError {
            XCTAssertEqual(error.errorCode, "APPLE_MODEL_CANCELLED")
        }

        await client.finish(call: 1, with: .success("replacement reply"))
        let reply = try await replacement.value
        XCTAssertEqual(reply.text, "replacement reply")
    }

    func testPayloadAndReplyLimitsFailClosed() async {
        let service = AppleFoundationModelService(client: StubAppleFoundationModelClient(replies: [.success(String(repeating: "x", count: AppleFoundationModelService.maxReplyCharacters + 1))]))
        do {
            _ = try await service.chat(requestID: "long-input", messages: [ChatMessage(role: "user", content: String(repeating: "a", count: AppleFoundationModelService.maxMessageCharacters + 1))], localeIdentifier: "en-US", maxTokens: 80)
            XCTFail("Oversize input must fail")
        } catch let error as AppleFoundationModelError {
            XCTAssertEqual(error.errorCode, "APPLE_MODEL_INPUT_TOO_LARGE")
        } catch { XCTFail("Unexpected error") }

        do {
            _ = try await service.chat(requestID: "long-output", messages: [ChatMessage(role: "user", content: "Hello")], localeIdentifier: "en-US", maxTokens: 80)
            XCTFail("Oversize output must fail")
        } catch let error as AppleFoundationModelError {
            XCTAssertEqual(error.errorCode, "APPLE_MODEL_OUTPUT_TOO_LARGE")
        } catch { XCTFail("Unexpected error") }
    }

    func testUnavailableNeverInvokesSessionOrFallsBack() async {
        let client = StubAppleFoundationModelClient(state: .modelNotReady)
        let service = AppleFoundationModelService(client: client)
        do {
            _ = try await service.chat(requestID: "unavailable", messages: [ChatMessage(role: "user", content: "Hello")], localeIdentifier: "en-US", maxTokens: 80)
            XCTFail("Unavailable model must not run")
        } catch let error as AppleFoundationModelError {
            XCTAssertEqual(error.errorCode, "APPLE_MODEL_NOT_READY")
        } catch { XCTFail("Unexpected error") }
        let prompts = await client.recordedPrompts()
        XCTAssertEqual(prompts.count, 0)
    }

    func testBridgeAppleSchemaForbidsEndpointCredentialAndModelFields() async {
        let service = AppleFoundationModelService(client: StubAppleFoundationModelClient())
        let bridge = VoiceWebBridge(
            credentials: InMemoryCredentialStore(),
            appleFoundationModel: service
        )
        for forbidden in ["baseUrl", "credential", "model"] {
            let response = await bridge.handleMessage(dict: [
                "id": "schema-\(forbidden)",
                "operation": "apple.chat",
                "providerId": VoiceWebBridge.appleFoundationModelProviderID,
                "messages": [["role": "user", "content": "Hello"]],
                forbidden: "must-not-be-accepted"
            ])
            XCTAssertFalse(response.success)
            XCTAssertEqual(response.error, "APPLE_MODEL_FORBIDDEN_PROPERTY_\(forbidden)")
            XCTAssertNil(response.text)
        }
    }

    func testBridgeAvailabilityIsTypedAndNetworkOperationsCannotUseAppleProvider() async {
        let service = AppleFoundationModelService(client: StubAppleFoundationModelClient(state: .deviceNotEligible))
        let bridge = VoiceWebBridge(
            credentials: InMemoryCredentialStore(),
            appleFoundationModel: service
        )
        let status = await bridge.handleMessage(dict: [
            "id": "status",
            "operation": "apple.status",
            "providerId": VoiceWebBridge.appleFoundationModelProviderID,
            "locale": "en-US"
        ])
        XCTAssertTrue(status.success)
        XCTAssertEqual(status.available, false)
        XCTAssertEqual(status.availability, "APPLE_MODEL_UNSUPPORTED_DEVICE")

        let networkAttempt = await bridge.handleMessage(dict: [
            "id": "no-fallback",
            "operation": "models",
            "providerId": VoiceWebBridge.appleFoundationModelProviderID
        ])
        XCTAssertFalse(networkAttempt.success)
        XCTAssertEqual(networkAttempt.error, "APPLE_MODEL_INVALID_OPERATION")
    }
}
#endif
