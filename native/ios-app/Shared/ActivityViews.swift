import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// The Live Activity's views, shared so the app can draw them too (Debug > Live Activity preview, and
/// the build's screenshots).
///
/// One layout idea for every phase, so the activity always reads the same way:
///
///     [bear] Poki · WeChat                [status]   [screen]
///     Headline, the one thing to know                [ of  ]
///     detail: last steps, code, hint                 [phone]
///     [footer: step count · time ............ action]
///
/// The right column is the phone's latest screen while the agent works (or a step counter, a setup
/// ring, a countdown), so the full width is used and the text column never has to wrap a status word.
/// Approvals put Deny and Allow full width under it. Everything stays inside 160 points tall on the
/// Lock Screen, the system's limit.

typealias PokiState = PokiActivityAttributes.ContentState

enum Brand {
    static let blue = Color(red: 0x20 / 255, green: 0x84 / 255, blue: 0xFD / 255)
    /// The Live Activity's own background, so it reads the same on any wallpaper.
    static let night = Color(red: 0.04, green: 0.06, blue: 0.11)
    static let approval = Color(red: 1.0, green: 0.62, blue: 0.04)
    static let done = Color(red: 0.19, green: 0.82, blue: 0.35)
    static let problem = Color(red: 1.0, green: 0.80, blue: 0.0)
}

extension PokiState {
    /// The phase's accent colour.
    var accent: Color {
        switch phase {
        case .working, .pairing, .setup: Brand.blue
        case .approval: Brand.approval
        case .problem: Brand.problem
        case .done: Brand.done
        case .idle: runnerPaused ? Color(white: 0.62) : Brand.done
        }
    }
    /// One word, so the pill never wraps.
    var status: String {
        switch phase {
        case .working: "Working"
        case .approval: "Approve"
        case .pairing: "Pairing"
        case .setup: "Setup"
        case .problem: "Problem"
        case .done: "Done"
        case .idle: runnerPaused ? "Idle" : "Ready"
        }
    }
    var symbol: String {
        switch phase {
        case .working: "hand.tap.fill"
        case .approval: "hand.raised.fill"
        case .pairing: "link"
        case .setup: "checklist"
        case .problem: "exclamationmark.triangle.fill"
        case .done: "checkmark.circle.fill"
        case .idle: runnerPaused ? "moon.zzz.fill" : "checkmark.circle.fill"
        }
    }
    var hasThumbnail: Bool { thumbnailVersion > 0 }
    /// The app line next to "Poki" in the header, only when it means something.
    var appLine: String? {
        switch phase {
        case .working, .approval, .done: app
        default: nil
        }
    }
    var runSummary: String {
        let steps = "\(stepCount) step\(stepCount == 1 ? "" : "s")"
        return failedCount > 0 ? "\(steps) · \(failedCount) missed" : steps
    }
}

extension PokiActivityAttributes.Event {
    var symbol: String {
        switch kind {
        case .started: "play.fill"
        case .app: "arrow.right.circle.fill"
        case .finished: "checkmark.circle.fill"
        case .approved: "checkmark.seal.fill"
        case .denied: "xmark.circle.fill"
        case .expired: "clock.badge.xmark"
        case .problem: "exclamationmark.triangle.fill"
        case .paired: "link.circle.fill"
        case .code: "number.circle.fill"
        }
    }
    var color: Color {
        switch kind {
        case .started, .app, .code: Brand.blue
        case .finished, .approved, .paired: Brand.done
        case .denied, .expired: Color(white: 0.75)
        case .problem: Brand.problem
        }
    }
}

// MARK: Lock Screen

/// Lock Screen and banner presentation. The widget pads it 14 by 12 points (HIG: 14 point margins),
/// which leaves 136 points for the content under the 160 point limit.
struct LockScreenView: View {
    var state: PokiState

