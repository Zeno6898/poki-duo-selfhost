import Foundation

/// The developer disk image PokiLauncher mounts (Apple's personalized Cryptex1 image; Apple signs it
/// for this phone at mount time). Downloaded once into the app's container: BuildManifest.plist,
/// Image.dmg and Image.dmg.trustcache, from the public mirror of Xcode's personalized image that
/// StikDebug and SideStore also use.
@MainActor
@Observable
final class DeveloperDiskImage {
    static let source = URL(string: "https://github.com/doronz88/DeveloperDiskImage/raw/main/PersonalizedImages/Xcode_iOS_DDI_Personalized/")!
    static let files = ["BuildManifest.plist", "Image.dmg", "Image.dmg.trustcache"]

    enum State: Equatable { case missing, downloading(Double), ready, failed(String) }
    private(set) var state: State = .missing

    init() { state = Self.present ? .ready : .missing }

    static var present: Bool {
        files.allSatisfy { FileManager.default.fileExists(atPath: AppFiles.ddiDirectory.appendingPathComponent($0).path) }
    }

    var isReady: Bool { state == .ready }

    func download() async {
        if case .downloading = state { return }
        state = .downloading(0)
        do {
            for (i, name) in Self.files.enumerated() {
                let target = AppFiles.ddiDirectory.appendingPathComponent(name)
                let (temp, response) = try await URLSession.shared.download(from: Self.source.appendingPathComponent(name))
                guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                    throw NSError(domain: "Poki", code: 20, userInfo: [NSLocalizedDescriptionKey: "\(name): HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)"])
                }
                try? FileManager.default.removeItem(at: target)
                try FileManager.default.moveItem(at: temp, to: target)
                state = .downloading(Double(i + 1) / Double(Self.files.count))
            }
            // A plist that does not parse means a broken download (for example an HTML error page).
            let manifest = try Data(contentsOf: AppFiles.ddiDirectory.appendingPathComponent("BuildManifest.plist"))
            _ = try PropertyListSerialization.propertyList(from: manifest, format: nil)
            state = .ready
        } catch {
            for name in Self.files { try? FileManager.default.removeItem(at: AppFiles.ddiDirectory.appendingPathComponent(name)) }
            state = .failed(error.localizedDescription)
        }
    }
}
