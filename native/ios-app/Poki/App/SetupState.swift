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
    var runnerInstalled = false

    var loopbackChosen: Bool { loopback == .proxy }

    init() {}
    // Field by field, so a setup saved by an older version keeps what it has.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pairingFile = try c.decodeIfPresent(String.self, forKey: .pairingFile)
        developerMode = try c.decodeIfPresent(Bool.self, forKey: .developerMode) ?? false
        uiAutomation = try c.decodeIfPresent(Bool.self, forKey: .uiAutomation) ?? false
        passcodeNoted = try c.decodeIfPresent(Bool.self, forKey: .passcodeNoted) ?? false
        loopback = (try? c.decodeIfPresent(Loopback.self, forKey: .loopback)) ?? Loopback.none
        if loopback == .builtIn { loopback = .none }
        proxyApp = try c.decodeIfPresent(String.self, forKey: .proxyApp)
        runnerInstalled = try c.decodeIfPresent(Bool.self, forKey: .runnerInstalled) ?? (pairingFile != nil)
    }

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

/// The setup steps, in the order a new user does them.
enum SetupStep: String, CaseIterable, Identifiable {
    case runner, developerMode, loopback, pairing, automation, background
    var id: String { rawValue }

    var title: String {
        switch self {
        case .runner: "Install Poki Runner"
        case .developerMode: "Turn on Developer Mode"
        case .loopback: "Turn on the loopback"
        case .pairing: "Pair this iPhone"
        case .automation: "Allow UI Automation"
        case .background: "Let Poki stay on"
        }
    }

    var symbol: String {
        switch self {
        case .runner: "square.and.arrow.down.on.square"
        case .developerMode: "hammer"
        case .loopback: "arrow.triangle.2.circlepath"
        case .pairing: "link"
        case .automation: "hand.tap"
        case .background: "location"
        }
    }

    var summary: String {
        switch self {
        case .runner: "The helper app that taps and types for your agent. Poki starts it; you never open it."
        case .developerMode: "Lets this iPhone run Poki Runner."
        case .loopback: "Lets Poki reach this iPhone's developer services at 10.7.0.1, through the proxy app you already use."
        case .pairing: "Gives Poki its own key to this iPhone. Made and kept on the phone, no computer needed."
        case .automation: "Lets Poki Runner use other apps."
        case .background: "Keeps Poki connected while it is in the background, and shows what it does on the Lock Screen."
        }
    }

    /// One line for the Live Activity while the person is in Settings.
    var hint: String {
        switch self {
        case .runner: "Install Poki Runner, then trust it: Settings > General > VPN & Device Management."
        case .developerMode: "Settings > Privacy & Security > Developer Mode. Turn it on, restart, then tap Turn On."
        case .loopback: "Turn on the Poki module in your proxy app, or connect LocalDevVPN. Then come back to Poki."
        case .pairing: "Settings > Privacy & Security > Developer Mode > Pair with Poki, then type the code shown here."
        case .automation: "Settings > Developer > Enable UI Automation."
        case .background: "Allow location While Using the App, and keep Live Activities on."
        }
    }
}

/// One of the agent's recent actions, for the home screen.
struct RecentStep: Identifiable, Equatable {
    let id = UUID()
    var text: String
    var detail: String
    var ok: Bool
    var at: Date
}
