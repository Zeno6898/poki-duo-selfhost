import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif
@testable import PokiCore

/// A WebDriverAgent stand-in: routes answer per method and path (the session part removed).
final class FakeWDA: HTTPTransport, @unchecked Sendable {
    typealias Route = @Sendable (_ body: JSON?) async throws -> (Int, JSON)
    private let lock = NSLock()
    private var routes: [String: Route] = [:]
    private(set) var log: [(method: String, path: String, body: JSON?)] = []

    init() {
        set("POST /session") { _ in (200, ["value": ["sessionId": "s1"]]) }
        set("GET /status") { _ in (200, ["value": ["ready": true]]) }
        set("DELETE /session") { _ in (200, ["value": .null]) }
        set("GET /wda/screen") { _ in (200, ["value": ["screenSize": ["width": 390, "height": 844]]]) }
        set("GET /screenshot") { _ in (200, ["value": .string(Data("png".utf8).base64EncodedString())]) }
        set("GET /wda/activeAppInfo") { _ in (200, ["value": ["bundleId": "com.apple.Preferences", "name": "Settings"]]) }
        source([("Button", "General"), ("Button", "Privacy")])
        for path in ["POST /wda/tap", "POST /wda/keys", "POST /wda/dragfromtoforduration", "POST /wda/touchAndHold", "POST /wda/apps/launch", "POST /wda/apps/activate", "POST /wda/apps/terminate", "POST /wda/homescreen", "POST /wda/lock", "POST /wda/pressButton", "POST /actions", "POST /wda/pressAndDragWithVelocity", "POST /appium/settings"] {
            set(path) { _ in (200, ["value": .null]) }
        }
    }

    /// The screen as a tree: (type, label, [x, y, w, h], children).
    func tree(_ nodes: [Node], app: String = "X") {
        func json(_ n: Node) -> JSON {
            ["type": .string("XCUIElementType\(n.type)"), "label": n.label.map(JSON.string) ?? .null, "rect": ["x": .number(n.frame[0]), "y": .number(n.frame[1]), "width": .number(n.frame[2]), "height": .number(n.frame[3])], "children": .array(n.children.map(json))]
        }
        let root: JSON = ["type": "XCUIElementTypeApplication", "label": .string(app), "rect": ["x": 0, "y": 0, "width": 390, "height": 844], "children": .array(nodes.map(json))]
        set("GET /source") { _ in (200, ["value": root]) }
    }

    static let sessionlessOnly: Set<String> = ["POST /wda/homescreen"]

    func set(_ key: String, _ route: @escaping Route) { lock.lock(); routes[key] = route; lock.unlock() }

    /// The screen as rows of (type, label), 44 points apart.
    func source(_ rows: [(String, String)], app: String = "Settings") {
        let children: [JSON] = rows.enumerated().map { index, row in
            ["type": .string("XCUIElementType\(row.0)"), "label": .string(row.1), "rect": ["x": 16, "y": .number(Double(100 + index * 44)), "width": 358, "height": 44]]
        }
        let root: JSON = ["type": "XCUIElementTypeApplication", "label": .string(app), "rect": ["x": 0, "y": 0, "width": 390, "height": 844], "children": .array(children)]
        set("GET /source") { _ in (200, ["value": root]) }
    }

    private func record(_ method: String, _ path: String, _ body: JSON?, _ key: String) -> Route? {
        lock.lock(); defer { lock.unlock() }
        log.append((method, path, body))
        return routes[key]
    }

    var sent: [String] { lock.lock(); defer { lock.unlock() }; return log.map { "\($0.method) \($0.path)" } }
    func bodies(_ key: String) -> [JSON] { lock.lock(); defer { lock.unlock() }; return log.filter { "\($0.method) \($0.path)" == key }.compactMap(\.body) }

