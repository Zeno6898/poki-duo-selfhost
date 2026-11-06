import Foundation
import Network
import UIKit
import AVFoundation
import CoreLocation

/// The backgrounding test: holds one TCP connection to 10.7.0.1 open while the user leaves the app,
/// and logs, with timestamps, the app's state changes, a once-a-second heartbeat (a gap in it is
/// time the app was suspended), the connection's state, and the background task's expiry. The log
/// is appended to a file as well, so it survives the app being killed; it is shown again on launch.
@MainActor
final class Hold: NSObject, ObservableObject, CLLocationManagerDelegate {
    enum Experiment: String, CaseIterable, Identifiable { case none = "None", audio = "Silent audio", location = "Location"; var id: String { rawValue } }

    @Published var port = "49152"
    @Published var experiment: Experiment = .none
    @Published var log: [String] = []
    @Published var holding = false
    private var connection: NWConnection?
    private var heartbeat: Timer?
    private var lastBeat: Date?
    private var started: Date?
    private var task: UIBackgroundTaskIdentifier = .invalid
    private var engine: AVAudioEngine?
    private var location: CLLocationManager?
    private var observers: [NSObjectProtocol] = []
    private let file = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("hold-log.txt")

    override init() {
        super.init()
        if let previous = try? String(contentsOf: file, encoding: .utf8), !previous.isEmpty {
            log = ["previous run:"] + previous.split(separator: "\n").map(String.init)
        }
    }

    private func note(_ line: String) {
        let now = Date()
        let since = started.map { String(format: "+%.1fs", now.timeIntervalSince($0)) } ?? ""
        let entry = "\(now.formatted(.dateTime.hour().minute().second())) \(since) \(line)"
        log.append(entry)
        if let data = (entry + "\n").data(using: .utf8) {
            if let handle = try? FileHandle(forWritingTo: file) { handle.seekToEndOfFile(); handle.write(data); try? handle.close() }
            else { try? data.write(to: file) }
        }
    }

    func start() {
        guard !holding, let number = UInt16(port), let nwPort = NWEndpoint.Port(rawValue: number) else { return }
        try? FileManager.default.removeItem(at: file)
        log = []; started = Date(); holding = true
        note("hold 10.7.0.1:\(number), experiment: \(experiment.rawValue)")
        observe()
        startExperiment()
        let c = NWConnection(host: "10.7.0.1", port: nwPort, using: .tcp)
        c.stateUpdateHandler = { [weak self] state in Task { @MainActor in self?.note("connection: \(state)") } }
        c.start(queue: .main)
        receive(c)
        connection = c
        lastBeat = Date()
        heartbeat = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let last = self.lastBeat else { return }
                let gap = Date().timeIntervalSince(last)
                if gap > 2.5 { self.note(String(format: "heartbeat gap %.1fs (suspended)", gap)) }
                self.lastBeat = Date()
            }
        }
    }

    func stop() {
        connection?.cancel(); connection = nil
        heartbeat?.invalidate(); heartbeat = nil
        endTask()
        engine?.stop(); engine = nil
        location?.stopUpdatingLocation(); location = nil
        for o in observers { NotificationCenter.default.removeObserver(o) }; observers = []
        if holding { note("stopped") }
        holding = false
    }

    private func receive(_ c: NWConnection) {
        c.receive(minimumIncompleteLength: 1, maximumLength: 4096) { [weak self] data, _, complete, error in
            Task { @MainActor in
                guard let self else { return }
                if let data, !data.isEmpty { self.note("received \(data.count) bytes") }
                if let error { self.note("receive error: \(error)"); return }
                if complete { self.note("closed by the other side"); return }
                self.receive(c)
            }
        }
    }

    private func observe() {
        let center = NotificationCenter.default
        let events: [(Notification.Name, String)] = [
            (UIApplication.willResignActiveNotification, "will resign active"),
            (UIApplication.didEnterBackgroundNotification, "entered background"),
            (UIApplication.willEnterForegroundNotification, "will enter foreground"),
            (UIApplication.didBecomeActiveNotification, "became active"),
            (UIApplication.willTerminateNotification, "will terminate"),
        ]
        for (name, text) in events {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    guard let self else { return }
                    self.note(text)
                    if name == UIApplication.didEnterBackgroundNotification { self.beginTask() }
                    if name == UIApplication.didBecomeActiveNotification { self.endTask() }
                }
            })
        }
    }

    private func beginTask() {
        guard task == .invalid else { return }
        task = UIApplication.shared.beginBackgroundTask(withName: "poki-probe-hold") { [weak self] in
            Task { @MainActor in self?.note("background task expired"); self?.endTask() }
        }
        note(String(format: "background task begun, %.0fs remaining", UIApplication.shared.backgroundTimeRemaining))
    }

    private func endTask() {
        guard task != .invalid else { return }
        UIApplication.shared.endBackgroundTask(task); task = .invalid
    }

    // Experiments only, not for shipping: keep the app running in the background with an audio or a
    // location background mode, to compare against none.
    private func startExperiment() {
        switch experiment {
        case .none: break
        case .audio:
            do {
                try AVAudioSession.sharedInstance().setCategory(.playback, options: [.mixWithOthers])
                try AVAudioSession.sharedInstance().setActive(true)
                let engine = AVAudioEngine()
                let player = AVAudioPlayerNode()
                engine.attach(player)
                let format = engine.mainMixerNode.outputFormat(forBus: 0)
                engine.connect(player, to: engine.mainMixerNode, format: format)
                let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(format.sampleRate))!
                buffer.frameLength = buffer.frameCapacity
                try engine.start()
                player.scheduleBuffer(buffer, at: nil, options: .loops)
                player.play()
                self.engine = engine
                note("silent audio playing")
            } catch { note("audio: \(error)") }
        case .location:
            let manager = CLLocationManager()
            manager.delegate = self
            manager.desiredAccuracy = kCLLocationAccuracyThreeKilometers
            manager.allowsBackgroundLocationUpdates = true
            manager.pausesLocationUpdatesAutomatically = false
            manager.showsBackgroundLocationIndicator = true
            manager.requestWhenInUseAuthorization()
            manager.startUpdatingLocation()
            location = manager
            note("location updates started")
        }
    }

    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        let status = manager.authorizationStatus.rawValue
        Task { @MainActor in self.note("location authorization: \(status)") }
    }
    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        Task { @MainActor in self.note("location error: \(error)") }
    }
}
