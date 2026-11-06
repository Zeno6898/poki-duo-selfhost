import Foundation

public struct CoreConfig: Sendable {
    public var relayURL: URL
    public var runnerURL: URL
    public var sensitive: SensitivityRules
    /// How long `do` holds for an approval before answering approval_required.
    public var approvalWait: Double
    /// The hard cap for one tool call, everything included.
    public var toolDeadline: Double
    /// The device time one `do` may spend on its actions.
    public var actionCap: Double
    /// The cap for one screen read (tree and screenshot together).
    public var readTimeout: Double
    /// How long a second tool call waits for the first before answering busy.
    public var busyWait: Double
    /// How long a call waits for a runner that is starting (the app wakes it when a call comes in).
    public var runnerWait: Double

    public init(relayURL: URL = URL(string: "wss://pokimcp.zheha.nz/v1")!, runnerURL: URL = URL(string: "http://127.0.0.1:8100")!, sensitive: SensitivityRules = SensitivityRules(), approvalWait: Double = 20, toolDeadline: Double = 25, actionCap: Double = 6, readTimeout: Double = 4, busyWait: Double = 2, runnerWait: Double = 15) {
        self.relayURL = relayURL
        self.runnerURL = runnerURL
        self.sensitive = sensitive
        self.approvalWait = approvalWait
        self.toolDeadline = toolDeadline
        self.actionCap = actionCap
        self.readTimeout = readTimeout
        self.busyWait = busyWait
        self.runnerWait = runnerWait
    }
}

/// The launcher's view of the runner, as the app shell reports it (from PokiLauncher's events).
public enum RunnerState: Sendable, Equatable {
    case running
    case starting(String)
    case failed(String, fix: String?)

    public var isRunning: Bool { self == .running }
    public var describe: String {
        switch self {
        case .running: return "running"
        case .starting(let detail): return "starting (\(detail))"
        case .failed(let detail, let fix): return "failed: \(detail)" + (fix.map { ". Fix on the phone: \($0)" } ?? "")
        }
    }
}

/// The relay's signing key: Ed25519, kept in the keychain on the phone.
public protocol RelayKey: Sendable {
    /// The raw 32-byte public key.
    var publicKey: Data { get }
    func sign(_ message: Data) throws -> Data
}

public protocol CoreHost: AnyObject, Sendable {
    func signingKey() throws -> RelayKey
    /// sha256 (hex) of each connector secret.
    func accessHashes() -> [String]
    /// A JPEG of the PNG screenshot, `width` pixels wide.
    func jpeg(fromPNG png: Data, width: Int, quality: Double) throws -> Data
    func runnerState() -> RunnerState
    func restartRunner()
    /// Text read from a PNG screenshot, used for elements an app collapsed. PokiCore answers it with
    /// Vision by default, so a host need not implement it.
    func recognizeText(inPNG png: Data) async -> [RecognizedText]?
}

public enum RelayState: Sendable, Equatable {
    case connecting
    case ready(url: String)
    case offline(String)
}

public struct ToolActivity: Sendable, Equatable {
    public var id: String
    public var name: String
    public var summary: String
    public var started: Date
}

public enum ToolOutcome: Sendable, Equatable {
    case done(String)
    case failed(String)
}

/// What the Live Activity shows after a call: the app in front and a small JPEG of the screen
/// (about 96 pixels wide, a few kB; store it in the app group, since ActivityKit's state is 4 kB).
public struct ToolFacts: Sendable, Equatable {
    public var app: String?
    public var thumbnail: Data?
}

public enum CoreEvent: Sendable, Equatable {
    case relay(RelayState)
    case toolStarted(ToolActivity)
    case toolFinished(ToolActivity, ToolOutcome, ToolFacts)
    case approvalRequested(Approval)
    case approvalEnded(id: String, approved: Bool?)
}

public struct RelayRequest: Sendable {
    public var id: String
    public var method: String
    public var headers: [String: String]
    public var body: String
    public init(id: String, method: String, headers: [String: String], body: String) {
        self.id = id
        self.method = method
        self.headers = headers
        self.body = body
    }
}

public struct RelayResponse: Sendable, Equatable {
    public var id: String
    public var status: Int
    public var headers: [String: String]
    public var body: String
}

