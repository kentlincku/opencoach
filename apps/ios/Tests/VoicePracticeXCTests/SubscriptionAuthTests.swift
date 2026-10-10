#if canImport(XCTest)
import XCTest
#if canImport(VoicePracticeCore)
@testable import VoicePracticeCore
#endif

private final class FakeHTTP: SubscriptionHTTP {
    var handler: (URLRequest) -> (Int, Any)
    var requests: [URLRequest] = []
    init(_ handler: @escaping (URLRequest) -> (Int, Any)) { self.handler = handler }
    func send(_ request: URLRequest) async throws -> (Int, Data) {
        requests.append(request)
        let (status, body) = handler(request)
        if let text = body as? String { return (status, Data(text.utf8)) }
        return (status, try JSONSerialization.data(withJSONObject: body))
    }
}

private func bodyString(_ r: URLRequest) -> String { String(decoding: r.httpBody ?? Data(), as: UTF8.self) }

final class SubscriptionAuthTests: XCTestCase {
    func testCodexDeviceLoginStoresTokensInKeychainOnly() async throws {
        var polls = 0
        let http = FakeHTTP { req in
            let url = req.url!.absoluteString
            if url.hasSuffix("/deviceauth/usercode") { return (200, ["user_code": "ABCD", "device_auth_id": "d1", "interval": 3]) }
            if url.hasSuffix("/deviceauth/token") { polls += 1; return polls == 1 ? (403, [:]) : (200, ["authorization_code": "ac", "code_verifier": "cv"]) }
            if url == "https://auth.openai.com/oauth/token" { return (200, ["access_token": "AT", "refresh_token": "RT", "expires_in": 3600]) }
            return (500, [:])
        }
        let store = InMemoryCredentialStore()
        var opened: URL?
        let bridge = VoiceWebBridge(credentials: store, subscriptionHTTP: http, openURL: { opened = $0 })
        let begin = await bridge.handleMessage(dict: ["id": "1", "operation": "subscription.begin", "providerId": "chatgpt-subscription"])
        XCTAssertTrue(begin.success)
        XCTAssertEqual(opened?.host, "auth.openai.com")
        XCTAssertEqual(begin.subscription?["userCode"] as? String, "ABCD")
        let loginId = try XCTUnwrap(begin.subscription?["loginId"] as? String)
        let p1 = await bridge.handleMessage(dict: ["id": "2", "operation": "subscription.poll", "loginId": loginId])
        XCTAssertEqual(p1.subscription?["state"] as? String, "pending")
        let p2 = await bridge.handleMessage(dict: ["id": "3", "operation": "subscription.poll", "loginId": loginId])
        XCTAssertEqual(p2.subscription?["state"] as? String, "complete")
        XCTAssertTrue(bodyString(http.requests.last!).contains("client_id=app_EMoamEEZ73f0CkXaXp7hrann"))
        let status = await bridge.handleMessage(dict: ["id": "4", "operation": "subscription.status", "providerId": "chatgpt-subscription"])
        XCTAssertEqual(status.subscription?["loggedIn"] as? Bool, true)
        // No token in any response; renderer cannot reach it via credential.*
        XCTAssertFalse("\(begin.subscription ?? [:])\(p2.subscription ?? [:])\(status.subscription ?? [:])".contains("AT"))
        let leak = await bridge.handleMessage(dict: ["id": "5", "operation": "credential.has", "providerId": "chatgpt-subscription"])
        XCTAssertEqual(leak.error, "PROVIDER_NOT_ALLOWED")
    }

