import XCTest
#if canImport(CryptoKit)
import CryptoKit
#endif
@testable import PokiCore

final class BasicsTests: XCTestCase {
    func testBase32() {
        XCTAssertEqual(base32(Data("foobar".utf8)), "mzxw6ytboi")
        XCTAssertEqual(base32(Data(count: 32)).count, 52)
    }

    func testJSONRoundTrip() throws {
        let value: JSON = ["a": [1, 2.5, "x", true, nil], "b": ["c": "d"]]
        XCTAssertEqual(try JSON.parse(value.serialized()), value)
    }

    func testDeadlineDoesNotWaitForAnOperationThatIgnoresCancellation() async {
        let started = Date()
        do {
            _ = try await withDeadline(0.2, "a stuck step") { await hang() }
            XCTFail("expected the deadline")
        } catch let error as DeadlineExceeded {
            XCTAssertEqual(error.what, "a stuck step")
        } catch { XCTFail("\(error)") }
        XCTAssertLessThan(Date().timeIntervalSince(started), 1)
    }

    func testSensitiveWordsMatchWholeWords() {
        XCTAssertEqual(SensitivityRules.matches("Delete Photo", ["delete"]), "delete")
        XCTAssertNil(SensitivityRules.matches("Display & Brightness", ["pay"]))
        XCTAssertEqual(SensitivityRules.matches("确认支付", ["支付"]), "支付")
    }
}

final class ToolTests: XCTestCase {
    func testLookListsElementsWithAPicture() async {
        let (core, _, _) = makeCore()
        let result = await core.call("look", [:])
        XCTAssertFalse(result.isError, result.text)
        XCTAssertTrue(result.text.hasPrefix("app: Settings"), result.text)
        XCTAssertTrue(result.text.contains("1 Button \"General\" [16,100,358,44]"), result.text)
        XCTAssertNotNil(result.jpeg)
    }

    func testAStuckTreeStillAnswersInTimeWithThePicture() async {
        let (core, wda, _) = makeCore()
        wda.set("GET /source") { _ in await hang() }
        let started = Date()
        let result = await core.call("look", [:])
        XCTAssertLessThan(Date().timeIntervalSince(started), 3)
        XCTAssertNotNil(result.jpeg, "the screenshot still comes back")
        XCTAssertTrue(result.text.contains("no element tree"), result.text)
    }

    func testANothingRunnerAnswersFastAndAsksForARestart() async {
        let (core, wda, host) = makeCore()
        let gone: FakeWDA.Route = { _ in throw TransportError.refused }
        for key in ["GET /source", "GET /screenshot", "GET /wda/activeAppInfo", "GET /wda/screen", "POST /session"] { wda.set(key, gone) }
        let started = Date()
        let result = await core.call("look", [:])
        XCTAssertTrue(result.isError)
        XCTAssertTrue(result.text.contains("read: failed"), result.text)
        XCTAssertLessThan(Date().timeIntervalSince(started), 3)
        XCTAssertGreaterThanOrEqual(host.restarts.value, 1)
        // A failed runner is answered at once, with its fix, and nothing is sent.
        host.state.value = .failed("Poki Runner is not installed", fix: "Install it")
        let count = wda.sent.count
        let quick = Date()
        let next = await core.call("do", ["actions": [["tap": [10, 10]]]])
        XCTAssertTrue(next.text.contains("runner: failed: Poki Runner is not installed. Fix on the phone: Install it"), next.text)
        XCTAssertLessThan(Date().timeIntervalSince(quick), 0.5)
        XCTAssertEqual(wda.sent.count, count)
    }

    func testACallWaitsForARunnerThatIsStartingThenGoesOn() async {
        let (core, wda, host) = makeCore()
        host.state.value = .starting("launching the runner")
        Task { try? await Task.sleep(nanoseconds: 600_000_000); host.state.value = .running }
        let started = Date()
        let result = await core.call("look", [:])
        XCTAssertFalse(result.isError, result.text)
        XCTAssertGreaterThan(Date().timeIntervalSince(started), 0.5)
        XCTAssertFalse(wda.sent.isEmpty)
    }

    func testARunnerThatNeverStartsIsAnsweredWithinTheCap() async {
        let (core, wda, host) = makeCore { $0.runnerWait = 0.5 }
        host.state.value = .starting("mounting the developer disk image")
        let started = Date()
        let result = await core.call("do", ["actions": [["tap": [10, 10]]]])
        XCTAssertTrue(result.text.contains("still starting"), result.text)
        XCTAssertLessThan(Date().timeIntervalSince(started), 1.5)
        XCTAssertTrue(wda.sent.isEmpty)
    }

