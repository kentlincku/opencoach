import Foundation

public enum LocalModelError: LocalizedError, Equatable {
    case invalidEndpoint(String)
    case unsafeScheme(String)
    case credentialsInURL
    case publicHttpNotAllowed(String)
    case endpointHostDisallowed(String)
    case cloudCredentialEndpointMismatch(provider: String, host: String)
    case requestTooLarge
    case responseTooLarge
    case requestTimeout
    case redirectNotAllowed
    case httpError(Int)
    case invalidResponse
    case emptyModelList
    case invalidModel
    case invalidMessages

    public var errorCode: String {
        switch self {
        case .invalidEndpoint: return "INVALID_ENDPOINT"
        case .unsafeScheme: return "UNSAFE_SCHEME"
        case .credentialsInURL: return "CREDENTIALS_IN_URL"
        case .publicHttpNotAllowed: return "PUBLIC_HTTP_FORBIDDEN"
        case .endpointHostDisallowed: return "ENDPOINT_HOST_DISALLOWED"
        case .cloudCredentialEndpointMismatch: return "CLOUD_CREDENTIAL_ENDPOINT_MISMATCH"
        case .requestTooLarge: return "REQUEST_TOO_LARGE"
        case .responseTooLarge: return "RESPONSE_TOO_LARGE"
        case .requestTimeout: return "REQUEST_TIMEOUT"
        case .redirectNotAllowed: return "REDIRECT_REJECTED"
        case .httpError(let code): return "HTTP_ERROR_\(code)"
        case .invalidResponse: return "INVALID_RESPONSE"
        case .emptyModelList: return "EMPTY_MODEL_LIST"
        case .invalidModel: return "INVALID_MODEL"
        case .invalidMessages: return "INVALID_MESSAGES"
        }
    }

    public var errorDescription: String? {
        switch self {
        case .invalidEndpoint(let msg): return "Invalid endpoint: \(msg)"
        case .unsafeScheme(let scheme): return "Unsafe scheme: \(scheme)"
        case .credentialsInURL: return "Credentials in URL are forbidden"
        case .publicHttpNotAllowed(let host): return "Cleartext HTTP is forbidden for public host: \(host)"
        case .endpointHostDisallowed(let host): return "Endpoint host is not in allowlist: \(host)"
        case .cloudCredentialEndpointMismatch(let provider, let host): return "Cloud credential for \(provider) cannot be sent to endpoint: \(host)"
        case .requestTooLarge: return "Request payload exceeds maximum allowed size (1 MB)"
        case .responseTooLarge: return "Response payload exceeds maximum allowed size (1 MB)"
        case .requestTimeout: return "Model request timed out"
        case .redirectNotAllowed: return "HTTP redirects are rejected for model requests"
        case .httpError(let code): return "Model server responded with HTTP \(code)"
        case .invalidResponse: return "Invalid response from model endpoint"
        case .emptyModelList: return "Model endpoint returned an empty model list"
        case .invalidModel: return "Invalid or missing model identifier"
        case .invalidMessages: return "Invalid or empty conversation messages"
        }
    }
}

public struct ChatMessage: Codable, Equatable {
    public let role: String
    public let content: String

    public init(role: String, content: String) {
        self.role = role
        self.content = content
    }
}

public struct ChatRequestPayload: Codable, Equatable {
    public let model: String
    public let messages: [ChatMessage]
    public let maxTokens: Int?

    enum CodingKeys: String, CodingKey {
        case model
        case messages
        case maxTokens = "max_tokens"
    }

    public init(model: String, messages: [ChatMessage], maxTokens: Int? = 300) {
        self.model = model
        self.messages = messages
        self.maxTokens = maxTokens
    }
}

private final class StreamingTaskDelegate: NSObject, URLSessionDataDelegate {
    let maxBytes: Int
    private var accumulatedData = Data()
    private var response: URLResponse?
    private var exceeded = false
    private var completion: ((Result<(Data, URLResponse), Error>) -> Void)?

