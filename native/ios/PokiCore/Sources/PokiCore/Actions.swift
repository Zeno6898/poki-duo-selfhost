import Foundation

// The actions of `do`, as WebDriverAgent requests. Gestures are named verbs with defaults: the model
// names a direction or a target, never a path.
//
//   {tap: n | [x, y]}                          {type: "text", ref?, clear?}
//   {key: "return" | "delete" | ...}           {swipe: dir | {direction, in?, distance?}}
//   {scroll_to: "text" | {text | ref, in?, direction?, max_swipes?}}
//   {long_press: n | [x, y] | {ref | x, y, ms?}}   {drag: {from, to, ms?} | [x1, y1, x2, y2]}
//   {pinch: {ref | x, y, scale}}               {button: "home" | "lock" | "volume_up" | "volume_down"}
//   {launch: "bundle" | {bundle, fresh?}}      {wait: ms}
//   {wait_until: "text" | {text, gone?, ms?} | {settled: true, ms?}}
extension Computer {
    static let keyText: [String: String] = ["return": "\n", "enter": "\n", "delete": "\u{8}", "backspace": "\u{8}", "tab": "\t", "space": " ", "escape": "\u{1b}"]
    static let buttons: [String: String] = ["volume_up": "volumeUp", "volume-up": "volumeUp", "volume_down": "volumeDown", "volume-down": "volumeDown"]

    /// The point to touch for a target. A numbered element is touched where a tap reaches it: its
    /// centre, or the nearest part of it that is on screen and not under a bar or another element.
    /// None: not_hittable, and nothing is sent.
    func point(_ spec: JSON?) throws -> (x: Double, y: Double) {
        guard let spec else { throw ActionFailure(message: "no target given", delivery: .notSent) }
        if let a = spec.array, a.count >= 2, let x = a[0].double, let y = a[1].double { return try onScreen((x, y)) }
        if case .object = spec {
            if let ref = spec["ref"]?.int { return try reachable(ref) }
            if let x = spec["x"]?.double, let y = spec["y"]?.double { return try onScreen((x, y)) }
            throw ActionFailure(message: "a target is a number, [x, y], {ref} or {x, y}", delivery: .notSent)
        }
        guard let ref = spec.int else { throw ActionFailure(message: "a target is a number, [x, y], {ref} or {x, y}", delivery: .notSent) }
        return try reachable(ref)
    }

    func onScreen(_ p: (x: Double, y: Double)) throws -> (x: Double, y: Double) {
        if let size, p.x < 0 || p.y < 0 || p.x > size.width || p.y > size.height {
            throw ActionFailure(message: "not_hittable: [\(Int(p.x)), \(Int(p.y))] is off the screen (\(Int(size.width))x\(Int(size.height)) points); nothing was sent", delivery: .notSent)
        }
        return p
    }

    func reachable(_ ref: Int) throws -> (x: Double, y: Double) {
        let e = try element(ref)
        if e.fromPicture || size == nil { return e.frame.centre }
        let layout = self.layout
        guard let p = layout.hitPoint(e) else {
            throw ActionFailure(message: "not_hittable: element \(ref) \(e.type) \"\(e.text.prefix(40))\": \(layout.unreachable(e)); nothing was sent. Bring it into view first ({scroll_to: {ref: \(ref)}}) or touch a point you can see on the screenshot", delivery: .notSent)
        }
        return p
    }

    /// " at [x, y]" when the point touched is not the element's centre (its centre is off screen or covered).
    func offCentre(_ spec: JSON?, _ p: (x: Double, y: Double)) -> String {
        guard let spec, let ref = spec.int ?? spec["ref"]?.int, let e = refs[ref] else { return "" }
        let c = e.frame.centre
        return abs(c.x - p.x) < 0.5 && abs(c.y - p.y) < 0.5 ? "" : " at [\(Int(p.x.rounded())), \(Int(p.y.rounded()))] (its centre is off screen or covered)"
    }

    func element(_ ref: Int) throws -> Element {
        guard let e = refs[ref] else { throw ActionFailure(message: "no element \(ref) in the latest read", delivery: .notSent) }
        return e
    }

    /// Where a swipe goes: inside the element named, or the biggest list on screen, less the bars
    /// and anything drawn over it (a reply bar), so the finger lands on what scrolls.
    func area(_ ref: JSON?, _ screen: ScreenSize) throws -> Rect {
        let named = try ref.flatMap { r -> Element? in try (r.int ?? r["ref"]?.int).map(element) }
        return Layout(all: lastAll, screen: screen).swipeArea(named)
    }

