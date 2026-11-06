import XCTest
@testable import PokiCore

/// The relay side under stress: requests arriving while others run, cancels, and the connection
/// dropping mid-request. Each request gets at most one answer, on the connection it came in on, never
/// after its cancel, and every request that was neither cancelled nor cut off is answered in time.
final class RelaySoakTests: XCTestCase {
    func handshake(_ socket: FakeSocket) async -> Bool {
        socket.push((["t": "challenge", "nonce": .string(Data(repeating: 1, count: 32).base64EncodedString())] as JSON).serialized())
        guard await eventually(3, { socket.sent.contains { $0.contains("\"t\":\"hello\"") } }) else { return false }
        socket.push((["t": "ready", "max_body": 4_194_304] as JSON).serialized())
        return true
    }

    func answers(_ socket: FakeSocket) -> [String] {
        socket.sent.compactMap { text in
            guard let frame = try? JSON.parse(text), frame["t"] == "res" else { return nil }
            return frame["id"]?.string
        }
    }

    func testAnswersStayOnTheirConnectionOnceAndNeverAfterACancel() async throws {
        let wda = FakeWDA()
        // A slow runner, so requests overlap, cancels land while work runs, and drops cut some off.
        wda.set("GET /source") { _ in
            try await Task.sleep(nanoseconds: 150_000_000)
            return (200, ["value": ["type": "XCUIElementTypeApplication", "label": "X", "rect": ["x": 0, "y": 0, "width": 390, "height": 844], "children": [["type": "XCUIElementTypeButton", "label": "OK", "rect": ["x": 10, "y": 100, "width": 100, "height": 44]]]]])
        }
        let (core, _, _) = makeCore(wda) { $0.busyWait = 3 }
        let sockets = FakeSockets()
        core.start(socketFactory: sockets)
        core.relay?.maxBackoff = 0.05

        var plan: [(socket: Int, id: String, cancelled: Bool)] = []
        var dropped: [Int: Set<String>] = [:]
        let bodies = [
            (["jsonrpc": "2.0", "id": 1, "method": "tools/list"] as JSON),
            (["jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": ["name": "look", "arguments": .object([:])]] as JSON),
            (["jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": ["name": "status", "arguments": .object([:])]] as JSON),
        ]
        for round in 0..<6 {
            let ok = await eventually(5) { sockets.sockets.value.count > round }
            XCTAssertTrue(ok, "no connection \(round)")
            let socket = sockets.sockets.value[round]
            let shook = await handshake(socket)
            XCTAssertTrue(shook, "no hello on connection \(round)")
            for n in 0..<8 {
                let id = "c\(round)-\(n)"
                socket.push((["t": "req", "id": .string(id), "method": "POST", "headers": ["content-type": "application/json"], "body": .string(bodies[n % bodies.count].serialized())] as JSON).serialized())
                // n == 4 is a look (bodies[4 % 3]), slow enough that the cancel always lands first.
                let cancel = n == 4
                if cancel { socket.push((["t": "cancel", "id": .string(id)] as JSON).serialized()) }
                plan.append((round, id, cancel))
                try await Task.sleep(nanoseconds: 30_000_000)
            }
            if round % 2 == 1 {
                // Cut the connection while requests are still running.
                dropped[round] = Set(plan.filter { $0.socket == round }.map(\.id)).subtracting(answers(socket))
                socket.close(code: 1006, reason: "gone")
            } else {
                let expected = Set(plan.filter { $0.socket == round && !$0.cancelled }.map(\.id))
                let done = await eventually(20) { expected.isSubset(of: Set(self.answers(socket))) }
                XCTAssertTrue(done, "connection \(round) left \(expected.subtracting(self.answers(socket)).sorted()) unanswered")
                socket.close(code: 1006, reason: "next round")
            }
        }
        try await Task.sleep(nanoseconds: 500_000_000)
        core.stop()

        for (index, socket) in sockets.sockets.value.enumerated() {
            let ids = answers(socket)
            let mine = Set(plan.filter { $0.socket == index }.map(\.id))
            XCTAssertEqual(ids.count, Set(ids).count, "connection \(index) answered a request twice: \(ids)")
            XCTAssertTrue(Set(ids).isSubset(of: mine), "connection \(index) carried answers for another connection: \(Set(ids).subtracting(mine).sorted())")
            for p in plan where p.socket == index && p.cancelled {
                XCTAssertFalse(ids.contains(p.id), "answered \(p.id) after its cancel")
            }
            if let cut = dropped[index] {
                let late = Set(ids).intersection(cut)
                XCTAssertTrue(late.isEmpty, "answers sent on a closed connection: \(late.sorted())")
            }
        }
    }
}
