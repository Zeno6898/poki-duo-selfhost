import XCTest
@testable import PokiCore

/// The runner misbehaving in the ways a phone does, and text entry. Every call must answer in time
/// and say what was sent and what is on screen.
final class FaultTests: XCTestCase {
    /// A focused field that keeps what /wda/keys and the paste menu put in it.
    final class Field: @unchecked Sendable {
        let value = LockedBox("")
        let clipboard = LockedBox<String?>("owner's clipboard")
        func install(_ wda: FakeWDA, menu: Bool = true) {
            wda.set("GET /element/active") { _ in (200, ["value": ["ELEMENT": "E1"]]) }
            wda.set("GET /element/E1/attribute/value") { [value] _ in (200, ["value": .string(value.value)]) }
            wda.set("GET /element/E1/rect") { _ in (200, ["value": ["x": 16, "y": 100, "width": 358, "height": 44]]) }
            wda.set("POST /wda/keys") { [value] body in
                for key in body?["value"]?.array ?? [] {
                    if key.string == "\u{8}" { value.update { if !$0.isEmpty { $0.removeLast() } } } else { value.update { $0 += key.string ?? "" } }
                }
                return (200, ["value": .null])
            }
            wda.set("POST /wda/getPasteboard") { [clipboard] _ in
                guard let text = clipboard.value else { return (500, ["value": ["error": "unknown error", "message": "pasteboard unavailable"]]) }
                return (200, ["value": .string(Data(text.utf8).base64EncodedString())])
            }
            wda.set("POST /wda/setPasteboard") { [clipboard] body in
                clipboard.value = body?["content"]?.string.flatMap { Data(base64Encoded: $0) }.map { String(decoding: $0, as: UTF8.self) }
                return (200, ["value": .null])
            }
            if menu {
                wda.set("POST /wda/touchAndHold") { [wda] _ in
                    wda.tree([Node("TextField", nil, [16, 100, 358, 44]), Node("MenuItem", "Paste", [150, 50, 80, 40])], app: "Notes")
                    return (200, ["value": .null])
                }
            }
            wda.set("POST /wda/tap") { [value, clipboard] body in
                if body?["x"]?.double == 190, body?["y"]?.double == 70 { value.update { $0 += clipboard.value ?? "" } }
                return (200, ["value": .null])
            }
        }
    }

    func testMixedScriptTextIsTypedDirectlyAndReadBackExactly() async {
        let (core, wda, _) = makeCore()
        let field = Field()
        field.install(wda)
        _ = await core.call("look", [:])
        let text = "你好 Poki 2026，テスト 한글 ok"
        let result = await core.call("do", ["actions": [["type": .string(text)]]])
        XCTAssertFalse(result.isError, result.text)
        XCTAssertEqual(field.value.value, text)
        XCTAssertTrue(result.text.contains("(typed); the field now reads \"\(text)\""), result.text)
        XCTAssertEqual(wda.bodies("POST /wda/getPasteboard").count, 0, "typing never touches the clipboard")
    }

    func testPasteIsTheBackupAndPutsTheOwnersClipboardBack() async {
        let (core, wda, _) = makeCore()
        let field = Field()
        field.install(wda)
        _ = await core.call("look", [:])
        let result = await core.call("do", ["actions": [["type": "密码不是这个", "via": "paste"]]])
        XCTAssertFalse(result.isError, result.text)
        XCTAssertEqual(field.value.value, "密码不是这个")
        XCTAssertEqual(field.clipboard.value, "owner's clipboard", "the owner's clipboard is restored")
        XCTAssertTrue(result.text.contains("(pasted); the field now reads \"密码不是这个\""), result.text)
    }

