import ActivityKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Runs the one Live Activity: started when a session starts, updated from PokiCore's events, ended
/// when the session stops.
///
/// AppModel only describes the state (`update`, `record`); this class decides what deserves a pop-up.
/// It compares each new state with the last one and, for the moments that matter, sends the update with
/// an `AlertConfiguration`, which lights the screen, expands the Dynamic Island and plays a sound:
///
/// - approval asked (always, never throttled): the screen lights even when locked;
/// - a run starts, the agent moves to another app, a run finishes (quiet for `finishAfter`);
/// - a problem, a pairing code, paired.
///
/// The ordinary pop-ups are spaced at least `alertSpacing` apart so a busy agent does not buzz the
/// phone on every step. Updates are sent one after another, in order, so an alert is never overtaken
/// by an older update.
@MainActor
final class ActivityController {
    private var activity: Activity<PokiActivityAttributes>?
    private(set) var state = PokiActivityAttributes.ContentState(phase: .idle, headline: "Ready", thumbnailVersion: 0)
    private(set) var lastError: String?

    /// After this long without a new step, a run of steps counts as finished.
    var finishAfter: Duration = .seconds(15)

    /// How long an event tag stays on the Live Activity.
    private let eventLifetime: Duration = .seconds(6)
    private let alertSpacing: TimeInterval = 8

    private var lastAlert = Date.distantPast
    private var lastSent = Date.distantPast
    private let minimumGap: TimeInterval = 1
    private var deferred: Task<Void, Never>?
    private var sending: Task<Void, Never>?
    private var finishTimer: Task<Void, Never>?
    private var eventTimer: Task<Void, Never>?
    private var alertedApproval: String?
    private var inStep = false
    private var runAnnounced = false
    private var justRecorded = false

    var enabled: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    var isRunning: Bool { activity != nil }

    /// Starts the Live Activity if it is not running. iOS only allows this while Poki is in front, so
    /// it is called when the person taps something (Start, Start pairing, a setup step), never later
    /// from the background.
    func start(deviceName: String) {
        guard activity == nil else { return }
        guard enabled else { lastError = "Live Activities are off for Poki (Settings > Poki > Live Activities)."; return }
        // A Live Activity left from an earlier run of the app is replaced.
        for old in Activity<PokiActivityAttributes>.activities { Task { await old.end(nil, dismissalPolicy: .immediate) } }
        do {
            let started = try Activity.request(attributes: PokiActivityAttributes(deviceName: deviceName), content: content(), pushType: nil)
            activity = started
            lastError = nil
            // Dismissed by the person (swiped away) or ended by iOS: start again next time.
            Task { [weak self] in
                for await state in started.activityStateUpdates where state == .dismissed || state == .ended {
                    await MainActor.run { if self?.activity?.id == started.id { self?.activity = nil } }
                }
            }
        } catch { lastError = "The Live Activity did not start: \(error.localizedDescription)" }
    }

    /// Adds an action to the recent steps (three at most, each kept short for the 4 KB limit) and
    /// counts it for the run's summary.
    func record(step text: String, ok: Bool) {
        update { state in
            state.steps.append(.init(text: String(text.prefix(80)), ok: ok))
            if state.steps.count > 3 { state.steps.removeFirst(state.steps.count - 3) }
            state.stepCount += 1
            if !ok { state.failedCount += 1 }
        }
        justRecorded = true
    }

    func end() {
        finishTimer?.cancel(); eventTimer?.cancel(); deferred?.cancel(); deferred = nil
        guard let activity else { return }
        self.activity = nil
        state.steps = []; state.guide = nil; state.pin = nil; state.since = nil; state.event = nil
        state.stepCount = 0; state.failedCount = 0; state.endedAt = nil
        let previous = sending
        sending = Task { await previous?.value; await activity.end(nil, dismissalPolicy: .immediate) }
    }

    func update(_ change: (inout PokiActivityAttributes.ContentState) -> Void) {
        let old = state
        change(&state)
        let alert = transition(from: old)
        send(alert: alert)
    }

