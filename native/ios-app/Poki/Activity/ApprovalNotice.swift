import Foundation
import UserNotifications

/// A time-sensitive notification for each approval, so the person hears about it even when the Live
/// Activity is off, dismissed or hidden. Tapping it opens Poki, whose home screen has Allow and
/// Deny; the notification itself has no buttons, so nothing but the person can answer it.
enum ApprovalNotice {
    static func requestPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            Task { @MainActor in AppLog.shared.add("notice", granted ? "notifications allowed" : "notifications not allowed") }
        }
    }

    static func post(_ approval: PendingApproval) {
        let content = UNMutableNotificationContent()
        content.title = "Poki needs your OK"
        content.body = "\(approval.summary) in \(approval.app). Open Poki to allow or deny."
        content.sound = .default
        content.interruptionLevel = .timeSensitive
        content.threadIdentifier = "approvals"
        let request = UNNotificationRequest(identifier: "approval-\(approval.id)", content: content, trigger: nil)
        UNUserNotificationCenter.current().add(request)
    }

    static func clear(_ id: String) {
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: ["approval-\(id)"])
        center.removePendingNotificationRequests(withIdentifiers: ["approval-\(id)"])
    }
}