    func swipePath(_ area: Rect, _ direction: String, _ distance: String = "long") throws -> (Double, Double, Double, Double) {
        let d: (Double, Double)
        switch direction {
        case "up": d = (0, -1)
        case "down": d = (0, 1)
        case "left": d = (-1, 0)
        case "right": d = (1, 0)
        default: throw ActionFailure(message: "swipe must be up, down, left or right", delivery: .notSent)
        }
        let half = (d.0 != 0 ? area.width : area.height) * (distance == "short" ? 0.2 : 0.35)
        let (cx, cy) = area.centre
        return (cx - d.0 * half, cy - d.1 * half, cx + d.0 * half, cy + d.1 * half)
    }

    /// One touch from a point to another: down, `hold` seconds still, moving at a steady speed for
    /// `seconds`, then `rest` seconds still before lifting (no rest = a flick that keeps a list
    /// moving; a rest = the list stops where the finger stopped). XCTest's own press-drag through
    /// WDA's pressAndDragWithVelocity; its time limit is the gesture's own and a slow answer is not
    /// taken as the runner being gone.
    func gesture(_ path: (Double, Double, Double, Double), seconds: Double, hold: Double = 0, rest: Double = 0, until: Double) async throws {
        let distance = max(1, hypot(path.2 - path.0, path.3 - path.1))
        let velocity = distance / max(0.05, seconds)
        let expected = hold + distance / velocity + rest
        let timeout = max(1, min(expected + 5, until - now() - 0.2))
        do {
            _ = try await runner.call("POST", "/wda/pressAndDragWithVelocity", ["fromX": .number(path.0), "fromY": .number(path.1), "toX": .number(path.2), "toY": .number(path.3), "pressDuration": .number(hold), "holdDuration": .number(rest), "velocity": .number(velocity.rounded())], timeout: timeout, countsAsMiss: false)
        } catch let e as RunnerError where e.code == "unknown command" || e.code == "unknown method" {
            // A runner older than pressAndDragWithVelocity.
            _ = try await runner.call("POST", "/wda/dragfromtoforduration", ["fromX": .number(path.0), "fromY": .number(path.1), "toX": .number(path.2), "toY": .number(path.3), "duration": .number(max(0.05, hold))], timeout: timeout, countsAsMiss: false)
        }
    }

    func tap(_ p: (x: Double, y: Double)) async throws {
        _ = try await runner.call("POST", "/wda/tap", ["x": .number(p.x), "y": .number(p.y)], timeout: 3)
    }