    var body: some View {
        Group {
            switch state.phase {
            case .approval: ApprovalLayout(state: state, island: false)
            case .pairing: PairingLayout(state: state, island: false)
            case .setup: SetupLayout(state: state, island: false)
            default: RunLayout(state: state, island: false)
            }
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The top line: the bear, Poki, the app in use, and the status pill (or something better on the
/// right, such as the approval countdown).
struct Header<Trailing: View>: View {
    var state: PokiState
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 7) {
            BearMark(size: 20)
            Text("Poki").font(.system(size: 14, weight: .semibold))
                .layoutPriority(2)
            if let app = state.appLine {
                Text(app).font(.system(size: 14)).foregroundStyle(.white.opacity(0.55))
                    .lineLimit(1).truncationMode(.tail)
            }
            Spacer(minLength: 6)
            trailing.layoutPriority(3)
        }
        .lineLimit(1)
        .frame(height: 22)
    }
}

extension Header where Trailing == StatusPill {
    init(state: PokiState) { self.init(state: state) { StatusPill(state: state) } }
}

struct StatusPill: View {
    var state: PokiState
    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: state.symbol).font(.system(size: 10, weight: .bold))
            Text(state.status).font(.system(size: 12, weight: .semibold))
        }
        .lineLimit(1).fixedSize()
        .padding(.horizontal, 8).frame(height: 22)
        .foregroundStyle(state.accent)
        .background(state.accent.opacity(0.18), in: .capsule)
    }
}

/// The short-lived event tag ("Started", "Now in WeChat"), in place of nothing when there is none.
struct EventTag: View {
    var event: PokiActivityAttributes.Event
    var body: some View {
        Label { Text(event.text).lineLimit(1) } icon: { Image(systemName: event.symbol) }
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(event.color)
            .labelStyle(.titleAndIcon)
    }
}

// MARK: Working, done, idle, problem

struct RunLayout: View {
    var state: PokiState
    var island: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 0) {
                if !island { Header(state: state).padding(.bottom, 8) }
                if let event = state.event { EventTag(event: event).padding(.bottom, 2) }
                Text(state.headline)
                    .font(.system(size: island ? 16 : 17, weight: .semibold))
                    .foregroundStyle(state.phase == .problem ? Brand.problem : .white)
                    .lineLimit(2).minimumScaleFactor(0.85)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, 5)
                detail
                Spacer(minLength: 6)
                footer
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            side
        }
        .frame(height: island ? 104 : 128)
    }

    @ViewBuilder private var detail: some View {
        switch state.phase {
        case .working where !state.steps.isEmpty:
            StepList(steps: Array(state.steps.suffix(2)))
        case .working:
            Text("Starting up").font(.system(size: 13)).foregroundStyle(.white.opacity(0.6))
        case .done:
            Text(state.runSummary).font(.system(size: 13)).foregroundStyle(.white.opacity(0.7)).lineLimit(1)
        case .problem:
            Text("Open Poki to fix it.").font(.system(size: 13)).foregroundStyle(.white.opacity(0.7)).lineLimit(1)
        case .idle where state.runnerPaused:
            Text("The runner wakes when an agent asks.").font(.system(size: 13)).foregroundStyle(.white.opacity(0.6)).lineLimit(2)
        case .idle:
            Text("Runner on. Waiting for the agent.").font(.system(size: 13)).foregroundStyle(.white.opacity(0.6)).lineLimit(2)
        default:
            EmptyView()
        }
    }

    @ViewBuilder private var footer: some View {
        HStack(spacing: 8) {
            switch state.phase {
            case .working:
                Meta(symbol: "list.bullet", text: "Step \(state.stepCount + 1)")
                if let since = state.since { ElapsedMeta(since: since) }
                Spacer(minLength: 4)
                StopButton()
            case .done:
                if let since = state.since, let end = state.endedAt {
                    Meta(symbol: "timer", text: Duration.seconds(max(0, end.timeIntervalSince(since))).formatted(.time(pattern: .minuteSecond)))
                }
                if let end = state.endedAt {
                    Meta(symbol: "clock", text: end.formatted(date: .omitted, time: .shortened))
                }
                Spacer(minLength: 4)
            case .problem:
                Spacer(minLength: 0)
                OpenPokiButton(title: "Open Poki")
            default:
                Spacer(minLength: 0)
            }
        }
        .frame(height: 28)
    }

    /// The right column: the latest screen while there is one, otherwise a big glyph for the phase.
    @ViewBuilder private var side: some View {
        let height: CGFloat = island ? 104 : 128
        if state.hasThumbnail, state.phase == .working || state.phase == .done || state.phase == .idle && !state.runnerPaused {
            Thumbnail(version: state.thumbnailVersion, accent: state.phase == .done ? Brand.done : .white.opacity(0.28))
                .frame(width: height * 0.47, height: height)
        } else {
            PhaseGlyph(state: state).frame(width: island ? 52 : 60, height: height)
        }
    }
}

