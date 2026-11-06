import Foundation

public struct Rect: Equatable, Sendable {
    public var x, y, width, height: Double
    public var centre: (x: Double, y: Double) { (x + width / 2, y + height / 2) }
}

/// One element of the accessibility tree, flattened.
public struct Element: Equatable, Sendable {
    public var type: String
    public var label: String?
    public var value: String?
    public var identifier: String?
    public var frame: Rect
    public var depth: Int

    /// What the element says: its label, and its value when it has one.
    public var text: String { [label, value].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " = ") }
    /// The same element across two reads.
    public var key: String { "\(type)|\(text)" }
    public var isSecure: Bool { type == "SecureTextField" }
}

public struct Foreground: Equatable, Sendable {
    public var bundleID: String?
    public var name: String?
    public var describe: String { name ?? bundleID ?? "unknown" }
}

public struct ScreenSize: Equatable, Sendable { public var width, height: Double }

/// One read of the screen. Either part may be missing; `notes` says why.
public struct Reading: Sendable {
    public var elements: [Element] = []
    public var foreground: Foreground?
    public var png: Data?
    public var notes: [String] = []
    public var ms = 0
}

/// WDA's JSON source as a flat list of the elements worth listing: not the application root, with a
/// frame and something to say.
func flatten(_ root: JSON) -> [Element] {
    var out: [Element] = []
    func walk(_ node: JSON, _ depth: Int) {
        guard case .object = node else { return }
        let r = node["rect"]
        let frame = Rect(x: r?["x"]?.double ?? 0, y: r?["y"]?.double ?? 0, width: r?["width"]?.double ?? 0, height: r?["height"]?.double ?? 0)
        let visible = node["isVisible"]?.bool ?? true
        if depth > 0, visible, frame.width > 0, frame.height > 0 {
            let type = (node["type"]?.string ?? "Other").replacingOccurrences(of: "XCUIElementType", with: "")
            let name = node["name"]?.text
            out.append(Element(type: type, label: node["label"]?.text ?? name, value: node["value"]?.text, identifier: name, frame: frame, depth: depth))
        }
        for child in node["children"]?.array ?? [] { walk(child, depth + 1) }
    }
    walk(root, 0)
    return out
}

func listable(_ elements: [Element], _ size: ScreenSize) -> [Element] {
    elements.filter { e in
        guard !e.text.isEmpty else { return false }
        let f = e.frame
        return f.x + f.width > 0 && f.y + f.height > 0 && f.x < size.width && f.y < size.height
    }
}

extension Runner {
    /// The source without visible, accessible, enabled and index: `visible` alone costs 2 s against 0.6 s
    /// for Settings; what is on screen is decided from the frames instead.
    func tree(timeout: Double) async throws -> (elements: [Element], foreground: Foreground) {
        async let source = call("GET", "/source?format=json&excluded_attributes=visible,accessible,enabled,index", timeout: timeout)
        async let app = try? call("GET", "/wda/activeAppInfo", timeout: min(timeout, 2))
        let (sourceValue, appValue) = (try await source, await app)
        let root = (try? sourceValue.string.map(JSON.parse)) ?? sourceValue
        let name = appValue?["name"]?.string.flatMap { $0.isEmpty ? nil : $0 } ?? root["label"]?.text ?? root["name"]?.text
        return (flatten(root), Foreground(bundleID: appValue?["bundleId"]?.string, name: name))
    }

    func screenshot(timeout: Double) async throws -> Data {
        let value = try await raw("GET", "/screenshot", timeout: timeout)
        guard let base64 = value.string, let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else {
            throw RunnerError(message: "the runner sent no screenshot", delivery: .notSent)
        }
        return data
    }

    /// /wda/screen needs no session; a session's window size fails once the app it was opened on is gone.
    func screenSize(timeout: Double = 3) async throws -> ScreenSize {
        let value = try await raw("GET", "/wda/screen", timeout: timeout)
        guard let w = value["screenSize"]?["width"]?.double, let h = value["screenSize"]?["height"]?.double else {
            throw RunnerError(message: "the runner did not say the screen size", delivery: .notSent)
        }
        return ScreenSize(width: w, height: h)
    }

    /// The screenshot and the tree at the same time; each has its own deadline, and a part that fails
    /// is reported in `notes` instead of failing the read.
    func read(timeout: Double, wantPicture: Bool = true) async -> Reading {
        let started = now()
        async let treePart: Result<(elements: [Element], foreground: Foreground), Error> = {
            do { return .success(try await self.tree(timeout: timeout)) } catch { return .failure(error) }
        }()
        async let picturePart: Result<Data, Error>? = wantPicture ? {
            do { return .success(try await self.screenshot(timeout: timeout)) } catch { return .failure(error) }
        }() : nil
        var reading = Reading()
        switch await treePart {
        case .success(let t): reading.elements = t.elements; reading.foreground = t.foreground
        case .failure(let e): reading.notes.append("no element tree: \(e)")
        }
        switch await picturePart {
        case .success(let png)?: reading.png = png
        case .failure(let e)?: reading.notes.append("no screenshot: \(e)")
        case nil: break
        }
        reading.ms = Int(((now() - started) * 1000).rounded())
        return reading
    }
}
