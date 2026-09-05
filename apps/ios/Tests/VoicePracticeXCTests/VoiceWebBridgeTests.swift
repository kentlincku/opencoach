#if canImport(XCTest)
import XCTest
#if canImport(VoicePracticeCore)
@testable import VoicePracticeCore
#endif

final class VoiceWebBridgeTests: XCTestCase {
    func testCredentialLifecycleAndIsolation() async {
        let store = InMemoryCredentialStore()
        let bridge = VoiceWebBridge(credentials: store)

        // Initially has no credential
        let hasMsg1: [String: Any] = [
            "id": "msg-1",
            "operation": "credential.has",
            "providerId": "omlx"
        ]
        let res1 = await bridge.handleMessage(dict: hasMsg1)
        XCTAssertTrue(res1.success)
        XCTAssertEqual(res1.hasCredential, false)

        // Set credential
        let setMsg: [String: Any] = [
            "id": "msg-2",
            "operation": "credential.set",
            "providerId": "omlx",
            "credential": "sk-local-secret-key"
        ]
        let res2 = await bridge.handleMessage(dict: setMsg)
        XCTAssertTrue(res2.success)
        XCTAssertEqual(res2.stored, true)
        XCTAssertNil(res2.text)

        // Check has credential
        let hasMsg2: [String: Any] = [
            "id": "msg-3",
            "operation": "credential.has",
            "providerId": "omlx"
        ]
        let res3 = await bridge.handleMessage(dict: hasMsg2)
        XCTAssertTrue(res3.success)
        XCTAssertEqual(res3.hasCredential, true)

        // Clear credential
        let clearMsg: [String: Any] = [
            "id": "msg-4",
            "operation": "credential.clear",
            "providerId": "omlx"
        ]
        let res4 = await bridge.handleMessage(dict: clearMsg)
        XCTAssertTrue(res4.success)
        XCTAssertEqual(res4.cleared, true)

        // Check has after clear
        let res5 = await bridge.handleMessage(dict: hasMsg1)
        XCTAssertTrue(res5.success)
        XCTAssertEqual(res5.hasCredential, false)
    }

    func testRejectsForbiddenPropertiesAndArbitraryHeaders() async {
        let bridge = VoiceWebBridge(credentials: InMemoryCredentialStore())

        let forbiddenPayload: [String: Any] = [
            "id": "bad-1",
            "operation": "models",
            "headers": ["Authorization": "Bearer stolen"],
            "method": "DELETE"
        ]
        let res = await bridge.handleMessage(dict: forbiddenPayload)
        XCTAssertFalse(res.success)
        XCTAssertTrue(res.error?.contains("FORBIDDEN_PROPERTY") == true)
    }

    func testRejectsUnsupportedOperations() async {
        let bridge = VoiceWebBridge(credentials: InMemoryCredentialStore())

        let unsupportedPayload: [String: Any] = [
            "id": "bad-2",
            "operation": "shell.exec",
            "command": "cat /etc/passwd"
        ]
        let res = await bridge.handleMessage(dict: unsupportedPayload)
        XCTAssertFalse(res.success)
        XCTAssertEqual(res.error, "UNSUPPORTED_OPERATION")
    }

    func testRejectsMissingMessageId() async {
        let bridge = VoiceWebBridge(credentials: InMemoryCredentialStore())

        let noId: [String: Any] = [
            "operation": "models"
        ]
        let res = await bridge.handleMessage(dict: noId)
        XCTAssertFalse(res.success)
        XCTAssertEqual(res.error, "MISSING_MESSAGE_ID")
    }

    func testRejectsInvalidJson() async {
        let bridge = VoiceWebBridge(credentials: InMemoryCredentialStore())
        let res = await bridge.handleMessage(jsonString: "not a json string")
        XCTAssertFalse(res.success)
        XCTAssertEqual(res.error, "INVALID_JSON_MESSAGE")
    }

    func testSpecialCharactersInIdAreSafelyPreservedAsData() async {
        let bridge = VoiceWebBridge(credentials: InMemoryCredentialStore())
        let specialId = "msg'test\\with\nnewline\u{2028}line_sep"
        let msg: [String: Any] = [
            "id": specialId,
            "operation": "credential.has",
            "providerId": "omlx"
        ]
        let res = await bridge.handleMessage(dict: msg)
        XCTAssertEqual(res.id, specialId)
        XCTAssertTrue(res.success)
    }

    func testCloudCredentialCannotBeSentToLanEndpoint() async {
        let bridge = VoiceWebBridge(credentials: InMemoryCredentialStore())
        // Attempting to send openai providerId to local LAN endpoint must fail
        let payload: [String: Any] = [
            "id": "mismatch-1",
            "operation": "models",
            "providerId": "openai",
            "baseUrl": "http://127.0.0.1:8000/v1"
        ]
        let res = await bridge.handleMessage(dict: payload)
        XCTAssertFalse(res.success)
        XCTAssertEqual(res.error, "CLOUD_CREDENTIAL_ENDPOINT_MISMATCH")
    }

    func testSchemaLimitsEnforcedFailClosed() async {
        let bridge = VoiceWebBridge(credentials: InMemoryCredentialStore())

        // ID too long (>128)
        let longId = String(repeating: "a", count: 129)
        let resId = await bridge.handleMessage(dict: ["id": longId, "operation": "models"])
        XCTAssertFalse(resId.success)
        XCTAssertEqual(resId.error, "ID_TOO_LONG")

        // Provider ID too long (>64)
        let longProvider = String(repeating: "p", count: 65)
        let resProv = await bridge.handleMessage(dict: ["id": "req-1", "operation": "models", "providerId": longProvider])
        XCTAssertFalse(resProv.success)
        XCTAssertEqual(resProv.error, "INVALID_PROVIDER_ID")

        // Model name too long (>256)
        let longModel = String(repeating: "m", count: 257)
        let resModel = await bridge.handleMessage(dict: [
            "id": "req-2",
            "operation": "chat",
            "model": longModel,
            "messages": [["role": "user", "content": "hi"]]
        ])
        XCTAssertFalse(resModel.success)
        XCTAssertEqual(resModel.error, "INVALID_MODEL")

        // Messages count too large (>100)
        let tooManyMsgs = (0...101).map { ["role": "user", "content": "msg \($0)"] }
        let resMsgs = await bridge.handleMessage(dict: [
            "id": "req-3",
            "operation": "chat",
            "model": "test-model",
            "messages": tooManyMsgs
        ])
        XCTAssertFalse(resMsgs.success)
        XCTAssertEqual(resMsgs.error, "TOO_MANY_MESSAGES")

        // Message content too long (>32000)
        let longContent = String(repeating: "c", count: 32001)
        let resContent = await bridge.handleMessage(dict: [
            "id": "req-4",
            "operation": "chat",
            "model": "test-model",
            "messages": [["role": "user", "content": longContent]]
        ])
        XCTAssertFalse(resContent.success)
        XCTAssertEqual(resContent.error, "MESSAGE_CONTENT_TOO_LONG")

        // Credential too long (>4096)
        let longCred = String(repeating: "k", count: 4097)
        let resCred = await bridge.handleMessage(dict: [
            "id": "req-5",
            "operation": "credential.set",
            "providerId": "omlx",
            "credential": longCred
        ])
        XCTAssertFalse(resCred.success)
        XCTAssertEqual(resCred.error, "CREDENTIAL_TOO_LONG")
    }
}
#endif
