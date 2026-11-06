import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// The Live Activity's views, shared so the app can show them too (Debug > Live Activity preview).
///
/// Layout, Lock Screen: a header row (bear, "Poki", the app in use, a short status pill), then one
/// phase-specific body that uses the full width. Working shows the last steps on the left and the
/// latest screen on the right; approval shows what will happen and two large buttons; pairing shows
/// the code in six boxes; setup shows a segmented progress bar and what to do.

typealias PokiState = PokiActivityAttributes.ContentState

enum Brand {
    static let blue = Color(red: 0x20 / 255, green: 0x84 / 255, blue: 0xFD / 255)
    /// The Live Activity's own background, so it reads the same on any wallpaper.
    static let night = Color(red: 0.05, green: 0.07, blue: 0.12)
}

extension PokiState {
    /// The phase's accent colour.
    var accent: Color {
        switch phase {
        case .working, .pairing, .setup: Brand.blue
        case .approval: .orange
        case .problem: .yellow
        case .idle: runnerPaused ? Color(white: 0.6) : .green
        }
    }
    /// One or two words, so the pill never wraps.
    var status: String {
        switch phase {
        case .working: "Working"
        case .approval: "Needs you"
        case .pairing: "Pairing"
        case .setup: "Setup"
        case .problem: "Problem"
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
        case .idle: runnerPaused ? "moon.zzz.fill" : "checkmark.circle.fill"
        }
    }
    var showsThumbnail: Bool { thumbnailVersion > 0 && (phase == .working || phase == .idle && !runnerPaused) }
}

// MARK: Lock Screen

struct LockScreenView: View {
    var state: PokiState

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Header(state: state)
            PhaseBody(state: state, roomy: true)
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct Header: View {
    var state: PokiState
    var body: some View {
        HStack(spacing: 8) {
            BearMark(size: 24)
            Text("Poki").font(.subheadline.weight(.semibold))
            if let app = state.app, state.phase == .working || state.phase == .approval || state.phase == .idle && !state.runnerPaused {
                Text(app).font(.subheadline).foregroundStyle(.white.opacity(0.6)).lineLimit(1)
            }
            Spacer(minLength: 8)
            StatusPill(state: state)
        }
    }
}

struct StatusPill: View {
    var state: PokiState
    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: state.symbol).font(.caption2.weight(.bold))
            Text(state.status).font(.caption.weight(.semibold))
        }
        .lineLimit(1).fixedSize()
        .padding(.horizontal, 8).padding(.vertical, 4)
        .foregroundStyle(state.accent)
        .background(state.accent.opacity(0.18), in: .capsule)
    }
}

/// Everything under the header, by phase. `roomy` is the Lock Screen; otherwise the expanded Dynamic
/// Island, which is a little narrower and shorter.
struct PhaseBody: View {
    var state: PokiState
    var roomy: Bool

    var body: some View {
        switch state.phase {
        case .working, .idle, .problem: WorkBody(state: state, roomy: roomy)
        case .approval: ApprovalBody(state: state, roomy: roomy)
        case .pairing: PairingBody(state: state, roomy: roomy)
        case .setup: SetupBody(state: state, roomy: roomy)
        }
    }
}

struct WorkBody: View {
    var state: PokiState
    var roomy: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            VStack(alignment: .leading, spacing: 8) {
                Text(state.headline).font(roomy ? .headline : .subheadline.weight(.semibold)).lineLimit(2)
                    .foregroundStyle(state.phase == .problem ? .yellow : .white)
                if state.phase == .idle && state.runnerPaused {
                    Text("Nothing is running. The runner starts when an agent asks.")
                        .font(.caption).foregroundStyle(.white.opacity(0.65)).lineLimit(2)
                } else if !state.steps.isEmpty {
                    StepList(steps: Array(state.steps.suffix(roomy ? 3 : 2)))
                }
                if !state.runnerPaused, state.phase != .problem {
                    HStack(spacing: 10) {
                        if let since = state.since {
                            Label { Text(timerInterval: since...Date.distantFuture, countsDown: false).monospacedDigit() } icon: { Image(systemName: "timer") }
                                .font(.caption2).foregroundStyle(.white.opacity(0.6)).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                        Button(intent: StopRunnerIntent()) {
                            Label("Stop", systemImage: "stop.fill").font(.caption.weight(.semibold)).padding(.horizontal, 4)
                        }
                        .buttonStyle(.bordered).buttonBorderShape(.capsule).tint(.white)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if state.showsThumbnail {
                Thumbnail(version: state.thumbnailVersion)
                    .frame(width: roomy ? 58 : 44, height: roomy ? 118 : 90)
            }
        }
    }
}

struct StepList: View {
    var steps: [PokiActivityAttributes.Step]
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(steps.enumerated()), id: \.offset) { i, step in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: step.ok ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                        .font(.caption2).foregroundStyle(step.ok ? Color.green : Color.orange)
                    Text(step.text).font(.caption).lineLimit(1)
                        .foregroundStyle(.white.opacity(i == steps.count - 1 ? 0.95 : 0.6))
                }
            }
        }
    }
}

struct ApprovalBody: View {
    var state: PokiState
    var roomy: Bool

