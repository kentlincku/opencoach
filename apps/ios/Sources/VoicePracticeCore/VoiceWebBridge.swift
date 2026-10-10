import Foundation
#if canImport(WebKit)
import WebKit
#endif

public struct BridgeResponse: Equatable {
    public let id: String
    public let success: Bool
    public let models: [String]?
    public let text: String?
    public let hasCredential: Bool?
    public let stored: Bool?
    public let cleared: Bool?
    public let available: Bool?
    public let availability: String?
    public let contextVersion: Int?
    public let error: String?
    public var subscription: [String: Any]? = nil

    public static func == (lhs: BridgeResponse, rhs: BridgeResponse) -> Bool {
        lhs.id == rhs.id && lhs.success == rhs.success && lhs.models == rhs.models && lhs.text == rhs.text
            && lhs.hasCredential == rhs.hasCredential && lhs.stored == rhs.stored && lhs.cleared == rhs.cleared
            && lhs.available == rhs.available && lhs.availability == rhs.availability
            && lhs.contextVersion == rhs.contextVersion && lhs.error == rhs.error
            && NSDictionary(dictionary: lhs.subscription ?? [:]).isEqual(to: rhs.subscription ?? [:])
    }

    public init(
        id: String,
        success: Bool,
        models: [String]? = nil,
        text: String? = nil,
        hasCredential: Bool? = nil,
        stored: Bool? = nil,
        cleared: Bool? = nil,
        available: Bool? = nil,
        availability: String? = nil,
        contextVersion: Int? = nil,
        error: String? = nil,
        subscription: [String: Any]? = nil
    ) {
        self.subscription = subscription
        self.id = id
        self.success = success
        self.models = models
        self.text = text
        self.hasCredential = hasCredential
        self.stored = stored
        self.cleared = cleared
        self.available = available
        self.availability = availability
        self.contextVersion = contextVersion
        self.error = error
    }
}

// The concrete VoiceWebBridge is intentionally behind this protocol so that
// ScriptBridgeHandler can be exercised in tests with a controllable in-flight
// delay (see packet P3: real navigation-away during an in-flight bridge
// operation). Production always passes a real VoiceWebBridge(); tests pass a
// bridge whose handleMessage() blocks on a gate they control.
public protocol VoiceBridgeContract {
    func handleMessage(dict: [String: Any]) async -> BridgeResponse
}

public final class VoiceWebBridge: VoiceBridgeContract {
    private let client: LocalModelClient
    private let credentials: CredentialStoreProtocol
    private let appleFoundationModel: any AppleFoundationModelServicing
    private let subscriptionAuth: SubscriptionAuth
    private let subscriptionClient: SubscriptionClient
    private let openURL: (URL) async -> Void

    public static let appleFoundationModelProviderID = "apple-foundation-models"

    public static let allowedOperations: Set<String> = [
        "models", "chat", "credential.has", "credential.set", "credential.clear",
        "apple.status", "apple.chat", "apple.cancel",
        "subscription.begin", "subscription.poll", "subscription.complete", "subscription.cancel",
        "subscription.status", "subscription.logout"
    ]

    public static let allowedKeys: Set<String> = [
        "id", "operation", "providerId", "baseUrl", "model", "messages", "maxTokens", "credential",
        "locale", "targetRequestId", "loginId", "code"
    ]

    public static let cloudProviders: Set<String> = [
        "openai", "gemini", "anthropic", "groq", "deepseek"
    ]

    public init(
        client: LocalModelClient? = nil,
        credentials: CredentialStoreProtocol = KeychainStore(),
        appleFoundationModel: any AppleFoundationModelServicing = AppleFoundationModelService(),
        subscriptionHTTP: SubscriptionHTTP = URLSessionSubscriptionHTTP(),
        openURL: @escaping (URL) async -> Void = { _ in }
    ) {
        self.credentials = credentials
        self.subscriptionAuth = SubscriptionAuth(credentials: credentials, http: subscriptionHTTP)
        self.subscriptionClient = SubscriptionClient(auth: subscriptionAuth, http: subscriptionHTTP)
        self.openURL = openURL
        self.client = client ?? LocalModelClient(credentials: credentials)
        self.appleFoundationModel = appleFoundationModel
    }

