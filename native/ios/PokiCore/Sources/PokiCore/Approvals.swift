import Foundation

/// What needs the owner's approval on the phone before it is sent. Words match whole words or
/// phrases, case-insensitively, in the label of the element an action touches.
public struct SensitivityRules: Sendable, Equatable {
    public var secureFields = true
    public var payments: [String] = ["pay", "buy", "purchase", "subscribe", "checkout", "place order", "transfer", "send money", "confirm payment", "apple pay", "支付", "付款", "购买", "订阅", "转账", "确认支付", "下单"]
    public var deletions: [String] = ["delete", "remove", "erase", "reset", "delete all", "删除", "移除", "抹掉", "清空", "还原"]
    public var sending: [String] = ["send", "post", "reply", "发送", "回复", "发布"]
    /// Apps where every input needs approval (banking, wallets).
    public var guardedApps: [String] = ["com.apple.Passbook"]
    /// Apps where tapping a sending word needs approval.
    public var messagingApps: [String] = ["com.apple.MobileSMS", "com.apple.mobilemail", "com.tencent.xin", "net.whatsapp.WhatsApp", "ph.telegra.Telegraph", "com.burbn.instagram", "com.atebits.Tweetie2", "com.facebook.Messenger", "com.hammerandchisel.discord", "com.tinyspeck.chatlyio"]
    public var enabled = true
    public init() {}

    static func matches(_ text: String, _ words: [String]) -> String? {
        let lowered = text.lowercased()
        for word in words {
            let w = word.lowercased()
            guard let range = lowered.range(of: w) else { continue }
            // CJK words match anywhere; Latin words only on word boundaries ("Display" is not "pay").
            if w.unicodeScalars.contains(where: { $0.value > 0x2E80 }) { return word }
            let before = range.lowerBound == lowered.startIndex ? nil : lowered[lowered.index(before: range.lowerBound)]
            let after = range.upperBound == lowered.endIndex ? nil : lowered[range.upperBound]
            let boundary: (Character?) -> Bool = { c in c.map { !$0.isLetter } ?? true }
            if boundary(before) && boundary(after) { return word }
        }
        return nil
    }

    /// Why this action needs approval, or nil.
    func reason(touching element: Element?, typing: Bool, app: Foreground?, secureOnScreen: Bool) -> String? {
        guard enabled else { return nil }
        if let bundle = app?.bundleID, guardedApps.contains(bundle) { return "input in \(app?.describe ?? bundle)" }
        if typing, secureFields, element?.isSecure == true || (element == nil && secureOnScreen) { return "typing into a password field" }
        guard let element, !typing else { return nil }
        let text = element.text
        if let word = Self.matches(text, payments) { return "a payment (\"\(word)\")" }
        if let word = Self.matches(text, deletions) { return "deleting (\"\(word)\")" }
        if let bundle = app?.bundleID, messagingApps.contains(bundle), let word = Self.matches(text, sending) {
            return "sending a message (\"\(word)\")"
        }
        return nil
    }
}

public struct Approval: Sendable, Equatable {
    public var id: String
    public var app: String
    public var summary: String
    public var reason: String
    public var requested: Date
    public var expires: Date
    /// The actions it covers, as a fingerprint: the same actions sent again run once it is granted.
    var fingerprint: String
}

/// Pending and granted approvals. At most one is pending; it is granted or declined only from the app
/// (the Live Activity), and nothing the automation does can grant it, because every input is refused
/// while it is pending.
final class Approvals: @unchecked Sendable {
    enum Decision: Sendable { case approved, declined, expired }
    private struct Entry {
        var approval: Approval
        var decision: Decision?
        var waiters: [UUID: CheckedContinuation<Decision?, Never>] = [:]
    }
    private let lock = NSLock()
    private var entries: [String: Entry] = [:]
    let lifetime: Double
    let emit: @Sendable (CoreEvent) -> Void

