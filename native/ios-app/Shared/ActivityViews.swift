import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// The Live Activity's views.
///
/// Sizes (HIG, iPhone): Lock Screen and expanded island are 371-408 points wide and at most 160
/// points tall; anything taller is cut. The Lock Screen card has large rounded corners, so content
/// keeps the same 16 points from every edge, and stays within 128 points of
/// height. The expanded island also spends ~44 points on its leading/trailing row, so its bottom
/// region stays within ~90 points.
///
/// Two sizes of pop-up, as the owner asked: an action (each step) expands the island to a small
/// card, one or two lines of plain text; an approval expands it to the large card with Deny and
/// Allow. The Lock Screen always shows the full card.

typealias PokiState = PokiActivityAttributes.ContentState

enum Brand {
    static let blue = Color(red: 0x20 / 255, green: 0x84 / 255, blue: 0xFD / 255)
    /// The Live Activity's own background, so it reads the same on any wallpaper (a fixed dark
    /// tint also avoids iOS 26/27's wrong-appearance bug with adaptive tints).
    static let night = Color(red: 0.07, green: 0.08, blue: 0.11)
    static let approval = Color(red: 1.0, green: 0.62, blue: 0.04)
    static let done = Color(red: 0.19, green: 0.82, blue: 0.35)
    static let problem = Color(red: 1.0, green: 0.80, blue: 0.0)
}

/// Lock Screen padding (see the comment at the top).
enum LockInsets {
    static let horizontal: CGFloat = 16
    static let vertical: CGFloat = 16
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
        case .working: String(localized: "Working")
        case .approval: String(localized: "Approve")
        case .pairing: String(localized: "Pairing")
        case .setup: String(localized: "Setup")
        case .problem: String(localized: "Problem")
        case .done: String(localized: "Done")
        case .idle: runnerPaused ? String(localized: "Idle") : String(localized: "Ready")
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
    /// The app line next to "Poki", only when it means something.
    var appLine: String? {
        switch phase {
        case .working, .approval, .done: app
        default: nil
        }
    }
    var runSummary: String {
        let steps = stepCount == 1 ? String(localized: "1 step") : String(localized: "\(stepCount) steps")
        return failedCount > 0 ? String(localized: "\(steps) · \(failedCount) missed") : steps
    }
    /// The line under the headline: the last step while working, otherwise the phase's explanation.
    var detailLine: String? {
        switch phase {
        case .working: steps.last.map(\.text) ?? String(localized: "Starting up")
        case .done: runSummary
        case .problem: String(localized: "Open Poki to fix it.")
        case .idle: runnerPaused ? String(localized: "The runner wakes when an agent asks.") : String(localized: "Runner on. Waiting for the agent.")
        default: nil
        }
    }
}

extension PokiActivityAttributes.Event {
    var symbol: String {
        switch kind {
        case .started: "play.fill"
        case .app: "arrow.right"
        case .step: "hand.tap.fill"
        case .finished: "checkmark"
        case .approved: "checkmark.seal.fill"
        case .denied: "xmark"
        case .expired: "clock"
        case .problem: "exclamationmark.triangle.fill"
        case .paired: "link"
        case .code: "number"
        }
    }
    var color: Color {
        switch kind {
        case .started, .app, .code, .step: Brand.blue
        case .finished, .approved, .paired: Brand.done
        case .denied, .expired: Color(white: 0.75)
        case .problem: Brand.problem
        }
    }
}

// MARK: Lock Screen

/// The Lock Screen (and banner) card. The widget adds `LockInsets`.
struct LockScreenView: View {
    var state: PokiState

