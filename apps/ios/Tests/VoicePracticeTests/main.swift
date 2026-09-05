import Foundation
import VoicePracticeCore

func assertTrue(_ condition: Bool, _ message: String = "", file: StaticString = #file, line: UInt = #line) {
    if !condition {
        fputs("❌ Assertion Failed: \(message) at \(file):\(line)\n", stderr)
        exit(1)
    }
}

func assertEqual<T: Equatable>(_ a: T, _ b: T, _ message: String = "", file: StaticString = #file, line: UInt = #line) {
    if a != b {
        fputs("❌ Assertion Failed: expected \(b) but got \(a) - \(message) at \(file):\(line)\n", stderr)
        exit(1)
    }
}

print("Running VoicePracticeTests...")

// --- Test 1: Loopback and LAN endpoints allowed for HTTP ---
let allowedEndpoints = [
    "http://127.0.0.1:8000/v1",
    "http://localhost:8000/v1",
    "http://[::1]:8000/v1",
    "http://192.168.1.50:8000/v1",
    "http://192.168.0.1:11434/v1",
    "http://10.0.0.15:8000/v1",
    "http://10.254.254.254:1234/v1",
    "http://172.16.0.1:8000/v1",
    "http://172.24.10.5:8000/v1",
    "http://172.31.255.254:8000/v1",
    "http://169.254.1.1:8000/v1",
    "http://mac-studio.local:8000/v1",
    "http://server.local/v1"
]

for urlString in allowedEndpoints {
    do {
        _ = try LocalModelClient.validateEndpoint(urlString: urlString)
        print("  ✓ Allowed: \(urlString)")
    } catch {
        assertTrue(false, "Should allow \(urlString), got error: \(error)")
    }
}

// --- Test 2: Public HTTP endpoints rejected ---
let rejectedEndpoints = [
    "http://8.8.8.8:8000/v1",
    "http://1.1.1.1:8000/v1",
    "http://142.250.190.46:8000/v1",
    "http://example.com/v1",
    "http://api.openai.com/v1",
    "http://openai.com/v1",
    "http://172.15.0.1:8000/v1",
    "http://172.32.0.1:8000/v1"
]

for urlString in rejectedEndpoints {
    do {
        _ = try LocalModelClient.validateEndpoint(urlString: urlString)
        assertTrue(false, "Should reject public HTTP: \(urlString)")
    } catch let err as LocalModelError {
        guard case .publicHttpNotAllowed = err else {
            assertTrue(false, "Expected publicHttpNotAllowed for \(urlString), got \(err)")
            break
        }
        print("  ✓ Rejected: \(urlString)")
    } catch {
        assertTrue(false, "Unexpected error: \(error)")
    }
}

// --- Test 3: Credentials in URL rejected ---
for urlString in ["http://admin:secret@127.0.0.1:8000/v1", "http://user:pass@192.168.1.1:8000/v1"] {
    do {
        _ = try LocalModelClient.validateEndpoint(urlString: urlString)
        assertTrue(false, "Should reject credentials in URL: \(urlString)")
    } catch let err as LocalModelError {
        guard case .credentialsInURL = err else {
            assertTrue(false, "Expected credentialsInURL, got \(err)")
            break
        }
        print("  ✓ Rejected credentials in URL: \(urlString)")
    } catch {
        assertTrue(false, "Unexpected error: \(error)")
    }
}

// --- Test 4: Unsafe schemes rejected ---
for urlString in ["file:///etc/passwd", "ftp://127.0.0.1/v1", "ws://127.0.0.1:8000/v1"] {
    do {
        _ = try LocalModelClient.validateEndpoint(urlString: urlString)
        assertTrue(false, "Should reject unsafe scheme: \(urlString)")
    } catch let err as LocalModelError {
        guard case .unsafeScheme = err else {
            assertTrue(false, "Expected unsafeScheme, got \(err)")
            break
        }
        print("  ✓ Rejected unsafe scheme: \(urlString)")
    } catch {
        assertTrue(false, "Unexpected error: \(error)")
    }
}

