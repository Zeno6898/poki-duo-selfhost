import SwiftUI
import UIKit

/// The app's state and the glue between PokiCore, PokiLauncher, the loopback, the Live Activity and
/// approvals. One instance, owned by PokiApp.
@MainActor
@Observable
final class AppModel {
    var setup = SetupState.load() { didSet { setup.save() } }
    let identity = RelayIdentity()
    let loopback = LoopbackMonitor()
    let background = BackgroundKeeper()
    let diskImage = DiskImageStore()
    private(set) var runner = RunnerStatus.idle
    private(set) var relayStatus = RelayStatus.off
    private(set) var sessionOn = false
    private(set) var activityText = "Idle"
    private(set) var lastAction: String?
    private(set) var approvals: [PendingApproval] = []
    private(set) var pairing: PairingEvent?
    private(set) var problem: String?
    /// The agent's recent actions, newest last, for the home screen.
    private(set) var recentSteps: [RecentStep] = []
    /// The runner is stopped until the next agent request (idle, or the owner tapped Stop runner).
    private(set) var runnerPaused = false
    /// Stop the runner after this long without agent activity; 0 never stops it.
    /// Two minutes by default: an agent can think for a minute between steps of a long task, and the
    /// runner must not stop (and the banner flash) in the middle of it.
    var idleStopSeconds: Int = UserDefaults.standard.object(forKey: "idleStopSeconds.v3") as? Int ?? 120 {
        didSet { UserDefaults.standard.set(idleStopSeconds, forKey: "idleStopSeconds.v3"); log.add("runner", "idle stop set to \(idleStopSeconds) s") }
    }
    /// Poki was on when it last ran; it turns itself on again at launch.
    private var wantsOn: Bool {
        get { UserDefaults.standard.bool(forKey: "wantsOn") }
        set { UserDefaults.standard.set(newValue, forKey: "wantsOn") }
    }
    /// The setup step the Live Activity is guiding, if any.
    private(set) var guiding: SetupStep?
    private var lastAgentActivity = Date()
    private var idleTimer: Timer?
    private var launcherConfig: LauncherConfig?

    private let host = AppCoreHost()
    private let core: LiveCore
    private let launcher: RunnerLauncher
    private let pairer: DevicePairing
    private let activity = ActivityController()
    let log = AppLog.shared
    private var eventsTask: Task<Void, Never>?