/// Poki on the phone: the MCP server behind the relay.
public final class PokiCore: @unchecked Sendable {
    public let config: CoreConfig
    weak var host: CoreHost?
    let runner: Runner
    let computer: Computer
    let approvals: Approvals
    private let continuation: AsyncStream<CoreEvent>.Continuation
    public let events: AsyncStream<CoreEvent>
    private let gate = Gate()
    private let sessions = LockedBox<Set<String>>([])
    var relay: RelayClient?

    public init(config: CoreConfig, host: CoreHost, transport: HTTPTransport = URLSessionTransport()) {
        self.config = config
        self.host = host
        var c: AsyncStream<CoreEvent>.Continuation!
        events = AsyncStream(bufferingPolicy: .bufferingNewest(64)) { c = $0 }
        continuation = c
        runner = Runner(url: config.runnerURL, transport: transport)
        let emit: @Sendable (CoreEvent) -> Void = { [c] event in c!.yield(event) }
        approvals = Approvals(emit: emit)
        computer = Computer(runner: runner, host: host, config: config, approvals: approvals)
        // Two silent runner requests in a row: the runner is gone or stuck, so the launcher starts it again.
        runner.onUnhealthy = { [weak host, runner] in
            runner.forgetSession()
            host?.restartRunner()
        }
    }

    func emit(_ event: CoreEvent) { continuation.yield(event) }

    public func start(socketFactory: WebSocketFactory = URLSessionWebSocketFactory()) {
        guard relay == nil, let host else { return }
        let client = RelayClient(baseURL: config.relayURL, host: host, factory: socketFactory, handler: { [weak self] request in
            await self?.handle(request) ?? RelayResponse(id: request.id, status: 503, headers: [:], body: "")
        }, emit: { [weak self] in self?.emit(.relay($0)) })
        relay = client
        client.start()
    }

    public func stop() {
        relay?.stop()
        relay = nil
    }

    /// The connector secrets changed: tell the relay the new list.
    public func accessChanged() { relay?.sendAccess() }

    public func resolveApproval(id: String, approved: Bool) { approvals.resolve(id: id, approved: approved) }

    public var pendingApproval: Approval? { approvals.pending }

    // MARK: MCP over HTTP (Streamable HTTP, JSON answers only)

    static let protocolVersions = ["2025-06-18", "2025-03-26", "2024-11-05"]

    public func handle(_ request: RelayRequest) async -> RelayResponse {
        func answer(_ status: Int, _ body: JSON?, session: String? = nil) -> RelayResponse {
            var headers = ["content-type": "application/json"]
            if let session { headers["mcp-session-id"] = session }
            return RelayResponse(id: request.id, status: status, headers: headers, body: body?.serialized() ?? "")
        }
        switch request.method {
        case "GET": return RelayResponse(id: request.id, status: 405, headers: ["allow": "POST, DELETE"], body: "")
        case "DELETE":
            if let s = request.headers["mcp-session-id"] { _ = sessions.update { $0.remove(s) } }
            return RelayResponse(id: request.id, status: 200, headers: [:], body: "")
        case "POST": break
        default: return RelayResponse(id: request.id, status: 405, headers: ["allow": "POST, DELETE"], body: "")
        }
        guard let message = try? JSON.parse(request.body) else {
            return answer(400, rpcError(nil, -32700, "Parse error"))
        }
        let session = request.headers["mcp-session-id"]
        if let batch = message.array {
            var replies: [JSON] = []
            for item in batch { if let r = await rpc(item, session: session).reply { replies.append(r) } }
            return replies.isEmpty ? RelayResponse(id: request.id, status: 202, headers: [:], body: "") : answer(200, .array(replies), session: session)
        }
        let (reply, newSession) = await rpc(message, session: session)
        guard let reply else { return RelayResponse(id: request.id, status: 202, headers: [:], body: "") }
        return answer(200, reply, session: newSession ?? session)
    }

    func rpcError(_ id: JSON?, _ code: Int, _ message: String) -> JSON {
        ["jsonrpc": "2.0", "id": id ?? .null, "error": ["code": .number(Double(code)), "message": .string(message)]]
    }