struct StepList: View {
    var steps: [PokiActivityAttributes.Step]
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(steps.enumerated()), id: \.offset) { i, step in
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Image(systemName: step.ok ? "checkmark" : "xmark")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(step.ok ? Brand.done : Brand.approval)
                        .frame(width: 12)
                    Text(step.text).font(.system(size: 13)).lineLimit(1).truncationMode(.middle)
                        .foregroundStyle(.white.opacity(i == steps.count - 1 ? 0.85 : 0.55))
                }
            }
        }
    }
}

/// A small icon-and-value pair in the footer.
struct Meta: View {
    var symbol: String
    var text: String
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: symbol).font(.system(size: 10, weight: .semibold))
            Text(text).font(.system(size: 12, weight: .medium).monospacedDigit())
        }
        .foregroundStyle(.white.opacity(0.6))
        .lineLimit(1).fixedSize()
    }
}

/// A running clock. Text(timerInterval:) takes all the width it is offered, so it gets a fixed frame.
struct ElapsedMeta: View {
    var since: Date
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "timer").font(.system(size: 10, weight: .semibold))
            Text(timerInterval: since...Date.distantFuture, countsDown: false)
                .font(.system(size: 12, weight: .medium).monospacedDigit())
                .frame(width: 40, alignment: .leading)
        }
        .foregroundStyle(.white.opacity(0.6))
        .lineLimit(1)
    }
}

struct StopButton: View {
    var body: some View {
        Button(intent: StopRunnerIntent()) {
            HStack(spacing: 4) {
                Image(systemName: "stop.fill").font(.system(size: 10, weight: .bold))
                Text("Stop").font(.system(size: 13, weight: .semibold))
            }
            .padding(.horizontal, 12).frame(height: 28)
            .background(.white.opacity(0.16), in: .capsule)
        }
        .buttonStyle(.plain)
        .foregroundStyle(.white)
        .fixedSize()
    }
}

struct OpenPokiButton: View {
    var title: String
    var body: some View {
        Link(destination: URL(string: "poki://home")!) {
            Text(title).font(.system(size: 13, weight: .semibold))
                .padding(.horizontal, 12).frame(height: 28)
                .background(.white.opacity(0.16), in: .capsule)
        }
        .foregroundStyle(.white)
        .fixedSize()
    }
}

/// The right column when there is no screenshot: the phase's glyph in a soft tile, with the step
/// count while working.
struct PhaseGlyph: View {
    var state: PokiState
    var body: some View {
        VStack(spacing: 6) {
            ZStack {
                Circle().fill(state.accent.opacity(0.16))
                Image(systemName: state.symbol).font(.system(size: 22, weight: .semibold)).foregroundStyle(state.accent)
            }
            .frame(width: 48, height: 48)
            if state.phase == .working || state.phase == .done, state.stepCount > 0 {
                Text("\(state.stepCount)").font(.system(size: 13, weight: .semibold).monospacedDigit()).foregroundStyle(.white.opacity(0.7))
            }
        }
        .frame(maxHeight: .infinity)
    }
}

// MARK: Approval

struct ApprovalLayout: View {
    var state: PokiState
    var island: Bool

