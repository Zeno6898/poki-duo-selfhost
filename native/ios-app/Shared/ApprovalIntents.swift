import AppIntents
import Foundation

/// Approve and Deny on the Live Activity. A decision is written to the App Group and announced with a
/// Darwin notification, so it reaches the app whichever process runs the intent. PokiCore sends no
/// input at all while an approval is pending, so the automation cannot press these buttons itself;
/// Approve also asks for Face ID or the passcode when the phone is locked.
struct ApproveActionIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Approve action"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication
    static let isDiscoverable = false

    @Parameter(title: "Approval") var approvalID: String

    init() {}
    init(approvalID: String) { self.approvalID = approvalID }

    func perform() async throws -> some IntentResult {
        ApprovalMailbox.post(id: approvalID, approved: true)
        return .result()
    }
}

struct DenyActionIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Deny action"
    static let isDiscoverable = false

    @Parameter(title: "Approval") var approvalID: String

    init() {}
    init(approvalID: String) { self.approvalID = approvalID }

    func perform() async throws -> some IntentResult {
        ApprovalMailbox.post(id: approvalID, approved: false)
        return .result()
    }
}

/// Decisions in flight between the intent and the app.
enum ApprovalMailbox {
    static let notification = "nz.zheha.poki.approval"
    private static let key = "approval.decisions"

    static func post(id: String, approved: Bool) {
        var decisions = SharedContainer.defaults.dictionary(forKey: key) as? [String: Bool] ?? [:]
        decisions[id] = approved
        SharedContainer.defaults.set(decisions, forKey: key)
        CFNotificationCenterPostNotification(CFNotificationCenterGetDarwinNotifyCenter(), CFNotificationName(notification as CFString), nil, nil, true)
    }

    /// Takes every decision posted so far, once.
    static func drain() -> [String: Bool] {
        let decisions = SharedContainer.defaults.dictionary(forKey: key) as? [String: Bool] ?? [:]
        SharedContainer.defaults.removeObject(forKey: key)
        return decisions
    }
}
