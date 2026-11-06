import Foundation
import PokiCore

/// Linux Foundation's WebSocket needs a libcurl built with WebSockets, which the Swift images lack,
/// so on Linux the socket is a `node ws-bridge.mjs <url>` child: one JSON string per line each way.
/// On the phone PokiCore uses URLSession's WebSocket instead.
final class NodeSocketFactory: WebSocketFactory, @unchecked Sendable {
    let node: String, bridge: String
    init(node: String, bridge: String) { self.node = node; self.bridge = bridge }
    func connect(to url: URL) async throws -> WebSocketConnection {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = [bridge, url.absoluteString]
        let input = Pipe(), output = Pipe()
        process.standardInput = input
        process.standardOutput = output
        try process.run()
        let socket = NodeSocket(process: process, input: input.fileHandleForWriting, output: output.fileHandleForReading)
        let opened = try await socket.receive()
        guard opened == "\u{0}open" else { throw NSError(domain: "ws-bridge", code: 1, userInfo: [NSLocalizedDescriptionKey: opened]) }
        return socket
    }
}

final class NodeSocket: WebSocketConnection, @unchecked Sendable {
    let process: Process, input: FileHandle
    private let lines = LinesBox()
    init(process: Process, input: FileHandle, output: FileHandle) {
        self.process = process
        self.input = input
        output.readabilityHandler = { [lines] handle in
            let data = handle.availableData
            if data.isEmpty { lines.finish(); handle.readabilityHandler = nil } else { lines.add(data) }
        }
    }
    func send(_ text: String) async throws {
        let line = String(decoding: try JSONEncoder().encode(text), as: UTF8.self) + "\n"
        try input.write(contentsOf: Data(line.utf8))
    }
    func receive() async throws -> String {
        guard let line = await lines.next() else { throw NSError(domain: "ws-bridge", code: 2, userInfo: [NSLocalizedDescriptionKey: "closed"]) }
        return try JSONDecoder().decode(String.self, from: Data(line.utf8))
    }
    func close(code: Int, reason: String) { if process.isRunning { process.terminate() } }
}

/// Lines from the child, handed to one waiting reader at a time.
final class LinesBox: @unchecked Sendable {
    private let lock = NSLock()
    private var buffer = Data(), ready: [String] = [], waiter: CheckedContinuation<String?, Never>?, done = false
    func add(_ data: Data) {
        lock.lock()
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 10) {
            ready.append(String(decoding: buffer[buffer.startIndex..<newline], as: UTF8.self))
            buffer.removeSubrange(buffer.startIndex...newline)
        }
        let (w, line) = take()
        lock.unlock()
        if let w { w.resume(returning: line) }
    }
    func finish() { lock.lock(); done = true; let (w, line) = take(); lock.unlock(); w?.resume(returning: line) }
    private func take() -> (CheckedContinuation<String?, Never>?, String?) {
        guard let w = waiter, !ready.isEmpty || done else { return (nil, nil) }
        waiter = nil
        return (w, ready.isEmpty ? nil : ready.removeFirst())
    }
    func next() async -> String? {
        await withCheckedContinuation { c in
            lock.lock()
            if !ready.isEmpty { let l = ready.removeFirst(); lock.unlock(); c.resume(returning: l); return }
            if done { lock.unlock(); c.resume(returning: nil); return }
            waiter = c
            lock.unlock()
        }
    }
}