    func testTapByNumberHitsTheCentre() async {
        let (core, wda, _) = makeCore()
        _ = await core.call("look", [:])
        let result = await core.call("do", ["actions": [["tap": 2]]])
        XCTAssertFalse(result.isError, result.text)
        XCTAssertEqual(wda.bodies("POST /wda/tap").last, ["x": 195, "y": 166])
        XCTAssertTrue(result.text.contains("did: tap tap \"Privacy\" (sent"), result.text)
    }

    func testAStaleNumberSendsNothing() async {
        let (core, wda, _) = makeCore()
        _ = await core.call("look", [:])
        let result = await core.call("do", ["actions": [["tap": 9]]])
        XCTAssertTrue(result.isError)
        XCTAssertTrue(result.text.contains("element 9 is not in the latest read"), result.text)
        XCTAssertTrue(wda.bodies("POST /wda/tap").isEmpty)
    }

    func testAStuckTapIsReportedAsMaybeDeliveredAndNothingAfterItIsSent() async {
        let (core, wda, _) = makeCore()
        wda.set("POST /wda/tap") { _ in await hang() }
        _ = await core.call("look", [:])
        let started = Date()
        let result = await core.call("do", ["actions": [["tap": 1], ["key": "return"]]])
        XCTAssertLessThan(Date().timeIntervalSince(started), 6)
        XCTAssertTrue(result.text.contains("may have been delivered"), result.text)
        XCTAssertTrue(wda.bodies("POST /wda/keys").isEmpty)
        XCTAssertNotNil(result.jpeg, "the screen is still read after the failure")
    }

    func testTypingClearsWithDeletesInOneRequest() async {
        let (core, wda, _) = makeCore()
        wda.set("GET /element/active") { _ in (200, ["value": ["ELEMENT": "e1"]]) }
        wda.set("GET /element/e1/attribute/value") { _ in (200, ["value": "abc"]) }
        _ = await core.call("look", [:])
        _ = await core.call("do", ["actions": [["type": "hi", "clear": true]]])
        XCTAssertEqual(wda.bodies("POST /wda/keys").last, ["value": ["\u{8}", "\u{8}", "\u{8}", "h", "i"]])
    }

    func testTheSecondCallIsBusyInsteadOfQueued() async {
        let (core, wda, _) = makeCore()
        wda.set("GET /source") { _ in try await Task.sleep(nanoseconds: 800_000_000); return (200, ["value": ["type": "XCUIElementTypeApplication"]]) }
        async let first = core.call("look", [:])
        try? await Task.sleep(nanoseconds: 100_000_000)
        let second = await core.call("look", [:])
        XCTAssertTrue(second.text.hasPrefix("busy"), second.text)
        _ = await first
    }
}

final class ApprovalTests: XCTestCase {
    func screenWithDelete() -> FakeWDA {
        let wda = FakeWDA()
        wda.source([("Button", "Delete Photo"), ("Button", "Share")], app: "Photos")
        return wda
    }

    func testADeletionWaitsForTheOwnerAndSendsNothing() async {
        let (core, wda, _) = makeCore(screenWithDelete())
        _ = await core.call("look", [:])
        let result = await core.call("do", ["actions": [["tap": 1]]])
        XCTAssertTrue(result.isError)
        XCTAssertTrue(result.text.contains("approval_required"), result.text)
        XCTAssertTrue(wda.bodies("POST /wda/tap").isEmpty)
        let pending = core.pendingApproval
        XCTAssertEqual(pending?.reason, "deleting (\"delete\")")
        // Approved on the phone: the same actions sent again run once.
        core.resolveApproval(id: pending!.id, approved: true)
        let again = await core.call("do", ["actions": [["tap": 1]]])
        XCTAssertFalse(again.isError, again.text)
        XCTAssertTrue(again.text.contains("approved on the phone"), again.text)
        XCTAssertEqual(wda.bodies("POST /wda/tap").count, 1)
        // Used up: a third time asks again.
        let third = await core.call("do", ["actions": [["tap": 1]]])
        XCTAssertTrue(third.text.contains("approval_required"), third.text)
    }

