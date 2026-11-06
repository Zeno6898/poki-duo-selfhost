import Foundation

/// What the user has done in setup, kept across launches.
struct SetupState: Codable, Equatable {
    enum Loopback: String, Codable { case none, builtIn, proxy }
    var pairingFile: String?
    var developerMode = false
    var uiAutomation = false
    var passcodeNoted = false
    var loopback: Loopback = .none
    var proxyApp: String?

    var loopbackChosen: Bool { loopback != .none }
    var isComplete: Bool { pairingFile != nil && developerMode && uiAutomation && loopbackChosen && passcodeNoted }

    static func load() -> SetupState {
        guard let data = UserDefaults.standard.data(forKey: "setup"), let state = try? JSONDecoder().decode(SetupState.self, from: data) else { return SetupState() }
        return state
    }
    func save() { if let data = try? JSONEncoder().encode(self) { UserDefaults.standard.set(data, forKey: "setup") } }
}

enum AppFiles {
    static var support: URL {
        let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Poki", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    /// The pairing file lives in the app's container with complete-until-first-unlock protection, so
    /// the launcher can read it in the background after the first unlock.
    static var pairingFile: URL { support.appendingPathComponent("pairing.plist") }
    static var ddiDirectory: URL {
        let url = support.appendingPathComponent("ddi", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}
