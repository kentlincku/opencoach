import Foundation
import Security

public protocol CredentialStoreProtocol: AnyObject {
    func get(key: String) throws -> String?
    func set(key: String, value: String) throws
    func has(key: String) -> Bool
    func clear(key: String) throws
}

public final class KeychainStore: CredentialStoreProtocol {
    private let service: String

    public init(service: String = "com.kentlin.voicepractice.credentials") {
        self.service = service
    }

    public func get(key: String) throws -> String? {
        guard !key.isEmpty else { return nil }
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: key,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)

        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess, let data = result as? Data, let str = String(data: data, encoding: .utf8) else {
            throw NSError(domain: "KeychainError", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "Failed to read credential: \(status)"])
        }
        return str
    }

    public func set(key: String, value: String) throws {
        guard !key.isEmpty else { return }
        guard let data = value.data(using: .utf8) else { return }

        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: key
        ]

        let updateAttrs: [CFString: Any] = [
            kSecValueData: data
        ]

        let status = SecItemUpdate(query as CFDictionary, updateAttrs as CFDictionary)
        if status == errSecItemNotFound {
            var newQuery = query
            newQuery[kSecValueData] = data
            let addStatus = SecItemAdd(newQuery as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw NSError(domain: "KeychainError", code: Int(addStatus), userInfo: [NSLocalizedDescriptionKey: "Failed to save credential: \(addStatus)"])
            }
        } else if status != errSecSuccess {
            throw NSError(domain: "KeychainError", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "Failed to update credential: \(status)"])
        }
    }

    public func has(key: String) -> Bool {
        guard !key.isEmpty else { return false }
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: key,
            kSecMatchLimit: kSecMatchLimitOne
        ]
        let status = SecItemCopyMatching(query as CFDictionary, nil)
        return status == errSecSuccess
    }

    public func clear(key: String) throws {
        guard !key.isEmpty else { return }
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: key
        ]
        let status = SecItemDelete(query as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            throw NSError(domain: "KeychainError", code: Int(status), userInfo: [NSLocalizedDescriptionKey: "Failed to delete credential: \(status)"])
        }
    }
}

public final class InMemoryCredentialStore: CredentialStoreProtocol {
    private var storage = [String: String]()
    private let lock = NSLock()

    public init() {}

    public func get(key: String) throws -> String? {
        lock.lock()
        defer { lock.unlock() }
        return storage[key]
    }

    public func set(key: String, value: String) throws {
        lock.lock()
        defer { lock.unlock() }
        storage[key] = value
    }

    public func has(key: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return storage[key] != nil
    }

    public func clear(key: String) throws {
        lock.lock()
        defer { lock.unlock() }
        storage.removeValue(forKey: key)
    }
}