    func testApprovalDuringTheWaitRunsTheActionsInTheSameCall() async {
        let (core, wda, _) = makeCore(screenWithDelete()) { $0.approvalWait = 2 }
        _ = await core.call("look", [:])
        Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            if let p = core.pendingApproval { core.resolveApproval(id: p.id, approved: true) }
        }
        let result = await core.call("do", ["actions": [["tap": 1]]])
        XCTAssertFalse(result.isError, result.text)
        XCTAssertEqual(wda.bodies("POST /wda/tap").count, 1)
    }

    func testDeclinedSendsNothing() async {
        let (core, wda, _) = makeCore(screenWithDelete()) { $0.approvalWait = 2 }
        _ = await core.call("look", [:])
        Task {
            try? await Task.sleep(nanoseconds: 200_000_000)
            if let p = core.pendingApproval { core.resolveApproval(id: p.id, approved: false) }
        }
        let result = await core.call("do", ["actions": [["tap": 1]]])
        XCTAssertTrue(result.text.contains("declined"), result.text)
        XCTAssertTrue(wda.bodies("POST /wda/tap").isEmpty)
    }

    func testOtherActionsWithdrawThePendingRequestSoTheAutomationCannotApproveIt() async {
        let (core, _, _) = makeCore(screenWithDelete())
        _ = await core.call("look", [:])
        _ = await core.call("do", ["actions": [["tap": 1]]])
        let id = core.pendingApproval!.id
        _ = await core.call("do", ["actions": [["tap": 2]]])
        XCTAssertNil(core.pendingApproval)
        core.resolveApproval(id: id, approved: true)  // a press that arrives late does nothing
        let again = await core.call("do", ["actions": [["tap": 1]]])
        XCTAssertTrue(again.text.contains("approval_required"), again.text)
    }

    func testPasswordsNeedApproval() async {
        let wda = FakeWDA()
        wda.source([("TextField", "Email"), ("SecureTextField", "Password")])
        let (core, _, _) = makeCore(wda)
        _ = await core.call("look", [:])
        let typed = await core.call("do", ["actions": [["type": "hunter2", "ref": 2]]])
        XCTAssertTrue(typed.text.contains("password field"), typed.text)
        XCTAssertFalse(core.pendingApproval!.summary.contains("hunter2"), "the summary hides the text")
        let email = await core.call("do", ["actions": [["type": "a@b.c", "ref": 1]]])
        XCTAssertFalse(email.isError, email.text)
    }
}

final class MCPTests: XCTestCase {
    func post(_ core: PokiCore, _ body: JSON, session: String? = nil) async -> RelayResponse {
        await core.handle(RelayRequest(id: "r", method: "POST", headers: session.map { ["mcp-session-id": $0] } ?? [:], body: body.serialized()))
    }

    func testInitializeListAndCall() async throws {
        let (core, _, _) = makeCore()
        let initialized = await post(core, ["jsonrpc": "2.0", "id": 1, "method": "initialize", "params": ["protocolVersion": "2025-06-18"]])
        XCTAssertEqual(initialized.status, 200)
        let session = try XCTUnwrap(initialized.headers["mcp-session-id"])
        XCTAssertEqual(try JSON.parse(initialized.body)["result"]?["protocolVersion"], "2025-06-18")
        let note = await post(core, ["jsonrpc": "2.0", "method": "notifications/initialized"], session: session)
        XCTAssertEqual(note.status, 202)
        let list = try JSON.parse(await post(core, ["jsonrpc": "2.0", "id": 2, "method": "tools/list"], session: session).body)
        XCTAssertEqual(list["result"]?["tools"]?.array?.compactMap { $0["name"]?.string }, ["look", "do", "status"])
        let call = try JSON.parse(await post(core, ["jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": ["name": "look", "arguments": .object([:])]], session: session).body)
        XCTAssertEqual(call["result"]?["content"]?[1]?["type"], "image")
        XCTAssertEqual(call["result"]?["isError"], false)
    }

    func testGetIsNotAllowed() async {
        let (core, _, _) = makeCore()
        let r = await core.handle(RelayRequest(id: "r", method: "GET", headers: [:], body: ""))
        XCTAssertEqual(r.status, 405)
    }
}

