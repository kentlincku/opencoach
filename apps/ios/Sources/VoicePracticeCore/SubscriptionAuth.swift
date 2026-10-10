import Foundation
import CryptoKit

// Subscription login (ChatGPT/Codex, Claude Pro/Max, Grok) using the official CLIs'
// public OAuth clients — same approach as the Desktop
// subscription-auth.cjs. Personal use only; see docs/SUBSCRIPTION_LOGIN_SPEC.md.
// Tokens live only in the Keychain; the WebView never receives them.

public enum SubscriptionError: Error, Equatable {
    case providerNotAllowed, unsafeEndpoint, rateLimited, deviceCodeFailed, pollFailed, denied
    case tokenExchangeFailed, loginNotFound, loginExpired, stateMismatch, invalidCode
    case loginRequiresCode, loginDoesNotAcceptCode, loginRequired, refreshFailed, discoveryFailed
    case http(Int), invalidResponse, streamFailed, notEntitled

    public var code: String {
        switch self {
        case .providerNotAllowed: return "PROVIDER_NOT_ALLOWED"
        case .unsafeEndpoint: return "UNSAFE_AUTH_ENDPOINT"
        case .rateLimited: return "AUTH_RATE_LIMITED"
        case .deviceCodeFailed: return "AUTH_DEVICE_CODE_FAILED"
        case .pollFailed: return "AUTH_POLL_FAILED"
        case .denied: return "AUTH_DENIED"
        case .tokenExchangeFailed: return "AUTH_TOKEN_EXCHANGE_FAILED"
        case .loginNotFound: return "LOGIN_NOT_FOUND"
        case .loginExpired: return "LOGIN_EXPIRED"
        case .stateMismatch: return "AUTH_STATE_MISMATCH"
        case .invalidCode: return "INVALID_AUTH_CODE"
        case .loginRequiresCode: return "LOGIN_REQUIRES_CODE"
        case .loginDoesNotAcceptCode: return "LOGIN_DOES_NOT_ACCEPT_CODE"
        case .loginRequired: return "SUBSCRIPTION_LOGIN_REQUIRED"
        case .refreshFailed: return "AUTH_REFRESH_FAILED"
        case .discoveryFailed: return "AUTH_DISCOVERY_FAILED"
        case .http(let status): return "PROVIDER_HTTP_\(status)"
        case .invalidResponse: return "INVALID_PROVIDER_RESPONSE"
        case .streamFailed: return "PROVIDER_STREAM_FAILED"
        case .notEntitled: return "SUBSCRIPTION_NOT_ENTITLED"
        }
    }
}

public struct SubscriptionLoginStart: Equatable {
    public let loginId: String
    public let mode: String          // "device" | "paste"
    public let userCode: String?
    public let verificationURL: URL
    public let interval: Int?
}

/// Abstracts HTTP so tests can inject canned responses.
public protocol SubscriptionHTTP {
    func send(_ request: URLRequest) async throws -> (Int, Data)
}

private final class NoRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

public final class URLSessionSubscriptionHTTP: SubscriptionHTTP {
    private let session: URLSession
    public static let maxBytes = 4 * 1024 * 1024

    public init(timeout: TimeInterval = 60) {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout
        session = URLSession(configuration: config, delegate: NoRedirectDelegate(), delegateQueue: nil)
    }

    public func send(_ request: URLRequest) async throws -> (Int, Data) {
        let (data, response) = try await session.data(for: request)
        guard data.count <= Self.maxBytes else { throw SubscriptionError.invalidResponse }
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }
}

public enum SubscriptionProvider: String, CaseIterable {
    case chatgpt = "chatgpt-subscription"
    case grok = "grok-subscription"
    case claude = "claude-subscription"

    var clientId: String {
        switch self {
        case .chatgpt: return "app_EMoamEEZ73f0CkXaXp7hrann"
        case .grok: return "b1a00492-073a-47ea-816f-4c329264a828"
        case .claude: return "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
        }
    }

    var refreshSkew: TimeInterval {
        switch self {
        case .chatgpt: return 120
        case .grok: return 3600
        case .claude: return 300
        }
    }

    var keychainKey: String { "subscription:\(rawValue)" }
}

