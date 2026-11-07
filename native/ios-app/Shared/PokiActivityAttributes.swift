import ActivityKit
import Foundation

/// The Live Activity's data, shared by the app (which starts and updates it) and the widget extension
/// (which draws it). ActivityKit caps the payload at 4 KB, so the screenshot thumbnail is not in it:
/// the app writes it to the App Group container and the state carries only its version.
struct PokiActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        /// `done` is set by ActivityController itself when the agent has been quiet for a while after a
        /// run of steps; the app never needs to set it.
        enum Phase: String, Codable, Hashable { case idle, working, approval, pairing, setup, problem, done }
        var phase: Phase
        /// What the agent is doing, in a few words ("Reading Settings").
        var headline: String
        /// The last action and its delivery ("tap 'General' · sent").
        var lastAction: String?
        /// The app in front.
        var app: String?
        /// Bumped whenever a new thumbnail is written to the App Group container.
        var thumbnailVersion: Int
        /// A pending approval, if any. Its buttons are App Intents; see ApprovalIntents.swift.
        var approval: PendingApproval?
        /// The pairing PIN while on-device pairing is waiting for it.
        var pin: String?
        /// The runner is stopped while no agent uses the phone (no automation banner); the next
        /// request starts it again.
        var runnerPaused = false
        /// The agent's latest actions, newest last (at most three, each short), so the Live Activity
        /// shows the steps and not only the last one.
        var steps: [Step] = []
        /// During setup: which step the person is on ("2 of 6") and what to do in Settings.
        var guide: Guide?
        /// When the agent's current run of steps began, for the elapsed time on the Live Activity.
        var since: Date?
        /// Steps in the current run, and how many of them did not go through. Kept by ActivityController.
        var stepCount = 0
        var failedCount = 0
        /// When the run finished (phase `done`), so the summary shows a fixed duration.
        var endedAt: Date?
        /// When the pending approval was asked, for the draining countdown bar.
        var approvalSince: Date?
        /// A short-lived event ("Started", "Now in WeChat", "Finished") shown as a tag above the
        /// headline while the Dynamic Island is expanded for it. ActivityController clears it.
        var event: Event?
    }
    struct Event: Codable, Hashable {
        enum Kind: String, Codable, Hashable { case started, app, step, finished, approved, denied, expired, problem, paired, code }
        var kind: Kind
        var text: String
    }
    struct Step: Codable, Hashable {
        var text: String
        var ok: Bool
    }
    struct Guide: Codable, Hashable {
        var number: Int
        var count: Int
        var title: String
        /// Where to go and what to tap, one line.
        var hint: String
    }
    var deviceName: String
}

struct PendingApproval: Codable, Hashable {
    var id: String
    var app: String
    var summary: String
    var expires: Date
}

enum SharedContainer {
    static let appGroup = "group.nz.zheha.poki"
    static var url: URL? { FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup) }
    static var thumbnailURL: URL? { url?.appendingPathComponent("activity-thumbnail.jpg") }
    static var defaults: UserDefaults { UserDefaults(suiteName: appGroup) ?? .standard }
}
