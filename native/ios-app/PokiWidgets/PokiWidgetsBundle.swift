import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct PokiWidgetsBundle: WidgetBundle {
    var body: some Widget { PokiLiveActivity() }
}

struct PokiLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: PokiActivityAttributes.self) { context in
            LockScreenView(state: context.state)
                .padding()
                .activityBackgroundTint(nil)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image("Bear").resizable().scaledToFit().frame(width: 36, height: 36)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Thumbnail(version: context.state.thumbnailVersion).frame(width: 44, height: 64)
                }
                DynamicIslandExpandedRegion(.center) {
                    Text(context.state.headline).font(.headline).lineLimit(2)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    if let pin = context.state.pin {
                        Text(pin).font(.title.monospacedDigit().bold())
                    } else if let approval = context.state.approval {
                        ApprovalButtons(approval: approval)
                    } else {
                        HStack {
                            if let last = context.state.lastAction {
                                Text(last).font(.caption.monospaced()).lineLimit(1).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if !context.state.runnerPaused {
                                Button(intent: StopRunnerIntent()) { Image(systemName: "pause.fill") }.tint(.blue)
                            }
                        }
                    }
                }
            } compactLeading: {
                Image("Bear").resizable().scaledToFit().frame(width: 20, height: 20)
            } compactTrailing: {
                CompactState(state: context.state)
            } minimal: {
                Image(systemName: context.state.phase == .approval ? "hand.raised.fill" : "pawprint.fill")
                    .foregroundStyle(context.state.phase == .approval ? .orange : .blue)
            }
            .keylineTint(.blue)
        }
    }
}

struct LockScreenView: View {
    var state: PokiActivityAttributes.ContentState

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image("Bear").resizable().scaledToFit().frame(width: 40, height: 40)
            VStack(alignment: .leading, spacing: 4) {
                Text(state.headline).font(.headline).lineLimit(2)
                if let app = state.app { Text(app).font(.caption).foregroundStyle(.secondary) }
                if let pin = state.pin {
                    Text(pin).font(.system(size: 34, weight: .bold, design: .rounded).monospacedDigit())
                } else if let approval = state.approval {
                    Text(approval.summary).font(.callout)
                    ApprovalButtons(approval: approval)
                } else {
                    if let last = state.lastAction {
                        Text(last).font(.caption.monospaced()).lineLimit(1).foregroundStyle(.secondary)
                    }
                    if !state.runnerPaused {
                        Button(intent: StopRunnerIntent()) { Label("Stop runner", systemImage: "pause.fill") }
                            .buttonStyle(.bordered).tint(.blue).font(.caption)
                    }
                }
            }
            Spacer(minLength: 0)
            if state.pin == nil { Thumbnail(version: state.thumbnailVersion).frame(width: 48, height: 72) }
        }
    }
}

struct ApprovalButtons: View {
    var approval: PendingApproval
    var body: some View {
        HStack {
            Button(intent: DenyActionIntent(approvalID: approval.id)) { Label("Deny", systemImage: "xmark") }
                .tint(.red)
            Button(intent: ApproveActionIntent(approvalID: approval.id)) { Label("Approve", systemImage: "checkmark") }
                .tint(.green)
        }
        .buttonStyle(.borderedProminent)
    }
}

struct CompactState: View {
    var state: PokiActivityAttributes.ContentState
    var body: some View {
        switch state.phase {
        case .approval: Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
        case .pairing: Text(state.pin ?? "").font(.caption.monospacedDigit().bold())
        case .working: ProgressView().progressViewStyle(.circular).tint(.blue)
        case .problem: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.yellow)
        case .idle: Image(systemName: state.runnerPaused ? "pause.circle.fill" : "checkmark.circle.fill").foregroundStyle(state.runnerPaused ? Color.secondary : Color.green)
        }
    }
}

/// The latest screenshot thumbnail, read from the App Group container. `version` changes when the app
/// writes a new one, which redraws the view.
struct Thumbnail: View {
    var version: Int
    var body: some View {
        if version > 0, let url = SharedContainer.thumbnailURL, let image = UIImage(contentsOfFile: url.path) {
            Image(uiImage: image).resizable().scaledToFill().clipShape(.rect(cornerRadius: 8)).id(version)
        } else {
            RoundedRectangle(cornerRadius: 8).fill(.quaternary)
        }
    }
}
