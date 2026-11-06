import SwiftUI
import UIKit

/// The app's state and the glue between PokiCore, PokiLauncher, the loopback, the Live Activity and
/// approvals. One instance, owned by PokiApp.
@MainActor
@Observable
final class AppModel {
    var setup = SetupState.load() { didSet { setup.save() } }
    let identity = RelayIdentity()
    let tunnel = TunnelController()
    let diskImage = DiskImageStore()
    private(set) var runner = RunnerStatus.idle
    private(set) var relayStatus = RelayStatus.off
    private(set) var sessionOn = false
    private(set) var activityText = "Idle"
    private(set) var lastAction: String?
    private(set) var approvals: [PendingApproval] = []
    private(set) var pairing: PairingEvent?
    private(set) var problem: String?
    /// The runner is stopped until the next agent request (idle, or the owner tapped Stop runner).
    private(set) var runnerPaused = false
    /// Stop the runner after this long without agent activity; 0 never stops it.
    var idleStopSeconds: Int = UserDefaults.standard.object(forKey: "idleStopSeconds") as? Int ?? 120 {
        didSet { UserDefaults.standard.set(idleStopSeconds, forKey: "idleStopSeconds") }
    }
    private var lastAgentActivity = Date()
    private var idleTimer: Timer?
    private var launcherConfig: LauncherConfig?

    private let host = AppCoreHost()
    private let core: LiveCore
    private let launcher: RunnerLauncher
    private let pairer: DevicePairing
    private let activity = ActivityController()
    private let keepAlive = KeepAlive()
    private var eventsTask: Task<Void, Never>?

    init() {
        core = LiveCore(host: host)
        let launcher = RustLauncher()
        self.launcher = launcher
        pairer = RustPairing()
        host.update(key: identity.signingKey, hashes: identity.accessHashes)
        host.onRestart { launcher.restart() }
        host.onWake { [weak self] in Task { @MainActor in self?.wakeRunner() } }
        listenForApprovals()
        Task { await tunnel.load() }
        if !diskImage.isReady { Task { await diskImage.download() } }
    }

    var deviceName: String { UIDevice.current.name }

    // MARK: Session