public final class SubscriptionAuth {
    static let allowedAuthHosts: Set<String> = ["auth.openai.com", "auth.x.ai", "platform.claude.com", "console.anthropic.com"]
    static let allowedLoginHosts: Set<String> = ["auth.openai.com", "accounts.x.ai", "auth.x.ai", "claude.ai"]
    static let claudeRedirect = "https://console.anthropic.com/oauth/code/callback"
    static let claudeTokenURLs = ["https://platform.claude.com/v1/oauth/token", "https://console.anthropic.com/v1/oauth/token"]
    static let loginTTL: TimeInterval = 15 * 60

    private struct PendingLogin {
        let provider: SubscriptionProvider
        let expiresAt: Date
        var deviceAuthId: String?
        var userCode: String?
        var deviceCode: String?
        var verifier: String?
        var state: String?
    }

    struct TokenRecord: Codable {
        var accessToken: String
        var refreshToken: String?
        var expiresAt: Double   // epoch seconds
    }

    private let credentials: CredentialStoreProtocol
    private let http: SubscriptionHTTP
    private let now: () -> Date
    private let lock = NSLock()
    private var logins: [String: PendingLogin] = [:]
    private var refreshing: [SubscriptionProvider: Task<TokenRecord, Error>] = [:]
    private var xaiTokenURL: String?

    public init(credentials: CredentialStoreProtocol, http: SubscriptionHTTP = URLSessionSubscriptionHTTP(),
                now: @escaping () -> Date = Date.init) {
        self.credentials = credentials
        self.http = http
        self.now = now
    }

    public static func provider(_ id: String) throws -> SubscriptionProvider {
        guard let provider = SubscriptionProvider(rawValue: id) else { throw SubscriptionError.providerNotAllowed }
        return provider
    }

    // MARK: HTTP helpers

    private func request(_ url: String, method: String = "POST", headers: [String: String] = [:], body: Data? = nil,
                         allowedHosts: Set<String> = SubscriptionAuth.allowedAuthHosts) async throws -> (Int, [String: Any]) {
        guard let parsed = URL(string: url), parsed.scheme == "https", let host = parsed.host,
              allowedHosts.contains(host) else { throw SubscriptionError.unsafeEndpoint }
        var req = URLRequest(url: parsed)
        req.httpMethod = method
        headers.forEach { req.setValue($1, forHTTPHeaderField: $0) }
        req.httpBody = body
        let (status, data) = try await http.send(req)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        return (status, json)
    }