    public func handleMessage(jsonString: String) async -> BridgeResponse {
        guard let data = jsonString.data(using: .utf8) else {
            return BridgeResponse(id: "unknown", success: false, error: "INVALID_JSON_MESSAGE")
        }
        guard data.count <= LocalModelClient.maxBytes else {
            return BridgeResponse(id: "unknown", success: false, error: "REQUEST_TOO_LARGE")
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return BridgeResponse(id: "unknown", success: false, error: "INVALID_JSON_MESSAGE")
        }
        return await handleMessage(dict: json)
    }

    public func handleMessage(dict: [String: Any]) async -> BridgeResponse {
        guard JSONSerialization.isValidJSONObject(dict),
              let encodedPayload = try? JSONSerialization.data(withJSONObject: dict),
              encodedPayload.count <= LocalModelClient.maxBytes else {
            return BridgeResponse(id: "unknown", success: false, error: "REQUEST_TOO_LARGE")
        }
        guard let id = dict["id"] as? String, !id.isEmpty else {
            return BridgeResponse(id: "unknown", success: false, error: "MISSING_MESSAGE_ID")
        }
        guard id.count <= 128 else {
            return BridgeResponse(id: "unknown", success: false, error: "ID_TOO_LONG")
        }

        guard let operation = dict["operation"] as? String, Self.allowedOperations.contains(operation) else {
            return BridgeResponse(id: id, success: false, error: "UNSUPPORTED_OPERATION")
        }

        // Validate the schema only after the operation has been allowlisted. This keeps
        // unsupported operations fail-closed without exposing per-operation key parsing.
        for key in dict.keys {
            if !Self.allowedKeys.contains(key) {
                return BridgeResponse(id: id, success: false, error: "FORBIDDEN_PROPERTY_\(key)")
            }
        }

        let rawProviderId = dict["providerId"] as? String ?? "openai-compatible"
        guard rawProviderId.count <= 64 else {
            return BridgeResponse(id: id, success: false, error: "INVALID_PROVIDER_ID")
        }
        let providerId = rawProviderId.lowercased()

        if operation.hasPrefix("subscription.") {
            return await handleSubscriptionMessage(id: id, operation: operation, providerId: providerId, dict: dict)
        }
        if SubscriptionProvider(rawValue: providerId) != nil {
            // Subscription tokens are never reachable through credential.* ; models/chat route to the subscription client.
            if operation.hasPrefix("credential.") {
                return BridgeResponse(id: id, success: false, error: "PROVIDER_NOT_ALLOWED")
            }
            return await handleSubscriptionInference(id: id, operation: operation, providerId: providerId, dict: dict)
        }

        if operation.hasPrefix("apple.") {
            return await handleAppleFoundationModelMessage(
                id: id,
                operation: operation,
                providerId: providerId,
                dict: dict
            )
        }
        guard providerId != Self.appleFoundationModelProviderID else {
            return BridgeResponse(id: id, success: false, error: "APPLE_MODEL_INVALID_OPERATION")
        }

        let rawBaseUrl = dict["baseUrl"] as? String ?? "http://127.0.0.1:8000/v1"
        guard rawBaseUrl.count <= 2048 else {
            return BridgeResponse(id: id, success: false, error: "INVALID_BASE_URL")
        }

        do {
            switch operation {
            case "models":
                let models = try await client.fetchModels(baseUrl: rawBaseUrl, providerId: providerId)
                return BridgeResponse(id: id, success: true, models: models)

            case "chat":
                guard let model = dict["model"] as? String, !model.isEmpty else {
                    return BridgeResponse(id: id, success: false, error: "MISSING_MODEL")
                }
                guard model.count <= 256 else {
                    return BridgeResponse(id: id, success: false, error: "INVALID_MODEL")
                }
                guard let rawMessages = dict["messages"] as? [[String: Any]] else {
                    return BridgeResponse(id: id, success: false, error: "MISSING_MESSAGES")
                }
                guard !rawMessages.isEmpty else {
                    return BridgeResponse(id: id, success: false, error: "EMPTY_MESSAGES")
                }
                guard rawMessages.count <= 100 else {
                    return BridgeResponse(id: id, success: false, error: "TOO_MANY_MESSAGES")
                }

                var messages: [ChatMessage] = []
                for msg in rawMessages {
                    guard let role = msg["role"] as? String,
                          ["system", "user", "assistant"].contains(role) else {
                        return BridgeResponse(id: id, success: false, error: "MALFORMED_MESSAGES")
                    }
                    guard let content = msg["content"] as? String else {
                        return BridgeResponse(id: id, success: false, error: "MALFORMED_MESSAGES")
                    }
                    guard content.count <= 32000 else {
                        return BridgeResponse(id: id, success: false, error: "MESSAGE_CONTENT_TOO_LONG")
                    }
                    messages.append(ChatMessage(role: role, content: content))
                }

                let maxTokens = dict["maxTokens"] as? Int ?? 300
                guard maxTokens >= 1 && maxTokens <= 4096 else {
                    return BridgeResponse(id: id, success: false, error: "INVALID_MAX_TOKENS")
                }

                let text = try await client.chat(
                    baseUrl: rawBaseUrl,
                    providerId: providerId,
                    model: model,
                    messages: messages,
                    maxTokens: maxTokens
                )
                return BridgeResponse(id: id, success: true, text: text)

            case "credential.has":
                let canonicalKey = try CredentialBinding.canonicalKey(providerId: providerId, baseUrl: rawBaseUrl)
                let has = credentials.has(key: canonicalKey)
                return BridgeResponse(id: id, success: true, hasCredential: has)

            case "credential.set":
                guard let credential = dict["credential"] as? String, !credential.isEmpty else {
                    return BridgeResponse(id: id, success: false, error: "INVALID_CREDENTIAL")
                }
                guard credential.count <= 4096 else {
                    return BridgeResponse(id: id, success: false, error: "CREDENTIAL_TOO_LONG")
                }
                let canonicalKey = try CredentialBinding.canonicalKey(providerId: providerId, baseUrl: rawBaseUrl)
                try credentials.set(key: canonicalKey, value: credential)
                return BridgeResponse(id: id, success: true, stored: true)

            case "credential.clear":
                let canonicalKey = try CredentialBinding.canonicalKey(providerId: providerId, baseUrl: rawBaseUrl)
                try credentials.clear(key: canonicalKey)
                return BridgeResponse(id: id, success: true, cleared: true)

            default:
                return BridgeResponse(id: id, success: false, error: "UNSUPPORTED_OPERATION")
            }
        } catch let localErr as LocalModelError {
            return BridgeResponse(id: id, success: false, error: localErr.errorCode)
        } catch let urlErr as URLError {
            // Surface the network cause (e.g. local-network permission denied, ATS, timeout) without details.
            return BridgeResponse(id: id, success: false, error: "NETWORK_ERROR_\(abs(urlErr.code.rawValue))")
        } catch {
            return BridgeResponse(id: id, success: false, error: "BRIDGE_EXECUTION_ERROR")
        }
    }