final class RelayTests: XCTestCase {
    func testHandshakeRequestsAndKeepalive() async throws {
        let (core, _, _) = makeCore()
        let sockets = FakeSockets()
        let events = LockedBox<[CoreEvent]>([])
        Task { for await e in core.events { events.update { $0.append(e) } } }
        core.start(socketFactory: sockets)
        core.relay?.pingEvery = 0.1
        do { let ok = await eventually { !sockets.sockets.value.isEmpty }; XCTAssertTrue(ok) }
        let socket = sockets.sockets.value[0]
        let label = base32(FakeKey().publicKey)
        XCTAssertEqual(sockets.urls.value[0].absoluteString, "wss://pokimcp.zheha.nz/v1/\(label)/connect")

        let nonce = Data(repeating: 7, count: 32)
        socket.push((["t": "challenge", "nonce": .string(nonce.base64EncodedString())] as JSON).serialized())
        do { let ok = await eventually { !socket.sent.isEmpty }; XCTAssertTrue(ok) }
        let hello = try JSON.parse(socket.sent[0])
        XCTAssertEqual(hello["t"], "hello")
        XCTAssertEqual(hello["access"], ["abc123"])
        var signed = Data("poki-relay-v1:\(label):".utf8)
        signed.append(nonce)
        XCTAssertEqual(hello["sig"]?.string, try FakeKey().sign(signed).base64EncodedString())

        socket.push((["t": "ready", "max_body": 4_194_304] as JSON).serialized())
        do { let ok = await eventually { events.value.contains(.relay(.ready(url: "wss://pokimcp.zheha.nz/v1/\(label)"))) }; XCTAssertTrue(ok) }
        do { let ok = await eventually { socket.sent.contains("ping") }; XCTAssertTrue(ok) }

        let body = (["jsonrpc": "2.0", "id": 1, "method": "tools/list"] as JSON).serialized()
        socket.push((["t": "req", "id": "q1", "method": "POST", "headers": ["Content-Type": "application/json"], "body": .string(body)] as JSON).serialized())
        do { let ok = await eventually { socket.sent.contains { $0.contains("\"t\":\"res\"") } }; XCTAssertTrue(ok) }
        let res = try JSON.parse(socket.sent.first { $0.contains("\"t\":\"res\"") }!)
        XCTAssertEqual(res["id"], "q1")
        XCTAssertEqual(res["status"], 200)
        XCTAssertNotNil(try JSON.parse(res["body"]!.string!)["result"]?["tools"])
        core.stop()
    }

    func testTheRelayIsDialedAgainAfterADrop() async {
        let (core, _, _) = makeCore()
        let sockets = FakeSockets()
        core.start(socketFactory: sockets)
        core.relay?.maxBackoff = 0.05
        do { let ok = await eventually { !sockets.sockets.value.isEmpty }; XCTAssertTrue(ok) }
        sockets.sockets.value[0].close(code: 1006, reason: "gone")
        do { let ok = await eventually(5) { sockets.sockets.value.count >= 2 }; XCTAssertTrue(ok) }
        core.stop()
    }
}

final class EventTests: XCTestCase {
    func testAFinishedCallCarriesTheAppAndAThumbnail() async {
        let (core, _, _) = makeCore()
        let events = LockedBox<[CoreEvent]>([])
        Task { for await e in core.events { events.update { $0.append(e) } } }
        _ = await core.call("look", [:])
        let finished = await eventually { events.value.contains { if case .toolFinished = $0 { return true }; return false } }
        XCTAssertTrue(finished)
        guard case .toolFinished(_, .done, let facts)? = events.value.last else { return XCTFail("\(events.value)") }
        XCTAssertEqual(facts.app, "Settings")
        XCTAssertNotNil(facts.thumbnail)
    }
}

final class DDITests: XCTestCase {
    final class Mirror: HTTPTransport, @unchecked Sendable {
        var files: [String: Data] = [:]
        func send(method: String, url: URL, body: Data?, timeout: Double) async throws -> (status: Int, body: Data) {
            files[url.lastPathComponent].map { (200, $0) } ?? (404, Data())
        }
    }

    func testDownloadsIntoPlaceAndKeepsAVerifiedCopy() async throws {
        let mirror = Mirror()
        var manifestEntries: [String: Any] = [:]
        for (key, path) in zip(DeveloperDiskImage.payloadKeys, ["Image.dmg", "Image.dmg.trustcache", "Image.dmg.cryptex_info", "Image.dmg.root_hash"]) {
            #if canImport(CryptoKit)
            let digest = Data(SHA384.hash(data: Data(path.utf8)))
            #else
            let digest = Data([1])
            #endif
            manifestEntries[key] = ["Info": ["Path": path], "Digest": digest]
            mirror.files[path] = Data(path.utf8)
        }
        let manifest: [String: Any] = ["ProductBuildVersion": "22A1", "BuildIdentities": [["Manifest": manifestEntries]]]
        mirror.files["BuildManifest.plist"] = try PropertyListSerialization.data(fromPropertyList: manifest, format: .xml, options: 0)
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("ddi-\(UUID().uuidString)")
        let build = try await DeveloperDiskImage.ensure(in: dir, from: URL(string: "https://mirror.invalid/x")!, transport: mirror)
        XCTAssertEqual(build, "22A1")
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.appendingPathComponent("Image.dmg").path))
        mirror.files = [:]  // a verified copy is not downloaded again
        let again = try await DeveloperDiskImage.ensure(in: dir, from: URL(string: "https://mirror.invalid/x")!, transport: mirror)
        XCTAssertEqual(again, "22A1")
        try? FileManager.default.removeItem(at: dir)
    }
}
