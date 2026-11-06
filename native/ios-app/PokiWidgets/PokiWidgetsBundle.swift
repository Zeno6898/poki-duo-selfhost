import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

@main
struct PokiWidgetsBundle: WidgetBundle {
    var body: some Widget { PokiLiveActivity() }
}

/// Poki's Live Activity: what the agent is doing and its last steps, the pairing code while pairing,
/// the current setup step while setting up, and Allow/Deny for sensitive actions. The buttons are for
/// the person; PokiCore sends no input while an approval waits, so the runner never taps them.
///
/// The Lock Screen keeps a fixed dark tint with white controls: it matches the island, reads on any
/// wallpaper, and avoids iOS 26/27's wrong-appearance bug with adaptive tints.
struct PokiLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: PokiActivityAttributes.self) { context in
            LockScreenView(state: context.state)
                .padding(.horizontal, 14).padding(.vertical, 12)
                .activityBackgroundTint(Brand.night.opacity(0.94))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            let state = context.state
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading) { IslandLeading(state: state) }
                DynamicIslandExpandedRegion(.trailing) { IslandTrailing(state: state) }
                DynamicIslandExpandedRegion(.bottom) { IslandBottom(state: state) }
            } compactLeading: {
                CompactLeading(state: state)
            } compactTrailing: {
                CompactTrailing(state: state)
            } minimal: {
                MinimalView(state: state)
            }
            .keylineTint(state.accent)
            .contentMargins(.horizontal, 14, for: .expanded)
        }
    }
}