    private func handleAppleFoundationModelMessage(
        id: String,
        operation: String,
        providerId: String,
        dict: [String: Any]
    ) async -> BridgeResponse {
        guard providerId == Self.appleFoundationModelProviderID else {
            return BridgeResponse(id: id, success: false, error: "APPLE_MODEL_INVALID_PROVIDER")
        }
        let allowedKeysByOperation: [String: Set<String>] = [
            "apple.status": ["id", "operation", "providerId", "locale"],
            "apple.chat": ["id", "operation", "providerId", "messages", "maxTokens", "locale"],
            "apple.cancel": ["id", "operation", "providerId", "targetRequestId"]
        ]
        guard let operationKeys = allowedKeysByOperation[operation] else {
            return BridgeResponse(id: id, success: false, error: "UNSUPPORTED_OPERATION")
        }
        for key in dict.keys where !operationKeys.contains(key) {
            return BridgeResponse(id: id, success: false, error: "APPLE_MODEL_FORBIDDEN_PROPERTY_\(key)")
        }

        let locale = dict["locale"] as? String ?? "en-US"
        guard !locale.isEmpty, locale.count <= 64 else {
            return BridgeResponse(id: id, success: false, error: "APPLE_MODEL_INVALID_LOCALE")
        }

        do {
            switch operation {
            case "apple.status":
                let status = await appleFoundationModel.availability(localeIdentifier: locale)
                return BridgeResponse(
                    id: id,
                    success: true,
                    available: status.available,
                    availability: status.code,
                    contextVersion: AppleFoundationModelService.contextVersion
                )
            case "apple.chat":
                guard let rawMessages = dict["messages"] as? [[String: Any]], !rawMessages.isEmpty else {
                    return BridgeResponse(id: id, success: false, error: "APPLE_MODEL_INVALID_PAYLOAD")
                }
                guard rawMessages.count <= AppleFoundationModelService.maxMessages else {
                    return BridgeResponse(id: id, success: false, error: "APPLE_MODEL_INPUT_TOO_LARGE")
                }
                var messages: [ChatMessage] = []
                for raw in rawMessages {
                    guard Set(raw.keys) == Set(["role", "content"]),
                          let role = raw["role"] as? String,
                          let content = raw["content"] as? String else {
                        return BridgeResponse(id: id, success: false, error: "APPLE_MODEL_INVALID_PAYLOAD")
                    }
                    messages.append(ChatMessage(role: role, content: content))
                }
                let maxTokens = dict["maxTokens"] as? Int ?? 300
                let reply = try await appleFoundationModel.chat(
                    requestID: id,
                    messages: messages,
                    localeIdentifier: locale,
                    maxTokens: maxTokens
                )
                return BridgeResponse(
                    id: id,
                    success: true,
                    text: reply.text,
                    contextVersion: reply.contextVersion
                )
            case "apple.cancel":
                guard let target = dict["targetRequestId"] as? String,
                      !target.isEmpty,
                      target.count <= 128 else {
                    return BridgeResponse(id: id, success: false, error: "APPLE_MODEL_INVALID_CANCEL_TARGET")
                }
                await appleFoundationModel.cancel(requestID: target)
                return BridgeResponse(id: id, success: true, cleared: true)
            default:
                return BridgeResponse(id: id, success: false, error: "UNSUPPORTED_OPERATION")
            }
        } catch let error as AppleFoundationModelError {
            return BridgeResponse(id: id, success: false, error: error.errorCode)
        } catch {
            return BridgeResponse(id: id, success: false, error: "APPLE_MODEL_SESSION_ERROR")
        }
    }

