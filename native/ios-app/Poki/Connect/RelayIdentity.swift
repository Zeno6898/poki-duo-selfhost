import CryptoKit
import Foundation
import Security

/// The phone's relay identity (docs/ios-core.md, section 1): an Ed25519 key made once and kept in the
/// keychain, the label derived from it, and the connector secrets, one per MCP client, each revocable.
/// The relay never sees a secret, only its sha256.
struct ConnectorSecret: Codable, Identifiable, Hashable {
    var id: String { secret }
    var name: String
    var secret: String
    var created: Date
    var hash: String { SHA256.hash(data: Data(secret.utf8)).map { String(format: "%02x", $0) }.joined() }
}

@MainActor
@Observable
final class RelayIdentity {
    static let relayBase = URL(string: "https://pokimcp.zheha.nz/v1")!
    private static let keyAccount = "relay.ed25519"
    private static let secretsAccount = "relay.secrets"

    private(set) var label = ""
    private(set) var secrets: [ConnectorSecret] = []
    private(set) var error: String?
    private var key: Curve25519.Signing.PrivateKey?

    init() { load() }

    var publicKey: Data? { key?.publicKey.rawRepresentation }
    var signingKey: Curve25519.Signing.PrivateKey? { key }
    var accessHashes: [String] { secrets.map(\.hash) }

    func url(for secret: ConnectorSecret) -> URL {
        Self.relayBase.appendingPathComponent(label).appendingPathComponent(secret.secret).appendingPathComponent("mcp")
    }

    func sign(_ message: Data) throws -> Data {
        guard let key else { throw NSError(domain: "Poki", code: 1, userInfo: [NSLocalizedDescriptionKey: "no relay key"]) }
        return try key.signature(for: message)
    }

    func addSecret(name: String) -> ConnectorSecret {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let secret = ConnectorSecret(name: name.isEmpty ? "Connector \(secrets.count + 1)" : name, secret: Data(bytes).base64URL, created: Date())
        secrets.append(secret)
        save()
        return secret
    }

    func revoke(_ secret: ConnectorSecret) {
        secrets.removeAll { $0 == secret }
        save()
    }

    private func load() {
        do {
            if let raw = try Keychain.read(Self.keyAccount) {
                key = try Curve25519.Signing.PrivateKey(rawRepresentation: raw)
            } else {
                let made = Curve25519.Signing.PrivateKey()
                try Keychain.write(made.rawRepresentation, account: Self.keyAccount)
                key = made
            }
            if let data = try Keychain.read(Self.secretsAccount) { secrets = (try? JSONDecoder().decode([ConnectorSecret].self, from: data)) ?? [] }
            label = Base32.encode(key!.publicKey.rawRepresentation)
        } catch {
            self.error = "\(error)"
        }
    }

    private func save() {
        do { try Keychain.write(try JSONEncoder().encode(secrets), account: Self.secretsAccount) }
        catch { self.error = "\(error)" }
    }
}

enum Keychain {
    private static let service = "nz.zheha.poki"

    static func read(_ account: String) throws -> Data? {
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account, kSecReturnData as String: true]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        return result as? Data
    }

    static func write(_ data: Data, account: String) throws {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }
}

/// RFC 4648 base32, lowercase, no padding.
enum Base32 {
    private static let alphabet = Array("abcdefghijklmnopqrstuvwxyz234567")
    static func encode(_ data: Data) -> String {
        var out = "", buffer = 0, bits = 0
        for byte in data {
            buffer = (buffer << 8) | Int(byte); bits += 8
            while bits >= 5 { out.append(alphabet[(buffer >> (bits - 5)) & 31]); bits -= 5 }
            buffer &= (1 << bits) - 1
        }
        if bits > 0 { out.append(alphabet[(buffer << (5 - bits)) & 31]) }
        return out
    }
}

extension Data {
    var base64URL: String { base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "") }
}