    func testClaudePasteRejectsStateMismatchAndChatUsesClaudeCodeIdentity() async throws {
        let http = FakeHTTP { req in
            let url = req.url!.absoluteString
            if url.hasSuffix("/oauth/token") {
                XCTAssertEqual(req.value(forHTTPHeaderField: "User-Agent"), "axios/1.7.9")
                return (200, ["access_token": "CA", "refresh_token": "CR", "expires_in": 3600])
            }
            if url == "https://api.anthropic.com/v1/messages" { return (200, ["content": [["type": "text", "text": "Hi"]]]) }
            return (500, [:])
        }
        let bridge = VoiceWebBridge(credentials: InMemoryCredentialStore(), subscriptionHTTP: http, openURL: { _ in })
        let auth = SubscriptionAuth(credentials: InMemoryCredentialStore(), http: http)
        let start = try await auth.beginLogin("claude-subscription")
        let state = URLComponents(url: start.verificationURL, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "state" }!.value!
        do { try await auth.completeLogin(start.loginId, code: "c#wrong"); XCTFail() } catch { XCTAssertEqual(error as? SubscriptionError, .stateMismatch) }

        let begin = await bridge.handleMessage(dict: ["id": "1", "operation": "subscription.begin", "providerId": "claude-subscription"])
        XCTAssertEqual(begin.subscription?["mode"] as? String, "paste")
        XCTAssertNil(begin.subscription?["verificationUrl"], "PKCE URL stays native")
        _ = state
        // Complete through the bridge requires the native state, so drive the client directly for chat.
        let store = InMemoryCredentialStore()
        let a2 = SubscriptionAuth(credentials: store, http: http)
        let s2 = try await a2.beginLogin("claude-subscription")
        let st2 = URLComponents(url: s2.verificationURL, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "state" }!.value!
        try await a2.completeLogin(s2.loginId, code: "code#\(st2)")
        let client = SubscriptionClient(auth: a2, http: http)
        let text = try await client.chat("claude-subscription", model: "claude-sonnet-4-6",
            messages: [ChatMessage(role: "system", content: "Coach"), ChatMessage(role: "user", content: "Hello")], maxTokens: 100)
        XCTAssertEqual(text, "Hi")
        let req = http.requests.last!
        XCTAssertTrue(req.value(forHTTPHeaderField: "User-Agent")!.hasPrefix("claude-code/"))
        XCTAssertTrue(req.value(forHTTPHeaderField: "anthropic-beta")!.contains("oauth-2025-04-20"))
        let body = try JSONSerialization.jsonObject(with: req.httpBody!) as! [String: Any]
        let system = body["system"] as! [[String: String]]
        XCTAssertTrue(system[0]["text"]!.hasPrefix("You are Claude Code"))
        XCTAssertEqual(system[1]["text"], "Coach")
    }

    func testCodexChatParsesSSEAndRetries401WithRefresh() async throws {
        var calls = 0
        let http = FakeHTTP { req in
            let url = req.url!.absoluteString
            if url == "https://auth.openai.com/oauth/token" { return (200, ["access_token": "NEW", "refresh_token": "RT2", "expires_in": 3600]) }
            if url.hasSuffix("/codex/responses") {
                calls += 1
                if req.value(forHTTPHeaderField: "Authorization") == "Bearer OLD" { return (401, [:]) }
                return (200, "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hel\"}\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"lo\"}\ndata: [DONE]\n")
            }
            return (500, [:])
        }
        let store = InMemoryCredentialStore()
        let auth = SubscriptionAuth(credentials: store, http: http)
        try auth.save(.chatgpt, ["access_token": "OLD", "refresh_token": "RT", "expires_in": 3600], previous: nil)
        let text = try await SubscriptionClient(auth: auth, http: http).chat("chatgpt-subscription", model: "gpt-5.5",
            messages: [ChatMessage(role: "user", content: "hi")], maxTokens: 50)
        XCTAssertEqual(text, "Hello")
        XCTAssertEqual(calls, 2)
    }

    func testRejectsUnknownProviderAndForeignHosts() async {
        let bridge = VoiceWebBridge(credentials: InMemoryCredentialStore(), subscriptionHTTP: FakeHTTP { _ in (200, [:]) })
        let r = await bridge.handleMessage(dict: ["id": "1", "operation": "subscription.begin", "providerId": "copilot-subscription"])
        XCTAssertEqual(r.error, "PROVIDER_NOT_ALLOWED")
        let extra = await bridge.handleMessage(dict: ["id": "2", "operation": "subscription.status", "providerId": "grok-subscription", "baseUrl": "x"])
        XCTAssertEqual(extra.error, "FORBIDDEN_PROPERTY_baseUrl")
        let chat = await bridge.handleMessage(dict: ["id": "3", "operation": "chat", "providerId": "grok-subscription", "model": "grok-4",
                                                    "messages": [["role": "user", "content": "hi"]]])
        XCTAssertEqual(chat.error, "SUBSCRIPTION_LOGIN_REQUIRED")
    }

    func testGrokSpendingLimitIsReportedAsNotEntitled() async throws {
        let http = FakeHTTP { _ in (402, ["code": "personal-team-blocked:spending-limit", "error": "run out of credits"]) }
        let store = InMemoryCredentialStore()
        let auth = SubscriptionAuth(credentials: store, http: http)
        try auth.save(.grok, ["access_token": "G", "refresh_token": "GR", "expires_in": 21600], previous: nil)
        let bridge = VoiceWebBridge(credentials: store, subscriptionHTTP: http)
        let chat = await bridge.handleMessage(dict: ["id": "1", "operation": "chat", "providerId": "grok-subscription",
            "model": "grok-4.6", "messages": [["role": "user", "content": "hi"]]])
        XCTAssertEqual(chat.error, "SUBSCRIPTION_NOT_ENTITLED")
        http.handler = { _ in (403, ["code": "personal-team-blocked:spending-limit"]) }
        let models = await bridge.handleMessage(dict: ["id": "2", "operation": "models", "providerId": "grok-subscription"])
        XCTAssertEqual(models.error, "SUBSCRIPTION_NOT_ENTITLED")
    }
}
#endif