    private func handleSubscriptionMessage(id: String, operation: String, providerId: String, dict: [String: Any]) async -> BridgeResponse {
        let keys: [String: Set<String>] = [
            "subscription.begin": ["id", "operation", "providerId"],
            "subscription.poll": ["id", "operation", "loginId"],
            "subscription.complete": ["id", "operation", "loginId", "code"],
            "subscription.cancel": ["id", "operation", "loginId"],
            "subscription.status": ["id", "operation", "providerId"],
            "subscription.logout": ["id", "operation", "providerId"],
        ]
        guard let allowed = keys[operation] else { return BridgeResponse(id: id, success: false, error: "UNSUPPORTED_OPERATION") }
        for key in dict.keys where !allowed.contains(key) {
            return BridgeResponse(id: id, success: false, error: "FORBIDDEN_PROPERTY_\(key)")
        }
        let loginId = dict["loginId"] as? String ?? ""
        if allowed.contains("loginId") && (loginId.isEmpty || loginId.count > 64) {
            return BridgeResponse(id: id, success: false, error: "INVALID_SUBSCRIPTION_REQUEST")
        }
        do {
            switch operation {
            case "subscription.begin":
                let start = try await subscriptionAuth.beginLogin(providerId)
                await openURL(start.verificationURL)
                // The authorize URL (PKCE state) stays native; JS only gets display data.
                var info: [String: Any] = ["loginId": start.loginId, "mode": start.mode,
                                           "verificationHost": start.verificationURL.host ?? ""]
                if let code = start.userCode { info["userCode"] = code }
                if let interval = start.interval { info["interval"] = interval }
                return BridgeResponse(id: id, success: true, subscription: info)
            case "subscription.poll":
                let done = try await subscriptionAuth.pollLogin(loginId)
                return BridgeResponse(id: id, success: true, subscription: ["state": done ? "complete" : "pending"])
            case "subscription.complete":
                guard let code = dict["code"] as? String else { return BridgeResponse(id: id, success: false, error: "INVALID_AUTH_CODE") }
                try await subscriptionAuth.completeLogin(loginId, code: code)
                return BridgeResponse(id: id, success: true, subscription: ["state": "complete"])
            case "subscription.cancel":
                subscriptionAuth.cancelLogin(loginId)
                return BridgeResponse(id: id, success: true, cleared: true)
            case "subscription.status":
                let status = try subscriptionAuth.status(providerId)
                return BridgeResponse(id: id, success: true, subscription: ["providerId": providerId,
                    "loggedIn": status.loggedIn, "canRefresh": status.canRefresh])
            case "subscription.logout":
                try subscriptionAuth.logout(providerId)
                return BridgeResponse(id: id, success: true, cleared: true)
            default:
                return BridgeResponse(id: id, success: false, error: "UNSUPPORTED_OPERATION")
            }
        } catch let error as SubscriptionError {
            return BridgeResponse(id: id, success: false, error: error.code)
        } catch let urlErr as URLError {
            return BridgeResponse(id: id, success: false, error: "NETWORK_ERROR_\(abs(urlErr.code.rawValue))")
        } catch {
            return BridgeResponse(id: id, success: false, error: "BRIDGE_EXECUTION_ERROR")
        }
    }

