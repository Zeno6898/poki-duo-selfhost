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
extension Computer {
    static let keyText: [String: String] = ["return": "\n", "enter": "\n", "delete": "\u{8}", "backspace": "\u{8}", "tab": "\t", "space": " ", "escape": "\u{1b}"]
    static let buttons: [String: String] = ["volume_up": "volumeUp", "volume-up": "volumeUp", "volume_down": "volumeDown", "volume-down": "volumeDown"]

    func point(_ spec: JSON?) throws -> (x: Double, y: Double) {
        guard let spec else { throw ActionFailure(message: "no target given", delivery: .notSent) }
        if let a = spec.array, a.count >= 2, let x = a[0].double, let y = a[1].double { return (x, y) }
        if case .object = spec {
            if let ref = spec["ref"]?.int { return try element(ref).frame.centre }
            if let x = spec["x"]?.double, let y = spec["y"]?.double { return (x, y) }
            throw ActionFailure(message: "a target is a number, [x, y], {ref} or {x, y}", delivery: .notSent)
        }
        guard let ref = spec.int else { throw ActionFailure(message: "a target is a number, [x, y], {ref} or {x, y}", delivery: .notSent) }
        return try element(ref).frame.centre
    }

    func element(_ ref: Int) throws -> Element {
        guard let e = refs[ref] else { throw ActionFailure(message: "no element \(ref) in the latest read", delivery: .notSent) }
        return e
    }

    func area(_ ref: JSON?, _ screen: ScreenSize) throws -> Rect {
        guard let ref, let n = ref.int ?? ref["ref"]?.int else { return Rect(x: 0, y: 0, width: screen.width, height: screen.height) }
        return try element(n).frame
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

    func drag(_ path: (Double, Double, Double, Double), seconds: Double) async throws {
        _ = try await runner.call("POST", "/wda/dragfromtoforduration", ["fromX": .number(path.0), "fromY": .number(path.1), "toX": .number(path.2), "toY": .number(path.3), "duration": .number(max(0.05, seconds))], timeout: 4 + seconds)
    }

    func tap(_ p: (x: Double, y: Double)) async throws {
        _ = try await runner.call("POST", "/wda/tap", ["x": .number(p.x), "y": .number(p.y)], timeout: 3)
    }

    /// Returns the action's kind (for the settle pause) and what it did.
    func perform(_ action: JSON, until: Double) async throws -> (String, String) {
        if let spec = action["tap"] {
            try await tap(try point(spec))
            return ("tap", "tap \(describe(action))")
        }
        if let text = action["type"]?.text {
            if let ref = action["ref"] {
                try await tap(try point(ref))
                await sleep(seconds: 0.25)
            }
            try await type(text, clear: action["clear"]?.bool ?? false)
            return ("type", describe(action))
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
            try await drag(path, seconds: 0.3)
            return ("swipe", "swipe \(direction)")
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
            try await drag((from.x, from.y, to.x, to.y), seconds: ms / 1000)
            return ("drag", "drag \(spec.serialized())")
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

    /// Swipes until the target is fully on screen, with a tree read after each swipe. Stops at the
    /// end of the list, at max_swipes, or when the action time runs out.
    func scrollTo(_ spec: JSON, until: Double) async throws -> String {
        let screen = try await screenSize(until: until)
        let wantedKey: String? = try spec["ref"]?.int.map { try element($0).key }
        let wantedText = spec.string ?? spec["text"]?.string
        guard wantedKey != nil || wantedText != nil else { throw ActionFailure(message: "scroll_to takes text or ref", delivery: .notSent) }
        let region = try area(spec["in"], screen)
        let fingerGoes = ["down": "up", "up": "down", "right": "left", "left": "right"][spec["direction"]?.string ?? "down"] ?? "up"
        let max = min(12, spec["max_swipes"]?.int ?? 6)
        func onScreen(_ e: Element) -> Bool { e.frame.x >= 0 && e.frame.y >= 0 && e.frame.x + e.frame.width <= screen.width && e.frame.y + e.frame.height <= screen.height }
        func hit(_ elements: [Element]) -> Element? {
            elements.first { e in onScreen(e) && (wantedKey.map { e.key == $0 } ?? e.text.lowercased().contains(wantedText!.lowercased())) }
        }
        var elements = lastElements, swipes = 0, last: String?
        while hit(elements) == nil, swipes < max, until - now() > 0.9 {
            try await drag(try swipePath(region, fingerGoes), seconds: 0.25)
            swipes += 1
            await sleep(seconds: 0.25)
            guard let seen = try? await runner.tree(timeout: Swift.max(0.3, Swift.min(1.5, until - now() - 0.2))) else { continue }
            let signature = seen.elements.map { "\($0.key)@\(Int($0.frame.y))" }.joined(separator: ";")
            if signature == last { return "\(swipes) swipes, not found: the list stopped moving" }
            last = signature
            elements = seen.elements
        }
        if let found = hit(elements) { return "\(swipes) swipes, found at [\(Int(found.frame.x)),\(Int(found.frame.y))]" }
        return "\(swipes) swipes, not found\(swipes >= max ? " within \(max) swipes" : "")"
    }
}
