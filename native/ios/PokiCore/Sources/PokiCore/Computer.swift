import Foundation

/// What a tool call answers: facts as text, a screenshot when there is one, and whether it failed.
public struct ToolResult: Sendable {
    public var text: String
    public var jpeg: Data?
    public var isError = false
}

/// A sent action failed: whether it may have reached the phone.
struct ActionFailure: Error, CustomStringConvertible {
    var message: String
    var delivery: Delivery
    var description: String { message }
}

/// The computer-use tools (look and do), ported from src/cua.mjs and src/cua-wda.mjs. One call does
/// some actions and then reads the screen once; the answer is facts only, and the model decides what
/// happened. Every step has a deadline, so a call always answers within `toolDeadline`.
final class Computer: @unchecked Sendable {
    let runner: Runner
    let host: CoreHost
    let config: CoreConfig
    let approvals: Approvals

    // Kept between calls; one tool call runs at a time (the gate in PokiCore), so no lock is needed.
    var refs: [Int: Element] = [:]
    var previous: Set<String> = []
    var lastElements: [Element] = []
    var lastForeground: Foreground?
    var size: ScreenSize?
    var lastPNG: Data?

    static let settle: [String: Double] = ["tap": 0.45, "type": 0.25, "key": 0.3, "swipe": 0.6, "drag": 0.6, "long_press": 0.4, "pinch": 0.6, "button": 0.7, "launch": 0.9, "scroll_to": 0.2, "wait": 0]
    static let imageWidth = 300
    static let lineLimit = 120

    init(runner: Runner, host: CoreHost, config: CoreConfig, approvals: Approvals) {
        self.runner = runner
        self.host = host
        self.config = config
        self.approvals = approvals
    }

    // MARK: Reading and answering

    func screenSize(until: Double) async throws -> ScreenSize {
        if let size { return size }
        let s = try await runner.screenSize(timeout: max(0.5, min(3, until - now())))
        size = s
        return s
    }

    /// Reads the screen and answers with the facts, whatever part of the read failed.
    func readAndReply(until: Double, full: Bool, did: [String] = [], error: String? = nil, extra: [String] = []) async -> ToolResult {
        let budget = max(0.8, min(config.readTimeout, until - now() - 0.2))
        let reading = await runner.read(timeout: budget)
        var screen = ScreenSize(width: 10_000, height: 10_000)
        if let known = size { screen = known } else if let asked = try? await screenSize(until: now() + 1.5) { screen = asked }
        var notes = reading.notes
        let elements = listable(reading.elements, screen)
        if reading.png == nil && reading.elements.isEmpty {
            // Nothing came back: say what was sent and what the runner is doing, and nothing else.
            let state = host.runnerState()
            let did = did.map { $0.replacingOccurrences(of: "(sent,", with: "(sent, not confirmed: no read after it,") }
            let lines = ["read: failed (\(notes.joined(separator: "; ")))", "runner: \(state.describe)"] + did.map { "did: \($0)" } + (error.map { ["error: \($0)"] } ?? []) + extra
            return ToolResult(text: lines.joined(separator: "\n"), jpeg: nil, isError: true)
        }
        lastForeground = reading.foreground ?? lastForeground
        lastPNG = reading.png ?? lastPNG
        // Numbers refer to this read only.
        refs = [:]
        var keysNow = Set<String>()
        let fresh = previous.isEmpty
        var lines: [(isNew: Bool, text: String)] = []
        for (index, e) in elements.enumerated() {
            let ref = index + 1
            refs[ref] = e
            keysNow.insert(e.key)
            let isNew = !fresh && !previous.contains(e.key)
            let f = e.frame
            lines.append((isNew, "\(isNew ? "+" : " ")\(ref) \(e.type) \"\(e.text)\" [\([f.x, f.y, f.width, f.height].map { String(Int($0.rounded())) }.joined(separator: ","))]"))
        }
        let gone = previous.subtracting(keysNow).sorted().prefix(20).map { key -> String in
            let parts = key.split(separator: "|", maxSplits: 1).map(String.init)
            return "\(parts[0]) \"\(parts.count > 1 ? parts[1] : "")\""
        }
        if !reading.elements.isEmpty || reading.notes.isEmpty { previous = keysNow; lastElements = elements }
        let shown = full || fresh ? lines : lines.enumerated().filter { $0.element.isNew || $0.offset < Self.lineLimit }.map(\.element)

        var jpeg: Data?
        if let png = reading.png {
            do { jpeg = try host.jpeg(fromPNG: png, width: Self.imageWidth, quality: 0.6) }
            catch { notes.append("screenshot not encoded: \(error)") }
        }
        let app = reading.foreground?.describe ?? "unknown"
        var header = ["app: \(app)   read: \(ISO8601DateFormatter().string(from: Date())) (\(reading.ms) ms)" + (notes.isEmpty ? "" : "   note: \(notes.joined(separator: "; "))")]
        header += did.map { "did: \($0)" }
        if let error { header.append("error: \(error)") }
        header += extra
        header.append(fresh ? "elements (\(lines.count)):" : "elements (\(lines.count); + = new since the last read):")
        let footer = gone.isEmpty ? [] : ["gone since the last read: \(gone.joined(separator: ", "))"]
        let body = shown.prefix(full ? 1000 : Self.lineLimit).map(\.text)
        return ToolResult(text: (header + body + footer).joined(separator: "\n"), jpeg: jpeg, isError: error != nil)
    }