    var body: some View {
        Group {
            switch state.phase {
            case .approval: ApprovalCard(state: state, island: false)
            case .pairing: PairingCard(state: state, island: false)
            case .setup: SetupCard(state: state, island: false)
            default: RunCard(state: state)
            }
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The top line: the bear, Poki, the app in use, and on the right the status, or for a few seconds
/// the latest event ("Started", "Now in WeChat") in its place.
struct Header<Trailing: View>: View {
    var state: PokiState
    @ViewBuilder var trailing: Trailing

    var body: some View {
        HStack(spacing: 7) {
            BearMark(size: 20)
            Text("Poki").font(.system(size: 14, weight: .semibold)).layoutPriority(2)
            if let app = state.appLine {
                Text(app).font(.system(size: 14)).foregroundStyle(.white.opacity(0.55))
                    .truncationMode(.tail)
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

/// The status, or the latest event while it is fresh.
struct StatusPill: View {
    var state: PokiState
    var body: some View {
        let symbol = state.event?.symbol ?? state.symbol
        let text = state.event?.text ?? state.status
        let color = state.event?.color ?? state.accent
        HStack(spacing: 4) {
            Image(systemName: symbol).font(.system(size: 10, weight: .bold))
            Text(text).font(.system(size: 12, weight: .semibold))
        }
        .lineLimit(1).fixedSize()
        .padding(.horizontal, 9).frame(height: 22)
        .foregroundStyle(color)
        .background(color.opacity(0.18), in: .capsule)
    }
}

// MARK: Working, done, idle, problem

/// The Lock Screen card for a run (working, done) and the quiet phases (ready, idle, problem).
struct RunCard: View {
    var state: PokiState

    private var tall: Bool { state.phase == .working || state.phase == .done }

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 0) {
                Header(state: state).padding(.bottom, 8)
                Text(state.headline)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(state.phase == .problem ? Brand.problem : .white)
                    .lineLimit(2).minimumScaleFactor(0.85)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = state.detailLine {
                    DetailLine(state: state, text: detail).padding(.top, 3)
                }
                if tall || state.phase == .problem {
                    Spacer(minLength: 8)
                    Footer(state: state)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if tall {
                if state.hasThumbnail {
                    Thumbnail(version: state.thumbnailVersion, accent: state.phase == .done ? Brand.done : .white.opacity(0.25))
                        .frame(width: 54, height: 116)
                } else {
                    PhaseGlyph(state: state).frame(width: 54, height: 116)
                }
            }
        }
        .frame(height: tall ? 116 : nil)
    }
}

/// The last step with its result mark, or the phase's explanation.
struct DetailLine: View {
    var state: PokiState
    var text: String
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            if state.phase == .working, let step = state.steps.last {
                Image(systemName: step.ok ? "checkmark" : "xmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(step.ok ? Brand.done : Brand.approval)
            }
            Text(text).font(.system(size: 13)).foregroundStyle(.white.opacity(0.68))
                .lineLimit(1).truncationMode(.tail)
        }
    }
}

/// Step count, time and the one button, along the bottom.
struct Footer: View {
    var state: PokiState
    var body: some View {
        HStack(spacing: 10) {
            switch state.phase {
            case .working:
                Meta(symbol: "list.bullet", text: String(localized: "Step \(state.stepCount + 1)"))
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
                OpenPokiButton()
            default:
                Spacer(minLength: 0)
            }
        }
        .frame(height: 28)
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

/// A running clock. Text(timerInterval:) is sized for its longest value and shows dashes when its
/// frame is narrower, so the frame fits h:mm:ss. (The locked, dimmed screen shows "1:--" on purpose.)
struct ElapsedMeta: View {
    var since: Date
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "timer").font(.system(size: 10, weight: .semibold))
            Text(timerInterval: since...since.addingTimeInterval(12 * 3600), countsDown: false)
                .font(.system(size: 12, weight: .medium).monospacedDigit())
                .frame(width: 58, alignment: .leading)
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
    var body: some View {
        Link(destination: URL(string: "poki://home")!) {
            Text("Open Poki").font(.system(size: 13, weight: .semibold))
                .padding(.horizontal, 12).frame(height: 28)
                .background(.white.opacity(0.16), in: .capsule)
        }
        .foregroundStyle(.white)
        .fixedSize()
    }
}

/// The right column when there is no screenshot yet: the phase's glyph, and the step count.
struct PhaseGlyph: View {
    var state: PokiState
    var body: some View {
        VStack(spacing: 6) {
            ZStack {
                Circle().fill(state.accent.opacity(0.16))
                Image(systemName: state.symbol).font(.system(size: 20, weight: .semibold)).foregroundStyle(state.accent)
            }
            .frame(width: 44, height: 44)
            if state.stepCount > 0 {
                Text("\(state.stepCount)").font(.system(size: 13, weight: .semibold).monospacedDigit()).foregroundStyle(.white.opacity(0.7))
            }
        }
        .frame(maxHeight: .infinity)
    }
}

// MARK: Approval

/// The approval card: what the agent wants to do, the time left draining, and Deny / Allow full width.
/// The same card is the island's large pop-up (without the header, which the island's own top row
/// replaces).
struct ApprovalCard: View {
    var state: PokiState
    var island: Bool

    var body: some View {
        if let approval = state.approval {
            VStack(alignment: .leading, spacing: 0) {
                if !island {
                    Header(state: state) { Countdown(until: approval.expires) }.padding(.bottom, 8)
                }
                Text(approval.summary)
                    .font(.system(size: 16, weight: .semibold))
                    .lineLimit(2).minimumScaleFactor(0.8)
                    .fixedSize(horizontal: false, vertical: true)
                DrainBar(from: state.approvalSince ?? approval.expires.addingTimeInterval(-120), to: approval.expires)
                    .padding(.top, 8)
                ApprovalButtons(approval: approval).padding(.top, 10)
            }
        } else {
            RunCard(state: state)
        }
    }
}

/// The time left to answer, counting down, with the hand so it also says what it is.
struct Countdown: View {
    var until: Date
    /// Counting down to `until`. The start is fixed just under an hour before it (not "now", which the
    /// system may take at another moment than it draws), so the remaining time is always `until - now`.
    static func range(_ until: Date) -> ClosedRange<Date> { until.addingTimeInterval(-3599)...until }

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "hand.raised.fill").font(.system(size: 10, weight: .bold))
            Text(timerInterval: Countdown.range(until), countsDown: true)
                .font(.system(size: 12, weight: .semibold).monospacedDigit())
                .frame(width: 40, alignment: .leading)
        }
        .foregroundStyle(Brand.approval)
        .padding(.horizontal, 9).frame(height: 22)
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

struct PairingCard: View {
    var state: PokiState
    var island: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !island { Header(state: state).padding(.bottom, 8) }
            if let pin = state.pin {
                Text("Type this code in Settings").font(.system(size: 15, weight: .semibold)).lineLimit(1)
                    .padding(.bottom, 8)
                HStack(spacing: 7) {
                    ForEach(Array(pin.enumerated()), id: \.offset) { _, digit in
                        Text(String(digit))
                            .font(.system(size: island ? 22 : 26, weight: .bold, design: .rounded).monospacedDigit())
                            .frame(maxWidth: .infinity).frame(height: island ? 36 : 42)
                            .background(.white.opacity(0.12), in: .rect(cornerRadius: 9, style: .continuous))
                    }
                }
            } else {
                Text("Open Settings to pair").font(.system(size: 17, weight: .semibold)).lineLimit(1).minimumScaleFactor(0.85)
                Text("Privacy & Security › Developer Mode › Pair with Poki. The code shows up here.")
                    .font(.system(size: 13)).foregroundStyle(.white.opacity(0.65)).lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 3)
            }
        }
    }
}

// MARK: Setup

struct SetupCard: View {
    var state: PokiState
    var island: Bool

    var body: some View {
        if let guide = state.guide {
            VStack(alignment: .leading, spacing: 0) {
                if !island { Header(state: state) { StepRingSmall(guide: guide) }.padding(.bottom, 8) }
                Text(guide.title).font(.system(size: 16, weight: .semibold)).lineLimit(1).minimumScaleFactor(0.8)
                Text(guide.hint).font(.system(size: 13)).foregroundStyle(.white.opacity(0.7))
                    .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 2)
                HStack(spacing: 4) {
                    ForEach(1...max(guide.count, 1), id: \.self) { i in
                        Capsule().fill(i < guide.number ? Brand.done : i == guide.number ? Brand.blue : .white.opacity(0.18)).frame(height: 4)
                    }
                }
                .padding(.top, 10)
            }
        } else {
            RunCard(state: state)
        }
    }
}

/// "2" in a ring that fills 2/6 of the way, for the header and the island.
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

/// Expanded leading region: the bear and Poki, with the app or the setup step under it.
struct IslandLeading: View {
    var state: PokiState
    var body: some View {
        HStack(spacing: 8) {
            BearMark(size: 28)
            VStack(alignment: .leading, spacing: 0) {
                Text("Poki").font(.system(size: 14, weight: .semibold))
                if let sub = state.appLine ?? state.guide.map({ String(localized: "Step \($0.number) of \($0.count)") }) {
                    Text(sub).font(.system(size: 12)).foregroundStyle(.white.opacity(0.55))
                }
            }
            .lineLimit(1)
        }
        .frame(maxHeight: .infinity, alignment: .center)
    }
}

/// Expanded trailing region: the most useful short value for the phase.
struct IslandTrailing: View {
    var state: PokiState
    var body: some View {
        Group {
            switch state.phase {
            case .approval:
                if let approval = state.approval { Countdown(until: approval.expires) } else { StatusPill(state: state) }
            case .working where state.event == nil:
                if let since = state.since {
                    Text(timerInterval: since...since.addingTimeInterval(12 * 3600), countsDown: false)
                        .font(.system(size: 15, weight: .semibold).monospacedDigit())
                        .foregroundStyle(Brand.blue)
                        .multilineTextAlignment(.trailing)
                        .frame(width: 64, alignment: .trailing)
                } else { StatusPill(state: state) }
            default:
                StatusPill(state: state)
            }
        }
        .frame(maxHeight: .infinity, alignment: .center)
    }
}

/// Expanded bottom region. Small for actions and the quiet phases (a headline and one line), large
/// for an approval (the full approval card).
struct IslandBottom: View {
    var state: PokiState
    var body: some View {
        Group {
            switch state.phase {
            case .approval: ApprovalCard(state: state, island: true)
            case .pairing: PairingCard(state: state, island: true)
            case .setup: SetupCard(state: state, island: true)
            default: IslandSmall(state: state)
            }
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The small pop-up: what just happened in words, the next line under it, and Stop while working.
struct IslandSmall: View {
    var state: PokiState
    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(state.headline)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(state.phase == .problem ? Brand.problem : .white)
                    .lineLimit(2).minimumScaleFactor(0.85)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail = state.detailLine { DetailLine(state: state, text: detail) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            switch state.phase {
            case .working: StopButton()
            case .problem: OpenPokiButton()
            default: EmptyView()
            }
        }
    }
}

/// Compact trailing: a short value rather than a word, so it never truncates.
struct CompactTrailing: View {
    var state: PokiState
    var body: some View {
        Group {
            switch state.phase {
            case .approval:
                if let approval = state.approval {
                    Text(timerInterval: Countdown.range(approval.expires), countsDown: true)
                        .font(.system(size: 14, weight: .semibold).monospacedDigit())
                        .foregroundStyle(Brand.approval)
                        .multilineTextAlignment(.trailing)
                        .frame(width: 40, alignment: .trailing)
                } else { glyph }
            case .pairing where state.pin != nil:
                Text(state.pin ?? "").font(.system(size: 13, weight: .bold).monospacedDigit()).foregroundStyle(Brand.blue)
                    .fixedSize()
            case .setup:
                if let guide = state.guide { StepRingSmall(guide: guide) } else { glyph }
            case .working:
                if let since = state.since {
                    Text(timerInterval: since...since.addingTimeInterval(12 * 3600), countsDown: false)
                        .font(.system(size: 14, weight: .semibold).monospacedDigit())
                        .foregroundStyle(Brand.blue)
                        .multilineTextAlignment(.trailing)
                        .frame(width: 44, alignment: .trailing)
                } else { glyph }
            default:
                glyph
            }
        }
    }

    private var glyph: some View {
        Image(systemName: state.symbol).font(.system(size: 15, weight: .semibold)).foregroundStyle(state.accent)
    }
}

/// Compact leading: the bear, or the hand while an approval waits.
struct CompactLeading: View {
    var state: PokiState
    var body: some View {
        if state.phase == .approval {
            Image(systemName: "hand.raised.fill").font(.system(size: 15, weight: .semibold)).foregroundStyle(Brand.approval)
                .frame(width: 22, height: 22)
        } else {
            BearMark(size: 22)
        }
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
        default:
            BearMark(size: 20)
        }
    }
}

// MARK: Pieces

/// The bear on its blue tile, like the app icon, inset so no part of it is clipped.
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
/// changes when the app writes a new one, which redraws the view. Without a file it draws a plain
/// phone outline, so the layout never jumps.
struct Thumbnail: View {
    /// The app's own previews draw this when there is no file (the widget never sets it).
    @MainActor static var previewImage: UIImage?
    var version: Int
    var accent: Color = .white.opacity(0.25)
    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 8, style: .continuous)
        Group {
            if let image = (SharedContainer.thumbnailURL.flatMap { UIImage(contentsOfFile: $0.path) }) ?? Self.previewImage {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Color.white.opacity(0.08)
            }
        }
        .clipShape(shape)
        .overlay(shape.strokeBorder(accent, lineWidth: 1.5))
        .id(version)
    }
}