    func testAnUnreadableClipboardIsNeverOverwritten() async {
        let (core, wda, _) = makeCore()
        let field = Field()
        field.install(wda)
        field.clipboard.value = nil
        _ = await core.call("look", [:])
        let result = await core.call("do", ["actions": [["type": "hello", "via": "paste"]]])
        XCTAssertTrue(result.text.contains("the clipboard could not be read, so it was not used"), result.text)
        XCTAssertEqual(wda.bodies("POST /wda/setPasteboard").count, 0)
        XCTAssertEqual(field.value.value, "")
    }

    func testAMissingPasteMenuStillRestoresTheClipboard() async {
        let (core, wda, _) = makeCore { $0.actionCap = 4 }
        let field = Field()
        field.install(wda, menu: false)
        _ = await core.call("look", [:])
        let result = await core.call("do", ["actions": [["type": "hello", "via": "paste"]]])
        XCTAssertTrue(result.text.contains("showed no Paste item"), result.text)
        XCTAssertEqual(field.clipboard.value, "owner's clipboard")
    }

    func testClearingWithNothingFocusedKeepsTheSession() async {
        let (core, wda, _) = makeCore()
        wda.set("GET /element/active") { _ in (404, ["value": ["error": "no such element", "message": "No element has focus"]]) }
        _ = await core.call("look", [:])
        let sessions = wda.sent.filter { $0 == "POST /session" }.count
        let result = await core.call("do", ["actions": [["type": "hi", "clear": true]]])
        XCTAssertFalse(result.isError, result.text)
        XCTAssertEqual(wda.sent.filter { $0 == "POST /session" }.count, sessions, "no new session for a WebDriver 'no such element'")
    }

    func testWaitUntilSettledAsAWordWaitsForAStillScreen() async {
        let (core, _, _) = makeCore()
        _ = await core.call("look", [:])
        let result = await core.call("do", ["actions": [["wait_until": "settled"]]])
        XCTAssertTrue(result.text.contains("wait_until: the screen held still after"), result.text)
    }

    func testALockedPhoneTakesNoInputAndLookSaysSo() async {
        let (core, wda, _) = makeCore()
        wda.set("GET /wda/locked") { _ in (200, ["value": true]) }
        let look = await core.call("look", [:])
        XCTAssertTrue(look.text.contains("screen: locked"), look.text)
        let result = await core.call("do", ["actions": [["tap": [100, 100]]]])
        XCTAssertTrue(result.text.contains("screen: locked. Nothing was sent."), result.text)
        XCTAssertEqual(wda.bodies("POST /wda/tap").count, 0)
        let button = await core.call("do", ["actions": [["button": "home"]]])
        XCTAssertFalse(button.text.contains("Nothing was sent"), "buttons still work: \(button.text)")
    }

    func testARunnerRestartedMidCallGetsANewSessionAndTheTapGoesThrough() async {
        let (core, wda, _) = makeCore()
        _ = await core.call("look", [:])
        let first = LockedBox(true)
        wda.set("POST /wda/tap") { [first] _ in
            if first.value { first.value = false; return (404, ["value": ["error": "invalid session id", "message": "Session does not exist"]]) }
            return (200, ["value": .null])
        }
        let result = await core.call("do", ["actions": [["tap": 1]]])
        XCTAssertFalse(result.isError, result.text)
        XCTAssertEqual(wda.bodies("POST /wda/tap").count, 2)
        XCTAssertTrue(result.text.contains("(sent,"), result.text)
    }

    func testARunnerThatDiesMidDoStopsAndSaysWhatWasSent() async {
        let (core, wda, host) = makeCore()
        _ = await core.call("look", [:])
        let gone: FakeWDA.Route = { _ in throw TransportError.refused }
        wda.set("POST /wda/keys", gone)
        for key in ["GET /source", "GET /screenshot", "GET /wda/activeAppInfo"] { wda.set(key, gone) }
        let started = Date()
        let result = await core.call("do", ["actions": [["tap": 1], ["key": "return"], ["tap": 2]]])
        XCTAssertLessThan(Date().timeIntervalSince(started), 4)
        XCTAssertTrue(result.text.contains("(sent,"), "the tap before it was sent: \(result.text)")
        XCTAssertTrue(result.text.contains("(not_sent"), result.text)
        XCTAssertTrue(result.text.contains("runner:"), "says what the runner is doing: \(result.text)")
        XCTAssertEqual(wda.bodies("POST /wda/tap").count, 1, "nothing after the failed action")
        XCTAssertGreaterThanOrEqual(host.restarts.value, 1)
    }

