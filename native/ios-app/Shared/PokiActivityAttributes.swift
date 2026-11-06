import ActivityKit
import Foundation

/// The Live Activity's data, shared by the app (which starts and updates it) and the widget extension
/// (which draws it). ActivityKit caps the payload at 4 KB, so the screenshot thumbnail is not in it:
/// the app writes it to the App Group container and the state carries only its version.
struct PokiActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        enum Phase: String, Codable, Hashable { case idle, working, approval, pairing, problem }
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
