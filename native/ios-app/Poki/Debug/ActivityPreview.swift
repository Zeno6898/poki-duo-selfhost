import ActivityKit
import SwiftUI

/// The Live Activity in every phase, drawn with the widget's own views at the system's sizes (Lock
/// Screen 371 x up to 160, expanded island 371 wide, compact island), so it can be checked without a
/// session. Debug > Live Activity.
///
/// For the build's screenshots: `-pokiScreen activity -pokiActivityState approval` shows one phase on
/// its own, and `-pokiActivityDemo approval` also starts a real Live Activity in that phase and, six
/// seconds later, sends it an alert, so the simulator draws the real Lock Screen and Dynamic Island.
struct ActivityPreview: View {
    private let only = UserDefaults.standard.string(forKey: "pokiActivityState")
    private let demo = UserDefaults.standard.string(forKey: "pokiActivityDemo")

    init() { if Thumbnail.previewImage == nil { Thumbnail.previewImage = Self.sampleScreen() } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 28) {
                ForEach(Self.samples.filter { only == nil || $0.0 == only }, id: \.0) { name, state in
                    VStack(alignment: .leading, spacing: 10) {
                        Text(name).font(.footnote.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase)
                        LockScreenFrame(state: state)
                        IslandExpandedFrame(state: state)
                        IslandCompactFrame(state: state)
                    }
                }
            }
            .padding(.vertical).padding(.horizontal, 16)
            .frame(maxWidth: .infinity)
        }
        .background(LinearGradient(colors: [Color(red: 0.32, green: 0.36, blue: 0.55), Color(red: 0.75, green: 0.55, blue: 0.5)], startPoint: .top, endPoint: .bottom).ignoresSafeArea())
        .navigationTitle("Live Activity")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if let demo, let state = Self.samples.first(where: { $0.0 == demo })?.1 {
                // Detached: going to the background must not cancel the demo's wait for its alert.
                Task.detached { await DemoActivity.run(state) }
            }
        }
    }

    /// Sample states, one per thing the Live Activity can show.
    static let samples: [(String, PokiState)] = {
        let now = Date()
        var start = PokiState(phase: .working, headline: "Open WeChat", thumbnailVersion: 0)
        start.since = now.addingTimeInterval(-3)
        start.event = .init(kind: .started, text: "Started")

        var working = PokiState(phase: .working, headline: "Tap “Send”", thumbnailVersion: 1)
        working.app = "WeChat"
        working.since = now.addingTimeInterval(-42)
        working.stepCount = 6; working.failedCount = 1
        working.steps = [.init(text: "Type “On my way” in the message box", ok: true), .init(text: "Tap at 212, 640", ok: false)]
        working.event = .init(kind: .app, text: "Now in WeChat")

        var approval = PokiState(phase: .approval, headline: "Allow this step?", thumbnailVersion: 1)
        approval.app = "Messages"
        approval.approval = PendingApproval(id: "a", app: "Messages", summary: "Send “On my way” to Mom", expires: now.addingTimeInterval(25))
        approval.approvalSince = now.addingTimeInterval(-5)
        approval.since = now.addingTimeInterval(-61)
        approval.stepCount = 4

        var done = PokiState(phase: .done, headline: "Finished in Messages", thumbnailVersion: 1)
        done.app = "Messages"
        done.since = now.addingTimeInterval(-84); done.endedAt = now
        done.stepCount = 12; done.failedCount = 1
        done.event = .init(kind: .finished, text: "Finished")

        var ready = PokiState(phase: .idle, headline: "Ready for the agent", thumbnailVersion: 0)
        var idle = PokiState(phase: .idle, headline: "Waiting for an agent", thumbnailVersion: 0)
        idle.runnerPaused = true
        ready.runnerPaused = false

        var problem = PokiState(phase: .problem, headline: "Turn on the loopback in your proxy app", thumbnailVersion: 0)
        problem.event = .init(kind: .problem, text: "Runner stopped")

        let pairWait = PokiState(phase: .pairing, headline: "Pair in Settings", thumbnailVersion: 0)
        var pairCode = PokiState(phase: .pairing, headline: "Pairing code", thumbnailVersion: 0)
        pairCode.pin = "482913"

        var setup = PokiState(phase: .setup, headline: "Setting up Poki", thumbnailVersion: 0)
        setup.guide = .init(number: 2, count: 6, title: SetupStep.developerMode.title, hint: SetupStep.developerMode.hint)

        return [("start", start), ("working", working), ("approval", approval), ("done", done), ("ready", ready), ("idle", idle),
                ("problem", problem), ("pairing", pairWait), ("code", pairCode), ("setup", setup)]
    }()

    /// A stand-in screenshot (a chat screen) for the thumbnail, drawn here so the preview needs no files.
    @MainActor static func sampleScreen() -> UIImage? {
        let view = VStack(alignment: .leading, spacing: 10) {
            Capsule().fill(.gray.opacity(0.4)).frame(width: 70, height: 10)
            ForEach(0..<5) { i in
                HStack {
                    if i % 2 == 0 { Spacer() }
                    RoundedRectangle(cornerRadius: 10).fill(i % 2 == 0 ? Color.green : Color(white: 0.85)).frame(width: 90, height: 26)
                    if i % 2 == 1 { Spacer() }
                }
            }
            Spacer()
            RoundedRectangle(cornerRadius: 12).fill(Color(white: 0.9)).frame(height: 28)
        }
        .padding(14).frame(width: 196, height: 426).background(.white)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 1
        return renderer.uiImage
    }
}