    func look(full: Bool) async -> ToolResult {
        let until = now() + config.toolDeadline
        if let blocked = runnerBlocked() { return blocked }
        return await readAndReply(until: until, full: full)
    }

    /// The runner is being started or has failed: answer at once instead of waiting on it.
    func runnerBlocked() -> ToolResult? {
        let state = host.runnerState()
        guard !state.isRunning else { return nil }
        return ToolResult(text: "runner: \(state.describe)\nNothing was sent. Call look again in a few seconds; the launcher restarts the runner by itself.", jpeg: nil, isError: true)
    }

    // MARK: do

    func act(actions: [JSON], full: Bool) async -> ToolResult {
        let started = now()
        let until = started + config.toolDeadline
        if let blocked = runnerBlocked() { return blocked }

        // A number that is not in the latest read is refused before anything is sent.
        let stale = Set(actions.flatMap(Self.refs(in:))).filter { refs[$0] == nil }.sorted()
        if !stale.isEmpty {
            return await readAndReply(until: until, full: true, error: "element \(stale.map(String.init).joined(separator: ", ")) is not in the latest read; nothing was sent. The current elements are below.")
        }

        // Approval: nothing in this call is sent until the owner approves it on the phone.
        let fingerprint = JSON.array(actions).serialized()
        var approvedNote: String?
        if let pending = approvals.pending, pending.fingerprint != fingerprint {
            approvals.withdraw(id: pending.id)
        }
        if let reason = sensitiveReason(actions) {
            if approvals.consumeGrant(fingerprint: fingerprint) != nil {
                approvedNote = "approval: approved on the phone (\(reason))"
            } else {
                let approval = approvals.pending.flatMap { $0.fingerprint == fingerprint ? $0 : nil }
                    ?? approvals.request(app: lastForeground?.describe ?? "unknown", summary: actions.map(describe).joined(separator: ", "), reason: reason, fingerprint: fingerprint)
                let wait = max(0, min(config.approvalWait, until - now() - config.readTimeout - 1))
                switch await approvals.wait(id: approval.id, seconds: wait) {
                case .approved?:
                    _ = approvals.consumeGrant(fingerprint: fingerprint)
                    approvedNote = "approval: approved on the phone (\(reason))"
                case .declined?:
                    return ToolResult(text: "not_sent: the owner declined on the phone (\(reason)). Nothing was sent.", jpeg: nil, isError: true)
                case .expired?:
                    return ToolResult(text: "not_sent: the approval request ended unanswered (\(reason)). Nothing was sent.", jpeg: nil, isError: true)
                case nil:
                    return ToolResult(text: "not_sent: approval_required (id \(approval.id)): \(reason). The owner was asked on the phone. Nothing was sent. When they approve, send the same actions again (within \(Int(approvals.lifetime / 60)) minutes); other actions withdraw the request.", jpeg: nil, isError: true)
                }
            }
        }

        var did: [String] = []
        var error: String?
        var lastKind: String?
        let actionsUntil = min(until - config.readTimeout - 0.5, started + config.actionCap)
        for (index, action) in actions.enumerated() {
            let left = actionsUntil - now()
            if left < 0.3 {
                error = "stopped before action \(index + 1): the \(Int(config.actionCap)) s action time ran out; nothing more was sent"
                break
            }
            let began = now()
            do {
                let (kind, text) = try await withDeadline(left, "action \(index + 1)") { [self] in try await perform(action, until: actionsUntil) }
                lastKind = kind
                did.append("\(text) (sent, \(Int(((now() - began) * 1000).rounded())) ms)")
            } catch is CancellationError {
                return ToolResult(text: "cancelled", jpeg: nil, isError: true)
            } catch let failure {
                let delivery: Delivery
                switch failure {
                case let e as ActionFailure: delivery = e.delivery
                case let e as RunnerError: delivery = e.delivery
                default: delivery = .unknown
                }
                did.append("\(action.serialized()) (\(delivery.rawValue), \(Int(((now() - began) * 1000).rounded())) ms)")
                // An action that may have been delivered is never sent again by us, and nothing after it is sent.
                error = "action \(index + 1) \(delivery == .unknown ? "may have been delivered" : "was not sent"): \(failure)\(index + 1 < actions.count ? "; the actions after it were not sent" : "")"
                break
            }
        }
        if let lastKind {
            let pause = min(Self.settle[lastKind] ?? 0.4, max(0, until - now() - config.readTimeout - 0.3))
            await sleep(seconds: pause)
            did.append("waited \(Int((pause * 1000).rounded())) ms")
        }
        return await readAndReply(until: until, full: full, did: did, error: error, extra: approvedNote.map { [$0] } ?? [])
    }

