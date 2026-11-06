import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
#if canImport(CryptoKit)
import CryptoKit
#endif

/// The developer disk image the launcher mounts (its `ddi_dir`), downloaded once into the app's
/// container from the doronz88/DeveloperDiskImage mirror, the files pymobiledevice3 uses. Every
/// payload is checked against the SHA-384 digest its BuildManifest.plist declares. Apple's files are
/// downloaded at run time, never shipped in the app.
public enum DeveloperDiskImage {
    public static let mirror = URL(string: "https://raw.githubusercontent.com/doronz88/DeveloperDiskImage/main/PersonalizedImages/Xcode_iOS_DDI_Cryptex")!
    public static let files = ["BuildManifest.plist", "Image.dmg", "Image.dmg.trustcache", "Image.dmg.cryptex_info", "Image.dmg.root_hash"]
    static let payloadKeys = ["Cryptex1,GenericDmg", "Cryptex1,GenericTrustCache", "Cryptex1,CryptexInfoPlist", "Cryptex1,GenericVolume"]

    public struct Problem: Error, CustomStringConvertible { public let description: String }

    /// The build of a verified image in `dir`; throws when anything is missing or does not match.
    @discardableResult
    public static func verify(_ dir: URL) throws -> String {
        let manifestURL = dir.appendingPathComponent("BuildManifest.plist")
        guard let data = try? Data(contentsOf: manifestURL),
              let manifest = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else {
            throw Problem(description: "BuildManifest.plist is missing or unreadable")
        }
        let identities = manifest["BuildIdentities"] as? [[String: Any]] ?? []
        guard let identity = identities.first(where: { id in payloadKeys.allSatisfy { ((id["Manifest"] as? [String: Any])?[$0]) != nil } }),
              let entries = identity["Manifest"] as? [String: Any] else {
            throw Problem(description: "BuildManifest.plist has no Cryptex1 build identity")
        }
        for key in payloadKeys {
            let entry = entries[key] as? [String: Any]
            guard let path = (entry?["Info"] as? [String: Any])?["Path"] as? String, !path.isEmpty, !path.hasPrefix("/"), !path.split(separator: "/").contains(".."),
                  let digest = entry?["Digest"] as? Data else {
                throw Problem(description: "BuildManifest.plist gives no usable path or digest for \(key)")
            }
            guard let bytes = try? Data(contentsOf: dir.appendingPathComponent(path)) else { throw Problem(description: "\(path) is missing") }
            #if canImport(CryptoKit)
            guard Data(SHA384.hash(data: bytes)) == digest else { throw Problem(description: "\(path) does not match its SHA-384 digest") }
            #else
            _ = (bytes, digest)
            #endif
        }
        return manifest["ProductBuildVersion"] as? String ?? "unknown"
    }

    /// Makes sure `dir` holds a verified image, downloading it when it does not. Files land in a
    /// sibling directory first and move into place only after every digest matches.
    public static func ensure(in dir: URL, from base: URL = mirror, transport: HTTPTransport = URLSessionTransport(), progress: @Sendable (String) -> Void = { _ in }) async throws -> String {
        if let build = try? verify(dir) { return build }
        let fm = FileManager.default
        let partial = dir.deletingLastPathComponent().appendingPathComponent(dir.lastPathComponent + ".partial")
        try? fm.removeItem(at: partial)
        try fm.createDirectory(at: partial, withIntermediateDirectories: true)
        do {
            for name in files {
                progress("Downloading \(name)…")
                let (status, body) = try await transport.send(method: "GET", url: base.appendingPathComponent(name), body: nil, timeout: 120)
                guard status == 200 else { throw Problem(description: "downloading \(name) failed with HTTP \(status)") }
                try body.write(to: partial.appendingPathComponent(name))
            }
            let build = try verify(partial)
            try? fm.removeItem(at: dir)
            try fm.moveItem(at: partial, to: dir)
            return build
        } catch {
            try? fm.removeItem(at: partial)
            throw error
        }
    }
}
