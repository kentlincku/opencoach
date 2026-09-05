import Foundation
import CryptoKit

public enum CredentialBinding {
    /// Normalizes baseUrl and computes a secure canonical credential storage key.
    /// Cloud providers map to cloud:<provider> only if their host matches the cloud allowlist.
    /// Custom / LAN endpoints map to endpoint:<SHA256(canonicalUrl)> to isolate hosts, ports, and paths.
    public static func canonicalKey(providerId: String, baseUrl: String) throws -> String {
        let normalizedProvider = providerId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let validatedUrl = try LocalModelClient.validateEndpoint(urlString: baseUrl, providerId: normalizedProvider)

        if LocalModelClient.cloudProviderHosts.keys.contains(normalizedProvider) {
            return "cloud:\(normalizedProvider)"
        }

        guard let scheme = validatedUrl.scheme?.lowercased() else {
            throw LocalModelError.invalidEndpoint("Missing scheme")
        }
        guard let host = validatedUrl.host?.lowercased() else {
            throw LocalModelError.invalidEndpoint("Missing host")
        }

        let port = validatedUrl.port
        let effectivePort: Int?
        if scheme == "http" && port == 80 {
            effectivePort = nil
        } else if scheme == "https" && port == 443 {
            effectivePort = nil
        } else {
            effectivePort = port
        }

        let rawPath = validatedUrl.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let canonicalPath = rawPath.isEmpty ? "" : "/\(rawPath)"
        let portString = effectivePort != nil ? ":\(effectivePort!)" : ""
        let canonicalUrlString = "\(scheme)://\(host)\(portString)\(canonicalPath)"

        let hash = SHA256.hash(data: Data(canonicalUrlString.utf8))
        let hexHash = hash.compactMap { String(format: "%02x", $0) }.joined()
        return "endpoint:\(hexHash)"
    }
}