    private func handleSubscriptionInference(id: String, operation: String, providerId: String, dict: [String: Any]) async -> BridgeResponse {
        do {
            switch operation {
            case "models":
                return BridgeResponse(id: id, success: true, models: try await subscriptionClient.models(providerId))
            case "chat":
                guard let model = dict["model"] as? String, !model.isEmpty, model.count <= 256 else {
                    return BridgeResponse(id: id, success: false, error: "INVALID_MODEL")
                }
                guard let raw = dict["messages"] as? [[String: Any]], !raw.isEmpty, raw.count <= 100 else {
                    return BridgeResponse(id: id, success: false, error: "MALFORMED_MESSAGES")
                }
                var messages: [ChatMessage] = []
                for msg in raw {
                    guard let role = msg["role"] as? String, ["system", "user", "assistant"].contains(role),
                          let content = msg["content"] as? String, content.count <= 32000 else {
                        return BridgeResponse(id: id, success: false, error: "MALFORMED_MESSAGES")
                    }
                    messages.append(ChatMessage(role: role, content: content))
                }
                let maxTokens = dict["maxTokens"] as? Int ?? 300
                guard maxTokens >= 1 && maxTokens <= 4096 else {
                    return BridgeResponse(id: id, success: false, error: "INVALID_MAX_TOKENS")
                }
                let text = try await subscriptionClient.chat(providerId, model: model, messages: messages, maxTokens: maxTokens)
                return BridgeResponse(id: id, success: true, text: text)
            default:
                return BridgeResponse(id: id, success: false, error: "UNSUPPORTED_OPERATION")
            }
        } catch let error as SubscriptionError {
            return BridgeResponse(id: id, success: false, error: error.code)
        } catch let urlErr as URLError {
            return BridgeResponse(id: id, success: false, error: "NETWORK_ERROR_\(abs(urlErr.code.rawValue))")
        } catch {
            return BridgeResponse(id: id, success: false, error: "BRIDGE_EXECUTION_ERROR")
        }
    }
}