    /// Kept for AppModel's approval call; the approval's pop-up already went out with its update, so
    /// this only alerts when that one did not (no approval in the state).
    func alert(title: String, body: String) {
        if state.approval?.id == alertedApproval, alertedApproval != nil { return }
        send(alert: AlertConfiguration(title: "\(title)", body: "\(body)", sound: .default))
    }

    /// Writes a thumbnail, at most about 160 points wide, to the App Group container for the widget.
    func setThumbnail(_ jpeg: Data?) {
        guard let jpeg, let url = SharedContainer.thumbnailURL, let small = Self.shrink(jpeg, maxPixels: 260) else { return }
        try? small.write(to: url, options: .atomic)
        update { $0.thumbnailVersion += 1 }
    }

    // MARK: Transitions

    /// Fills in what the app does not track (run counters, the approval's start, the event tag) and
    /// returns the pop-up this change deserves, if any.
    private func transition(from old: PokiState) -> AlertConfiguration? {
        var alert: AlertConfiguration?
        let now = Date()

        // A new run of steps: from anything that is not already a run.
        let runPhases: Set<PokiState.Phase> = [.working, .approval]
        if state.phase == .working, !runPhases.contains(old.phase) {
            state.stepCount = 0; state.failedCount = 0; state.endedAt = nil; state.steps = []
            if state.since == nil { state.since = now }
            let place = state.app.map { String(localized: "Working in \($0)") } ?? String(localized: "Your agent is using this iPhone")
            // The runner's start and the agent's first step are one start, not two pop-ups.
            if !runAnnounced {
                runAnnounced = true
                setEvent(.started, String(localized: "Started"))
                alert = ordinary(String(localized: "Agent started"), place)
            }
        }
        if state.phase == .done || state.phase == .idle && state.runnerPaused || state.phase == .pairing || state.phase == .setup {
            runAnnounced = false
        }
        // Into another app mid-run.
        if runPhases.contains(state.phase), let app = state.app, let before = old.app, app != before {
            setEvent(.app, String(localized: "Now in \(app)"))
            alert = alert ?? ordinary(String(localized: "Now in \(app)"), state.steps.last?.text ?? String(localized: "Your agent switched apps"))
        }
        // Approval: always pops up and lights the screen.
        if let approval = state.approval, approval.id != old.approval?.id {
            state.approvalSince = now
            alertedApproval = approval.id
            alert = critical(String(localized: "Allow this step?"), "\(approval.summary) · \(approval.app)")
        }
        if state.approval == nil, let was = old.approval {
            state.approvalSince = nil
            let approved = state.headline.hasPrefix("Approved")
            let expired = !approved && was.expires <= now.addingTimeInterval(0.5)
            setEvent(approved ? .approved : expired ? .expired : .denied, approved ? String(localized: "Allowed") : expired ? String(localized: "Timed out") : String(localized: "Denied"))
        }
        if state.phase == .problem, old.phase != .problem {
            setEvent(.problem, String(localized: "Problem"))
            alert = critical(String(localized: "Poki needs attention"), state.headline)
        }
        if let pin = state.pin, pin != old.pin {
            setEvent(.code, String(localized: "Code ready"))
            alert = critical(String(localized: "Pairing code \(pin)"), String(localized: "Type it on the Pair with Poki screen in Settings"))
        }
        if old.phase == .pairing, state.phase == .idle, state.headline == "Paired" {
            setEvent(.paired, String(localized: "Paired"))
            alert = critical(String(localized: "Paired"), String(localized: "This iPhone is ready for Poki"))
        }

        // The finish timer: re-armed by every change during a run. A headline change that is not the
        // one right after a step (AppModel's "waiting for the next step") means a step began, and a run
        // never finishes in the middle of a step, however long it takes.
        if state.phase == .working, old.phase == .working, state.headline != old.headline, state.stepCount == old.stepCount {
            if justRecorded { justRecorded = false } else { inStep = true }
        }
        if state.stepCount != old.stepCount { inStep = false }
        if state.phase == .working, state.approval == nil, state.stepCount > 0 { armFinish() } else { finishTimer?.cancel() }
        return alert
    }