    func send(method: String, url: URL, body: Data?, timeout: Double) async throws -> (status: Int, body: Data) {
        let inSession = url.path.hasPrefix("/session/")
        var path = url.path.replacingOccurrences(of: #"^/session/[^/]+"#, with: "", options: .regularExpression)
        if path.isEmpty { path = "/session" }
        let key = "\(method) \(path)"
        // As in WDA 16.15.3 (FBCustomCommands.m): the Home button has no route inside a session.
        if inSession, Self.sessionlessOnly.contains(key) {
            let missing: JSON = ["value": ["error": "unknown command", "message": .string("Unhandled endpoint: \(url.path)")]]
            _ = record(method, url.path, nil, "")
            return (404, missing.data())
        }
        let parsed = body.flatMap { try? JSON.parse($0) }
        let route = record(method, path, parsed, key)
        guard let route else { let missing: JSON = ["value": ["error": "unknown command", "message": .string("no route \(key)")]]; return (404, missing.data()) }
        let (status, json) = try await route(parsed)
        return (status, json.data())
    }
}

private func block() { Thread.sleep(forTimeInterval: 0.05) }

/// Never answers, and ignores cancellation: the worst runner there is.
func hang() async -> Never {
    while true { block(); await Task.yield() }
}

struct FakeKey: RelayKey {
    var publicKey = Data((0..<32).map { UInt8($0) })
    func sign(_ message: Data) throws -> Data { Data(message.reversed()) }
}

struct Node {
    var type: String
    var label: String?
    var frame: [Double]
    var children: [Node] = []
    init(_ type: String, _ label: String?, _ frame: [Double], _ children: [Node] = []) {
        self.type = type
        self.label = label
        self.frame = frame
        self.children = children
    }
}

final class FakeHost: CoreHost, @unchecked Sendable {
    let state = LockedBox<RunnerState>(.running)
    let restarts = LockedBox(0)
    let texts = LockedBox<[RecognizedText]?>(nil)
    let widths = LockedBox<[Int]>([])
    func recognizeText(inPNG png: Data) async -> [RecognizedText]? { texts.value }
    func signingKey() throws -> RelayKey { FakeKey() }
    func accessHashes() -> [String] { ["abc123"] }
    func jpeg(fromPNG png: Data, width: Int, quality: Double) throws -> Data { widths.update { $0.append(width) }; return Data("jpeg:\(png.count)".utf8) }
    func runnerState() -> RunnerState { state.value }
    func restartRunner() { restarts.update { $0 += 1 } }
}

/// One end of a fake WebSocket; the test plays the relay on the other end.
final class FakeSocket: WebSocketConnection, @unchecked Sendable {
    private let lock = NSLock()
    private var inbox: [String] = []
    private var waiting: CheckedContinuation<String, Error>?
    private(set) var outbox: [String] = []
    private(set) var closed = false

    func push(_ text: String) {
        lock.lock()
        if let w = waiting { waiting = nil; lock.unlock(); w.resume(returning: text); return }
        inbox.append(text)
        lock.unlock()
    }
    func send(_ text: String) async throws { lock.lock(); outbox.append(text); lock.unlock() }
    func receive() async throws -> String {
        try await withCheckedThrowingContinuation { c in
            lock.lock()
            if closed { lock.unlock(); c.resume(throwing: RelayFailure("closed")); return }
            if !inbox.isEmpty { let t = inbox.removeFirst(); lock.unlock(); c.resume(returning: t); return }
            waiting = c
            lock.unlock()
        }
    }
    func close(code: Int, reason: String) {
        lock.lock()
        closed = true
        let w = waiting
        waiting = nil
        lock.unlock()
        w?.resume(throwing: RelayFailure("closed"))
    }
    var sent: [String] { lock.lock(); defer { lock.unlock() }; return outbox }
}

final class FakeSockets: WebSocketFactory, @unchecked Sendable {
    let sockets = LockedBox<[FakeSocket]>([])
    let urls = LockedBox<[URL]>([])
    func connect(to url: URL) async throws -> WebSocketConnection {
        let s = FakeSocket()
        sockets.update { $0.append(s) }
        urls.update { $0.append(url) }
        return s
    }
}

func eventually(_ seconds: Double = 2, _ condition: () -> Bool) async -> Bool {
    let until = Date().addingTimeInterval(seconds)
    while Date() < until { if condition() { return true }; try? await Task.sleep(nanoseconds: 10_000_000) }
    return condition()
}

func makeCore(_ wda: FakeWDA = FakeWDA(), host: FakeHost = FakeHost(), configure: (inout CoreConfig) -> Void = { _ in }) -> (PokiCore, FakeWDA, FakeHost) {
    var config = CoreConfig(approvalWait: 0.3, toolDeadline: 6, actionCap: 3, readTimeout: 1, busyWait: 0.2, treeFormat: "json") // the fake speaks JSON
    configure(&config)
    return (PokiCore(config: config, host: host, transport: wda), wda, host)
}