    var body: some View {
        if let approval = state.approval {
            VStack(alignment: .leading, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(state.headline).font(roomy ? .headline : .subheadline.weight(.semibold))
                    Text(approval.summary).font(.subheadline).foregroundStyle(.white.opacity(0.85)).lineLimit(2)
                }
                HStack(spacing: 4) {
                    Image(systemName: "clock").font(.caption2)
                    Text("Expires in ") + Text(timerInterval: Date()...max(Date(), approval.expires), countsDown: true)
                }
                .font(.caption.monospacedDigit()).foregroundStyle(.white.opacity(0.6))
                ApprovalButtons(approval: approval)
            }
        }
    }
}

struct ApprovalButtons: View {
    var approval: PendingApproval
    var body: some View {
        HStack(spacing: 10) {
            Button(intent: DenyActionIntent(approvalID: approval.id)) {
                Text("Deny").font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 4)
            }
            .buttonStyle(.bordered).tint(.white)
            Button(intent: ApproveActionIntent(approvalID: approval.id)) {
                Text("Allow").font(.subheadline.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 4)
            }
            .buttonStyle(.borderedProminent).tint(.green)
        }
        .buttonBorderShape(.capsule)
    }
}

struct PairingBody: View {
    var state: PokiState
    var roomy: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let pin = state.pin {
                Text("Enter this code on the pairing screen").font(.subheadline.weight(.semibold))
                HStack(spacing: roomy ? 8 : 6) {
                    ForEach(Array(pin.enumerated()), id: \.offset) { _, digit in
                        Text(String(digit))
                            .font(.system(size: roomy ? 28 : 24, weight: .bold, design: .rounded).monospacedDigit())
                            .frame(maxWidth: .infinity).frame(height: roomy ? 46 : 38)
                            .background(.white.opacity(0.12), in: .rect(cornerRadius: 10, style: .continuous))
                    }
                }
            } else {
                Text(state.headline).font(.subheadline.weight(.semibold))
                Text("Settings > Privacy & Security > Developer Mode. The code appears here.")
                    .font(.caption).foregroundStyle(.white.opacity(0.65)).lineLimit(2)
            }
        }
    }
}

struct SetupBody: View {
    var state: PokiState
    var roomy: Bool

    var body: some View {
        if let guide = state.guide {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 4) {
                    ForEach(1...max(guide.count, 1), id: \.self) { i in
                        Capsule().fill(i <= guide.number ? Brand.blue : .white.opacity(0.18)).frame(height: 4)
                    }
                }
                HStack(alignment: .firstTextBaseline) {
                    Text(guide.title).font(roomy ? .headline : .subheadline.weight(.semibold)).lineLimit(1)
                    Spacer(minLength: 8)
                    Text("\(guide.number) of \(guide.count)").font(.caption.monospacedDigit()).foregroundStyle(.white.opacity(0.6))
                }
                Text(guide.hint).font(.caption).foregroundStyle(.white.opacity(0.75)).lineLimit(roomy ? 3 : 2)
            }
        } else {
            Text(state.headline).font(.subheadline.weight(.semibold))
        }
    }
}

// MARK: Dynamic Island

/// The compact trailing side: a short value rather than a word, so it never truncates.
struct CompactState: View {
    var state: PokiState
    var body: some View {
        switch state.phase {
        case .pairing where state.pin != nil:
            Text(state.pin ?? "").font(.caption2.monospacedDigit().bold()).foregroundStyle(Brand.blue)
        case .setup:
            Text("\(state.guide?.number ?? 0)/\(state.guide?.count ?? 0)").font(.caption.monospacedDigit().bold()).foregroundStyle(Brand.blue)
        case .working:
            if let since = state.since {
                Text(timerInterval: since...Date.distantFuture, countsDown: false)
                    .font(.caption.monospacedDigit()).foregroundStyle(Brand.blue)
                    .frame(maxWidth: 44).multilineTextAlignment(.trailing)
            } else {
                Image(systemName: state.symbol).foregroundStyle(state.accent)
            }
        default:
            Image(systemName: state.symbol).foregroundStyle(state.accent)
        }
    }
}

/// The expanded Dynamic Island's bottom region: the phase body without the header.
struct IslandBody: View {
    var state: PokiState
    var body: some View {
        PhaseBody(state: state, roomy: false)
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: Pieces

/// The bear in a rounded square, inset so the corners are never clipped.
struct BearMark: View {
    var size: CGFloat
    var body: some View {
        Image("Bear").resizable().scaledToFit()
            .frame(width: size, height: size)
            .clipShape(.rect(cornerRadius: size * 0.26, style: .continuous))
    }
}

/// The latest screenshot, read from the App Group container and drawn like a small phone. `version`
/// changes when the app writes a new one, which redraws the view.
struct Thumbnail: View {
    var version: Int
    var body: some View {
        if let url = SharedContainer.thumbnailURL, let image = UIImage(contentsOfFile: url.path) {
            Image(uiImage: image).resizable().scaledToFill()
                .clipShape(.rect(cornerRadius: 9, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(.white.opacity(0.25), lineWidth: 1))
                .id(version)
        }
    }
}
