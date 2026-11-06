import XCTest
@testable import PokiCore

/// The fixes from an agent's run in X: taps that cannot land, swipes that started on the reply bar,
/// slow drags, no-op actions that looked like success, the picture's scale, collapsed cells, fixed
/// waits and repeated text.
final class LookDoTests: XCTestCase {
    /// A reply thread: a table of posts with a reply bar drawn over its bottom.
    func thread(_ wda: FakeWDA, quotedY: Double = 742) {
        wda.tree([
            Node("Table", nil, [0, 0, 390, 844], [
                Node("Cell", "Post one", [0, 100, 390, 120]),
                Node("Cell", "Post two", [0, 220, 390, 120]),
                Node("Cell", "Quoted post", [0, quotedY, 390, 120]),
            ]),
            Node("Other", nil, [0, 744, 390, 100], [Node("TextView", "Post your reply", [16, 760, 300, 40])]),
        ])
    }

    func testTheSessionTurnsOffWDAsWaitsAfterEveryGesture() async {
        let (core, wda, _) = makeCore()
        _ = await core.call("look", [:])
        let settings = wda.bodies("POST /appium/settings").first?["settings"]
        XCTAssertEqual(settings?["animationCoolOffTimeout"]?.double, 0)
        XCTAssertEqual(settings?["waitForIdleTimeout"]?.double, 0.5)
    }

    func testAnElementUnderTheReplyBarIsNotHittableAndNothingIsSent() async {
        let (core, wda, _) = makeCore()
        thread(wda, quotedY: 750)
        let look = await core.call("look", [:])
        XCTAssertTrue(look.text.contains("3 Cell \"Quoted post\" [0,750,390,120]"), look.text)
        let result = await core.call("do", ["actions": [["tap": 3]]])
        XCTAssertTrue(result.text.contains("not_hittable: element 3 Cell \"Quoted post\": its visible part is covered by Other"), result.text)
        XCTAssertTrue(result.text.contains("scroll_to"), result.text)
        XCTAssertEqual(wda.bodies("POST /wda/tap").count, 0)
    }

    func testAPartlyCoveredElementIsTappedOnItsVisiblePart() async {
        let (core, wda, _) = makeCore()
        thread(wda, quotedY: 690) // 690-810: the centre (750) is under the bar, 690-744 is free
        _ = await core.call("look", [:])
        let result = await core.call("do", ["actions": [["tap": 3]]])
        XCTAssertFalse(result.isError, result.text)
        let y = wda.bodies("POST /wda/tap").first?["y"]?.double ?? 0
        XCTAssertTrue(y > 690 && y < 744, "tapped at y \(y)")
        XCTAssertTrue(result.text.contains("(its centre is off screen or covered)"), result.text)
    }

    func testAPointOffTheScreenIsNotHittable() async {
        let (core, wda, _) = makeCore()
        _ = await core.call("look", [:])
        let result = await core.call("do", ["actions": [["tap": [200, 900]]]])
        XCTAssertTrue(result.text.contains("not_hittable: [200, 900] is off the screen (390x844 points)"), result.text)
        XCTAssertEqual(wda.bodies("POST /wda/tap").count, 0)
    }

    func testASwipeStartsInsideTheListClearOfTheReplyBarAsAQuickFlick() async {
        let (core, wda, _) = makeCore()
        thread(wda)
        _ = await core.call("look", [:])
        let result = await core.call("do", ["actions": [["swipe": "up"]]])
        XCTAssertFalse(result.isError, result.text)
        guard let body = wda.bodies("POST /wda/pressAndDragWithVelocity").first else { return XCTFail("no gesture sent: \(wda.sent)") }
        let fromY = body["fromY"]!.double!, toY = body["toY"]!.double!
        XCTAssertLessThan(fromY, 744, "the finger must not land on the reply bar")
        XCTAssertGreaterThan(fromY, toY)
        XCTAssertGreaterThan(toY, 844 * 0.06)
        XCTAssertEqual(body["pressDuration"]?.double, 0)
        XCTAssertEqual(body["holdDuration"]?.double, 0)
        XCTAssertEqual(wda.bodies("POST /wda/dragfromtoforduration").count, 0)
    }

    func testADragStopsBeforeLiftingAndUsesItsOwnSpeed() async {
        let (core, wda, _) = makeCore()
        _ = await core.call("look", [:])
        let result = await core.call("do", ["actions": [["drag": [200, 600, 200, 200]]]])
        XCTAssertFalse(result.isError, result.text)
        let body = wda.bodies("POST /wda/pressAndDragWithVelocity").first
        XCTAssertEqual(body?["velocity"]?.double, 1000) // 400 points in the default 400 ms
        XCTAssertEqual(body?["holdDuration"]?.double, 0.15)
        XCTAssertTrue(result.text.contains("drag from [200, 600] to [200, 200] in 400 ms"), result.text)
    }