    /// Returns the action's kind (for the settle pause) and what it did.
    func perform(_ action: JSON, until: Double) async throws -> (String, String) {
        if let spec = action["tap"] {
            let p = try point(spec)
            try await tap(p)
            return ("tap", "tap \(describe(action))\(offCentre(spec, p))")
        }
        if let text = action["type"]?.text {
            if let ref = action["ref"] {
                try await tap(try point(ref))
                await sleep(seconds: 0.25)
            }
            let hidden = describe(action).hasSuffix("(hidden)")
            let via = action["via"]?.string == "paste" ? "pasted" : "typed"
            if via == "pasted" {
                try await paste(text, clear: action["clear"]?.bool ?? false, until: until)
            } else {
                try await type(text, clear: action["clear"]?.bool ?? false)
            }
            // What the field holds now, so the model sees at once whether the text arrived whole.
            let reads = await fieldValue(timeout: min(1.5, max(0.3, until - now() - 0.2)))
            let readBack = reads.map { hidden ? "; the field now holds \($0.count) characters" : "; the field now reads \"\($0.count > 200 ? String($0.prefix(190)) + "…" : $0)\"" }
                ?? "; the field could not be read back (no focused field answered in time), so check the elements or the picture"
            return ("type", "\(describe(action)) (\(via))\(readBack)")
        }
        if let key = action["key"]?.text {
            let k = key.lowercased()
            guard let text = Self.keyText[k] ?? (key.count == 1 ? key : nil) else {
                throw ActionFailure(message: "key \(key) has no equivalent; use return, delete, tab, space, escape or one character", delivery: .notSent)
            }
            _ = try await runner.call("POST", "/wda/keys", ["value": [.string(text)]], timeout: 3)
            return ("key", "key \(key)")
        }
        if let spec = action["swipe"] {
            let direction = spec.string ?? spec["direction"]?.string ?? ""
            let screen = try await screenSize(until: until)
            let path = try swipePath(try area(spec["in"] ?? action["in"], screen), direction, spec["distance"]?.string ?? "long")
            try await gesture(path, seconds: 0.25, until: until)
            return ("swipe", "swipe \(direction) from [\(Int(path.0)), \(Int(path.1))] to [\(Int(path.2)), \(Int(path.3))]")
        }
        if let spec = action["scroll_to"] {
            return ("scroll_to", "scroll_to \(spec.serialized()): \(try await scrollTo(spec, until: until))")
        }
        if let spec = action["long_press"] {
            let p = try point(spec)
            let ms = min(5000, max(100, spec["ms"]?.double ?? action["ms"]?.double ?? 600))
            _ = try await runner.call("POST", "/wda/touchAndHold", ["x": .number(p.x), "y": .number(p.y), "duration": .number(ms / 1000)], timeout: 3 + ms / 1000)
            return ("long_press", "long_press \(spec.serialized()) \(Int(ms)) ms")
        }
        if let spec = action["drag"] {
            let from: (x: Double, y: Double), to: (x: Double, y: Double)
            if let a = spec.array, a.count == 4, let v = Optional(a.compactMap(\.double)), v.count == 4 {
                from = (v[0], v[1]); to = (v[2], v[3])
            } else {
                from = try point(spec["from"]); to = try point(spec["to"])
            }
            let ms = min(3000, max(100, spec["ms"]?.double ?? 400))
            let hold = min(3000, max(0, spec["hold_ms"]?.double ?? 0))
            try await gesture((from.x, from.y, to.x, to.y), seconds: ms / 1000, hold: hold / 1000, rest: 0.15, until: until)
            return ("drag", "drag from [\(Int(from.x)), \(Int(from.y))] to [\(Int(to.x)), \(Int(to.y))] in \(Int(ms)) ms\(hold > 0 ? " after holding \(Int(hold)) ms" : "")")
        }
        if let spec = action["pinch"] {
            let p = try point(spec)
            let screen = try await screenSize(until: until)
            let scale = min(4, max(0.25, spec["scale"]?.double ?? action["scale"]?.double ?? 2))
            let start = min(screen.width, screen.height) * (scale > 1 ? 0.12 : 0.3)
            let a = start / 2, b = start * scale / 2, ms = 500.0
            func finger(_ id: String, _ sign: Double) -> JSON {
                ["type": "pointer", "id": .string(id), "parameters": ["pointerType": "touch"], "actions": [
                    ["type": "pointerMove", "duration": 0, "x": .number((p.x + sign * a).rounded()), "y": .number(p.y.rounded())],
                    ["type": "pointerDown", "button": 0],
                    ["type": "pointerMove", "duration": .number(ms), "x": .number((p.x + sign * b).rounded()), "y": .number(p.y.rounded())],
                    ["type": "pointerUp", "button": 0],
                ]]
            }
            _ = try await runner.call("POST", "/actions", ["actions": [finger("f1", -1), finger("f2", 1)]], timeout: 4)
            return ("pinch", "pinch \(spec.serialized()) x\(scale)")
        }
        if let name = action["button"]?.text {
            let n = name.lowercased()
            switch n {
            case "lock", "power": _ = try await runner.call("POST", "/wda/lock", [:], timeout: 3)
            case "home": _ = try await runner.call("POST", "/wda/homescreen", [:], timeout: 3)
            default:
                guard let wda = Self.buttons[n] else { throw ActionFailure(message: "button \(name) has no equivalent; use home, lock, volume_up or volume_down", delivery: .notSent) }
                _ = try await runner.call("POST", "/wda/pressButton", ["name": .string(wda)], timeout: 3)
            }
            return ("button", "button \(name)")
        }
        if let spec = action["launch"] {
            guard let bundle = spec.string ?? spec["bundle"]?.string, !bundle.isEmpty else { throw ActionFailure(message: "launch takes a bundle id", delivery: .notSent) }
            let fresh = spec["fresh"]?.bool ?? false
            // A fresh launch ends the app first, so a page it was left on cannot answer for it.
            if fresh {
                do { _ = try await runner.call("POST", "/wda/apps/terminate", ["bundleId": .string(bundle)], timeout: 4) }
                catch let e as RunnerError where e.delivery == .notSent {}
            }
            _ = try await runner.call("POST", "/wda/apps/launch", ["bundleId": .string(bundle)], timeout: 8)
            return ("launch", "launch \(bundle)\(fresh ? " (fresh)" : "")")
        }
        if let spec = action["wait_until"] {
            return ("wait_until", try await waitUntil(spec, until: until))
        }
        if let ms = action["wait"]?.double {
            let seconds = min(ms / 1000, 3, max(0, until - now()))
            await sleep(seconds: seconds)
            return ("wait", "wait \(Int(seconds * 1000)) ms")
        }
        throw ActionFailure(message: "unknown action \(action.serialized())", delivery: .notSent)
    }

