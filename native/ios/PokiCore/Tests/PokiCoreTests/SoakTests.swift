import XCTest
@testable import PokiCore

/// A runner that misbehaves the way real ones do: slow answers, answers that never come, refused
/// connections (the runner died), lost sessions and errors, chosen by a seeded generator so a failing
/// run can be replayed. Everything else is answered by the FakeWDA underneath.
final class ChaosRunner: HTTPTransport, @unchecked Sendable {
    let base: FakeWDA
    private let rng: LockedBox<UInt64>
    private let counts = LockedBox<[String: Int]>([:])
    /// While true, every request is answered normally (to check recovery).
    let calm = LockedBox(false)

    init(base: FakeWDA, seed: UInt64) {
        self.base = base
        rng = LockedBox(seed)
    }

    private func next() -> Double {
        rng.update { state -> Double in
            // SplitMix64.
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return Double((z ^ (z >> 31)) >> 11) / Double(1 << 53)
        }
    }

    var tally: [String: Int] { counts.value }
    private func count(_ kind: String) { counts.update { $0[kind, default: 0] += 1 } }

    func send(method: String, url: URL, body: Data?, timeout: Double) async throws -> (status: Int, body: Data) {
        if calm.value { return try await base.send(method: method, url: url, body: body, timeout: timeout) }
        let roll = next()
        switch roll {
        case ..<0.05:
            count("hang")
            try await Task.sleep(nanoseconds: 60_000_000_000)  // cancelled by the deadline
            throw TransportError.timedOut
        case ..<0.10:
            count("refused")
            throw TransportError.refused
        case ..<0.13:
            count("lost session")
            return (404, (["value": ["error": "invalid session id", "message": "Session does not exist"]] as JSON).data())
        case ..<0.18:
            count("error 500")
            return (500, (["value": ["error": "unknown error", "message": "the app crashed"]] as JSON).data())
        case ..<0.30:
            count("slow")
            try await Task.sleep(nanoseconds: UInt64((0.1 + next() * 1.4) * 1e9))
            return try await base.send(method: method, url: url, body: body, timeout: timeout)
        default:
            count("normal")
            return try await base.send(method: method, url: url, body: body, timeout: timeout)
        }
    }
}

/// A launcher stand-in: a restart makes the runner `.starting` for a moment, then `.running` again.
final class RestartingHost: CoreHost, @unchecked Sendable {
    let base = FakeHost()
    let startingUntil = LockedBox<Date?>(nil)
    let restarts = LockedBox(0)
    func signingKey() throws -> RelayKey { try base.signingKey() }
    func accessHashes() -> [String] { base.accessHashes() }
    func jpeg(fromPNG png: Data, width: Int, quality: Double) throws -> Data { try base.jpeg(fromPNG: png, width: width, quality: quality) }
    func recognizeText(inPNG png: Data) async -> [RecognizedText]? { await base.recognizeText(inPNG: png) }
    func runnerState() -> RunnerState {
        if let until = startingUntil.value, Date() < until { return .starting("relaunching the runner") }
        return .running
    }
    func restartRunner() {
        restarts.update { $0 += 1 }
        startingUntil.value = Date().addingTimeInterval(0.4)
    }
}

final class SoakTests: XCTestCase {
    /// Hundreds of mixed calls against a misbehaving runner: every call answers within its deadline,
    /// one call never blocks the next, and once the runner behaves again everything works.
    func testNoCallOutlivesItsDeadlineAgainstAMisbehavingRunner() async throws {
        let seed = UInt64(ProcessInfo.processInfo.environment["POKI_SOAK_SEED"] ?? "") ?? 20261106
        let calls = Int(ProcessInfo.processInfo.environment["POKI_SOAK_CALLS"] ?? "") ?? 120
        let wda = FakeWDA()
        wda.source([("Button", "General"), ("Button", "Privacy"), ("TextField", "Search"), ("Cell", "Wi-Fi"), ("Cell", "Bluetooth"), ("Cell", "Battery")])
        let chaos = ChaosRunner(base: wda, seed: seed)
        let host = RestartingHost()
        var config = CoreConfig(approvalWait: 0.3, toolDeadline: 4, actionCap: 2, readTimeout: 1, busyWait: 0.2, runnerWait: 1)
        config.sensitive.enabled = false
        let core = PokiCore(config: config, host: host, transport: chaos)
        let limit = config.toolDeadline + config.approvalWait + 1.5

        let menu: [(String, JSON)] = [
            ("look", [:]),
            ("look", ["full": true]),
            ("do", ["actions": [["tap": 1]]]),
            ("do", ["actions": [["tap": [195, 300]], ["wait": 100]]]),
            ("do", ["actions": [["type": "hello", "ref": 3]]]),
            ("do", ["actions": [["type": "x", "clear": true]]]),
            ("do", ["actions": [["swipe": "up"]]]),
            ("do", ["actions": [["scroll_to": "Battery"]]]),
            ("do", ["actions": [["wait_until": "Wi-Fi"]]]),
            ("do", ["actions": [["key": "return"], ["button": "home"]]]),
            ("do", ["actions": [["launch": "com.apple.Preferences"]]]),
            ("status", [:]),
        ]
        var slowest = 0.0, errors = 0
        var outcomes: [String: Int] = [:]
        for i in 0..<calls {
            let (name, args) = menu[i % menu.count]
            let started = Date()
            let result: ToolResult
            if i % 17 == 5 {
                // Two at once: the second waits briefly or answers busy, never hangs behind the first.
                async let a = core.call(name, args)
                async let b = core.call("look", [:])
                let (first, second) = await (a, b)
                result = first
                XCTAssertLessThan(Date().timeIntervalSince(started), limit, "call \(i) (pair): \(second.text.prefix(120))")
            } else {
                result = await core.call(name, args)
            }
            let took = Date().timeIntervalSince(started)
            slowest = max(slowest, took)
            XCTAssertLessThan(took, limit, "call \(i) \(name) \(args.serialized()) took \(took) s: \(result.text.prefix(200))")
            XCTAssertFalse(result.text.isEmpty, "call \(i) answered nothing")
            if took > config.toolDeadline + 0.5 { print("soak: call \(i) \(name) \(args.serialized()) took \(String(format: "%.2f", took)) s: \(result.text.prefix(300))") }
            if result.isError { errors += 1 }
            let first = result.text.split(separator: "\n").first.map(String.init) ?? ""
            let kind = first.hasPrefix("app:") ? "read" : String(first.prefix(24))
            outcomes[kind, default: 0] += 1
        }

        // The runner behaves again: within a couple of calls everything works, nothing is left held.
        chaos.calm.value = true
        host.startingUntil.value = nil
        var recovered: ToolResult?
        for _ in 0..<3 {
            let r = await core.call("look", [:])
            if !r.isError { recovered = r; break }
        }
        XCTAssertNotNil(recovered, "no recovery once the runner behaved")
        let status = await core.call("status", [:])
        XCTAssertFalse(status.text.contains("running: "), "the gate was left held: \(status.text)")
        let tap = await core.call("do", ["actions": [["tap": 1]]])
        XCTAssertFalse(tap.isError, tap.text)

        print("soak: seed \(seed), \(calls) calls, slowest \(String(format: "%.2f", slowest)) s (limit \(limit) s), \(errors) answered with isError, restarts asked \(host.restarts.value)")
        print("soak: runner behaviour \(chaos.tally.sorted { $0.key < $1.key })")
        print("soak: first lines \(outcomes.sorted { $0.value > $1.value }.prefix(8))")
        XCTAssertGreaterThan(chaos.tally["hang", default: 0], 0, "the run had no hangs to survive")
    }
}
