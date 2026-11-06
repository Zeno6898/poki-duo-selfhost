import Foundation
import Network

/// Live loopback status: every few seconds while Poki is in front (and on demand), a TCP connect to
/// lockdown at 10.7.0.1:62078, which only answers when the proxy app (or LocalDevVPN) reflects
/// 10.7.0.1 back to this phone. Also whether Wi-Fi is up, which the phone's developer services need.
@MainActor
@Observable
final class LoopbackMonitor {
    enum State: Equatable {
        case checking
        case working(ms: Int)
        /// A tunnel gave the phone a 10.7.0.x address, but nothing answered through it.
        case noAnswer
        case off
    }
    private(set) var state = State.checking
    private(set) var onWiFi = false
    private(set) var checkedAt: Date?
    private var timer: Timer?
    private let path = NWPathMonitor()
    private var running = false

    init() {
        path.pathUpdateHandler = { [weak self] path in
            let wifi = path.status == .satisfied && path.usesInterfaceType(.wifi)
            Task { @MainActor in
                guard let self else { return }
                if self.onWiFi != wifi { self.onWiFi = wifi; self.check() }
            }
        }
        path.start(queue: DispatchQueue(label: "poki.path"))
    }

    private static func same(_ a: State, _ b: State) -> Bool {
        switch (a, b) {
        case (.working(let x), .working(let y)): abs(x - y) < 100
        default: a == b
        }
    }

    var isWorking: Bool { if case .working = state { true } else { false } }

    /// Checks every 3 s until `pause`.
    func resume() {
        guard timer == nil else { return }
        check()
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in Task { @MainActor in self?.check() } }
    }

    func pause() { timer?.invalidate(); timer = nil }

    func check() {
        guard !running else { return }
        running = true
        Task {
            let result = await probe(label: "loopback", host: "10.7.0.1", port: 62078, timeout: 1.5)
            running = false
            let next: State = result.outcome == "connected" ? .working(ms: result.milliseconds) : loopbackInterface() == nil ? .off : .noAnswer
            // Only a change is published, so the screens are not redrawn every 3 s (a redraw while
            // the person drags a list makes scrolling stutter).
            if !Self.same(next, state) { state = next; checkedAt = Date() }
        }
    }

    var text: String {
        switch state {
        case .checking: "Checking…"
        case .working: "Working"
        case .noAnswer: "Tunnel on, no answer"
        case .off: "Off"
        }
    }

    var detail: String {
        switch state {
        case .checking: "Looking for this iPhone at 10.7.0.1."
        case .working(let ms): "This iPhone answers at 10.7.0.1 (\(ms) ms)." + (onWiFi ? "" : " Connect to Wi-Fi: the developer services need it.")
        case .noAnswer: "Your proxy app's tunnel is on, but 10.7.0.1 is not reflected. Turn on the Poki module or route, then reconnect the proxy."
        case .off: "Nothing answers at 10.7.0.1. Turn on your proxy app (with the Poki module) or LocalDevVPN."
        }
    }
}