    var body: some View {
        if let approval = state.approval {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 0) {
                        if !island {
                            Header(state: state) { Countdown(until: approval.expires) }.padding(.bottom, 6)
                        }
                        Text("Allow this step?")
                            .font(.system(size: 12, weight: .semibold)).foregroundStyle(Brand.approval)
                            .padding(.bottom, 2)
                        Text(approval.summary)
                            .font(.system(size: 16, weight: .semibold))
                            .lineLimit(2).minimumScaleFactor(0.8)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 4)
                        DrainBar(from: state.approvalSince ?? approval.expires.addingTimeInterval(-30), to: approval.expires)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if state.hasThumbnail {
                        Thumbnail(version: state.thumbnailVersion, accent: Brand.approval)
                            .frame(width: island ? 38 : 44, height: island ? 70 : 92)
                    }
                }
                .frame(height: island ? 70 : 92)
                ApprovalButtons(approval: approval)
            }
        } else {
            RunLayout(state: state, island: island)
        }
    }
}

/// The time left to answer, counting down. Fixed width, so it never pushes the header around.
struct Countdown: View {
    var until: Date
    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "clock.fill").font(.system(size: 10, weight: .bold))
            Text(timerInterval: Date.now...max(Date.now, until), countsDown: true)
                .font(.system(size: 12, weight: .semibold).monospacedDigit())
                .frame(width: 34, alignment: .leading)
        }
        .foregroundStyle(Brand.approval)
        .padding(.horizontal, 8).frame(height: 22)
        .background(Brand.approval.opacity(0.18), in: .capsule)
        .lineLimit(1).fixedSize()
    }
}

/// A thin bar that empties as the approval runs out.
struct DrainBar: View {
    var from: Date
    var to: Date
    var body: some View {
        ProgressView(timerInterval: min(from, to)...to, countsDown: true) { EmptyView() } currentValueLabel: { EmptyView() }
            .progressViewStyle(.linear)
            .tint(Brand.approval)
            .labelsHidden()
            .frame(height: 4)
    }
}

struct ApprovalButtons: View {
    var approval: PendingApproval
    var body: some View {
        HStack(spacing: 10) {
            Button(intent: DenyActionIntent(approvalID: approval.id)) {
                Text("Deny").font(.system(size: 15, weight: .semibold))
                    .frame(maxWidth: .infinity).frame(height: 36)
                    .background(.white.opacity(0.16), in: .capsule)
                    .foregroundStyle(.white)
            }
            .buttonStyle(.plain)
            Button(intent: ApproveActionIntent(approvalID: approval.id)) {
                HStack(spacing: 5) {
                    Image(systemName: "faceid").font(.system(size: 13, weight: .semibold))
                    Text("Allow").font(.system(size: 15, weight: .semibold))
                }
                .frame(maxWidth: .infinity).frame(height: 36)
                .background(Brand.done, in: .capsule)
                .foregroundStyle(.black)
            }
            .buttonStyle(.plain)
        }
    }
}

// MARK: Pairing

struct PairingLayout: View {
    var state: PokiState
    var island: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !island { Header(state: state).padding(.bottom, 8) }
            if let pin = state.pin {
                Text("Type this code in Settings").font(.system(size: 15, weight: .semibold)).lineLimit(1)
                Text("Pair with Poki asks for it").font(.system(size: 12)).foregroundStyle(.white.opacity(0.6)).lineLimit(1)
                    .padding(.bottom, 8)
                HStack(spacing: island ? 6 : 8) {
                    ForEach(Array(pin.enumerated()), id: \.offset) { _, digit in
                        Text(String(digit))
                            .font(.system(size: island ? 24 : 28, weight: .bold, design: .rounded).monospacedDigit())
                            .frame(maxWidth: .infinity).frame(height: island ? 40 : 46)
                            .background(.white.opacity(0.12), in: .rect(cornerRadius: 10, style: .continuous))
                    }
                }
            } else {
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Open Settings to pair").font(.system(size: 17, weight: .semibold)).lineLimit(1).minimumScaleFactor(0.85)
                        Text("Privacy & Security › Developer Mode › Pair with Poki. The code shows up here.")
                            .font(.system(size: 13)).foregroundStyle(.white.opacity(0.65)).lineLimit(3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    PhaseGlyph(state: state).frame(width: 52, height: 60)
                }
            }
        }
    }
}

