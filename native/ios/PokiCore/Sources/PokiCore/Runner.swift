import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// How a request to the runner ended, as far as the phone is concerned.
public enum Delivery: String, Sendable {
    case sent
    /// Refused before anything reached the phone.
    case notSent = "not_sent"
    /// It may or may not have reached the phone.
    case unknown
}

public struct RunnerError: Error, CustomStringConvertible, Sendable {
    public var message: String
    public var delivery: Delivery
    public var status: Int? = nil
    /// WebDriver's error code when the runner answered with one ("unknown command", "invalid session id").
    public var code: String? = nil
    /// No answer at all (refused or timed out), as opposed to an answer that says no.
    public var silent = false
    public var description: String { message }
}

/// One HTTP exchange. URLSession on the phone; a fake in tests.
public protocol HTTPTransport: Sendable {
    func send(method: String, url: URL, body: Data?, timeout: Double) async throws -> (status: Int, body: Data)
}

public enum TransportError: Error, Sendable {
    /// Nothing listens there (the runner is down).
    case refused
    case timedOut
    case other(String)
}

public final class URLSessionTransport: HTTPTransport {
    let session: URLSession
    public init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpMaximumConnectionsPerHost = 4
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.connectionProxyDictionary = [:]
        session = URLSession(configuration: configuration)
    }
    public func send(method: String, url: URL, body: Data?, timeout: Double) async throws -> (status: Int, body: Data) {
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = method
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        do {
            let (data, response) = try await session.data(for: request)
            return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
        } catch let error as URLError {
            switch error.code {
            case .cannotConnectToHost, .cannotFindHost: throw TransportError.refused
            case .timedOut: throw TransportError.timedOut
            default: throw TransportError.other(error.localizedDescription)
            }
        }
    }
}

/// The WebDriverAgent runner on the phone (W3C WebDriver plus WDA's extensions). Every request has its
/// own timeout, and one session is kept and made again when WDA says it is gone.
public final class Runner: @unchecked Sendable {
    public let url: URL
    let transport: HTTPTransport
    private let state = LockedBox<(session: String?, misses: Int)>((nil, 0))
    /// Called after `unhealthyAfter` silent requests in a row: at once when the runner refused or
    /// broke the connection, and only after a `GET /status` probe also went unanswered for
    /// `probeTimeout` when the requests merely timed out. WDA serves every request on its main
    /// thread, so one slow read (a big tree, a keyboard coming up) holds back all the others; that
    /// runner is busy, not gone, and restarting it would cost the owner far more than waiting.
    var onUnhealthy: (@Sendable () -> Void)?
    var unhealthyAfter = 2
    var probeTimeout: Double = 15
    private let probing = LockedBox(false)

    public init(url: URL, transport: HTTPTransport = URLSessionTransport()) {
        self.url = url
        self.transport = transport
    }

    public var consecutiveMisses: Int { state.value.misses }

    /// Settings for every session. WDA waits after each gesture until the app has been still for up
    /// to `animationCoolOffTimeout` (2 s) and before each event until it is idle for up to
    /// `waitForIdleTimeout` (10 s); an app that never stops animating (a feed with videos) used all of
    /// both on every drag. Poki pauses briefly itself and the model reads the screen after.
    ///
    /// `accessibilityDeadline` (WDA #1210, off by default): before reading an app's tree WDA checks
    /// that the app's event loop answers within this time, and fails the read if not. Without it a
    /// read of an app that never goes idle (a looping animation over the keyboard on the simulator)
    /// blocks WDA's main thread, and with it every request behind it, screenshots and Home included,
    /// for half a minute.
    static let sessionSettings: JSON = ["animationCoolOffTimeout": 0, "waitForIdleTimeout": 0.5, "accessibilityDeadline": 2]

