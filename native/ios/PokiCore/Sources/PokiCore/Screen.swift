import Foundation
#if canImport(FoundationXML)
import FoundationXML
#endif

public struct Rect: Equatable, Sendable {
    public var x, y, width, height: Double
    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
    public var centre: (x: Double, y: Double) { (x + width / 2, y + height / 2) }
    public var maxX: Double { x + width }
    public var maxY: Double { y + height }
    public var area: Double { max(0, width) * max(0, height) }
    public var isEmpty: Bool { width <= 0 || height <= 0 }
    public func contains(_ p: (x: Double, y: Double)) -> Bool { x <= p.x && p.x <= maxX && y <= p.y && p.y <= maxY }
    public func intersection(_ o: Rect) -> Rect {
        let left = max(x, o.x), top = max(y, o.y), right = min(maxX, o.maxX), bottom = min(maxY, o.maxY)
        return Rect(x: left, y: top, width: max(0, right - left), height: max(0, bottom - top))
    }
    public func intersects(_ o: Rect) -> Bool { !intersection(o).isEmpty }
    /// x, y, width and height rounded to whole points.
    var described: String { "[\([x, y, width, height].map { String(Int($0.rounded())) }.joined(separator: ","))]" }
}

/// One element of the accessibility tree, flattened.
public struct Element: Equatable, Sendable {
    public var type: String
    public var label: String?
    public var value: String?
    public var identifier: String?
    public var frame: Rect
    public var depth: Int
    /// The element's place in the tree, in document order, and the last place inside it: an element
    /// whose `node` is in `node+1...end` is inside this one.
    public var node = 0
    public var end = 0
    /// Not in the tree: text read from the screenshot.
    public var fromPicture = false

    public init(type: String, label: String?, value: String?, identifier: String?, frame: Rect, depth: Int, node: Int = 0, end: Int = 0, fromPicture: Bool = false) {
        self.type = type
        self.label = label
        self.value = value
        self.identifier = identifier
        self.frame = frame
        self.depth = depth
        self.node = node
        self.end = end
        self.fromPicture = fromPicture
    }

    func contains(_ other: Element) -> Bool { node < other.node && other.node <= end }

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
    var counter = 0
    func walk(_ node: JSON, _ depth: Int) {
        guard case .object = node else { return }
        counter += 1
        let place = counter
        let r = node["rect"]
        let frame = Rect(x: r?["x"]?.double ?? 0, y: r?["y"]?.double ?? 0, width: r?["width"]?.double ?? 0, height: r?["height"]?.double ?? 0)
        let visible = node["isVisible"]?.bool ?? true
        var index: Int?
        if depth > 0, visible, frame.width > 0, frame.height > 0 {
            let type = (node["type"]?.string ?? "Other").replacingOccurrences(of: "XCUIElementType", with: "")
            let name = node["name"]?.text
            index = out.count
            out.append(Element(type: type, label: node["label"]?.text ?? name, value: node["value"]?.text, identifier: name, frame: frame, depth: depth, node: place, end: place))
        }
        for child in node["children"]?.array ?? [] { walk(child, depth + 1) }
        if let index { out[index].end = counter }
    }
    walk(root, 0)
    return out
}

/// WDA's XML source (`<AppiumAUT><XCUIElementTypeApplication …><XCUIElementTypeButton name label
/// value x y width height …/>…`) as the same flat list. The wrapper element is not counted.
func flattenXML(_ data: Data) -> (elements: [Element], root: (label: String?, name: String?))? {
    final class Walker: NSObject, XMLParserDelegate {
        var out: [Element] = []
        var counter = 0
        var open: [Int?] = []
        var depth = -1
        var root: (label: String?, name: String?) = (nil, nil)
        var failed = false
        func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?, qualifiedName: String?, attributes: [String: String]) {
            guard name != "AppiumAUT" else { return }
            depth += 1
            counter += 1
            let place = counter
            let frame = Rect(x: Double(attributes["x"] ?? "") ?? 0, y: Double(attributes["y"] ?? "") ?? 0, width: Double(attributes["width"] ?? "") ?? 0, height: Double(attributes["height"] ?? "") ?? 0)
            let visible = attributes["visible"].map { $0 == "true" } ?? true
            if depth == 0 { root = (attributes["label"], attributes["name"]) }
            var index: Int?
            if depth > 0, visible, frame.width > 0, frame.height > 0 {
                let type = name.replacingOccurrences(of: "XCUIElementType", with: "")
                let id = attributes["name"]
                index = out.count
                out.append(Element(type: type, label: attributes["label"] ?? id, value: attributes["value"], identifier: id, frame: frame, depth: depth, node: place, end: place))
            }
            open.append(index)
        }
        func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
            guard name != "AppiumAUT" else { return }
            if let index = open.removeLast() { out[index].end = counter }
            depth -= 1
        }
        func parser(_ parser: XMLParser, parseErrorOccurred error: Error) { failed = true }
    }
    let walker = Walker()
    let parser = XMLParser(data: data)
    parser.delegate = walker
    parser.parse()
    guard !walker.failed || !walker.out.isEmpty else { return nil }
    return (walker.out, walker.root)
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
    /// for Settings; what is on screen is decided from the frames instead. `format` is "json" or "xml"
    /// (WDA's JSON adds each element's custom actions, one accessibility round trip per element).
    func tree(timeout: Double, format: String = "json") async throws -> (elements: [Element], foreground: Foreground) {
        let xml = format.lowercased() == "xml"
        async let source = call("GET", "/source?format=\(xml ? "xml" : "json")&excluded_attributes=visible,accessible,enabled,index", timeout: timeout)
        async let app = try? call("GET", "/wda/activeAppInfo", timeout: min(timeout, 2))
        let (sourceValue, appValue) = (try await source, await app)
        let appName = appValue?["name"]?.string.flatMap { $0.isEmpty ? nil : $0 }
        if xml {
            guard let text = sourceValue.string, let parsed = flattenXML(Data(text.utf8)) else {
                throw RunnerError(message: "the runner's XML tree could not be read", delivery: .notSent)
            }
            return (parsed.elements, Foreground(bundleID: appValue?["bundleId"]?.string, name: appName ?? parsed.root.label ?? parsed.root.name))
        }
        let root = (try? sourceValue.string.map(JSON.parse)) ?? sourceValue
        let name = appName ?? root["label"]?.text ?? root["name"]?.text
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
    func read(timeout: Double, wantPicture: Bool = true, format: String = "json") async -> Reading {
        let started = now()
        async let treePart: Result<(elements: [Element], foreground: Foreground), Error> = {
            do { return .success(try await self.tree(timeout: timeout, format: format)) } catch { return .failure(error) }
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
