import Foundation
#if canImport(WebKit)
import WebKit
#endif

public struct BridgeResponse: Codable, Equatable {
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
        error: String? = nil
    ) {
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

    public static let appleFoundationModelProviderID = "apple-foundation-models"

    public static let allowedOperations: Set<String> = [
        "models", "chat", "credential.has", "credential.set", "credential.clear",
        "apple.status", "apple.chat", "apple.cancel"
    ]

    public static let allowedKeys: Set<String> = [
        "id", "operation", "providerId", "baseUrl", "model", "messages", "maxTokens", "credential",
        "locale", "targetRequestId"
    ]

    public static let cloudProviders: Set<String> = [
        "openai", "gemini", "anthropic", "groq", "deepseek"
    ]

    public init(
        client: LocalModelClient? = nil,
        credentials: CredentialStoreProtocol = KeychainStore(),
        appleFoundationModel: any AppleFoundationModelServicing = AppleFoundationModelService()
    ) {
        self.credentials = credentials
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
}