// MARK: Setup

struct SetupLayout: View {
    var state: PokiState
    var island: Bool

    var body: some View {
        if let guide = state.guide {
            VStack(alignment: .leading, spacing: 0) {
                if !island { Header(state: state) { StepRingSmall(guide: guide) }.padding(.bottom, 8) }
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Step \(guide.number) of \(guide.count)")
                            .font(.system(size: 12, weight: .semibold).monospacedDigit()).foregroundStyle(Brand.blue)
                        Text(guide.title).font(.system(size: island ? 16 : 17, weight: .semibold)).lineLimit(1).minimumScaleFactor(0.8)
                        Text(guide.hint).font(.system(size: 13)).foregroundStyle(.white.opacity(0.7))
                            .lineLimit(island ? 2 : 3).fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                Spacer(minLength: 8)
                HStack(spacing: 4) {
                    ForEach(1...max(guide.count, 1), id: \.self) { i in
                        Capsule().fill(i < guide.number ? Brand.done : i == guide.number ? Brand.blue : .white.opacity(0.18)).frame(height: 4)
                    }
                }
            }
            .frame(height: island ? 96 : 128)
        } else {
            RunLayout(state: state, island: island)
        }
    }
}

/// "2/6" in a ring, for the header and the island.
struct StepRingSmall: View {
    var guide: PokiActivityAttributes.Guide
    var body: some View {
        ZStack {
            Circle().stroke(.white.opacity(0.18), lineWidth: 3)
            Circle().trim(from: 0, to: CGFloat(guide.number) / CGFloat(max(guide.count, 1)))
                .stroke(Brand.blue, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text("\(guide.number)").font(.system(size: 10, weight: .bold).monospacedDigit())
        }
        .frame(width: 22, height: 22)
    }
}

// MARK: Dynamic Island

/// The expanded island's leading region: the bear and Poki, inset so nothing is clipped by the
/// island's rounded corner.
struct IslandLeading: View {
    var state: PokiState
    var body: some View {
        HStack(spacing: 7) {
            BearMark(size: 26)
            VStack(alignment: .leading, spacing: 0) {
                Text("Poki").font(.system(size: 14, weight: .semibold))
                if let app = state.appLine {
                    Text(app).font(.system(size: 12)).foregroundStyle(.white.opacity(0.55))
                }
            }
            .lineLimit(1)
        }
        .padding(.leading, 4)
        .frame(maxHeight: .infinity, alignment: .center)
    }
}

/// The expanded island's trailing region: the most useful short value for the phase.
struct IslandTrailing: View {
    var state: PokiState
    var body: some View {
        Group {
            switch state.phase {
            case .approval:
                if let approval = state.approval { Countdown(until: approval.expires) } else { StatusPill(state: state) }
            case .setup:
                if let guide = state.guide { StepRingSmall(guide: guide).scaleEffect(1.2) } else { StatusPill(state: state) }
            case .working:
                if let since = state.since {
                    Text(timerInterval: since...Date.distantFuture, countsDown: false)
                        .font(.system(size: 15, weight: .semibold).monospacedDigit())
                        .foregroundStyle(Brand.blue)
                        .multilineTextAlignment(.trailing)
                        .frame(width: 52, alignment: .trailing)
                } else { StatusPill(state: state) }
            default:
                StatusPill(state: state)
            }
        }
        .padding(.trailing, 4)
        .frame(maxHeight: .infinity, alignment: .center)
    }
}

/// The expanded island's bottom region.
struct IslandBottom: View {
    var state: PokiState
    var body: some View {
        Group {
            switch state.phase {
            case .approval: ApprovalLayout(state: state, island: true)
            case .pairing: PairingLayout(state: state, island: true)
            case .setup: SetupLayout(state: state, island: true)
            default: RunLayout(state: state, island: true)
            }
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 4)
    }
}

/// The compact trailing side: a short value rather than a word, so it never truncates.
struct CompactTrailing: View {
    var state: PokiState
    var body: some View {
        Group {
            switch state.phase {
            case .approval:
                if let approval = state.approval {
                    Text(timerInterval: Date.now...max(Date.now, approval.expires), countsDown: true)
                        .font(.system(size: 14, weight: .semibold).monospacedDigit())
                        .foregroundStyle(Brand.approval)
                        .multilineTextAlignment(.trailing)
                        .frame(width: 36, alignment: .trailing)
                } else { glyph }
            case .pairing where state.pin != nil:
                Text(state.pin ?? "").font(.system(size: 13, weight: .bold).monospacedDigit()).foregroundStyle(Brand.blue)
                    .fixedSize()
            case .setup:
                if let guide = state.guide { StepRingSmall(guide: guide) } else { glyph }
            case .working:
                if let since = state.since {
                    Text(timerInterval: since...Date.distantFuture, countsDown: false)
                        .font(.system(size: 14, weight: .semibold).monospacedDigit())
                        .foregroundStyle(Brand.blue)
                        .multilineTextAlignment(.trailing)
                        .frame(width: 40, alignment: .trailing)
                } else { glyph }
            default:
                glyph
            }
        }
        .padding(.trailing, 2)
    }