/// The Lock Screen presentation as iOS lays it out: 371 points wide, the widget's padding and tint.
private struct LockScreenFrame: View {
    var state: PokiState
    var body: some View {
        LockScreenView(state: state)
            .padding(.horizontal, 14).padding(.vertical, 12)
            .frame(maxWidth: 371)
            .background(Brand.night.opacity(0.94), in: .rect(cornerRadius: 24, style: .continuous))
            .overlay(alignment: .bottomTrailing) { HeightBadge() }
            .environment(\.colorScheme, .dark)
    }
}

/// The expanded island, regions placed the way iOS does: leading and trailing beside the camera,
/// the bottom region under them, 14 point margins.
private struct IslandExpandedFrame: View {
    var state: PokiState
    var body: some View {
        VStack(spacing: 6) {
            HStack(alignment: .center) {
                IslandLeading(state: state).frame(height: 36)
                Spacer(minLength: 120)
                IslandTrailing(state: state).frame(height: 36)
            }
            IslandBottom(state: state)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 14).padding(.top, 14).padding(.bottom, 16)
        .frame(maxWidth: 371)
        .background(.black, in: .rect(cornerRadius: 44, style: .continuous))
        .overlay(alignment: .top) { Capsule().fill(Color(white: 0.08)).frame(width: 120, height: 36).padding(.top, 11) }
        .environment(\.colorScheme, .dark)
    }
}

/// The compact island: leading, the camera, trailing, and the minimal circle beside it.
private struct IslandCompactFrame: View {
    var state: PokiState
    var body: some View {
        HStack(spacing: 12) {
            HStack(spacing: 0) {
                CompactLeading(state: state).frame(width: 44, alignment: .leading)
                Color.clear.frame(width: 120)
                CompactTrailing(state: state).frame(minWidth: 44, alignment: .trailing)
            }
            .padding(.horizontal, 10).frame(height: 37)
            .background(.black, in: .capsule)
            MinimalView(state: state).frame(width: 37, height: 37).background(.black, in: .circle)
        }
        .environment(\.colorScheme, .dark)
    }
}

/// Shows the Lock Screen view's height, red over the system's 160 point limit.
private struct HeightBadge: View {
    var body: some View {
        GeometryReader { proxy in
            let height = Int(proxy.size.height.rounded())
            Text("\(height) pt").font(.caption2.monospacedDigit().bold())
                .padding(.horizontal, 5).padding(.vertical, 2)
                .background(height > 160 ? Color.red : Color.white.opacity(0.15), in: .capsule)
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                .offset(x: 0, y: 22)
        }
    }
}

/// A real Live Activity in one sample phase, for the simulator screenshots.
@MainActor
enum DemoActivity {
    static func run(_ sample: PokiState) async {
        for old in Activity<PokiActivityAttributes>.activities { await old.end(nil, dismissalPolicy: .immediate) }
        if let url = SharedContainer.thumbnailURL, let jpeg = ActivityPreview.sampleScreen()?.jpegData(compressionQuality: 0.7) {
            try? jpeg.write(to: url, options: .atomic)
        }
        var state = sample
        // Times relative to now, so countdowns are live in the screenshots: elapsed starts at 0:00 and
        // an approval has two minutes, which also shows any clock difference between app and widget.
        let now = Date()
        if state.since != nil { state.since = now }
        if let end = state.endedAt, let since = sample.since { state.endedAt = now; state.since = now.addingTimeInterval(-end.timeIntervalSince(since)) }
        if var approval = state.approval {
            approval.expires = now.addingTimeInterval(120); state.approval = approval
            state.approvalSince = now.addingTimeInterval(-30)
        }
        // Poki keeps running in the background while it is on; the demo asks for time to send its alert.
        let task = UIApplication.shared.beginBackgroundTask(withName: "activity demo")
        defer { UIApplication.shared.endBackgroundTask(task) }
        guard let activity = try? Activity.request(attributes: PokiActivityAttributes(deviceName: "iPhone"), content: .init(state: state, staleDate: nil), pushType: nil) else {
            AppLog.shared.add("activity", "demo did not start")
            return
        }
        // Each `notifyutil -p nz.zheha.poki.demo-alert` from the build sends an alert, so the
        // screenshot is taken right after it (simulator screenshots take seconds; fixed delays miss it).
        let center = CFNotificationCenterGetDarwinNotifyCenter()
        CFNotificationCenterAddObserver(center, UnsafeRawPointer(bitPattern: 0x5051), { _, _, _, _, _ in
            Task { @MainActor in await DemoActivity.alert() }
        }, "nz.zheha.poki.demo-alert" as CFString, nil, .deliverImmediately)
        current = (activity, state)
        try? await Task.sleep(for: .seconds(28))
    }

    private static var current: (Activity<PokiActivityAttributes>, PokiState)?

    static func alert() async {
        guard let (activity, state) = current else { return }
        await activity.update(.init(state: state, staleDate: nil, relevanceScore: 100),
                              alertConfiguration: AlertConfiguration(title: "Poki", body: "\(state.headline)", sound: .default))
        AppLog.shared.add("activity", "demo alert sent")
    }
}