    /// The whole text as key presses in one request. Clearing deletes what the focused field holds
    /// with Delete keys in the same request: WDA's element clear retries until the value is empty,
    /// which a field like Safari's address bar never reports (that took 25 s).
    func type(_ text: String, clear: Bool) async throws {
        var deletes = 0
        if clear {
            let active = try? await runner.call("GET", "/element/active", timeout: 2)
            let id = active?["ELEMENT"]?.string ?? active?["element-6066-11e4-a52e-4f735466cecf"]?.string
            if let id, let value = try? await runner.call("GET", "/element/\(id)/attribute/value", timeout: 2), let s = value.string {
                deletes = min(400, s.count)
            }
        }
        let keys = Array(repeating: "\u{8}", count: deletes) + text.map(String.init)
        guard keys.count <= 2000 else { throw ActionFailure(message: "at most 2000 characters at a time", delivery: .notSent) }
        _ = try await runner.call("POST", "/wda/keys", ["value": .array(keys.map(JSON.string))], timeout: 3 + 0.06 * Double(keys.count))
    }

    /// The focused field's id and value, or nil when nothing is focused or the runner does not say.
    func focusedField(timeout: Double) async -> (id: String, value: String?)? {
        guard let active = try? await runner.call("GET", "/element/active", timeout: timeout, countsAsMiss: false),
              let id = active["ELEMENT"]?.string ?? active["element-6066-11e4-a52e-4f735466cecf"]?.string else { return nil }
        let value = try? await runner.call("GET", "/element/\(id)/attribute/value", timeout: timeout, countsAsMiss: false)
        return (id, value?.string)
    }

    func fieldValue(timeout: Double) async -> String? {
        await focusedField(timeout: timeout / 2)?.value
    }

    /// Words of the edit menu's Paste item in the languages iOS ships most.
    static let pasteWords = ["paste", "粘贴", "貼上", "貼り付け", "ペースト", "붙여넣기", "coller", "einfügen", "pegar", "incolla", "colar", "вставить"]

    /// The backup to typing (`via: "paste"`): the text goes through the clipboard and the field's edit
    /// menu. The owner's clipboard is read first and put back afterwards, whatever happens; if it
    /// cannot be read, nothing is pasted (it would be lost).
    func paste(_ text: String, clear: Bool, until: Double) async throws {
        let saved: JSON
        do { saved = try await runner.call("POST", "/wda/getPasteboard", ["contentType": "plaintext"], timeout: 2, countsAsMiss: false) }
        catch { throw ActionFailure(message: "the clipboard could not be read, so it was not used (the owner's clipboard would be lost); type the text instead", delivery: .notSent) }
        guard let field = await focusedField(timeout: 1) else {
            throw ActionFailure(message: "no field is focused to paste into; tap the field first", delivery: .notSent)
        }
        let rect = try? await runner.call("GET", "/element/\(field.id)/rect", timeout: 1.5, countsAsMiss: false)
        guard let x = rect?["x"]?.double, let y = rect?["y"]?.double, let w = rect?["width"]?.double, let h = rect?["height"]?.double else {
            throw ActionFailure(message: "the focused field's frame is unknown, so there is nowhere to open its menu", delivery: .notSent)
        }
        var restored = false
        func restore() async {
            guard !restored else { return }
            restored = true
            _ = try? await runner.call("POST", "/wda/setPasteboard", ["content": .string(saved.string ?? ""), "contentType": "plaintext"], timeout: 2, countsAsMiss: false)
        }
        do {
            if clear, let value = field.value, !value.isEmpty {
                _ = try await runner.call("POST", "/wda/keys", ["value": .array(Array(repeating: JSON.string("\u{8}"), count: min(400, value.count)))], timeout: 3 + 0.06 * Double(min(400, value.count)))
            }
            _ = try await runner.call("POST", "/wda/setPasteboard", ["content": .string(Data(text.utf8).base64EncodedString()), "contentType": "plaintext"], timeout: 2, countsAsMiss: false)
            _ = try await runner.call("POST", "/wda/touchAndHold", ["x": .number(x + w / 2), "y": .number(y + h / 2), "duration": .number(0.7)], timeout: 4)
            var item: Element?
            let menuBy = min(until - 0.3, now() + 2)
            while item == nil, now() < menuBy {
                await sleep(seconds: 0.2)
                if let seen = try? await runner.tree(timeout: max(0.3, min(1.2, menuBy - now()))) {
                    item = seen.elements.first { e in Self.pasteWords.contains { e.text.lowercased() == $0 } }
                }
            }
            guard let item else {
                await restore()
                throw ActionFailure(message: "the field's menu showed no Paste item; the text was not pasted (a long press was sent)", delivery: .sent)
            }
            try await tap(item.frame.centre)
            await sleep(seconds: 0.3)
            await restore()
        } catch {
            await restore()
            throw error
        }
    }