    func testAnOlderRunnerFallsBackToItsDrag() async {
        let (core, wda, _) = makeCore()
        wda.set("POST /wda/pressAndDragWithVelocity") { _ in (404, ["value": ["error": "unknown command", "message": "Unhandled endpoint"]]) }
        _ = await core.call("look", [:])
        let result = await core.call("do", ["actions": [["swipe": "up"]]])
        XCTAssertFalse(result.isError, result.text)
        XCTAssertEqual(wda.bodies("POST /wda/dragfromtoforduration").count, 1)
    }

    func testASlowGestureIsNotTakenAsTheRunnerBeingGone() async {
        let (core, wda, host) = makeCore { $0.actionCap = 1.2 }
        wda.set("POST /wda/pressAndDragWithVelocity") { _ in try await Task.sleep(nanoseconds: 30_000_000_000); return (200, ["value": .null]) }
        _ = await core.call("look", [:])
        for _ in 0..<2 {
            let result = await core.call("do", ["actions": [["swipe": "up"], ["tap": 1]]])
            XCTAssertTrue(result.text.contains("may have been delivered"), result.text)
            XCTAssertTrue(result.text.contains("app: Settings"), "the read after it still answers: \(result.text)")
        }
        XCTAssertEqual(host.restarts.value, 0)
        XCTAssertEqual(core.runner.consecutiveMisses, 0)
    }

    func testScreenChangedSaysWhenAnActionDidNothing() async {
        let (core, wda, _) = makeCore()
        _ = await core.call("look", [:])
        let same = await core.call("do", ["actions": [["tap": [200, 400]]]])
        XCTAssertTrue(same.text.contains("screen_changed: false (the elements and the picture are the same as in the read before)"), same.text)
        XCTAssertTrue(same.text.contains("elements: none changed (2 on screen keep their numbers)"), same.text)
        wda.source([("Button", "General"), ("Button", "Privacy"), ("Button", "Wi-Fi")])
        let changed = await core.call("do", ["actions": [["tap": [200, 400]]]])
        XCTAssertTrue(changed.text.contains("screen_changed: true (the elements changed)"), changed.text)
        wda.set("GET /screenshot") { _ in (200, ["value": .string(Data("png2".utf8).base64EncodedString())]) }
        let picture = await core.call("do", ["actions": [["tap": [200, 400]]]])
        XCTAssertTrue(picture.text.contains("screen_changed: true (only the picture changed"), picture.text)
    }

    func testNumbersStayAndDoListsOnlyWhatChanged() async {
        let (core, wda, _) = makeCore()
        wda.source([("Button", "A"), ("Button", "B"), ("Button", "C")])
        _ = await core.call("look", [:])
        wda.source([("Button", "A"), ("Button", "B"), ("Button", "C"), ("Button", "D")])
        let added = await core.call("do", ["actions": []])
        XCTAssertTrue(added.text.contains("+4 Button \"D\" [16,232,358,44]"), added.text)
        XCTAssertFalse(added.text.contains("Button \"A\""), added.text)
        // B is gone; C and D move up and keep their numbers.
        wda.source([("Button", "A"), ("Button", "C"), ("Button", "D")])
        let moved = await core.call("do", ["actions": []])
        XCTAssertTrue(moved.text.contains("~3 Button \"C\" [16,144,358,44]"), moved.text)
        XCTAssertTrue(moved.text.contains("gone since the last read: 2 Button \"B\""), moved.text)
        _ = await core.call("do", ["actions": [["tap": 4]]])
        XCTAssertEqual(wda.bodies("POST /wda/tap").last?["y"]?.double, 210)
        // A whole new screen numbers from 1 again.
        wda.source([("Button", "X"), ("Button", "Y")])
        let next = await core.call("do", ["actions": []])
        XCTAssertTrue(next.text.contains(" 1 Button \"X\""), next.text)
    }