    func rpc(_ message: JSON, session: String?) async -> (reply: JSON?, session: String?) {
        let id = message["id"]
        guard let method = message["method"]?.string else { return (id == nil ? nil : rpcError(id, -32600, "Invalid Request"), nil) }
        let isNotification = id == nil
        func result(_ value: JSON) -> JSON { ["jsonrpc": "2.0", "id": id ?? .null, "result": value] }
        switch method {
        case "initialize":
            let asked = message["params"]?["protocolVersion"]?.string ?? Self.protocolVersions[0]
            let version = Self.protocolVersions.contains(asked) ? asked : Self.protocolVersions[0]
            let newSession = UUID().uuidString.lowercased()
            sessions.update { _ = $0.insert(newSession) }
            return (result([
                "protocolVersion": .string(version),
                "capabilities": ["tools": ["listChanged": false]],
                "serverInfo": ["name": "poki", "version": "1.0"],
                "instructions": .string(Self.instructions),
            ]), newSession)
        case "notifications/initialized", "notifications/cancelled": return (nil, nil)
        case "ping": return (isNotification ? nil : result(.object([:])), nil)
        case "tools/list": return (result(["tools": .array(Self.tools)]), nil)
        case "tools/call":
            let name = message["params"]?["name"]?.string ?? ""
            let args = message["params"]?["arguments"] ?? .object([:])
            let output = await call(name, args)
            var content: [JSON] = [["type": "text", "text": .string(output.text)]]
            if let jpeg = output.jpeg { content.append(["type": "image", "data": .string(jpeg.base64EncodedString()), "mimeType": "image/jpeg"]) }
            return (result(["content": .array(content), "isError": .bool(output.isError)]), nil)
        default:
            if isNotification { return (nil, nil) }
            return (rpcError(id, -32601, "Method not found: \(method)"), nil)
        }
    }

    // MARK: Tools

    static let instructions = "look reads the iPhone's screen; do runs actions and then reads it. Both return the app in front, numbered elements and a screenshot whose pixels are screen points. Use the numbers from the latest answer; an element that stays on screen keeps its number, and do lists only what changed. Decide what happened from the elements, the screen_changed line and the picture. To reach something further down a list, use scroll_to with its text before trying swipes. Some actions (payments, deleting, sending messages, passwords) need the owner's approval on the phone; do says so instead of sending them."

    static let tools: [JSON] = [
        ["name": "look", "description": "Read the screen now: the app in front, the numbered elements (role, \"label = value\", [x,y,w,h] in screen points; + marks elements new since the last read, ~ moved ones) and a screenshot that is one pixel per screen point, so a point on the picture is a point to tap. Repeated text, scroll bars and empty containers are left out and long labels are cut; full=true lists every element as the tree has it and adds the text read from the picture inside [collapsed] elements (an app showed a whole cell, buttons and all, as one element). Numbers stay the same while an element stays on screen.",
         "inputSchema": ["type": "object", "properties": ["full": ["type": "boolean"]], "additionalProperties": false],
         "annotations": ["readOnlyHint": true]],
        ["name": "do", "description": "Run actions in order, then read the screen once. The answer says what each action did, screen_changed (true or false: whether the elements or the picture differ from the read before), and only the elements that are new (+) or moved (~); the others keep their numbers (full=true lists all). Actions: {tap: n} or {tap: [x, y]} (a numbered element is tapped where it can be reached; if no part of it is on screen and uncovered, nothing is sent and the answer says not_hittable); {type: \"text\", ref?: n, clear?: true} (taps n first, then types the text); {key: \"return\"|\"delete\"|\"tab\"|\"space\"|\"escape\"}; {scroll_to: \"text\"} or {scroll_to: {text or ref, in?: n, direction?: \"down\", max_swipes?: 6}} (the best way to bring something into view: it scrolls until the text is fully on screen and says where); {swipe: \"up\"|\"down\"|\"left\"|\"right\"} or {swipe: {direction, in?: n, distance?: \"short\"|\"long\"}} (a quick flick inside the biggest list on screen, or inside n, clear of bars; direction is where the finger moves, so up shows what is further down); {drag: {from: n or [x, y], to: n or [x, y], ms?: 400, hold_ms?: 0}} or {drag: [x1, y1, x2, y2]} (the content follows the finger and stops where it stops; hold_ms first to pick something up); {long_press: n or [x, y] or {ref, ms?}}; {pinch: {ref or x, y, scale}}; {button: \"home\"|\"lock\"|\"volume_up\"|\"volume_down\"}; {launch: \"bundle id\"} or {launch: {bundle, fresh: true}}; {wait_until: \"text\"} or {wait_until: {text, gone?: true, ms?: 3000}} or {wait_until: {settled: true, ms?}} (reads the screen until the text appears or goes, or the screen holds still; use it instead of fixed waits); {wait: ms}. Points are screen points, like the frames and the screenshot's pixels. Each action is reported as sent, not_sent or unknown; it stops at the first action that fails and never re-sends one that may have been delivered. Payments, deleting, sending messages and passwords need the owner's approval on the phone: then nothing is sent, and the answer says approval_required; send the same actions again after they approve.",
         "inputSchema": ["type": "object", "properties": ["actions": ["type": "array", "items": ["type": "object"], "minItems": 0, "maxItems": 20], "full": ["type": "boolean"]], "required": ["actions"], "additionalProperties": false]],
        ["name": "status", "description": "Poki's state without touching the phone: the runner, the relay, and any approval waiting on the phone.",
         "inputSchema": ["type": "object", "properties": .object([:]), "additionalProperties": false],
         "annotations": ["readOnlyHint": true]],
    ]

