import Foundation

// The app shell's view of PokiCore (docs/ios-core.md, section 2) and PokiLauncher (section 3). LiveCore
// maps PokiCore's events onto ShellEvent; RustLauncher and RustPairing call PokiLauncher's C ABI.

/// What the shell shows. One-to-one with PokiCore's CoreEvent, plus the screenshot thumbnail the Live
/// Activity draws.
enum ShellEvent: Sendable {
    case relay(RelayStatus)
    case toolStarted(name: String, summary: String)
    case toolFinished(summary: String, delivery: String, app: String?, thumbnail: Data?)
    case approvalRequested(PendingApproval)
    case approvalEnded(id: String, approved: Bool?)
}

enum RelayStatus: Sendable, Equatable {
    case off, connecting, ready, offline(String)
    var text: String {
        switch self {
        case .off: "Off"
        case .connecting: "Connecting"
        case .ready: "Online"
        case .offline(let why): "Offline: \(why)"
        }
    }
}

protocol CoreSession: AnyObject {
    func start()
    func stop()
    var events: AsyncStream<ShellEvent> { get }
    func resolveApproval(id: String, approved: Bool)
}

/// The launcher's state, as its JSON events report it.
struct RunnerStatus: Sendable, Equatable, Decodable {
    var state: String
    var detail: String?
    var attempt: Int?
    var fix: String?
    var pairing: String?
    static let idle = RunnerStatus(state: "idle")

    var isRunning: Bool { state == "running" }
    var title: String {
        switch state {
        case "idle": "Not started"
        case "standby": "Standing by"
        case "connecting": "Connecting to the phone"
        case "pairing": "Verifying pairing"
        case "tunnel": "Opening the developer tunnel"
        case "mounting_ddi": "Mounting the developer disk image"
        case "launching": "Launching the runner"
        case "running": "Running"
        case "waiting_network": "Waiting for the loopback"
        case "failed": "Stopped"
        default: state
        }
    }
}

protocol RunnerLauncher: AnyObject {
    func start(config: LauncherConfig, onEvent: @escaping @Sendable (RunnerStatus) -> Void) throws
    func restart()
    func stop()
}

struct LauncherConfig: Encodable {
    var device_address = "10.7.0.1"
    var pairing_file: String
    var host_name = "Poki"
    var ddi_dir: String
    var runner_bundle: String? = nil
    var wda_port = 8100
}

/// On-device wireless pairing (iOS 27, Settings > Privacy & Security > Developer Mode > Pair).
protocol DevicePairing: AnyObject {
    func start(hostName: String, saveTo: URL, onEvent: @escaping @Sendable (PairingEvent) -> Void) throws
    func cancel()
}

enum PairingEvent: Sendable, Equatable {
    case advertising
    case pin(String)
    case paired(URL)
    case failed(String)
}