    private static func form(_ pairs: [String: String]) -> Data {
        var comps = URLComponents()
        comps.queryItems = pairs.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        let encoded = (comps.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
        return Data(encoded.utf8)
    }

    private static func json(_ object: [String: String]) -> Data {
        (try? JSONSerialization.data(withJSONObject: object)) ?? Data()
    }

    static func b64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func randomBytes(_ count: Int) -> Data {
        var bytes = [UInt8](repeating: 0, count: count)
        _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        return Data(bytes)
    }

    // MARK: Login

    public func beginLogin(_ providerId: String) async throws -> SubscriptionLoginStart {
        let provider = try Self.provider(providerId)
        let loginId = UUID().uuidString
        let expires = now().addingTimeInterval(Self.loginTTL)
        lock.withLock { logins = logins.filter { $0.value.provider != provider } }

        switch provider {
        case .chatgpt:
            let (status, data) = try await request("https://auth.openai.com/api/accounts/deviceauth/usercode",
                headers: ["Content-Type": "application/json"], body: Self.json(["client_id": provider.clientId]))
            if status == 429 { throw SubscriptionError.rateLimited }
            guard status == 200, let userCode = data["user_code"] as? String, let authId = data["device_auth_id"] as? String
            else { throw SubscriptionError.deviceCodeFailed }
            let interval = max(3, Int("\(data["interval"] ?? 5)") ?? 5)
            store(loginId, PendingLogin(provider: provider, expiresAt: expires, deviceAuthId: authId, userCode: userCode))
            return SubscriptionLoginStart(loginId: loginId, mode: "device", userCode: userCode,
                verificationURL: URL(string: "https://auth.openai.com/codex/device")!, interval: interval)
        case .grok:
            let (status, data) = try await request("https://auth.x.ai/oauth2/device/code",
                headers: ["Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"],
                body: Self.form(["client_id": provider.clientId,
                                 "scope": "openid profile email offline_access grok-cli:access api:access"]))
            guard status == 200, let deviceCode = data["device_code"] as? String, let userCode = data["user_code"] as? String,
                  let uri = (data["verification_uri_complete"] as? String) ?? (data["verification_uri"] as? String),
                  let url = URL(string: uri), let host = url.host, Self.allowedLoginHosts.contains(host)
            else { throw SubscriptionError.deviceCodeFailed }
            let interval = max(1, Int("\(data["interval"] ?? 5)") ?? 5)
            store(loginId, PendingLogin(provider: provider, expiresAt: expires, deviceCode: deviceCode))
            return SubscriptionLoginStart(loginId: loginId, mode: "device", userCode: userCode, verificationURL: url, interval: interval)
        case .claude:
            let verifier = Self.b64url(Self.randomBytes(32))
            let challenge = Self.b64url(Data(SHA256.hash(data: Data(verifier.utf8))))
            let state = Self.b64url(Self.randomBytes(32))
            var comps = URLComponents(string: "https://claude.ai/oauth/authorize")!
            comps.queryItems = [
                URLQueryItem(name: "code", value: "true"), URLQueryItem(name: "client_id", value: provider.clientId),
                URLQueryItem(name: "response_type", value: "code"), URLQueryItem(name: "redirect_uri", value: Self.claudeRedirect),
                URLQueryItem(name: "scope", value: "org:create_api_key user:profile user:inference"),
                URLQueryItem(name: "code_challenge", value: challenge), URLQueryItem(name: "code_challenge_method", value: "S256"),
                URLQueryItem(name: "state", value: state),
            ]
            store(loginId, PendingLogin(provider: provider, expiresAt: expires, verifier: verifier, state: state))
            return SubscriptionLoginStart(loginId: loginId, mode: "paste", userCode: nil, verificationURL: comps.url!, interval: nil)
        }
    }

    private func store(_ id: String, _ login: PendingLogin) {
        lock.withLock { logins[id] = login }
    }

    private func pending(_ id: String) throws -> PendingLogin {
        let (login, expired): (PendingLogin?, Bool) = lock.withLock {
            guard let login = logins[id] else { return (nil, false) }
            if now() > login.expiresAt { logins[id] = nil; return (nil, true) }
            return (login, false)
        }
        if expired { throw SubscriptionError.loginExpired }
        guard let login else { throw SubscriptionError.loginNotFound }
        return login
    }

    private func finish(_ id: String) { lock.withLock { logins[id] = nil } }

    /// Returns true when complete, false while pending.
    public func pollLogin(_ loginId: String) async throws -> Bool {
        let login = try pending(loginId)
        let tokens: [String: Any]
        switch login.provider {
        case .chatgpt:
            let (status, data) = try await request("https://auth.openai.com/api/accounts/deviceauth/token",
                headers: ["Content-Type": "application/json"],
                body: Self.json(["device_auth_id": login.deviceAuthId ?? "", "user_code": login.userCode ?? ""]))
            if status == 403 || status == 404 { return false }
            guard status == 200, let code = data["authorization_code"] as? String, let verifier = data["code_verifier"] as? String
            else { throw SubscriptionError.pollFailed }
            let (exStatus, exData) = try await request("https://auth.openai.com/oauth/token",
                headers: ["Content-Type": "application/x-www-form-urlencoded"],
                body: Self.form(["grant_type": "authorization_code", "code": code,
                                 "redirect_uri": "https://auth.openai.com/deviceauth/callback",
                                 "client_id": login.provider.clientId, "code_verifier": verifier]))
            guard exStatus == 200, exData["access_token"] is String else { throw SubscriptionError.tokenExchangeFailed }
            tokens = exData
        case .grok:
            let tokenURL = try await xaiTokenEndpoint()
            let (status, data) = try await request(tokenURL,
                headers: ["Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"],
                body: Self.form(["grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                                 "client_id": login.provider.clientId, "device_code": login.deviceCode ?? ""]))
            let error = data["error"] as? String
            if error == "authorization_pending" || error == "slow_down" { return false }
            guard status == 200, data["access_token"] is String else {
                throw error == "access_denied" ? SubscriptionError.denied : SubscriptionError.pollFailed
            }
            tokens = data
        case .claude:
            throw SubscriptionError.loginRequiresCode
        }
        finish(loginId)
        _ = try save(login.provider, tokens, previous: nil)
        return true
    }

    public func completeLogin(_ loginId: String, code pasted: String) async throws {
        let login = try pending(loginId)
        guard login.provider == .claude else { throw SubscriptionError.loginDoesNotAcceptCode }
        let trimmed = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= 2048 else { throw SubscriptionError.invalidCode }
        let parts = trimmed.split(separator: "#", maxSplits: 1).map(String.init)
        let code = parts[0], received = parts.count > 1 ? parts[1] : ""
        guard received == login.state else { throw SubscriptionError.stateMismatch }
        let tokens = try await claudeToken(["grant_type": "authorization_code", "client_id": login.provider.clientId,
            "code": code, "state": received, "redirect_uri": Self.claudeRedirect, "code_verifier": login.verifier ?? ""])
        finish(loginId)
        _ = try save(.claude, tokens, previous: nil)
    }

    public func cancelLogin(_ loginId: String) { finish(loginId) }

    private func xaiTokenEndpoint() async throws -> String {
        if let cached = xaiTokenURL { return cached }
        let (status, data) = try await request("https://auth.x.ai/.well-known/openid-configuration", method: "GET",
                                               headers: ["Accept": "application/json"])
        guard status == 200, let endpoint = data["token_endpoint"] as? String,
              URL(string: endpoint)?.host == "auth.x.ai" else { throw SubscriptionError.discoveryFailed }
        xaiTokenURL = endpoint
        return endpoint
    }

    private func claudeToken(_ payload: [String: String]) async throws -> [String: Any] {
        var failure = SubscriptionError.tokenExchangeFailed
        for url in Self.claudeTokenURLs {
            let (status, data) = try await request(url,
                headers: ["Content-Type": "application/json", "User-Agent": "axios/1.7.9"], body: Self.json(payload))
            if status == 200, data["access_token"] is String { return data }
            if status == 429 { failure = .rateLimited }
        }
        throw failure
    }

    // MARK: Storage & refresh

    static func jwtExp(_ token: String) -> Double? {
        let parts = token.split(separator: ".")
        guard parts.count >= 2 else { return nil }
        var b64 = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64),
              let claims = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return (claims["exp"] as? NSNumber)?.doubleValue
    }

    @discardableResult
    func save(_ provider: SubscriptionProvider, _ tokens: [String: Any], previous: TokenRecord?) throws -> TokenRecord {
        guard let access = tokens["access_token"] as? String else { throw SubscriptionError.tokenExchangeFailed }
        let expiresIn = (tokens["expires_in"] as? NSNumber)?.doubleValue
        let expiresAt = expiresIn.map { now().timeIntervalSince1970 + $0 }
            ?? Self.jwtExp(access) ?? now().timeIntervalSince1970 + 3600
        let record = TokenRecord(accessToken: access,
                                 refreshToken: (tokens["refresh_token"] as? String) ?? previous?.refreshToken,
                                 expiresAt: expiresAt)
        let data = try JSONEncoder().encode(record)
        try credentials.set(key: provider.keychainKey, value: String(decoding: data, as: UTF8.self))
        return record
    }

    func load(_ provider: SubscriptionProvider) throws -> TokenRecord {
        guard let raw = try credentials.get(key: provider.keychainKey),
              let record = try? JSONDecoder().decode(TokenRecord.self, from: Data(raw.utf8)) else {
            throw SubscriptionError.loginRequired
        }
        return record
    }

    public func status(_ providerId: String) throws -> (loggedIn: Bool, canRefresh: Bool) {
        let provider = try Self.provider(providerId)
        guard let record = try? load(provider) else { return (false, false) }
        return (!record.accessToken.isEmpty, record.refreshToken != nil)
    }

    public func logout(_ providerId: String) throws {
        try credentials.clear(key: Self.provider(providerId).keychainKey)
    }

    public func accessToken(_ provider: SubscriptionProvider, force: Bool = false) async throws -> String {
        let record = try load(provider)
        if !force && record.expiresAt - provider.refreshSkew > now().timeIntervalSince1970 { return record.accessToken }
        guard record.refreshToken != nil else { throw SubscriptionError.loginRequired }
        // Single-flight: Claude refresh tokens rotate and are single-use.
        let task: Task<TokenRecord, Error> = lock.withLock {
            if let existing = refreshing[provider] { return existing }
            let created = Task { try await self.refresh(provider, record) }
            refreshing[provider] = created
            return created
        }
        defer { lock.withLock { refreshing[provider] = nil } }
        return try await task.value.accessToken
    }

    private func refresh(_ provider: SubscriptionProvider, _ record: TokenRecord) async throws -> TokenRecord {
        let refreshToken = record.refreshToken ?? ""
        let tokens: [String: Any]
        if provider == .claude {
            tokens = try await claudeToken(["grant_type": "refresh_token", "refresh_token": refreshToken,
                                            "client_id": provider.clientId])
        } else {
            let url = provider == .grok ? try await xaiTokenEndpoint() : "https://auth.openai.com/oauth/token"
            let (status, data) = try await request(url,
                headers: ["Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"],
                body: Self.form(["grant_type": "refresh_token", "refresh_token": refreshToken, "client_id": provider.clientId]))
            guard status == 200, data["access_token"] is String else {
                throw (status == 400 || status == 401) ? SubscriptionError.loginRequired : SubscriptionError.refreshFailed
            }
            tokens = data
        }
        return try save(provider, tokens, previous: record)
    }
}

/// Inference against the subscription endpoints (mirrors provider-broker.cjs).
public final class SubscriptionClient {
    public static let claudeCodeVersion = "2.1.290"
    static let claudeSystemPrefix = "You are Claude Code, Anthropic's official CLI for Claude."
    static let codexFallbackModels = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini"]
    static let claudeFallbackModels = ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-6"]
    static let grokFallbackModels = ["grok-4.6", "grok-4.5", "grok-4.3"]
    static let inferenceHosts: Set<String> = ["chatgpt.com", "api.x.ai", "api.anthropic.com"]

    private let auth: SubscriptionAuth
    private let http: SubscriptionHTTP

    public init(auth: SubscriptionAuth, http: SubscriptionHTTP = URLSessionSubscriptionHTTP()) {
        self.auth = auth
        self.http = http
    }

    static func codexAccountHeaders(_ token: String) -> [String: String] {
        let parts = token.split(separator: ".")
        guard parts.count >= 2 else { return [:] }
        var b64 = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64 += "=" }
        guard let data = Data(base64Encoded: b64),
              let claims = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let auth = claims["https://api.openai.com/auth"] as? [String: Any] else { return [:] }
        var headers: [String: String] = [:]
        if let account = auth["chatgpt_account_id"] as? String, !account.isEmpty { headers["ChatGPT-Account-ID"] = account }
        if let residency = (auth["chatgpt_data_residency"] as? String) ?? (auth["chatgpt_compute_residency"] as? String),
           !residency.isEmpty { headers["x-openai-internal-codex-residency"] = residency }
        return headers
    }

    static func parseSSE(_ text: String) throws -> String {
        var out = "", completed = ""
        for line in text.split(whereSeparator: \.isNewline) where line.hasPrefix("data:") {
            let raw = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
            guard !raw.isEmpty, raw != "[DONE]",
                  let event = try? JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any] else { continue }
            let type = event["type"] as? String
            if type == "response.output_text.delta", let delta = event["delta"] as? String { out += delta }
            if type == "response.completed", let response = event["response"] as? [String: Any],
               let output = response["output"] as? [[String: Any]] {
                completed = output.flatMap { ($0["content"] as? [[String: Any]]) ?? [] }
                    .filter { $0["type"] as? String == "output_text" }.compactMap { $0["text"] as? String }.joined()
            }
            if type == "response.failed" || type == "error" { throw SubscriptionError.streamFailed }
        }
        return out.isEmpty ? completed : out
    }

    private func headers(_ provider: SubscriptionProvider, force: Bool) async throws -> [String: String] {
        let token = try await auth.accessToken(provider, force: force)
        var headers = ["Content-Type": "application/json", "Authorization": "Bearer \(token)"]
        switch provider {
        case .chatgpt:
            headers.merge(Self.codexAccountHeaders(token)) { $1 }
            headers["User-Agent"] = "codex_cli_rs/0.0.0 (Voice Practice)"
            headers["originator"] = "codex_cli_rs"
        case .claude:
            headers["anthropic-version"] = "2023-06-01"
            headers["anthropic-beta"] = "claude-code-20250219,oauth-2025-04-20"
            headers["User-Agent"] = "claude-code/\(Self.claudeCodeVersion)"
            headers["x-app"] = "cli"
        case .grok:
            break
        }
        return headers
    }

    /// Sends with the subscription token; on 401 refreshes once and retries.
    private func send(_ provider: SubscriptionProvider, url: String, method: String, body: Data?,
                      extra: [String: String] = [:]) async throws -> Data {
        guard let parsed = URL(string: url), parsed.scheme == "https", let host = parsed.host,
              Self.inferenceHosts.contains(host) else { throw SubscriptionError.unsafeEndpoint }
        for force in [false, true] {
            var req = URLRequest(url: parsed)
            req.httpMethod = method
            req.httpBody = body
            try await headers(provider, force: force).merging(extra) { $1 }.forEach { req.setValue($1, forHTTPHeaderField: $0) }
            let (status, data) = try await http.send(req)
            if status == 401 && !force { continue }
            // xAI answers 402/403 "personal-team-blocked:spending-limit" when the account has no SuperGrok/credits.
            if status == 402 || (status == 403 && String(decoding: data.prefix(512), as: UTF8.self).contains("spending-limit")) {
                throw SubscriptionError.notEntitled
            }
            guard (200...299).contains(status) else { throw SubscriptionError.http(status) }
            return data
        }
        throw SubscriptionError.http(401)
    }

    public func models(_ providerId: String) async throws -> [String] {
        let provider = try SubscriptionAuth.provider(providerId)
        do {
            switch provider {
            case .chatgpt:
                let data = try await send(provider, url: "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
                                          method: "GET", body: nil)
                let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                let ids = ((json?["models"] as? [[String: Any]]) ?? []).compactMap { ($0["slug"] ?? $0["id"]) as? String }
                return ids.isEmpty ? Self.codexFallbackModels : Array(ids.prefix(200))
            case .claude, .grok:
                let base = provider == .claude ? "https://api.anthropic.com/v1" : "https://api.x.ai/v1"
                let data = try await send(provider, url: "\(base)/models", method: "GET", body: nil)
                let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                let ids = ((json?["data"] as? [[String: Any]]) ?? []).compactMap { $0["id"] as? String }
                if ids.isEmpty { if provider == .claude { return Self.claudeFallbackModels }; throw SubscriptionError.invalidResponse }
                return Array(ids.prefix(200))
            }
        } catch SubscriptionError.loginRequired {
            throw SubscriptionError.loginRequired
        } catch SubscriptionError.notEntitled {
            throw SubscriptionError.notEntitled
        } catch {
            if provider == .grok { return Self.grokFallbackModels }
            if provider == .chatgpt { return Self.codexFallbackModels }
            if provider == .claude { return Self.claudeFallbackModels }
            throw error
        }
    }

    public func chat(_ providerId: String, model: String, messages: [ChatMessage], maxTokens: Int) async throws -> String {
        let provider = try SubscriptionAuth.provider(providerId)
        let system = messages.filter { $0.role == "system" }.map(\.content).joined(separator: "\n")
        let turns = messages.filter { $0.role != "system" }
        let text: String
        switch provider {
        case .chatgpt:
            let input: [[String: Any]] = turns.map { m in
                ["type": "message", "role": m.role,
                 "content": [["type": m.role == "assistant" ? "output_text" : "input_text", "text": m.content]]]
            }
            let body = try JSONSerialization.data(withJSONObject: [
                "model": model, "instructions": system.isEmpty ? "You are a helpful English speaking coach." : system,
                "store": false, "stream": true, "input": input,
            ] as [String: Any])
            let data = try await send(provider, url: "https://chatgpt.com/backend-api/codex/responses", method: "POST",
                                      body: body, extra: ["Accept": "text/event-stream"])
            text = try Self.parseSSE(String(decoding: data, as: UTF8.self))
        case .claude:
            var systemBlocks: [[String: String]] = [["type": "text", "text": Self.claudeSystemPrefix]]
            if !system.isEmpty { systemBlocks.append(["type": "text", "text": system]) }
            let body = try JSONSerialization.data(withJSONObject: [
                "model": model, "max_tokens": maxTokens, "system": systemBlocks,
                "messages": turns.map { ["role": $0.role, "content": $0.content] },
            ] as [String: Any])
            let data = try await send(provider, url: "https://api.anthropic.com/v1/messages", method: "POST", body: body)
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            text = ((json?["content"] as? [[String: Any]]) ?? []).filter { $0["type"] as? String == "text" }
                .compactMap { $0["text"] as? String }.joined(separator: "\n")
        case .grok:
            let body = try JSONSerialization.data(withJSONObject: [
                "model": model, "max_tokens": maxTokens,
                "messages": messages.map { ["role": $0.role, "content": $0.content] },
            ] as [String: Any])
            let data = try await send(provider, url: "https://api.x.ai/v1/chat/completions", method: "POST", body: body)
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            text = (((json?["choices"] as? [[String: Any]])?.first?["message"] as? [String: Any])?["content"] as? String) ?? ""
        }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw SubscriptionError.invalidResponse }
        return trimmed
    }
}
