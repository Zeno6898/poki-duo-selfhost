import Foundation

// The app shell's view of PokiCore (docs/ios-core.md, section 2) and PokiLauncher (section 3).
// PokiCore and PokiLauncher are built on dev/ios-core; until they are linked in, the shell runs against
// these protocols, so every screen, the Live Activity and the approval path can be built and tested
// without them. CoreAdapter.swift maps PokiCore's CoreEvent onto ShellEvent once the package is added.

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

/// On-device wireless pairing (iOS 27, Settings > Privacy & Security > Developer Mode > Pair). Not in
/// the launcher ABI v1 yet; requested from the core thread as poki_pair_start / poki_pair_cancel.
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

/// Stand-ins used until PokiCore and PokiLauncher are linked: the screens work, nothing reaches the
/// phone's developer services, and each says so.
final class UnlinkedCore: CoreSession {
    private let continuation: AsyncStream<ShellEvent>.Continuation
    let events: AsyncStream<ShellEvent>
    init() { (events, continuation) = AsyncStream.makeStream() }
    func start() { continuation.yield(.relay(.offline("PokiCore is not in this build"))) }
    func stop() { continuation.yield(.relay(.off)) }
    func resolveApproval(id: String, approved: Bool) { continuation.yield(.approvalEnded(id: id, approved: approved)) }
}

final class UnlinkedLauncher: RunnerLauncher {
    func start(config: LauncherConfig, onEvent: @escaping @Sendable (RunnerStatus) -> Void) throws {
        onEvent(RunnerStatus(state: "failed", detail: "PokiLauncher is not in this build", fix: "Install a build that includes PokiLauncher."))
    }
    func restart() {}
    func stop() {}
}

final class UnlinkedPairing: DevicePairing {
    func start(hostName: String, saveTo: URL, onEvent: @escaping @Sendable (PairingEvent) -> Void) throws {
        onEvent(.failed("On-device pairing is not in this build yet. Import a pairing file instead."))
    }
    func cancel() {}
}