    init() {
        core = LiveCore(host: host)
        let launcher = RustLauncher()
        self.launcher = launcher
        pairer = RustPairing()
        host.update(key: identity.signingKey, hashes: identity.accessHashes)
        // PokiCore asks for a restart after two silent requests in a row. A slow gesture can be one of
        // them while the runner is fine, so the runner is asked first; only a runner that does not
        // answer is started again (each restart costs seconds and flashes the automation banner).
        host.onRestart {
            Task.detached {
                let answers = await RunnerProbe.answers()
                await MainActor.run { AppLog.shared.add("runner", answers ? "PokiCore asked for a restart; the runner answers, so it was kept" : "PokiCore asked for a restart; the runner does not answer: restarting it") }
                if !answers { launcher.restart() }
            }
        }
        host.onWake { [weak self] in Task { @MainActor in self?.wakeRunner() } }
        listenForApprovals()
        if !diskImage.isReady { Task { await diskImage.download() } }
        if UserDefaults.standard.bool(forKey: "pokiSample") { loadSample() }
        NotificationCenter.default.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.appWillTerminate() }
        }
    }

    /// Poki came to the front: turn on again if it was on, check the loopback live, and finish a
    /// setup step the person just did in Settings.
    func becameActive() {
        loopback.resume()
        if wantsOn, !sessionOn, setup.pairingFile != nil, diskImage.isReady { startSession() }
        if let step = guiding, isDone(step) { stopGuide() }
    }

    func wentToBackground() { loopback.pause() }

    /// Poki is being closed: end the runner now (the launcher kills its process) instead of leaving
    /// iOS's automation banner up for half a minute. iOS gives a few seconds for this.
    private func appWillTerminate() {
        guard sessionOn else { return }
        log.add("app", "Poki is closing: ending the runner")
        launcher.stop()
        Thread.sleep(forTimeInterval: 2.5)
    }

    var deviceName: String { UIDevice.current.name }

    /// `-pokiSample YES`: sample steps and an approval, only for the build's screenshots of the home
    /// screen. Nothing is started.
    private func loadSample() {
        let now = Date()
        recentSteps = [
            RecentStep(text: "Open WeChat", detail: "In WeChat", ok: true, at: now.addingTimeInterval(-70)),
            RecentStep(text: "Tap “Search”, then type “Mom”", detail: "In WeChat", ok: true, at: now.addingTimeInterval(-52)),
            RecentStep(text: "Tap at 212, 640", detail: "In WeChat · Didn't go through", ok: false, at: now.addingTimeInterval(-30)),
            RecentStep(text: "Type “On my way”", detail: "In WeChat", ok: true, at: now.addingTimeInterval(-12)),
        ]
        approvals = [PendingApproval(id: "sample", app: "WeChat", summary: "Tap “Send”", expires: now.addingTimeInterval(45))]
    }

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
        log.add("session", "turned on")
        background.start()
        ApprovalNotice.requestPermission()
        stopGuide()
        activity.start(deviceName: deviceName)
        sessionOn = true
        wantsOn = true
        launcherConfig = LauncherConfig(pairing_file: pairing, ddi_dir: AppFiles.ddiDirectory.path)
        lastAgentActivity = Date()
        // The runner (and with it iOS's automation banner) starts only when an agent asks.
        standBy(reason: nil)
        core.start()
        idleTimer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in Task { @MainActor in self?.checkIdle() } }
        eventsTask = Task { [weak self, core] in
            for await event in core.events { self?.handle(event) }
        }
    }

    func stopSession() {
        guard sessionOn else { return }
        wantsOn = false
        log.add("session", "turned off: ending the runner")
        core.stop()
        launcher.stop()
        confirmRunnerEnded()
        idleTimer?.invalidate(); idleTimer = nil
        runnerPaused = false; host.setPaused(false)
        eventsTask?.cancel(); eventsTask = nil
        background.stop()
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
        log.add("runner", "stopping: \(reason)")
        launcher.stop()
        standBy(reason: reason)
        confirmRunnerEnded()
    }

    /// After a stop, checks that the runner really ended (and with it the automation banner). If it
    /// still answers after 8 s, says so on the home screen and in the log instead of looking stopped.
    private func confirmRunnerEnded() {
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(8))
            let alive = await RunnerProbe.answers()
            guard let self else { return }
            if alive, self.runnerPaused || !self.sessionOn {
                self.log.add("runner", "still answering 8 s after Stop")
                self.problem = "Poki Runner is still running after Stop. Swipe it away in the app switcher; the banner goes with it."
            } else {
                self.log.add("runner", alive ? "running again (an agent asked)" : "ended")
                if self.problem?.hasPrefix("Poki Runner is still running") == true { self.problem = nil }
            }
        }
    }

    /// The runner is off and starts on the next agent request.
    private func standBy(reason: String?) {
        runnerPaused = true
        runner = RunnerStatus(state: "standby", detail: reason.map { "\($0). It starts again when an agent asks." } ?? "It starts when an agent asks.")
        host.update(runner: .starting("starting the runner"))
        host.setPaused(true)
        activityText = "Idle"
        activity.update { $0.runnerPaused = true; $0.phase = .idle; $0.headline = "Waiting for an agent"; $0.since = nil }
    }

    /// Starts a paused runner again (the next agent request, or the owner).
    func wakeRunner() {
        guard sessionOn, runnerPaused else { return }
        runnerPaused = false
        host.setPaused(false)
        lastAgentActivity = Date()
        log.add("runner", "an agent asked: starting the runner")
        activity.update { $0.runnerPaused = false; $0.phase = .working; $0.headline = "Starting the runner"; $0.since = Date() }
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
        if status != runner { log.add("runner", "\(status.state)\(status.detail.map { ": \($0)" } ?? "")") }
        runner = status
        host.update(runner: status.coreState)
        if status.state == "failed" {
            activity.update { $0.phase = .problem; $0.headline = status.fix ?? status.detail ?? "The runner stopped" }
        } else if !status.isRunning {
            activity.update { $0.phase = .idle; $0.headline = status.title }
        } else if activity.state.phase == .problem || activity.state.phase == .idle || activity.state.headline == "Starting the runner" {
            activity.update { $0.phase = .idle; $0.headline = "Ready for the agent" }
        }
    }

    private func handle(_ event: ShellEvent) {
        switch event {
        case .relay(let status):
            if status != relayStatus { log.add("relay", "\(status)") }
            relayStatus = status
        case .toolStarted(_, let summary):
            lastAgentActivity = Date()
            activityText = summary
            log.add("agent", "started: \(summary)")
            activity.update { state in
                if state.approval == nil {
                    if state.phase != .working || state.since == nil { state.since = Date() }
                    state.phase = .working
                }
                state.headline = summary
            }
        case .toolFinished(let summary, let delivery, let app, let thumbnail):
            lastAgentActivity = Date()
            lastAction = "\(summary) · \(delivery)"
            activityText = "Idle"
            let failed = delivery.hasPrefix("failed")
            log.add("agent", "\(failed ? "failed" : "done"): \(summary) · \(delivery.prefix(160))")
            let place = app.map { "In \($0)" }
            let detail = failed ? ([place, "Didn't go through"].compactMap { $0 }.joined(separator: " · ")) : (place ?? "Done")
            recentSteps.append(RecentStep(text: summary, detail: detail, ok: !failed, at: Date()))
            if recentSteps.count > 20 { recentSteps.removeFirst(recentSteps.count - 20) }
            activity.record(step: summary, ok: !failed)
            activity.update { state in
                state.lastAction = summary
                state.app = app ?? state.app
                if state.approval == nil { state.headline = "Waiting for the agent's next step" }
            }
            activity.setThumbnail(thumbnail)
        case .approvalRequested(let approval):
            approvals.append(approval)
            log.add("approval", "requested \(approval.id) in \(approval.app): \(approval.summary)")
            activity.update { $0.phase = .approval; $0.approval = approval; $0.headline = "Allow this step?" }
            activity.alert(title: "Poki needs your OK", body: "\(approval.summary) in \(approval.app)")
            ApprovalNotice.post(approval)
        case .approvalEnded(let id, _):
            approvals.removeAll { $0.id == id }
            log.add("approval", "ended \(id): \(approved.map { $0 ? "approved" : "denied" } ?? "expired or replaced")")
            ApprovalNotice.clear(id)
            activity.update { state in
                if state.approval?.id == id { state.approval = nil; state.phase = .working; state.headline = approved == true ? "Approved. Continuing" : "Not allowed" }
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
        // Started now, while Poki is in front: the PIN arrives while the person is in Settings, when
        // iOS no longer lets Poki start a Live Activity.
        activity.start(deviceName: deviceName)
        activity.update { $0.phase = .pairing; $0.pin = nil; $0.headline = "Pair in Settings" }
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
            activity.update { $0.phase = .pairing; $0.pin = pin; $0.headline = "Pairing code" }
        case .paired(let url):
            try? (url as NSURL).setResourceValue(URLFileProtection.completeUntilFirstUserAuthentication, forKey: .fileProtectionKey)
            setup.pairingFile = url.path
            activity.update { $0.phase = .idle; $0.pin = nil; $0.headline = "Paired" }
            if !sessionOn { Task { try? await Task.sleep(for: .seconds(4)); if !self.sessionOn { self.activity.end() } } }
        case .failed(let why):
            activity.update { $0.phase = .problem; $0.pin = nil; $0.headline = "Pairing failed: \(why)" }
            if !sessionOn { Task { try? await Task.sleep(for: .seconds(8)); if !self.sessionOn { self.activity.end() } } }
        case .advertising: break
        }
    }

    // MARK: Setup guide

    /// The person is going to Settings for a setup step: the Live Activity shows the step and what to
    /// tap, so it stays in view there. Ended when they come back and the step is done.
    func guide(_ step: SetupStep) {
        guiding = step
        guard !sessionOn else { return }
        activity.start(deviceName: deviceName)
        let steps = SetupStep.allCases
        activity.update {
            $0.phase = .setup
            $0.headline = "Setting up Poki"
            $0.guide = .init(number: (steps.firstIndex(of: step) ?? 0) + 1, count: steps.count, title: step.title, hint: step.hint)
        }
    }

    func stopGuide() {
        guard guiding != nil else { return }
        guiding = nil
        activity.update { $0.guide = nil }
        if !sessionOn, activity.state.phase == .setup { activity.end() }
    }

    func isDone(_ step: SetupStep) -> Bool {
        switch step {
        case .runner: setup.runnerInstalled
        case .developerMode: setup.developerMode
        case .loopback: loopback.isWorking || setup.loopbackChosen
        case .pairing: setup.pairingFile != nil && diskImage.isReady
        case .automation: setup.uiAutomation
        case .background: background.allowed && activity.enabled
        }
    }

    var setupComplete: Bool { SetupStep.allCases.allSatisfy(isDone) }

    var activityProblem: String? { activity.lastError }

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

/// Whether WebDriverAgent answers /status right now (2 s at most).
enum RunnerProbe {
    static func answers() async -> Bool {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:8100/status")!, timeoutInterval: 2)
        request.httpMethod = "GET"
        let configuration = URLSessionConfiguration.ephemeral
        configuration.connectionProxyDictionary = [:]
        guard let (_, response) = try? await URLSession(configuration: configuration).data(for: request) else { return false }
        return (response as? HTTPURLResponse)?.statusCode == 200
    }
}