    func call(_ name: String, _ args: JSON) async -> ToolResult {
        if name == "status" { return status() }
        guard name == "look" || name == "do" else { return ToolResult(text: "unknown tool \(name); the tools are look, do and status", jpeg: nil, isError: true) }
        let activity = ToolActivity(id: UUID().uuidString, name: name, summary: name == "do" ? (args["actions"]?.array ?? []).map(computer.describe).joined(separator: ", ") : "look", started: Date())
        // One tool call at a time per phone; a second waits briefly, then says what the first is doing.
        guard await gate.enter(waiting: config.busyWait) else {
            return ToolResult(text: "busy: another call is still running (\(gate.current ?? "a tool")); nothing was sent. Try again in a moment.", jpeg: nil, isError: true)
        }
        gate.current = "\(name): \(activity.summary)"
        emit(.toolStarted(activity))
        let deadline = config.toolDeadline + 1
        let output: ToolResult
        do {
            output = try await withDeadline(deadline, name) { [computer] in
                name == "look" ? await computer.look(full: args["full"]?.bool ?? false) : await computer.act(actions: args["actions"]?.array ?? [], full: args["full"]?.bool ?? false)
            }
        } catch {
            // Never reached in practice (every step has its own deadline), but a call always answers.
            output = ToolResult(text: "error: \(error); what was sent is unknown. Call look to see the screen.", jpeg: nil, isError: true)
        }
        gate.current = nil
        gate.leave()
        let line = output.text.split(separator: "\n").first.map(String.init) ?? ""
        let thumbnail = computer.lastPNG.flatMap { try? host?.jpeg(fromPNG: $0, width: 96, quality: 0.5) }
        emit(.toolFinished(activity, output.isError ? .failed(line) : .done(line), ToolFacts(app: computer.lastForeground?.describe, thumbnail: thumbnail)))
        return output
    }

    func status() -> ToolResult {
        var lines = ["runner: \(host?.runnerState().describe ?? "unknown")"]
        if let relay { lines.append("relay: \(relay.stateDescription)") }
        if let p = approvals.pending { lines.append("approval waiting on the phone: \(p.summary) (\(p.reason), id \(p.id))") }
        if let current = gate.current { lines.append("running: \(current)") }
        return ToolResult(text: lines.joined(separator: "\n"), jpeg: nil)
    }
}

/// One holder at a time, with a bounded wait to get in.
final class Gate: @unchecked Sendable {
    private let lock = NSLock()
    private var held = false
    private var _current: String?
    var current: String? {
        get { lock.lock(); defer { lock.unlock() }; return _current }
        set { lock.lock(); _current = newValue; lock.unlock() }
    }
    func tryEnter() -> Bool { lock.lock(); defer { lock.unlock() }; if held { return false }; held = true; return true }
    func enter(waiting seconds: Double) async -> Bool {
        let until = now() + seconds
        while true {
            if tryEnter() { return true }
            if now() >= until { return false }
            await sleep(seconds: 0.05)
        }
    }
    func leave() { lock.lock(); held = false; lock.unlock() }
}
