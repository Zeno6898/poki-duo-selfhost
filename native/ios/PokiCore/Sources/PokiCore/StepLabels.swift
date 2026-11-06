import Foundation

/// Plain words for what the agent did, for the person: the Live Activity, the home screen's recent
/// steps and approval prompts. Never JSON. The agent's own result text is unchanged (Actions.swift).
extension Computer {
    /// "Tap “Send”", "Type “hello”", "Swipe up". Waits are not steps a person needs to see: nil.
    func label(_ action: JSON) -> String? {
        if action["wait"] != nil || action["wait_until"] != nil, action.object?.count == 1 { return nil }
        for (key, verb) in [("tap", "Tap"), ("long_press", "Press and hold")] {
            if let spec = action[key] {
                if let e = target(spec), let name = Self.name(of: e) { return "\(verb) “\(name)”" }
                if let point = spec.array, point.count >= 2, let x = point[0].int, let y = point[1].int { return "\(verb) at \(x), \(y)" }
                return "\(verb) on the screen"
            }
        }
        if let text = action["type"]?.text {
            let e = action["ref"].flatMap { refs[$0.int ?? -1] }
            if e?.isSecure == true || lastElements.contains(where: \.isSecure) { return "Type \(text.count) hidden characters" }
            return "Type “\(Self.short(text, 32))”"
        }
        if let key = action["key"]?.text { return "Press \(key.prefix(1).uppercased() + key.dropFirst())" }
        if let spec = action["swipe"] {
            let direction = spec.string ?? spec["direction"]?.string ?? ""
            return direction.isEmpty ? "Swipe" : "Swipe \(direction)"
        }
        if let spec = action["scroll_to"] {
            if let text = spec.string ?? spec["text"]?.string { return "Scroll to “\(Self.short(text, 28))”" }
            if let e = target(spec), let name = Self.name(of: e) { return "Scroll to “\(name)”" }
            return "Scroll"
        }
        if action["drag"] != nil { return "Drag" }
        if let spec = action["pinch"] {
            let scale = spec["scale"]?.double ?? action["scale"]?.double ?? 2
            return scale >= 1 ? "Zoom in" : "Zoom out"
        }
        if let name = action["button"]?.text {
            return "Press \(name.prefix(1).uppercased() + name.dropFirst()) button"
        }
        if let spec = action["launch"] {
            let bundle = spec.string ?? spec["bundle"]?.string ?? ""
            return bundle.isEmpty ? "Open an app" : "Open \(appNameOrBundle(bundle))"
        }
        if action["wait"] != nil || action["wait_until"] != nil { return "Wait" }
        return "Act on the screen"
    }

    /// The labels of several actions, waits left out: "Tap “Search”, then type “cats”".
    func labels(_ actions: [JSON]) -> String {
        let parts = actions.compactMap(label)
        guard let first = parts.first else { return actions.isEmpty ? "Look at the screen" : "Wait" }
        let rest = parts.dropFirst().map { $0.prefix(1).lowercased() + $0.dropFirst() }
        return ([first] + rest).joined(separator: ", then ")
    }

    /// An element's visible name: the label, or the value when there is no label; never "x = x".
    static func name(of e: Element) -> String? {
        let label = e.label?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let value = e.value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let text = label.isEmpty ? value : label
        return text.isEmpty ? nil : short(text, 28)
    }

    static func short(_ text: String, _ limit: Int) -> String {
        let one = text.replacingOccurrences(of: "\n", with: " ")
        return one.count > limit ? String(one.prefix(limit - 1)) + "…" : one
    }

    /// A readable name for a bundle ID: the app's name when it is the app in front, else the last
    /// part, capitalised.
    func appNameOrBundle(_ bundle: String) -> String {
        if lastForeground?.bundleID == bundle, let name = lastForeground?.name { return name }
        return Self.appName(bundle)
    }

    static let knownApps: [String: String] = [
        "com.apple.mobilenotes": "Notes", "com.apple.Preferences": "Settings", "com.apple.mobilesafari": "Safari",
        "com.apple.mobiletimer": "Clock", "com.apple.MobileSMS": "Messages", "com.apple.mobilemail": "Mail",
        "com.apple.mobileslideshow": "Photos", "com.apple.camera": "Camera", "com.apple.Maps": "Maps",
        "com.apple.reminders": "Reminders", "com.apple.mobilecal": "Calendar", "com.apple.AppStore": "App Store",
        "com.apple.mobilephone": "Phone", "com.apple.weather": "Weather", "com.apple.calculator": "Calculator",
        "com.apple.DocumentsApp": "Files", "com.apple.Music": "Music", "com.apple.shortcuts": "Shortcuts",
        "com.tencent.xin": "WeChat", "com.atebits.Tweetie2": "X", "com.xingin.discover": "Xiaohongshu",
        "com.google.chrome.ios": "Chrome", "com.burbn.instagram": "Instagram", "net.whatsapp.WhatsApp": "WhatsApp",
        "ph.telegra.Telegraph": "Telegram", "com.spotify.client": "Spotify", "com.ss.iphone.ugc.Aweme": "Douyin",
        "com.zhiliaoapp.musically": "TikTok", "com.google.ios.youtube": "YouTube", "com.tinyspeck.chatlyio": "Slack",
    ]

    static func appName(_ bundle: String) -> String {
        if let known = knownApps[bundle] { return known }
        let parts = bundle.split(separator: ".").map(String.init)
        return parts.last.map { $0.prefix(1).uppercased() + $0.dropFirst() } ?? bundle
    }
}