    init(lifetime: Double = 120, emit: @escaping @Sendable (CoreEvent) -> Void) {
        self.lifetime = lifetime
        self.emit = emit
    }

    /// Drops expired entries (under the lock); returns the pending ones that expired, for events.
    private func sweep(at date: Date = Date()) -> [Approval] {
        var expired: [Approval] = []
        for (id, entry) in entries where entry.approval.expires <= date {
            entries[id] = nil
            if entry.decision == nil {
                expired.append(entry.approval)
                entry.waiters.values.forEach { $0.resume(returning: .expired) }
            }
        }
        return expired
    }

    var pending: Approval? {
        lock.lock()
        let expired = sweep()
        let p = entries.values.first { $0.decision == nil }?.approval
        lock.unlock()
        expired.forEach { emit(.approvalEnded(id: $0.id, approved: nil)) }
        return p
    }

    /// A granted approval for exactly these actions, used up by this call.
    func consumeGrant(fingerprint: String) -> Approval? {
        lock.lock()
        let expired = sweep()
        let found = entries.first { $0.value.approval.fingerprint == fingerprint && $0.value.decision == .approved }
        if let found { entries[found.key] = nil }
        lock.unlock()
        expired.forEach { emit(.approvalEnded(id: $0.id, approved: nil)) }
        return found?.value.approval
    }

    func request(app: String, summary: String, reason: String, fingerprint: String) -> Approval {
        let date = Date()
        let approval = Approval(id: String(UUID().uuidString.prefix(8)).lowercased(), app: app, summary: summary, reason: reason, requested: date, expires: date.addingTimeInterval(lifetime), fingerprint: fingerprint)
        lock.lock()
        // One pending at a time: a new request replaces an older one, which ends unanswered.
        let replaced = entries.values.filter { $0.decision == nil }
        for old in replaced {
            old.waiters.values.forEach { $0.resume(returning: .expired) }
            entries[old.approval.id] = nil
        }
        entries[approval.id] = Entry(approval: approval)
        lock.unlock()
        replaced.forEach { emit(.approvalEnded(id: $0.approval.id, approved: nil)) }
        emit(.approvalRequested(approval))
        return approval
    }

    /// Withdraws a pending approval (the agent moved on to something else).
    func withdraw(id: String) {
        lock.lock()
        guard let entry = entries[id], entry.decision == nil else { lock.unlock(); return }
        entries[id] = nil
        lock.unlock()
        entry.waiters.values.forEach { $0.resume(returning: .expired) }
        emit(.approvalEnded(id: id, approved: nil))
    }

    func resolve(id: String, approved: Bool) {
        lock.lock()
        guard var entry = entries[id], entry.decision == nil else { lock.unlock(); return }
        let decision: Decision = approved ? .approved : .declined
        let waiters = entry.waiters
        entry.decision = decision
        entry.waiters = [:]
        entries[id] = approved ? entry : nil
        lock.unlock()
        waiters.values.forEach { $0.resume(returning: decision) }
        emit(.approvalEnded(id: id, approved: approved))
    }

    /// Waits for the decision, at most `seconds`; nil when it is still pending then.
    func wait(id: String, seconds: Double) async -> Decision? {
        let token = UUID()
        return await withCheckedContinuation { (continuation: CheckedContinuation<Decision?, Never>) in
            lock.lock()
            guard var entry = entries[id] else { lock.unlock(); continuation.resume(returning: .expired); return }
            if let decision = entry.decision { lock.unlock(); continuation.resume(returning: decision); return }
            entry.waiters[token] = continuation
            entries[id] = entry
            lock.unlock()
            Task {
                await sleep(seconds: seconds)
                self.takeWaiter(id: id, token: token)?.resume(returning: nil)
            }
        }
    }

    private func takeWaiter(id: String, token: UUID) -> CheckedContinuation<Decision?, Never>? {
        lock.lock(); defer { lock.unlock() }
        return entries[id]?.waiters.removeValue(forKey: token)
    }
}
