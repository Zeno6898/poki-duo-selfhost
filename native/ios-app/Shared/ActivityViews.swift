import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// The Live Activity's views, shared so the app can show them too (Debug > Live Activity preview).

typealias PokiState = PokiActivityAttributes.ContentState

enum Brand {
    static let blue = Color(red: 0x20 / 255, green: 0x84 / 255, blue: 0xFD / 255)
}

struct LockScreenView: View {
    var state: PokiState

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                BearMark(size: 28)
                Text("Poki").font(.subheadline.weight(.semibold))
                PhaseLabel(state: state)
                Spacer(minLength: 0)
            }
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(state.headline).font(.title3.weight(.semibold)).lineLimit(2)
                    Detail(state: state, compact: false)
                }
                Spacer(minLength: 0)
                if state.thumbnailVersion > 0, state.phase == .working || state.phase == .idle {
                    Thumbnail(version: state.thumbnailVersion).frame(width: 48, height: 74)
                }
            }
        }
        .foregroundStyle(.white)
    }
}

/// The part under the headline, by phase.
struct Detail: View {
    var state: PokiState
    var compact: Bool

    var body: some View {
        switch state.phase {
        case .pairing:
            if let pin = state.pin {
                VStack(alignment: .leading, spacing: 4) {
                    Text(spaced(pin)).font(.system(size: compact ? 30 : 38, weight: .bold, design: .rounded).monospacedDigit())
                    Text("Type this code in Settings to finish pairing.").font(.caption).foregroundStyle(.white.opacity(0.75))
                }
            } else {
                Text("In Settings, open Privacy & Security > Developer Mode and tap Pair with Poki.").font(.caption).foregroundStyle(.white.opacity(0.75))
            }
        case .setup:
            if let guide = state.guide {
                VStack(alignment: .leading, spacing: 6) {
                    ProgressView(value: Double(guide.number), total: Double(max(guide.count, 1))).tint(Brand.blue)
                    Text("Step \(guide.number) of \(guide.count): \(guide.title)").font(.caption.weight(.semibold))
                    Text(guide.hint).font(.caption).foregroundStyle(.white.opacity(0.75)).lineLimit(3)
                }
            }
        case .approval:
            if let approval = state.approval {
                VStack(alignment: .leading, spacing: 8) {
                    Text("\(approval.app): \(approval.summary)").font(.callout).lineLimit(2)
                    ApprovalButtons(approval: approval)
                }
            }
        case .working, .idle, .problem:
            VStack(alignment: .leading, spacing: 6) {
                if !state.steps.isEmpty { StepList(steps: Array(state.steps.suffix(compact ? 2 : 3))) }
                HStack {
                    if let app = state.app { Text("In \(app)").font(.caption2).foregroundStyle(.white.opacity(0.7)).lineLimit(1) }
                    Spacer(minLength: 0)
                    if !state.runnerPaused {
                        Button(intent: StopRunnerIntent()) { Label("Stop", systemImage: "stop.fill").font(.caption.weight(.semibold)) }
                            .buttonStyle(.borderedProminent).tint(.white.opacity(0.2))
                    }
                }
            }
        }
    }

    private func spaced(_ pin: String) -> String { pin.map(String.init).joined(separator: " ") }
}

struct StepList: View {
    var steps: [PokiActivityAttributes.Step]
    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            ForEach(Array(steps.enumerated()), id: \.offset) { i, step in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: step.ok ? "checkmark.circle.fill" : "xmark.circle.fill")
                        .foregroundStyle(step.ok ? Color.green : Color.orange).font(.caption2)
                    Text(step.text).font(.caption).lineLimit(1)
                        .opacity(i == steps.count - 1 ? 1 : 0.7)
                }
            }
        }
    }
}

struct PhaseLabel: View {
    var state: PokiState
    var body: some View {
        Text(text).font(.caption2.weight(.semibold)).padding(.horizontal, 7).padding(.vertical, 2)
            .background(color.opacity(0.3), in: .capsule).foregroundStyle(.white)
    }
    private var text: String {
        switch state.phase {
        case .working: "Working"
        case .approval: "Needs you"
        case .pairing: "Pairing"
        case .setup: "Setup"
        case .problem: "Problem"
        case .idle: state.runnerPaused ? "Standing by" : "Ready"
        }
    }
    private var color: Color {
        switch state.phase {
        case .working, .pairing, .setup: Brand.blue
        case .approval: .orange
        case .problem: .yellow
        case .idle: state.runnerPaused ? .gray : .green
        }
    }
}

struct ApprovalButtons: View {
    var approval: PendingApproval
    var body: some View {
        HStack {
            Button(intent: DenyActionIntent(approvalID: approval.id)) { Label("Deny", systemImage: "xmark").frame(maxWidth: .infinity) }
                .tint(.red)
            Button(intent: ApproveActionIntent(approvalID: approval.id)) { Label("Approve", systemImage: "checkmark").frame(maxWidth: .infinity) }
                .tint(.green)
        }
        .buttonStyle(.borderedProminent)
    }
}

struct CompactState: View {
    var state: PokiState
    var body: some View {
        switch state.phase {
        case .approval: Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
        case .pairing:
            if let pin = state.pin { Text(pin).font(.caption.monospacedDigit().bold()).foregroundStyle(Brand.blue) }
            else { Image(systemName: "link").foregroundStyle(Brand.blue) }
        case .setup: Text("\(state.guide?.number ?? 0)/\(state.guide?.count ?? 0)").font(.caption.monospacedDigit().bold()).foregroundStyle(Brand.blue)
        case .working: Image(systemName: "hand.tap.fill").foregroundStyle(Brand.blue)
        case .problem: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.yellow)
        case .idle: Image(systemName: state.runnerPaused ? "moon.fill" : "checkmark.circle.fill").foregroundStyle(state.runnerPaused ? Color.gray : Color.green)
        }
    }
}

/// The bear, cut round so it reads at small sizes.
struct BearMark: View {
    var size: CGFloat
    var body: some View {
        Image("Bear").resizable().scaledToFill().frame(width: size, height: size).clipShape(.circle)
    }
}

/// The latest screenshot thumbnail, read from the App Group container. `version` changes when the app
/// writes a new one, which redraws the view.
struct Thumbnail: View {
    var version: Int
    var body: some View {
        if let url = SharedContainer.thumbnailURL, let image = UIImage(contentsOfFile: url.path) {
            Image(uiImage: image).resizable().scaledToFill().clipShape(.rect(cornerRadius: 6)).id(version)
        }
    }
}