    private func armFinish() {
        finishTimer?.cancel()
        let count = state.stepCount
        finishTimer = Task { [weak self, finishAfter] in
            try? await Task.sleep(for: finishAfter)
            guard !Task.isCancelled else { return }
            self?.finishRun(ifCount: count)
        }
    }

    private func finishRun(ifCount count: Int) {
        guard state.phase == .working, state.approval == nil, !inStep, state.stepCount == count, count > 0 else { return }
        state.phase = .done
        runAnnounced = false
        state.endedAt = Date()
        state.headline = state.app.map { String(localized: "Finished in \($0)") } ?? String(localized: "Finished")
        setEvent(.finished, String(localized: "Finished"))
        let summary = state.runSummary
        send(alert: ordinary(String(localized: "Agent finished"), summary))
    }

    private func setEvent(_ kind: PokiActivityAttributes.Event.Kind, _ text: String) {
        state.event = .init(kind: kind, text: text)
        eventTimer?.cancel()
        let shown = state.event
        eventTimer = Task { [weak self, eventLifetime] in
            try? await Task.sleep(for: eventLifetime)
            guard !Task.isCancelled, let self, self.state.event == shown else { return }
            self.state.event = nil
            self.send(alert: nil)
        }
    }

    private func ordinary(_ title: String, _ body: String) -> AlertConfiguration? {
        let now = Date()
        guard now.timeIntervalSince(lastAlert) >= alertSpacing else { return nil }
        lastAlert = now
        return AlertConfiguration(title: "\(title)", body: "\(body)", sound: .default)
    }

    private func critical(_ title: String, _ body: String) -> AlertConfiguration {
        lastAlert = Date()
        return AlertConfiguration(title: "\(title)", body: "\(body)", sound: .default)
    }

    // MARK: Sending

    /// Sends the state. Alerts go out at once; plain updates are coalesced to at most one a second
    /// (the latest state wins), which keeps a fast agent inside ActivityKit's update budget.
    private func send(alert: AlertConfiguration?) {
        guard activity != nil else { return }
        if alert == nil {
            let wait = minimumGap - Date().timeIntervalSince(lastSent)
            if wait > 0 {
                if deferred == nil {
                    deferred = Task { [weak self] in
                        try? await Task.sleep(for: .seconds(wait))
                        guard !Task.isCancelled, let self else { return }
                        self.deferred = nil
                        self.push(alert: nil)
                    }
                }
                return
            }
        }
        deferred?.cancel(); deferred = nil
        push(alert: alert)
    }

    private func push(alert: AlertConfiguration?) {
        guard let activity else { return }
        lastSent = Date()
        trimToFit()
        let content = content()
        let previous = sending
        sending = Task {
            await previous?.value
            if let alert { await activity.update(content, alertConfiguration: alert) } else { await activity.update(content) }
        }
    }

    /// ActivityKit refuses a state over 4 KB. Ours is far smaller, but long step texts from an agent
    /// are cut first, then the older steps dropped, so an update is never lost to size.
    private func trimToFit() {
        func size() -> Int { (try? JSONEncoder().encode(state).count) ?? 0 }
        guard size() > 3_500 else { return }
        state.steps = state.steps.map { .init(text: String($0.text.prefix(40)), ok: $0.ok) }
        state.headline = String(state.headline.prefix(80))
        while size() > 3_500, !state.steps.isEmpty { state.steps.removeFirst() }
    }

    private func content() -> ActivityContent<PokiActivityAttributes.ContentState> {
        // Approvals are urgent; everything else is not. An approval goes stale when it expires.
        ActivityContent(state: state, staleDate: state.approval?.expires, relevanceScore: state.approval == nil ? 50 : 100)
    }

    private static func shrink(_ data: Data, maxPixels: Int) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: maxPixels] as CFDictionary) else { return nil }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.6] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? out as Data : nil
    }
}