    /// One request outside the session. `countsAsMiss: false` for a request that may rightly take long
    /// (a gesture): its timeout is not taken as a sign that the runner is gone.
    public func raw(_ method: String, _ path: String, _ body: JSON? = nil, timeout: Double = 4, countsAsMiss: Bool = true) async throws -> JSON {
        let target = URL(string: url.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path)!
        let result: (status: Int, body: Data)
        do {
            result = try await withDeadline(timeout + 0.5, "the runner's answer to \(method) \(Self.short(path))") { [transport] in
                try await transport.send(method: method, url: target, body: body?.data(), timeout: timeout)
            }
        } catch TransportError.refused {
            miss()
            throw RunnerError(message: "the runner is not running (connection refused at \(url.absoluteString)); it is being restarted", delivery: .notSent, silent: true)
        } catch let error as DeadlineExceeded {
            if countsAsMiss { miss(timedOut: true) }
            throw RunnerError(message: error.description, delivery: .unknown, silent: true)
        } catch TransportError.timedOut {
            if countsAsMiss { miss(timedOut: true) }
            throw RunnerError(message: "the runner did not answer \(method) \(Self.short(path)) within \(DeadlineExceeded.format(timeout))", delivery: .unknown, silent: true)
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            miss()
            throw RunnerError(message: "the runner did not answer \(method) \(Self.short(path)): \(error)", delivery: .unknown, silent: true)
        }
        state.update { $0.misses = 0 }
        let parsed = (try? JSON.parse(result.body)) ?? (result.body.isEmpty ? .object([:]) : ["value": .string(String(decoding: result.body, as: UTF8.self))])
        let value = parsed["value"] ?? parsed
        if let code = value["error"]?.string {
            let message = (value["message"]?.string ?? code).split(separator: "\n").first.map(String.init) ?? code
            throw RunnerError(message: "the runner refused \(method) \(Self.short(path)): \(message)", delivery: .notSent, status: result.status, code: code)
        }
        if !(200..<300).contains(result.status) {
            throw RunnerError(message: "the runner answered HTTP \(result.status) to \(method) \(Self.short(path))", delivery: .notSent, status: result.status)
        }
        return value
    }

    private func miss(timedOut: Bool = false) {
        let misses = state.update { s -> Int in s.misses += 1; return s.misses }
        guard misses == unhealthyAfter else { return }
        if !timedOut { onUnhealthy?(); return }
        // Slow, not refused: ask whether it is still there before giving up on it. One probe at a time;
        // it runs apart from the calls, which have already answered with what they had.
        guard probing.update({ p -> Bool in defer { p = true }; return !p }) else { return }
        Task { [weak self, transport, url, probeTimeout] in
            let alive = (try? await withDeadline(probeTimeout + 0.5, "the runner's status") {
                try await transport.send(method: "GET", url: url.appendingPathComponent("status"), body: nil, timeout: probeTimeout)
            }).map { (200..<300).contains($0.status) } ?? false
            guard let self else { return }
            self.probing.value = false
            if alive { self.state.update { $0.misses = 0 } } else { self.onUnhealthy?() }
        }
    }

    func forgetSession() { state.update { $0.session = nil } }

    private let opening = LockedBox<Task<String, Error>?>(nil)

    /// The session, opened once when there is none. Concurrent callers share one open, and each waits
    /// at most its own `timeout` (and 8 s): a slow open never holds a call past its deadline, and the
    /// open goes on for the next caller.
    func session(timeout: Double = 8) async throws -> String {
        if let id = state.value.session { return id }
        let task = opening.update { current -> Task<String, Error> in
            if let current { return current }
            let made = Task { [self] () throws -> String in
                defer { opening.value = nil }
                let value = try await raw("POST", "/session", ["capabilities": ["alwaysMatch": .object([:])]], timeout: 8)
                guard let id = value["sessionId"]?.string ?? value["capabilities"]?["sessionId"]?.string else {
                    throw RunnerError(message: "the runner opened no session", delivery: .notSent)
                }
                // Best effort: a runner that refuses the settings still works, only slower.
                _ = try? await raw("POST", "/session/\(id)/appium/settings", ["settings": Self.sessionSettings], timeout: 2, countsAsMiss: false)
                state.update { $0.session = id }
                return id
            }
            current = made
            return made
        }
        do {
            return try await withDeadline(max(0.2, min(8, timeout)), "opening a session with the runner") { try await task.value }
        } catch let error as DeadlineExceeded {
            throw RunnerError(message: error.description, delivery: .notSent, silent: true)
        }
    }

    /// A request inside the session, made again once on a new session when WDA no longer knows it.
    public func call(_ method: String, _ path: String, _ body: JSON? = nil, timeout: Double = 4, countsAsMiss: Bool = true) async throws -> JSON {
        let id = try await session(timeout: timeout)
        do {
            return try await raw(method, "/session/\(id)\(path)", body, timeout: timeout, countsAsMiss: countsAsMiss)
        } catch let error as RunnerError where error.code == "invalid session id" || error.message.lowercased().contains("invalid session id") || (error.status == 404 && error.code == nil) {
            state.update { if $0.session == id { $0.session = nil } }
            return try await raw(method, "/session/\(try await session(timeout: timeout))\(path)", body, timeout: timeout, countsAsMiss: countsAsMiss)
        }
    }

    static func short(_ path: String) -> String {
        let trimmed = path.replacingOccurrences(of: #"/session/[^/]+"#, with: "", options: .regularExpression)
        return trimmed.split(separator: "?").first.map(String.init) ?? trimmed
    }
}
