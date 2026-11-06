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
                .padding(.horizontal, 18).padding(.vertical, 16)
                .activityBackgroundTint(Brand.night.opacity(0.92))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    HStack(spacing: 8) {
                        BearMark(size: 30)
                        Text("Poki").font(.subheadline.weight(.semibold)).lineLimit(1)
                    }
                    .padding(.leading, 6)
                    .frame(maxHeight: .infinity, alignment: .center)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    StatusPill(state: state)
                        .padding(.trailing, 6)
                        .frame(maxHeight: .infinity, alignment: .center)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    IslandBody(state: state)
                        .padding(.horizontal, 6).padding(.top, 4)
                }
            } compactLeading: {
                BearMark(size: 22).padding(.leading, 2)
            } compactTrailing: {
                CompactState(state: state).padding(.trailing, 2)
            } minimal: {
                CompactState(state: state)
            }
            .keylineTint(state.accent)
        }
    }
}