    // MARK: Sensitivity

    func element(at point: (x: Double, y: Double)) -> Element? {
        lastElements.filter { f in f.frame.x <= point.x && point.x <= f.frame.x + f.frame.width && f.frame.y <= point.y && point.y <= f.frame.y + f.frame.height }
            .min { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
    }

    func target(_ spec: JSON?) -> Element? {
        guard let spec else { return nil }
        if let point = spec.array, point.count >= 2, let x = point[0].double, let y = point[1].double { return element(at: (x, y)) }
        if case .object = spec {
            if let ref = spec["ref"]?.int { return refs[ref] }
            if let x = spec["x"]?.double, let y = spec["y"]?.double { return element(at: (x, y)) }
            return nil
        }
        return spec.int.flatMap { refs[$0] }
    }

    func sensitiveReason(_ actions: [JSON]) -> String? {
        let rules = config.sensitive
        let secureOnScreen = lastElements.contains(where: \.isSecure)
        var typingTarget: Element?
        for action in actions {
            if let tap = action["tap"] {
                let e = target(tap)
                typingTarget = e
                if let r = rules.reason(touching: e, typing: false, app: lastForeground, secureOnScreen: secureOnScreen) { return r }
            } else if action["type"] != nil {
                let e = action["ref"].flatMap { refs[$0.int ?? -1] } ?? typingTarget
                if let r = rules.reason(touching: e, typing: true, app: lastForeground, secureOnScreen: secureOnScreen && e == nil) { return r }
            } else if let spec = action["long_press"] {
                if let r = rules.reason(touching: target(spec), typing: false, app: lastForeground, secureOnScreen: secureOnScreen) { return r }
            } else if action["key"]?.string?.lowercased() == "return", let field = typingTarget, rules.reason(touching: field, typing: true, app: lastForeground, secureOnScreen: false) != nil {
                return "submitting a password field"
            } else if let r = rules.reason(touching: nil, typing: false, app: lastForeground, secureOnScreen: false) {
                return r
            }
        }
        return nil
    }

    func describe(_ action: JSON) -> String {
        for key in ["tap", "long_press"] {
            if let spec = action[key] {
                if let e = target(spec), !e.text.isEmpty { return "\(key) \"\(e.text)\"" }
                return "\(key) \(spec.serialized())"
            }
        }
        if let text = action["type"]?.text {
            let e = action["ref"].flatMap { refs[$0.int ?? -1] }
            return e?.isSecure == true || lastElements.contains(where: \.isSecure) ? "type \(text.count) characters (hidden)" : "type \"\(text.prefix(40))\""
        }
        return action.serialized()
    }

    static func refs(in action: JSON) -> [Int] {
        var out: [Int] = []
        func add(_ value: JSON?) {
            guard let value else { return }
            switch value {
            case .number(let n): out.append(Int(n))
            case .string(let s): if let n = Int(s) { out.append(n) }
            case .object: if let r = value["ref"]?.int { out.append(r) }
            default: break
            }
        }
        for key in ["tap", "long_press", "pinch", "ref", "in"] { add(action[key]) }
        if case .object = action["drag"] { add(action["drag"]?["from"]); add(action["drag"]?["to"]) }
        if case .object = action["swipe"] { add(action["swipe"]?["in"]) }
        if case .object = action["scroll_to"] { add(action["scroll_to"]?["ref"]); add(action["scroll_to"]?["in"]) }
        return out
    }
}
