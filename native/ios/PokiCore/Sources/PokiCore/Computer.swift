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
    /// The numbers of the latest read. An element that is still there in the next read keeps its
    /// number, so a `do` can list only what changed.
    var refs: [Int: Element] = [:]
    var listed: [(ref: Int, element: Element)] = []
    var nextRef = 1
    /// Every element of the latest tree with a frame, listed or not (for what covers what).
    var lastAll: [Element] = []
    var lastForeground: Foreground?
    var size: ScreenSize?
    var lastPNG: Data?
    var lastTree: String?
    var lastPicture: UInt64?

    var lastElements: [Element] { listed.map(\.element) }
    var layout: Layout { Layout(all: lastAll, screen: size ?? ScreenSize(width: 10_000, height: 10_000)) }

    static let settle: [String: Double] = ["tap": 0.45, "type": 0.25, "key": 0.3, "swipe": 0.6, "drag": 0.35, "long_press": 0.4, "pinch": 0.6, "button": 0.7, "launch": 0.9, "scroll_to": 0.2, "wait": 0, "wait_until": 0]
    static let lineLimit = 120
    static let textLimit = 160

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

    /// The screenshot's width: one pixel per screen point, so a point read off the picture is a point
    /// to tap.
    static func pictureWidth(_ screen: ScreenSize?) -> Int {
        guard let w = screen?.width, w >= 200, w <= 1400 else { return 300 }
        return Int(w.rounded())
    }

    /// Reads the screen and answers with the facts, whatever part of the read failed. `changes` lists
    /// only what changed since the read before (a `do`); `full` lists every element, as the tree has it.
    func readAndReply(until: Double, full: Bool, changes: Bool = false, did: [String] = [], error: String? = nil, extra: [String] = []) async -> ToolResult {
        let budget = max(0.8, min(config.readTimeout, until - now() - 0.2))
        let reading = await runner.read(timeout: budget)
        if size == nil { _ = try? await screenSize(until: now() + 1.5) }
        let screen = size ?? ScreenSize(width: 10_000, height: 10_000)
        var notes = reading.notes
        if reading.png == nil && reading.elements.isEmpty {
            // Nothing came back: say what was sent and what the runner is doing, and nothing else.
            let state = host.runnerState()
            let did = did.map { $0.replacingOccurrences(of: "(sent,", with: "(sent, not confirmed: no read after it,") }
            let lines = ["read: failed (\(notes.joined(separator: "; ")))", "runner: \(state.describe)"] + did.map { "did: \($0)" } + (error.map { ["error: \($0)"] } ?? []) + extra
            refs = [:]
            listed = []
            return ToolResult(text: lines.joined(separator: "\n"), jpeg: nil, isError: true)
        }
        let treeRead = !reading.elements.isEmpty || reading.notes.isEmpty
        let sameApp = reading.foreground?.bundleID == nil || reading.foreground?.bundleID == lastForeground?.bundleID
        lastForeground = reading.foreground ?? lastForeground
        lastPNG = reading.png ?? lastPNG

        // Whether the screen changed since the read before (the one the model saw last).
        let visible = listable(reading.elements, screen)
        let tree = visible.map { "\($0.key)@\($0.frame.described)" }.joined(separator: "\n")
        let picture = reading.png.map(fingerprint)
        var changedLine: String?
        if changes, treeRead, let before = lastTree {
            let pictureChanged: Bool? = picture.flatMap { now in lastPicture.map { $0 != now } }
            if tree != before { changedLine = "screen_changed: true (the elements changed)" }
            else if pictureChanged == true { changedLine = "screen_changed: true (only the picture changed; the elements are the same)" }
            else { changedLine = "screen_changed: false (the elements\(pictureChanged == false ? " and the picture" : "") are the same as in the read before)" }
        }
        if treeRead { lastTree = tree }
        if let picture { lastPicture = picture }

        // What to list: the elements without repeats, and in a full read the text inside collapsed ones.
        var shown = treeRead ? lean(visible, full: full) : []
        let collapsed = Set(shown.filter { isCollapsed($0, in: reading.elements) }.map(\.node))
        if full, !collapsed.isEmpty, let png = reading.png, size != nil {
            let host = self.host
            let left = max(0.3, min(2, until - now() - 0.5))
            if let texts = (try? await withDeadline(left, "reading text from the picture", { await host.recognizeText(inPNG: png) })) ?? nil {
                // Each text goes right after the collapsed element it lies in, top to bottom.
                var inside: [Int: [Element]] = [:]
                let holders = shown.filter { collapsed.contains($0.node) }
                for t in texts {
                    let frame = Rect(x: t.box.x * screen.width, y: t.box.y * screen.height, width: t.box.width * screen.width, height: t.box.height * screen.height)
                    guard let holder = holders.last(where: { $0.frame.contains(frame.centre) }) else { continue }
                    inside[holder.node, default: []].append(Element(type: "Text", label: t.text, value: nil, identifier: nil, frame: frame, depth: holder.depth + 1, fromPicture: true))
                }
                shown = shown.flatMap { e in [e] + (inside[e.node] ?? []).sorted { ($0.frame.y, $0.frame.x) < ($1.frame.y, $1.frame.x) } }
            } else {
                notes.append("no text read from the picture")
            }
        }

        // Numbers: an element still there keeps its number (same text and frame first, then same text).
        let prior = treeRead ? listed : []
        var exact: [String: [Int]] = [:], loose: [String: [Int]] = [:]
        for (r, e) in prior where !e.fromPicture {
            exact["\(e.key)@\(e.frame.described)", default: []].append(r)
            loose[e.key, default: []].append(r)
        }
        var used = Set<Int>()
        var assigned = [Int?](repeating: nil, count: shown.count)
        var moved = Set<Int>()
        for (i, e) in shown.enumerated() where !e.fromPicture {
            if let r = exact["\(e.key)@\(e.frame.described)"]?.first(where: { !used.contains($0) }) { assigned[i] = r; used.insert(r) }
        }
        for (i, e) in shown.enumerated() where !e.fromPicture && assigned[i] == nil {
            if let r = loose[e.key]?.first(where: { !used.contains($0) }) { assigned[i] = r; used.insert(r); moved.insert(r) }
        }
        // Another screen: numbering starts again.
        let fresh = prior.isEmpty || !sameApp || Double(used.count) < 0.3 * Double(max(1, shown.count))
        if fresh {
            assigned = [Int?](repeating: nil, count: shown.count)
            moved = []
            used = []
            nextRef = 1
        }
        for i in assigned.indices where assigned[i] == nil {
            assigned[i] = nextRef
            nextRef += 1
        }
        let gone = fresh ? [] : prior.filter { !used.contains($0.ref) && !$0.element.fromPicture }
        if treeRead {
            refs = [:]
            listed = []
            for (i, e) in shown.enumerated() {
                refs[assigned[i]!] = e
                listed.append((assigned[i]!, e))
            }
            lastAll = reading.elements
        } else {
            refs = [:]
            listed = []
        }

        func line(_ ref: Int, _ e: Element, _ mark: String) -> String {
            var text = e.text
            if !full, text.count > Self.textLimit { text = "\(text.prefix(Self.textLimit - 10))… (+\(text.count - Self.textLimit + 10) characters)" }
            let tag = e.fromPicture ? " (read from the picture)" : collapsed.contains(e.node) ? " [collapsed]" : ""
            return "\(mark)\(ref) \(e.type) \"\(text)\" \(e.frame.described)\(tag)"
        }
        var body: [String] = []
        var heading: String
        let marks: [String] = shown.indices.map { i in
            let r = assigned[i]!
            if fresh { return " " }
            return used.contains(r) ? (moved.contains(r) ? "~" : " ") : "+"
        }
        if changes, !full, !fresh {
            let changed = shown.indices.filter { marks[$0] != " " }
            let same = shown.count - changed.count
            heading = changed.isEmpty
                ? "elements: none changed (\(shown.count) on screen keep their numbers)"
                : "elements (\(shown.count) on screen; only the changed are listed: + new, ~ moved; the \(same) others keep their numbers, full=true lists all):"
            body = changed.prefix(Self.lineLimit).map { line(assigned[$0]!, shown[$0], marks[$0]) }
        } else {
            heading = fresh || prior.isEmpty ? "elements (\(shown.count)):" : "elements (\(shown.count); + new since the last read, ~ moved):"
            body = shown.indices.prefix(full ? 1000 : Self.lineLimit).map { line(assigned[$0]!, shown[$0], marks[$0]) }
            if !full, shown.count > Self.lineLimit { body.append("… \(shown.count - Self.lineLimit) more; full=true lists all") }
        }
        if !collapsed.isEmpty, !full { heading += "  ([collapsed] = one element whose parts are not in the tree; full=true adds the text read from the picture inside it, or tap a point on the screenshot)" }

        var jpeg: Data?
        let width = Self.pictureWidth(size)
        if let png = reading.png {
            do { jpeg = try host.jpeg(fromPNG: png, width: width, quality: 0.6) }
            catch { notes.append("screenshot not encoded: \(error)") }
        }
        let app = reading.foreground?.describe ?? "unknown"
        var header = ["app: \(app)   read: \(ISO8601DateFormatter().string(from: Date())) (\(reading.ms) ms)" + (notes.isEmpty ? "" : "   note: \(notes.joined(separator: "; "))")]
        if jpeg != nil { header.append(size != nil ? "screenshot: \(width) px wide, 1 px = 1 screen point (the same points as the frames and taps)" : "screenshot: \(width) px wide; screen size unknown") }
        header += did.map { "did: \($0)" }
        if let error { header.append("error: \(error)") }
        if let changedLine { header.append(changedLine) }
        header += extra
        header.append(heading)
        let footer = gone.isEmpty ? [] : ["gone since the last read: " + gone.prefix(20).map { "\($0.ref) \($0.element.type) \"\($0.element.text.prefix(40))\"" }.joined(separator: ", ")]
        return ToolResult(text: (header + body + footer).joined(separator: "\n"), jpeg: jpeg, isError: error != nil)
    }

    func look(full: Bool) async -> ToolResult {
        let until = now() + config.toolDeadline
        if let blocked = await waitForRunner(until: until) { return blocked }
        return await readAndReply(until: until, full: full)
    }

    /// The app stops the runner when no agent is using the phone, and asking for its state wakes it.
    /// While it is starting, the call waits for it (every 250 ms, at most `runnerWait`, within the
    /// call's deadline) and then goes on; a failed runner is answered at once, with its fix.
    func waitForRunner(until: Double) async -> ToolResult? {
        var state = host.runnerState()
        let waitUntil = min(now() + config.runnerWait, until - config.readTimeout - 1)
        while case .starting = state, now() < waitUntil {
            await sleep(seconds: 0.25)
            state = host.runnerState()
        }
        guard !state.isRunning else { return nil }
        let next: String
        if case .failed = state { next = "Fix it on the phone, then call look again." } else { next = "Call look again in a few seconds; it is still starting." }
        return ToolResult(text: "runner: \(state.describe)\nNothing was sent. \(next)", jpeg: nil, isError: true)
    }

    // MARK: do

    func act(actions: [JSON], full: Bool) async -> ToolResult {
        var started = now()
        var until = started + config.toolDeadline
        if let blocked = await waitForRunner(until: until) { return blocked }

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
                // The time the owner takes is not the actions' time: the clock starts again after it.
                let asked = now()
                switch await approvals.wait(id: approval.id, seconds: config.approvalWait) {
                case .approved?:
                    _ = approvals.consumeGrant(fingerprint: fingerprint)
                    let waited = now() - asked
                    approvedNote = "approval: approved on the phone after \(Int(waited.rounded())) s (\(reason))"
                    until += waited
                    started += waited
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
            if pause > 0.01 {
                await sleep(seconds: pause)
                did.append("paused \(Int((pause * 1000).rounded())) ms before reading")
            }
        }
        return await readAndReply(until: until, full: full, changes: true, did: did, error: error, extra: approvedNote.map { [$0] } ?? [])
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