// --- Test 5: Allowed HTTPS hosts ---
for urlString in [
    "https://api.openai.com/v1",
    "https://generativelanguage.googleapis.com/v1beta/openai",
    "https://api.groq.com/openai/v1",
    "https://192.168.1.1:8443/v1"
] {
    do {
        _ = try LocalModelClient.validateEndpoint(urlString: urlString)
        print("  ✓ Allowed HTTPS: \(urlString)")
    } catch {
        assertTrue(false, "Should allow \(urlString), got error: \(error)")
    }
}

// --- Test 6: VoiceWebBridge credential lifecycle & isolation ---
Task {
    let store = InMemoryCredentialStore()
    let bridge = VoiceWebBridge(credentials: store)

    // Check credential.has -> false
    let res1 = await bridge.handleMessage(dict: ["id": "m1", "operation": "credential.has", "providerId": "omlx"])
    assertTrue(res1.success)
    assertEqual(res1.hasCredential, false)
    print("  ✓ Bridge credential.has initially false")

    // Set credential
    let res2 = await bridge.handleMessage(dict: [
        "id": "m2",
        "operation": "credential.set",
        "providerId": "omlx",
        "credential": "sk-secret-token"
    ])
    assertTrue(res2.success)
    assertEqual(res2.stored, true)
    assertTrue(res2.text == nil, "Credential must NEVER be returned in response")
    print("  ✓ Bridge credential.set stored without leaking to web")

    // Check credential.has -> true
    let res3 = await bridge.handleMessage(dict: ["id": "m3", "operation": "credential.has", "providerId": "omlx"])
    assertTrue(res3.success)
    assertEqual(res3.hasCredential, true)
    print("  ✓ Bridge credential.has now true")

    // Clear credential
    let res4 = await bridge.handleMessage(dict: ["id": "m4", "operation": "credential.clear", "providerId": "omlx"])
    assertTrue(res4.success)
    assertEqual(res4.cleared, true)
    print("  ✓ Bridge credential.clear succeeded")

    // Check credential.has after clear -> false
    let res5 = await bridge.handleMessage(dict: ["id": "m5", "operation": "credential.has", "providerId": "omlx"])
    assertTrue(res5.success)
    assertEqual(res5.hasCredential, false)
    print("  ✓ Bridge credential.has false after clear")

    // --- Test 7: Bridge schema security ---
    // Reject forbidden properties (e.g. headers, method)
    let badRes1 = await bridge.handleMessage(dict: [
        "id": "bad1",
        "operation": "models",
        "headers": ["Authorization": "Bearer evil"],
        "method": "DELETE"
    ])
    assertTrue(!badRes1.success)
    assertTrue(badRes1.error?.contains("FORBIDDEN_PROPERTY") == true)
    print("  ✓ Bridge rejected forbidden properties (headers/method)")

    // Reject unsupported operation
    let badRes2 = await bridge.handleMessage(dict: ["id": "bad2", "operation": "shell.exec"])
    assertTrue(!badRes2.success)
    assertEqual(badRes2.error, "UNSUPPORTED_OPERATION")
    print("  ✓ Bridge rejected unsupported operation")

    // Reject missing message id
    let badRes3 = await bridge.handleMessage(dict: ["operation": "models"])
    assertTrue(!badRes3.success)
    assertEqual(badRes3.error, "MISSING_MESSAGE_ID")
    print("  ✓ Bridge rejected missing id")

    // --- Test 8: Bridge special characters preserved safely ---
    let specialId = "msg'test\\with\nnewline\u{2028}line_sep"
    let specialRes = await bridge.handleMessage(dict: [
        "id": specialId,
        "operation": "credential.has",
        "providerId": "omlx"
    ])
    assertEqual(specialRes.id, specialId)
    assertTrue(specialRes.success)
    print("  ✓ Bridge preserved special characters in ID safely")

    // --- Test 9: Cloud credential endpoint binding ---
    let cloudMismatchRes = await bridge.handleMessage(dict: [
        "id": "cloud-mismatch",
        "operation": "models",
        "providerId": "openai",
        "baseUrl": "http://127.0.0.1:8000/v1"
    ])
    assertTrue(!cloudMismatchRes.success)
    assertEqual(cloudMismatchRes.error, "CLOUD_CREDENTIAL_ENDPOINT_MISMATCH")
    print("  ✓ Bridge rejected cloud credential on LAN endpoint")

    // --- Test 10: Schema limits fail closed ---
    let longId = String(repeating: "x", count: 129)
    let badIdRes = await bridge.handleMessage(dict: ["id": longId, "operation": "models"])
    assertTrue(!badIdRes.success)
    assertEqual(badIdRes.error, "ID_TOO_LONG")

    let longProv = String(repeating: "p", count: 65)
    let badProvRes = await bridge.handleMessage(dict: ["id": "req-p", "operation": "models", "providerId": longProv])
    assertTrue(!badProvRes.success)
    assertEqual(badProvRes.error, "INVALID_PROVIDER_ID")

    let longModel = String(repeating: "m", count: 257)
    let badModelRes = await bridge.handleMessage(dict: [
        "id": "req-m",
        "operation": "chat",
        "model": longModel,
        "messages": [["role": "user", "content": "hi"]]
    ])
    assertTrue(!badModelRes.success)
    assertEqual(badModelRes.error, "INVALID_MODEL")

    let tooManyMsgs = (0...101).map { ["role": "user", "content": "msg \($0)"] }
    let badMsgsRes = await bridge.handleMessage(dict: [
        "id": "req-msgs",
        "operation": "chat",
        "model": "model-1",
        "messages": tooManyMsgs
    ])
    assertTrue(!badMsgsRes.success)
    assertEqual(badMsgsRes.error, "TOO_MANY_MESSAGES")

    let longContent = String(repeating: "c", count: 32001)
    let badContentRes = await bridge.handleMessage(dict: [
        "id": "req-c",
        "operation": "chat",
        "model": "model-1",
        "messages": [["role": "user", "content": longContent]]
    ])
    assertTrue(!badContentRes.success)
    assertEqual(badContentRes.error, "MESSAGE_CONTENT_TOO_LONG")

    let longCred = String(repeating: "k", count: 4097)
    let badCredRes = await bridge.handleMessage(dict: [
        "id": "req-k",
        "operation": "credential.set",
        "providerId": "omlx",
        "credential": longCred
    ])
    assertTrue(!badCredRes.success)
    assertEqual(badCredRes.error, "CREDENTIAL_TOO_LONG")
    print("  ✓ Bridge schema limits fail closed (ID/Provider/Model/Messages/Content/Credential)")

    // --- Test 11: CredentialBinding canonical isolation and normalization ---
    do {
        let k1 = try CredentialBinding.canonicalKey(providerId: "openai-compatible", baseUrl: "http://192.168.1.10:8000/v1")
        let k2 = try CredentialBinding.canonicalKey(providerId: "openai-compatible", baseUrl: "http://192.168.1.10:11434/v1")
        let k3 = try CredentialBinding.canonicalKey(providerId: "openai-compatible", baseUrl: "http://192.168.1.10:8000/v2")
        assertTrue(k1 != k2 && k1 != k3 && k2 != k3, "Ports and paths must be isolated")

        let k1Upper = try CredentialBinding.canonicalKey(providerId: "openai-compatible", baseUrl: "HTTP://192.168.1.10:8000/v1/")
        assertEqual(k1, k1Upper)

        let defPort1 = try CredentialBinding.canonicalKey(providerId: "custom", baseUrl: "http://192.168.1.10:80/v1")
        let defPort2 = try CredentialBinding.canonicalKey(providerId: "custom", baseUrl: "http://192.168.1.10/v1")
        assertEqual(defPort1, defPort2)

        print("  ✓ CredentialBinding canonical keys isolate ports, paths and normalize equivalence")
    } catch {
        assertTrue(false, "CredentialBinding test failed: \(error)")
    }

    print("\n✅ All 11 Swift test suites passed successfully!")
    exit(0)
}

dispatchMain()