    func testAnAppSwitchMidGestureIsReportedAndTheReadStillComes() async {
        let (core, wda, _) = makeCore()
        _ = await core.call("look", [:])
        wda.set("POST /wda/pressAndDragWithVelocity") { [wda] _ in
            wda.source([("Button", "Open")], app: "Other app")
            return (500, ["value": ["error": "invalid element state", "message": "Cannot resolve the on-screen position of the drag gesture"]])
        }
        let result = await core.call("do", ["actions": [["swipe": "up"], ["tap": 1]]])
        XCTAssertTrue(result.text.contains("Cannot resolve the on-screen position"), result.text)
        XCTAssertTrue(result.text.contains("Button \"Open\""), "the read after it shows the new screen: \(result.text)")
        XCTAssertEqual(wda.bodies("POST /wda/tap").count, 0)
    }

    func testAHugeTreeIsReadInTimeAndTheListIsCapped() async {
        let (core, wda, _) = makeCore()
        wda.source((0..<5000).map { ("StaticText", "Line \($0)") })
        let started = Date()
        let result = await core.call("look", [:])
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        XCTAssertTrue(result.text.contains("StaticText \"Line 0\""), String(result.text.prefix(300)))
        XCTAssertFalse(result.text.contains("Line 4999"), "rows off the screen are not listed")
        XCTAssertLessThan(result.text.count, 20_000)
    }

    func testASlowRunnerNeverHoldsACallPastItsDeadline() async {
        let (core, wda, _) = makeCore { $0.toolDeadline = 4; $0.actionCap = 2; $0.readTimeout = 1 }
        for key in ["GET /source", "GET /screenshot", "POST /wda/tap"] {
            wda.set(key) { _ in try await Task.sleep(nanoseconds: 20_000_000_000); return (200, ["value": .null]) }
        }
        let started = Date()
        let result = await core.call("do", ["actions": [["tap": [10, 10]], ["tap": [20, 20]]]])
        XCTAssertLessThan(Date().timeIntervalSince(started), 5.5)
        XCTAssertTrue(result.text.contains("may have been delivered"), result.text)
    }

    func testAHangingSessionCreationDoesNotOutliveTheToolDeadline() async {
        let wda = FakeWDA()
        wda.set("POST /session") { _ in try await Task.sleep(nanoseconds: 60_000_000_000); return (200, ["value": ["sessionId": "s1"]]) }
        let (core, _, _) = makeCore(wda) { $0.toolDeadline = 4; $0.readTimeout = 1 }
        let started = Date()
        let result = await core.call("look", [:])
        XCTAssertLessThan(Date().timeIntervalSince(started), 4)
        XCTAssertFalse(result.text.contains("what was sent is unknown"), "the call's own answer, not the backstop: \(result.text)")
    }

    func testConcurrentReadsOpenOneSession() async {
        let wda = FakeWDA()
        wda.set("POST /session") { _ in try await Task.sleep(nanoseconds: 200_000_000); return (200, ["value": ["sessionId": "s1"]]) }
        let (core, _, _) = makeCore(wda)
        _ = await core.call("look", [:])
        XCTAssertEqual(wda.sent.filter { $0 == "POST /session" }.count, 1, wda.sent.joined(separator: ", "))
    }