    private var glyph: some View {
        Image(systemName: state.symbol).font(.system(size: 15, weight: .semibold)).foregroundStyle(state.accent)
    }
}

/// The compact leading side: the bear, or the hand while an approval waits.
struct CompactLeading: View {
    var state: PokiState
    var body: some View {
        Group {
            if state.phase == .approval {
                Image(systemName: "hand.raised.fill").font(.system(size: 15, weight: .semibold)).foregroundStyle(Brand.approval)
                    .frame(width: 22, height: 22)
            } else {
                BearMark(size: 22)
            }
        }
        .padding(.leading, 2)
    }
}

/// Minimal (another app's activity shares the island): the one thing that matters.
struct MinimalView: View {
    var state: PokiState
    var body: some View {
        switch state.phase {
        case .approval:
            Image(systemName: "hand.raised.fill").foregroundStyle(Brand.approval)
        case .problem:
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(Brand.problem)
        case .working:
            ZStack {
                Circle().stroke(Brand.blue.opacity(0.3), lineWidth: 2)
                BearMark(size: 16)
            }
        default:
            BearMark(size: 20)
        }
    }
}

// MARK: Pieces

/// The bear on its blue tile, like the app icon, with the bear inset so no part of it is clipped.
struct BearMark: View {
    var size: CGFloat
    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.28, style: .continuous).fill(Brand.blue)
            Image("Bear").resizable().scaledToFit().padding(size * 0.12)
        }
        .frame(width: size, height: size)
    }
}

/// The latest screenshot, read from the App Group container and drawn like a small phone. `version`
/// changes when the app writes a new one, which redraws the view. Without a file it draws an empty
/// phone outline, so the layout never jumps.
struct Thumbnail: View {
    /// The app's own previews draw this when there is no file (the widget never sets it).
    @MainActor static var previewImage: UIImage?
    var version: Int
    var accent: Color = .white.opacity(0.28)
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 9, style: .continuous)
        Group {
            if let image = (SharedContainer.thumbnailURL.flatMap { UIImage(contentsOfFile: $0.path) }) ?? Self.previewImage {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                LinearGradient(colors: [Brand.blue.opacity(0.35), Brand.night], startPoint: .top, endPoint: .bottom)
            }
        }
        .clipShape(shape)
        .overlay(shape.strokeBorder(accent, lineWidth: 1.5))
        .id(version)
    }
}