    /// Swipes until the target is fully on screen and not under a bar, with a tree read after each
    /// swipe. The finger stops before lifting, so the list does not coast past the target. Stops at
    /// the end of the list, at max_swipes, or when the action time runs out.
    func scrollTo(_ spec: JSON, until: Double) async throws -> String {
        let screen = try await screenSize(until: until)
        let wantedKey: String? = try spec["ref"]?.int.map { try element($0).key }
        let wantedText = spec.string ?? spec["text"]?.string
        guard wantedKey != nil || wantedText != nil else { throw ActionFailure(message: "scroll_to takes text or ref", delivery: .notSent) }
        let region = try area(spec["in"], screen)
        let fingerGoes = ["down": "up", "up": "down", "right": "left", "left": "right"][spec["direction"]?.string ?? "down"] ?? "up"
        let max = min(12, spec["max_swipes"]?.int ?? 6)
        func hit(_ all: [Element]) -> Element? {
            let layout = Layout(all: all, screen: screen)
            return all.first { e in
                guard wantedKey.map({ e.key == $0 }) ?? (!e.text.isEmpty && e.text.lowercased().contains(wantedText!.lowercased())) else { return false }
                let f = e.frame
                guard f.x >= 0, f.y >= 0, f.maxX <= screen.width, f.maxY <= screen.height else { return false }
                let c = f.centre
                return !layout.covers(e).contains { $0.frame.contains(c) }
            }
        }
        var all = lastAll, swipes = 0, last: String?
        while hit(all) == nil, swipes < max, until - now() > 0.9 {
            try await gesture(try swipePath(region, fingerGoes), seconds: 0.3, rest: 0.1, until: until)
            swipes += 1
            await sleep(seconds: 0.15)
            guard let seen = try? await runner.tree(timeout: Swift.max(0.3, Swift.min(1.5, until - now() - 0.2))) else { continue }
            let signature = seen.elements.map { "\($0.key)@\(Int($0.frame.y))" }.joined(separator: ";")
            if signature == last { return "\(swipes) swipes, not found: the list stopped moving" }
            last = signature
            all = seen.elements
        }
        if let found = hit(all) { return "\(swipes) swipes, found at \(found.frame.described)" }
        return "\(swipes) swipes, not found\(swipes >= max ? " within \(max) swipes" : "")"
    }

    /// Reads the tree every quarter second until the text is there (or gone), or the screen holds still
    /// for two reads in a row. Not finding it is a fact, not a failure: the model decides.
    func waitUntil(_ spec: JSON, until: Double) async throws -> String {
        let settled = spec["settled"]?.bool ?? (spec.string == "settled")
        let text = settled && spec.string == "settled" ? nil : (spec.string ?? spec["text"]?.string)
        let gone = spec["gone"]?.bool ?? false
        guard settled || (text != nil && !text!.isEmpty) else { throw ActionFailure(message: "wait_until takes text, {text, gone?: true, ms?} or {settled: true, ms?}", delivery: .notSent) }
        let started = now()
        let limit = Swift.min(started + Swift.min(10, Swift.max(0.2, (spec["ms"]?.double ?? 3000) / 1000)), until)
        let screen = size ?? ScreenSize(width: 10_000, height: 10_000)
        let what = settled && text == nil ? "the screen held still" : "\"\(text!.prefix(40))\" \(gone ? "was gone" : "appeared")"
        var last: String?
        var reads = 0
        while now() < limit {
            if let seen = try? await runner.tree(timeout: Swift.max(0.3, Swift.min(1.5, limit - now()))) {
                reads += 1
                let elements = listable(seen.elements, screen)
                let ms = Int(((now() - started) * 1000).rounded())
                if settled && text == nil {
                    let signature = elements.map { "\($0.key)@\($0.frame.described)" }.joined(separator: ";")
                    if signature == last { return "wait_until: \(what) after \(ms) ms" }
                    last = signature
                } else if let text {
                    let present = elements.contains { $0.text.lowercased().contains(text.lowercased()) }
                    if present != gone { return "wait_until: \(what) after \(ms) ms" }
                }
            }
            await sleep(seconds: Swift.min(0.25, Swift.max(0, limit - now())))
        }
        return "wait_until: not seen within \(Int(((limit - started) * 1000).rounded())) ms that \(what) (\(reads) reads)"
    }
}