    /// WDA serves requests one at a time, so a slow read makes the next ones time out too. That runner
    /// is busy: it keeps its session and is not restarted while it still answers /status.
    func testABusyRunnerIsNotRestartedWhileItStillAnswersStatus() async throws {
        let (core, wda, host) = makeCore { $0.readTimeout = 0.3 }
        core.runner.probeTimeout = 0.5
        _ = await core.call("look", [:])
        let slow: FakeWDA.Route = { _ in try await Task.sleep(nanoseconds: 2_000_000_000); return (200, ["value": .null]) }
        for key in ["GET /source", "GET /screenshot", "GET /wda/activeAppInfo"] { wda.set(key, slow) }
        let sessions = wda.sent.filter { $0 == "POST /session" }.count
        _ = await core.call("look", [:])
        try await Task.sleep(nanoseconds: 800_000_000)
        XCTAssertEqual(host.restarts.value, 0, "a busy runner is left to finish")
        XCTAssertGreaterThanOrEqual(wda.sent.filter { $0 == "GET /status" }.count, 1, "it was asked whether it is there")
        wda.source([("Button", "General")])
        for key in ["GET /screenshot", "GET /wda/activeAppInfo"] { wda.set(key) { _ in (200, ["value": .null]) } }
        _ = await core.call("look", [:])
        XCTAssertEqual(wda.sent.filter { $0 == "POST /session" }.count, sessions, "the session is kept")
    }

    func testAWedgedRunnerThatAnswersNothingIsRestartedAfterTheProbe() async throws {
        let (core, wda, host) = makeCore { $0.readTimeout = 0.3 }
        core.runner.probeTimeout = 0.3
        _ = await core.call("look", [:])
        let stuck: FakeWDA.Route = { _ in try await Task.sleep(nanoseconds: 20_000_000_000); return (200, ["value": .null]) }
        for key in ["GET /source", "GET /screenshot", "GET /wda/activeAppInfo", "GET /status"] { wda.set(key, stuck) }
        _ = await core.call("look", [:])
        try await Task.sleep(nanoseconds: 1_200_000_000)
        XCTAssertEqual(host.restarts.value, 1, "no answer to /status either: the runner is started again")
    }

    /// Found on the simulator: WDA answers the Home button only outside a session.
    func testHomeIsPressedOutsideTheSession() async {
        let (core, wda, _) = makeCore()
        _ = await core.call("look", [:])
        let result = await core.call("do", ["actions": [["button": "home"]]])
        XCTAssertFalse(result.text.contains("not_sent"), result.text)
        XCTAssertEqual(wda.sent.filter { $0 == "POST /wda/homescreen" }.count, 1, wda.sent.joined(separator: ", "))
    }

    /// Found on the simulator: with a keyboard up the tree can take longer than a read waits. The text
    /// in the picture is listed instead, numbered, and a number taps that text.
    func testWithoutATreeTheTextInThePictureIsListedAndTappable() async {
        let (core, wda, host) = makeCore { $0.readTimeout = 0.5 }
        _ = await core.call("look", [:])
        host.texts.value = [RecognizedText(text: "Continue", box: Rect(x: 0.25, y: 0.9, width: 0.5, height: 0.05))]
        wda.set("GET /source") { _ in try await Task.sleep(nanoseconds: 5_000_000_000); return (200, ["value": .null]) }
        let look = await core.call("look", [:])
        XCTAssertTrue(look.text.contains("read from the picture because the element tree did not come in time"), look.text)
        XCTAssertTrue(look.text.contains("1 Text \"Continue\""), look.text)
        wda.source([("Button", "Continue")])
        let tap = await core.call("do", ["actions": [["tap": 1]]])
        XCTAssertFalse(tap.text.contains("not_sent"), tap.text)
        let body = wda.bodies("POST /wda/tap").last
        XCTAssertEqual(body?["x"]?.double, 195)
        XCTAssertEqual(body?["y"]?.double ?? 0, 0.925 * 844, accuracy: 0.5)
    }
}