    func startSession() {
        guard !sessionOn else { return }
        problem = nil
        guard let pairing = setup.pairingFile else { problem = "Pair this iPhone first (Setup)."; return }
        guard diskImage.isReady else {
            problem = "The developer disk image is not downloaded yet (Setup > Pair). It is needed once."
            Task { await diskImage.download() }
            return
        }
        do { try keepAlive.start() } catch { problem = "Could not keep Poki running in the background: \(error.localizedDescription)" }
        activity.start(deviceName: deviceName)
        activity.update { $0.phase = .idle; $0.headline = "Starting" }
        sessionOn = true
        launcherConfig = LauncherConfig(pairing_file: pairing, ddi_dir: AppFiles.ddiDirectory.path)
        lastAgentActivity = Date()
        launchRunner()
        core.start()
        idleTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in Task { @MainActor in self?.checkIdle() } }
        eventsTask = Task { [weak self, core] in
            for await event in core.events { self?.handle(event) }
        }
    }

    func stopSession() {
        guard sessionOn else { return }
        core.stop()
        launcher.stop()
        idleTimer?.invalidate(); idleTimer = nil
        runnerPaused = false; host.setPaused(false)
        eventsTask?.cancel(); eventsTask = nil
        keepAlive.stop()
        activity.end()
        sessionOn = false
        runner = .idle
        relayStatus = .off
        activityText = "Idle"
    }

    func restartRunner() { launcher.restart() }

    private func launchRunner() {
        guard let launcherConfig else { return }
        do {
            try launcher.start(config: launcherConfig) { [weak self] status in Task { @MainActor in self?.runnerChanged(status) } }
        } catch { runnerChanged(RunnerStatus(state: "failed", detail: "\(error)")) }
    }

    /// Stops the runner, and with it iOS's automation banner, while the relay stays connected; the
    /// next agent request starts it again. From the Stop runner button, the Live Activity, or idle.
    func pauseRunner(reason: String = "Stopped") {
        guard sessionOn, !runnerPaused, approvals.isEmpty else { return }
        launcher.stop()
        runnerPaused = true
        runner = RunnerStatus(state: "idle", detail: "\(reason). It starts again on the next agent request.")
        host.update(runner: .starting("stopped while idle"))
        host.setPaused(true)
        activity.update { $0.runnerPaused = true; $0.phase = .idle; $0.headline = "Runner stopped. Starts on the next request." }
    }

    /// Starts a paused runner again (the next agent request, or the owner).
    func wakeRunner() {
        guard sessionOn, runnerPaused else { return }
        runnerPaused = false
        host.setPaused(false)
        lastAgentActivity = Date()
        activity.update { $0.runnerPaused = false; $0.headline = "Starting the runner" }
        launchRunner()
    }

    private func checkIdle() {
        guard sessionOn, !runnerPaused, idleStopSeconds > 0, approvals.isEmpty, activityText == "Idle" else { return }
        if Date().timeIntervalSince(lastAgentActivity) >= Double(idleStopSeconds) {
            pauseRunner(reason: "Stopped after \(idleStopSeconds / 60 > 0 ? "\(idleStopSeconds / 60) min" : "\(idleStopSeconds) s") without agent activity")
        }
    }

    private func runnerChanged(_ status: RunnerStatus) {
        // Events from a launcher that was stopped for idle are old news.
        guard !runnerPaused else { return }
        runner = status
        host.update(runner: status.coreState)
        if status.state == "failed" {
            activity.update { $0.phase = .problem; $0.headline = status.fix ?? status.detail ?? "The runner stopped" }
        } else if !status.isRunning {
            activity.update { $0.phase = .idle; $0.headline = status.title }
        } else if activity.state.phase == .problem || activity.state.phase == .idle {
            activity.update { $0.phase = .idle; $0.headline = "Ready" }
        }
    }

    private func handle(_ event: ShellEvent) {
        switch event {
        case .relay(let status):
            relayStatus = status
        case .toolStarted(_, let summary):
            lastAgentActivity = Date()
            activityText = summary
            activity.update { $0.phase = $0.approval == nil ? .working : .approval; $0.headline = summary }
        case .toolFinished(let summary, let delivery, let app, let thumbnail):
            lastAgentActivity = Date()
            lastAction = "\(summary) · \(delivery)"
            activityText = "Idle"
            activity.update { state in
                state.lastAction = "\(summary) · \(delivery)"
                state.app = app ?? state.app
                if state.approval == nil { state.phase = .idle; state.headline = "Waiting for the agent" }
            }
            activity.setThumbnail(thumbnail)
        case .approvalRequested(let approval):
            approvals.append(approval)
            activity.update { $0.phase = .approval; $0.approval = approval; $0.headline = "Approve: \(approval.summary)" }
        case .approvalEnded(let id, _):
            approvals.removeAll { $0.id == id }
            activity.update { state in
                if state.approval?.id == id { state.approval = nil; state.phase = .idle; state.headline = "Waiting for the agent" }
            }
        }
    }

    // MARK: Approvals

    /// Approvals from the app's own screen (the same path as the Live Activity's buttons).
    func resolve(_ approval: PendingApproval, approved: Bool) {
        core.resolveApproval(id: approval.id, approved: approved)
    }

    private func listenForApprovals() {
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        let observer = Unmanaged.passUnretained(self).toOpaque()
        CFNotificationCenterAddObserver(center, observer, { _, observer, _, _, _ in
            guard let observer else { return }
            let model = Unmanaged<AppModel>.fromOpaque(observer).takeUnretainedValue()
            Task { @MainActor in model.drainApprovals() }
        }, ApprovalMailbox.notification as CFString, nil, .deliverImmediately)
        CFNotificationCenterAddObserver(center, observer, { _, observer, _, _, _ in
            guard let observer else { return }
            let model = Unmanaged<AppModel>.fromOpaque(observer).takeUnretainedValue()
            Task { @MainActor in model.pauseRunner(reason: "Stopped from the Live Activity") }
        }, ApprovalMailbox.stopRunner as CFString, nil, .deliverImmediately)
    }

    func drainApprovals() {
        for (id, approved) in ApprovalMailbox.drain() where approvals.contains(where: { $0.id == id }) {
            core.resolveApproval(id: id, approved: approved)
        }
    }

    // MARK: Pairing

    func importPairingFile(from url: URL) throws {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let data = try Data(contentsOf: url)
        // A lockdown pairing plist or an RPPairing file; both are property lists.
        _ = try PropertyListSerialization.propertyList(from: data, format: nil)
        try data.write(to: AppFiles.pairingFile, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        setup.pairingFile = AppFiles.pairingFile.path
    }

    func startPairing() {
        pairing = .advertising
        do {
            try pairer.start(hostName: "Poki", saveTo: AppFiles.pairingFile) { [weak self] event in
                Task { @MainActor in self?.pairingChanged(event) }
            }
        } catch { pairing = .failed("\(error)") }
    }

    func cancelPairing() { pairer.cancel(); pairing = nil; activity.update { $0.pin = nil } }

    private func pairingChanged(_ event: PairingEvent) {
        pairing = event
        switch event {
        case .pin(let pin):
            // The PIN goes in the Live Activity, so it is visible while the user is in Settings.
            activity.start(deviceName: deviceName)
            activity.update { $0.phase = .pairing; $0.pin = pin; $0.headline = "Enter this PIN in Settings" }
        case .paired(let url):
            try? (url as NSURL).setResourceValue(URLFileProtection.completeUntilFirstUserAuthentication, forKey: .fileProtectionKey)
            setup.pairingFile = url.path
            activity.update { $0.phase = .idle; $0.pin = nil; $0.headline = "Paired" }
            if !sessionOn { activity.end() }
        case .failed:
            activity.update { $0.pin = nil }
            if !sessionOn { activity.end() }
        case .advertising: break
        }
    }

    // MARK: Connectors

    func addConnector(name: String) -> ConnectorSecret {
        let secret = identity.addSecret(name: name)
        accessChanged()
        return secret
    }
    func revoke(_ secret: ConnectorSecret) { identity.revoke(secret); accessChanged() }
    private func accessChanged() {
        host.update(key: identity.signingKey, hashes: identity.accessHashes)
        core.accessChanged()
    }
}
