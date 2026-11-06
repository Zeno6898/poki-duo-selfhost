import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct PokiWidgetsBundle: WidgetBundle {
    var body: some Widget { PokiLiveActivity() }
}


/// Poki's Live Activity: what the agent is doing and its last steps, the pairing PIN while pairing,
/// the current setup step while setting up, and Approve/Deny for sensitive actions. The buttons are
/// for the person; the runner never taps the Live Activity.
struct PokiLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: PokiActivityAttributes.self) { context in
            LockScreenView(state: context.state)
                .padding(16)
                .activityBackgroundTint(Color.black.opacity(0.35))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 6) {
                        BearMark(size: 26)
                        PhaseLabel(state: state)
                    }
                    .padding(.leading, 4)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    if state.thumbnailVersion > 0, state.phase == .working || state.phase == .idle {
                        Thumbnail(version: state.thumbnailVersion).frame(width: 34, height: 52)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(state.headline).font(.headline).lineLimit(2)
                        Detail(state: state, compact: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 4)
                }
            } compactLeading: {
                BearMark(size: 20)
            } compactTrailing: {
                CompactState(state: state)
            } minimal: {
                CompactState(state: state)
            }
            .keylineTint(Brand.blue)
        }
    }
}