    func testRepeatsScrollBarsAndHoldersAreLeftOut() async {
        let (core, wda, _) = makeCore()
        let long = String(repeating: "word ", count: 60)
        wda.tree([
            Node("TextView", "Hello world. Line two", [16, 100, 358, 80], [
                Node("StaticText", "Hello world.", [16, 100, 358, 40]),
                Node("StaticText", "Line two", [16, 140, 358, 40]),
            ]),
            Node("Other", "Vertical scroll bar, 3 pages", [384, 90, 3, 700]),
            Node("Other", "Post", [16, 200, 80, 44], [Node("Button", "Post", [16, 200, 80, 44])]),
            Node("StaticText", long, [16, 300, 358, 200]),
        ])
        let lean = await core.call("look", [:])
        XCTAssertTrue(lean.text.contains("1 TextView \"Hello world. Line two\""), lean.text)
        XCTAssertFalse(lean.text.contains("StaticText \"Hello world.\""), lean.text)
        XCTAssertFalse(lean.text.contains("scroll bar"), lean.text)
        XCTAssertTrue(lean.text.contains("Button \"Post\""), lean.text)
        XCTAssertFalse(lean.text.contains("Other \"Post\""), lean.text)
        XCTAssertTrue(lean.text.contains("… (+150 characters)"), lean.text)
        let full = await core.call("look", ["full": true])
        XCTAssertTrue(full.text.contains("StaticText \"Hello world.\""), full.text)
        XCTAssertTrue(full.text.contains("Vertical scroll bar"), full.text)
        XCTAssertTrue(full.text.contains(long), "full keeps whole labels")
    }

    func testACollapsedCellGetsTheTextReadFromThePictureOnAFullRead() async {
        let (core, wda, host) = makeCore()
        wda.tree([Node("Cell", "Ada Lovelace @ada 2h This is the post's text, long enough to be a whole cell. 13 replies 7 likes", [0, 100, 390, 200])])
        // "13" at 200-230 x 260-280 points on a 390x844 screen.
        host.texts.value = [RecognizedText(text: "13", box: Rect(x: 200 / 390, y: 260 / 844, width: 30 / 390, height: 20 / 844)),
                            RecognizedText(text: "outside", box: Rect(x: 0.1, y: 0.9, width: 0.1, height: 0.02))]
        let lean = await core.call("look", [:])
        XCTAssertTrue(lean.text.contains("[collapsed]"), lean.text)
        XCTAssertFalse(lean.text.contains("Text \"13\""), lean.text)
        let full = await core.call("look", ["full": true])
        XCTAssertTrue(full.text.contains("2 Text \"13\" [200,260,30,20] (read from the picture)"), full.text)
        XCTAssertFalse(full.text.contains("outside"), full.text)
        _ = await core.call("do", ["actions": [["tap": 2]]])
        let tap = wda.bodies("POST /wda/tap").last
        XCTAssertEqual(tap?["x"]?.double ?? 0, 215, accuracy: 0.01)
        XCTAssertEqual(tap?["y"]?.double ?? 0, 270, accuracy: 0.01)
    }

    func testTheScreenshotIsOnePixelPerScreenPoint() async {
        let (core, _, host) = makeCore()
        let result = await core.call("look", [:])
        XCTAssertEqual(host.widths.value.first, 390)
        XCTAssertTrue(result.text.contains("screenshot: 390 px wide, 1 px = 1 screen point"), result.text)
    }

    func testWaitUntilReadsUntilTheTextAppears() async {
        let (core, wda, _) = makeCore()
        _ = await core.call("look", [:])
        Task { try? await Task.sleep(nanoseconds: 400_000_000); wda.source([("Button", "General"), ("StaticText", "Done")]) }
        let result = await core.call("do", ["actions": [["wait_until": "done"]]])
        XCTAssertTrue(result.text.contains("wait_until: \"done\" appeared after"), result.text)
        XCTAssertFalse(result.text.contains("paused"), "no pause after a wait: \(result.text)")
        let missing = await core.call("do", ["actions": [["wait_until": ["text": "Nope", "ms": 300]]]])
        XCTAssertTrue(missing.text.contains("wait_until: not seen within 300 ms that \"Nope\" appeared"), missing.text)
        XCTAssertFalse(missing.isError, "not seeing it is a fact for the model, not an error")
        let settled = await core.call("do", ["actions": [["wait_until": ["settled": true]]]])
        XCTAssertTrue(settled.text.contains("wait_until: the screen held still after"), settled.text)
    }

    func testAWaitSaysHowLongItWaitedOnce() async {
        let (core, _, _) = makeCore()
        _ = await core.call("look", [:])
        let result = await core.call("do", ["actions": [["wait": 100]]])
        XCTAssertTrue(result.text.contains("did: wait 100 ms (sent"), result.text)
        XCTAssertFalse(result.text.contains("waited 0 ms"), result.text)
        XCTAssertFalse(result.text.contains("paused"), result.text)
    }

