import Foundation
import Security

/// The PersonalOS session this app signed in with, shared with the share extension through one
/// Keychain access group (same team only). It is the person's own account session: it expires,
/// can be revoked from PersonalOS, and is never an API key, never in source, never in a file.
struct Credentials: Codable, Equatable {
    var server: URL
    var token: String
    var account: String
    var expiresAt: String?
}

enum CredentialStore {
    private static let service = "personalos.session"

    /// The resolved access group from Info.plist ($(AppIdentifierPrefix)<prefix>.shared).
    private static var accessGroup: String? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "PersonalOSKeychainGroup") as? String, !group.contains("$(") else { return nil }
        return group
    }

    private static func query() -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "current",
        ]
        if let group = accessGroup { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    static func load() -> Credentials? {
        var q = query()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return try? JSONDecoder().decode(Credentials.self, from: data)
    }

    @discardableResult
    static func save(_ credentials: Credentials) -> Bool {
        guard let data = try? JSONEncoder().encode(credentials) else { return false }
        SecItemDelete(query() as CFDictionary)
        var q = query()
        q[kSecValueData as String] = data
        // Readable after the first unlock (a share can happen any time), never synced or backed up off this device.
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    static func clear() {
        SecItemDelete(query() as CFDictionary)
    }
}