    init(maxBytes: Int, completion: @escaping (Result<(Data, URLResponse), Error>) -> Void) {
        self.maxBytes = maxBytes
        self.completion = completion
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        self.response = response
        if let http = response as? HTTPURLResponse, (300...399).contains(http.statusCode) {
            completionHandler(.cancel)
            return
        }
        if response.expectedContentLength > Int64(maxBytes) {
            exceeded = true
            completionHandler(.cancel)
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        accumulatedData.append(data)
        if accumulatedData.count > maxBytes {
            exceeded = true
            dataTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let finish = completion else { return }
        completion = nil

        if let resp = response as? HTTPURLResponse, (300...399).contains(resp.statusCode) {
            finish(.failure(LocalModelError.redirectNotAllowed))
            return
        }
        if exceeded {
            finish(.failure(LocalModelError.responseTooLarge))
            return
        }
        if let error = error {
            if let urlErr = error as? URLError {
                if urlErr.code == .timedOut {
                    finish(.failure(LocalModelError.requestTimeout))
                    return
                }
                if urlErr.code == .httpTooManyRedirects || (urlErr.code == .cancelled && exceeded) {
                    finish(.failure(exceeded ? LocalModelError.responseTooLarge : LocalModelError.redirectNotAllowed))
                    return
                }
            }
            finish(.failure(error))
            return
        }
        guard let resp = response else {
            finish(.failure(LocalModelError.invalidResponse))
            return
        }
        if let http = resp as? HTTPURLResponse, (300...399).contains(http.statusCode) {
            finish(.failure(LocalModelError.redirectNotAllowed))
            return
        }
        finish(.success((accumulatedData, resp)))
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // Strict: fail closed on redirection
        completionHandler(nil)
    }
}

public final class LocalModelClient {
    public static let maxBytes = 1024 * 1024 // 1 MB
    public static let defaultTimeout: TimeInterval = 15.0

    private let sessionConfiguration: URLSessionConfiguration
    private let credentials: CredentialStoreProtocol

    public static let allowedHttpsHosts: Set<String> = [
        "api.openai.com",
        "generativelanguage.googleapis.com",
        "api.anthropic.com",
        "api.groq.com",
        "api.deepseek.com"
    ]

    public static let cloudProviderHosts: [String: String] = [
        "openai": "api.openai.com",
        "gemini": "generativelanguage.googleapis.com",
        "anthropic": "api.anthropic.com",
        "groq": "api.groq.com",
        "deepseek": "api.deepseek.com"
    ]

    public init(
        credentials: CredentialStoreProtocol = KeychainStore(),
        timeout: TimeInterval = defaultTimeout,
        sessionConfiguration: URLSessionConfiguration? = nil
    ) {
        self.credentials = credentials
        let config = sessionConfiguration ?? URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        self.sessionConfiguration = config
    }

    public static func validateEndpoint(urlString: String, providerId: String? = nil) throws -> URL {
        guard let url = URL(string: urlString.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased() else {
            throw LocalModelError.invalidEndpoint("Malformed URL")
        }

        guard scheme == "http" || scheme == "https" else {
            throw LocalModelError.unsafeScheme(scheme)
        }

        guard let host = url.host?.lowercased(), !host.isEmpty else {
            throw LocalModelError.invalidEndpoint("Missing host in URL")
        }

        if url.user != nil || url.password != nil {
            throw LocalModelError.credentialsInURL
        }

        let isLan = isLocalOrLanHost(host)

        if scheme == "http" {
            guard isLan else {
                throw LocalModelError.publicHttpNotAllowed(host)
            }
        } else if scheme == "https" {
            guard isLan || allowedHttpsHosts.contains(host) else {
                throw LocalModelError.endpointHostDisallowed(host)
            }
        }

        // Endpoint binding check: cloud credentials cannot be sent to LAN or other cloud endpoints
        if let provider = providerId?.lowercased() {
            if let expectedHost = cloudProviderHosts[provider] {
                if host != expectedHost {
                    throw LocalModelError.cloudCredentialEndpointMismatch(provider: provider, host: host)
                }
            } else if !isLan && !allowedHttpsHosts.contains(host) {
                throw LocalModelError.endpointHostDisallowed(host)
            }
        }

        return url
    }

    public static func isLocalOrLanHost(_ rawHost: String) -> Bool {
        let host = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if host == "localhost" || host == "127.0.0.1" || host == "::1" {
            return true
        }
        if host.hasSuffix(".local") {
            return true
        }

        // IPv4 check
        let parts = host.split(separator: ".").compactMap { Int($0) }
        if parts.count == 4 && parts.allSatisfy({ $0 >= 0 && $0 <= 255 }) {
            let a = parts[0], b = parts[1]
            if a == 127 { return true } // Loopback
            if a == 10 { return true } // RFC1918 Class A
            if a == 172 && (b >= 16 && b <= 31) { return true } // RFC1918 Class B
            if a == 192 && b == 168 { return true } // RFC1918 Class C
            if a == 169 && b == 254 { return true } // Link-local
            return false // Public IPv4
        }

        // IPv6 check
        let lower = host.lowercased()
        if lower.hasPrefix("fe80:") { return true } // Link-local IPv6
        if lower.hasPrefix("fc") || lower.hasPrefix("fd") { return true } // ULA IPv6

        return false
    }

    public func fetchModels(baseUrl: String, providerId: String? = nil) async throws -> [String] {
        let base = try Self.validateEndpoint(urlString: baseUrl, providerId: providerId)
        let modelsUrl = base.appendingPathComponent("models")
        var request = URLRequest(url: modelsUrl)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        if let pId = providerId,
           let canonicalKey = try? CredentialBinding.canonicalKey(providerId: pId, baseUrl: baseUrl),
           let key = try? credentials.get(key: canonicalKey), !key.isEmpty {
            request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        }

        let (data, response) = try await execute(request: request)
        guard let http = response as? HTTPURLResponse else {
            throw LocalModelError.invalidResponse
        }
        guard (200...299).contains(http.statusCode) else {
            throw LocalModelError.httpError(http.statusCode)
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw LocalModelError.invalidResponse
        }

        var modelIds: [String] = []
        if let dataList = json["data"] as? [[String: Any]] {
            modelIds = dataList.compactMap { $0["id"] as? String ?? $0["name"] as? String }
        } else if let modelsList = json["models"] as? [Any] {
            modelIds = modelsList.compactMap { item in
                if let s = item as? String { return s }
                if let dict = item as? [String: Any] { return dict["id"] as? String ?? dict["name"] as? String }
                return nil
            }
        }

        let filtered = modelIds.filter { id in
            !id.isEmpty && id.count <= 256
        }

        guard !filtered.isEmpty else {
            throw LocalModelError.emptyModelList
        }
        return filtered
    }

    public func chat(
        baseUrl: String,
        providerId: String? = nil,
        model: String,
        messages: [ChatMessage],
        maxTokens: Int = 300
    ) async throws -> String {
        guard !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, model.count <= 256 else {
            throw LocalModelError.invalidModel
        }
        guard !messages.isEmpty, messages.count <= 100 else {
            throw LocalModelError.invalidMessages
        }
        for msg in messages {
            guard msg.content.count <= 32000 else {
                throw LocalModelError.invalidMessages
            }
        }

        let base = try Self.validateEndpoint(urlString: baseUrl, providerId: providerId)
        let chatUrl = base.appendingPathComponent("chat/completions")
        var request = URLRequest(url: chatUrl)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        if let pId = providerId,
           let canonicalKey = try? CredentialBinding.canonicalKey(providerId: pId, baseUrl: baseUrl),
           let key = try? credentials.get(key: canonicalKey), !key.isEmpty {
            request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        }

        let boundedTokens = min(max(maxTokens, 1), 4096)
        let payload = ChatRequestPayload(model: model, messages: messages, maxTokens: boundedTokens)
        let bodyData = try JSONEncoder().encode(payload)
        guard bodyData.count <= Self.maxBytes else {
            throw LocalModelError.requestTooLarge
        }
        request.httpBody = bodyData

        let (data, response) = try await execute(request: request)
        guard let http = response as? HTTPURLResponse else {
            throw LocalModelError.invalidResponse
        }
        guard (200...299).contains(http.statusCode) else {
            throw LocalModelError.httpError(http.statusCode)
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let choices = json["choices"] as? [[String: Any]],
              let first = choices.first,
              let message = first["message"] as? [String: Any],
              let text = message["content"] as? String, !text.isEmpty else {
            throw LocalModelError.invalidResponse
        }

        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func execute(request: URLRequest) async throws -> (Data, URLResponse) {
        return try await withCheckedThrowingContinuation { continuation in
            let delegate = StreamingTaskDelegate(maxBytes: Self.maxBytes) { result in
                switch result {
                case .success(let val):
                    continuation.resume(returning: val)
                case .failure(let err):
                    continuation.resume(throwing: err)
                }
            }
            let session = URLSession(configuration: self.sessionConfiguration, delegate: delegate, delegateQueue: nil)
            let task = session.dataTask(with: request)
            task.resume()
        }
    }
}