    func testScrollToBringsATargetOutFromUnderTheBar() async {
        let (core, wda, _) = makeCore()
        thread(wda, quotedY: 760)
        _ = await core.call("look", [:])
        wda.set("POST /wda/pressAndDragWithVelocity") { [wda] _ in
            wda.tree([
                Node("Table", nil, [0, 0, 390, 844], [Node("Cell", "Quoted post", [0, 300, 390, 120])]),
                Node("Other", nil, [0, 744, 390, 100], [Node("TextView", "Post your reply", [16, 760, 300, 40])]),
            ])
            return (200, ["value": .null])
        }
        let result = await core.call("do", ["actions": [["scroll_to": "Quoted"]]])
        XCTAssertTrue(result.text.contains("scroll_to \"Quoted\": 1 swipes, found at [0,300,390,120]"), result.text)
        XCTAssertEqual(wda.bodies("POST /wda/pressAndDragWithVelocity").first?["holdDuration"]?.double, 0.1)
    }

    func testAControlInsideABarOrAnInputBarListedApartFromItIsHittable() async {
        let (core, wda, _) = makeCore()
        // WeChat-like: the Send button is listed before the input bar and the keyboard that enclose it.
        wda.tree([
            Node("Table", nil, [0, 0, 390, 690], [Node("Cell", "Hello", [0, 100, 390, 60])]),
            Node("Button", "Send", [320, 705, 60, 40]),
            Node("Other", nil, [0, 700, 390, 50], [Node("TextView", "message", [16, 705, 290, 40])]),
            Node("Keyboard", nil, [0, 750, 390, 94], [Node("Key", "a", [10, 760, 30, 40])]),
            Node("Button", "Return", [300, 790, 80, 44]),
        ])
        _ = await core.call("look", [:])
        let result = await core.call("do", ["actions": [["tap": 2], ["tap": 5]]])
        XCTAssertFalse(result.isError, result.text)
        let taps = wda.bodies("POST /wda/tap")
        XCTAssertEqual(taps.first?["x"]?.double, 350)
        XCTAssertEqual(taps.first?["y"]?.double, 725)
        XCTAssertEqual(taps.last?["y"]?.double, 812)
    }

    func testTheActionsGetTheirFullTimeAfterTheOwnerApproves() async {
        let (core, wda, _) = makeCore { $0.approvalWait = 4; $0.toolDeadline = 3; $0.actionCap = 1.5; $0.readTimeout = 1 }
        wda.source([("Button", "Delete Photo")])
        _ = await core.call("look", [:])
        Task {
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            if let p = core.pendingApproval { core.resolveApproval(id: p.id, approved: true) }
        }
        let result = await core.call("do", ["actions": [["tap": 1]]])
        XCTAssertFalse(result.isError, result.text)
        XCTAssertEqual(wda.bodies("POST /wda/tap").count, 1, result.text)
        XCTAssertTrue(result.text.contains("approval: approved on the phone after"), result.text)
        XCTAssertTrue(result.text.contains("app: Settings"), "the read after it still answers: \(result.text)")
    }

    func testTheToolDescriptionsPointToScrollTo() {
        let text = PokiCore.tools.map { $0.serialized() }.joined() + PokiCore.instructions
        XCTAssertTrue(PokiCore.instructions.contains("scroll_to"))
        XCTAssertTrue(text.contains("wait_until"))
        XCTAssertTrue(text.contains("not_hittable"))
        XCTAssertTrue(text.contains("screen_changed"))
    }
}

#if canImport(Vision) && canImport(ImageIO) && canImport(CoreText) && os(macOS)
import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers

final class TextRecognitionTests: XCTestCase {
    /// Vision reads a rendered word back, with its box in parts of the picture from the top left.
    func testVisionReadsTextWithTopLeftBoxes() throws {
        let width = 600, height = 300
        let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let font = CTFontCreateWithName("Helvetica" as CFString, 64, nil)
        let text = NSAttributedString(string: "Poki 13", attributes: [NSAttributedString.Key(kCTFontAttributeName as String): font, NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(red: 0, green: 0, blue: 0, alpha: 1)])
        context.textPosition = CGPoint(x: 40, y: 200) // near the top: CoreGraphics counts from the bottom
        CTLineDraw(CTLineCreateWithAttributedString(text), context)
        let image = context.makeImage()!
        let data = NSMutableData()
        let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        // On a thread of its own with a limit, so a Vision that never answers fails the test instead of the run.
        let png = data as Data
        let box = LockedBox<[RecognizedText]??>(nil)
        let done = DispatchSemaphore(value: 0)
        Thread { box.value = .some(TextRecognizer.recognize(png: png)); done.signal() }.start()
        XCTAssertEqual(done.wait(timeout: .now() + 60), .success, "Vision did not answer within 60 s")
        let found = try XCTUnwrap(box.value ?? nil)
        let line = try XCTUnwrap(found.first { $0.text.contains("13") }, "\(found)")
        XCTAssertLessThan(line.box.y, 0.5, "the box is measured from the top: \(line.box)")
    }
}
#endif
