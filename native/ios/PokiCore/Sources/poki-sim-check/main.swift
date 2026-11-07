// Drives PokiCore's look/do through its MCP handler against a real WebDriverAgent (the iOS
// Simulator in CI), in Settings only, and prints what each call answered and how long it took.
// Exits non-zero when a check fails. macOS only; elsewhere it says so and exits.
import Foundation
#if os(macOS)
import PokiCore
import ImageIO
import UniformTypeIdentifiers

// Every line out at once: a crash must not take the last steps' output with it.
setvbuf(stdout, nil, _IOLBF, 0)

final class Host: CoreHost, @unchecked Sendable {
    struct NoKey: Error {}
    func signingKey() throws -> RelayKey { throw NoKey() }
    func accessHashes() -> [String] { [] }
    func jpeg(fromPNG png: Data, width: Int, quality: Double) throws -> Data {
        guard let source = CGImageSourceCreateWithData(png as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: width * 3] as CFDictionary) else { throw NoKey() }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { throw NoKey() }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        CGImageDestinationFinalize(destination)
        return out as Data
    }
    func runnerState() -> RunnerState { .running }
    func restartRunner() {}
}

let url = URL(string: ProcessInfo.processInfo.environment["POKI_WDA_URL"] ?? "http://127.0.0.1:8100")!
let treeFormat = ProcessInfo.processInfo.environment["POKI_TREE_FORMAT"] ?? "json"
let core = PokiCore(config: CoreConfig(runnerURL: url, treeFormat: treeFormat), host: Host())
print("tree format: \(treeFormat)")
var session: String?
var rows: [(String, Int, String)] = []
var failures: [String] = []

@MainActor func rpc(_ method: String, _ params: JSON) async -> JSON? {
    let body: JSON = ["jsonrpc": "2.0", "id": 1, "method": .string(method), "params": params]
    let reply = await core.handle(RelayRequest(id: "1", method: "POST", headers: session.map { ["mcp-session-id": $0] } ?? [:], body: body.serialized()))
    if session == nil { session = reply.headers["mcp-session-id"] }
    return try? JSON.parse(reply.body)
}

@discardableResult @MainActor
func call(_ label: String, _ name: String, _ args: JSON = .object([:])) async -> String {
    let started = Date()
    let reply = await rpc("tools/call", ["name": .string(name), "arguments": args])
    let ms = Int(Date().timeIntervalSince(started) * 1000)
    let text = reply?["result"]?["content"]?[0]?["text"]?.string ?? "no answer: \(reply?.serialized() ?? "nil")"
    let images = reply?["result"]?["content"]?.array?.filter { $0["type"]?.string == "image" }.count ?? 0
    print("=== \(label): \(ms) ms, \(images) image(s)\n\(text)\n")
    rows.append((label, ms, text.split(separator: "\n").first.map(String.init) ?? ""))
    return text
}

@MainActor func check(_ ok: Bool, _ what: String) {
    print(ok ? "PASS \(what)" : "FAIL \(what)")
    if !ok { failures.append(what) }
}

_ = await rpc("initialize", ["protocolVersion": "2025-06-18", "capabilities": .object([:]), "clientInfo": ["name": "poki-sim-check", "version": "1"]])
await call("look (cold: opens the session)", "look")
let launched = await call("launch Settings fresh", "do", ["actions": [["launch": ["bundle": "com.apple.Preferences", "fresh": true]]]])
// A cold app's first tree can take longer than a read waits on a CI simulator; the reply then says
// so. What must hold: Settings is in front by the next look.
let warm = await call("look (warm)", "look")
let warm2 = await call("look (warm, again)", "look")
check([launched, warm, warm2].contains { $0.contains("app: Settings") }, "Settings is in front after launch")
let swiped = await call("swipe up", "do", ["actions": [["swipe": "up"]]])
check(swiped.contains("screen_changed: true"), "a swipe up scrolls Settings")
let back = await call("swipe down", "do", ["actions": [["swipe": "down"]]])
check(back.contains("screen_changed: true"), "a swipe down scrolls back")
let dragged = await call("drag up 300 points", "do", ["actions": [["drag": [200, 650, 200, 350]]]])
check(dragged.contains("screen_changed: true"), "a drag scrolls Settings")
let found = await call("scroll_to Privacy", "do", ["actions": [["scroll_to": "Privacy"]]])
check(found.contains("found at"), "scroll_to finds Privacy")
let same = await call("no-op wait", "do", ["actions": [["wait": 300]]])
check(same.contains("screen_changed: false"), "nothing done: screen_changed false")
let waited = await call("wait_until settled", "do", ["actions": [["wait_until": "settled"]]])
check(waited.contains("wait_until: the screen held still"), "wait_until settled")
await call("swipe down to the top", "do", ["actions": [["swipe": "down"], ["swipe": "down"]]])
// Diagnostic only: how long Vision's text recognition takes here on a whole screenshot (the fallback
// when the tree is late gets up to 3.5 s).
if let shot = try? await URLSession.shared.data(from: url.appendingPathComponent("screenshot")).0,
   let b64 = (try? JSON.parse(shot))?["value"]?.string, let png = Data(base64Encoded: b64) {
    let began = Date()
    let texts = await Host().recognizeText(inPNG: png)
    print("diag: Vision read \(texts.map { "\($0.count) texts" } ?? "nothing (nil)") from a \(png.count / 1024) KB screenshot in \(Int(Date().timeIntervalSince(began) * 1000)) ms\n")
}
// Settings' search field: typing, read back exactly.
let list = await call("look for the search field", "look")
let searchRef = list.split(separator: "\n").first { $0.contains("SearchField") }.flatMap { line in line.split(separator: " ").first { Int($0.trimmingCharacters(in: CharacterSet(charactersIn: "+~"))) != nil } }.map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "+~")) }
if let searchRef, let ref = Int(searchRef) {
    let text = "Wi-Fi 你好 123"
    let typed = await call("type mixed text in search", "do", ["actions": [["type": .string(text), "ref": .number(Double(ref))]]])
    // The read-back can miss its time while the keyboard comes up; the next read shows the field then.
    // Simulator tolerance: on a fresh simulator Settings' own main loop can stop answering for a while
    // after the first search (WDA's log: "did not confirm its main run loop is responsive"), so the
    // check looks up to three more times. Each look's answer stays in the log and the table.
    var reads = [typed]
    for attempt in 1...4 {
        let after = await call(attempt == 1 ? "look at the field" : "look at the field (\(attempt))", "look")
        reads.append(after)
        if !after.contains("no element tree") { break }
    }
    // With the tree late, the text read from the picture stands in; it must show the typed text.
    check(reads.contains { $0.contains("the field now reads \"\(text)\"") || $0.contains("SearchField \"Search = \(text)\"") || $0.contains("Text \"\(text)\"") }, "typed text reads back exactly")
} else {
    check(false, "Settings shows a search field")
}
let home = await call("home", "do", ["actions": [["button": "home"]]])
check(home.contains("(sent,"), "home is pressed")
await call("status", "status")

print("\n| call | ms | first line |\n|---|---:|---|")
for (label, ms, line) in rows { print("| \(label) | \(ms) | \(line.replacingOccurrences(of: "|", with: "/")) |") }
if !failures.isEmpty {
    print("\n\(failures.count) check(s) failed: \(failures.joined(separator: "; "))")
    exit(1)
}
print("\nall checks passed")
#else
print("poki-sim-check runs on macOS only")
#endif
