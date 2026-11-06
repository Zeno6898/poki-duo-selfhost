import AVFoundation

/// Keeps the app running in the background while a session is on, so the launcher's connections
/// (and with them the runner) stay up: a silent audio session mixed with whatever else is playing.
/// The Live Activity shows that Poki is running. Background hold measurements in Debug decide whether
/// this is enough.
@MainActor
final class KeepAlive {
    private var engine: AVAudioEngine?
    private var interruption: NSObjectProtocol?

    var isOn: Bool { engine != nil }

    func start() throws {
        guard engine == nil else { return }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, options: [.mixWithOthers])
        try session.setActive(true)
        let engine = AVAudioEngine()
        let player = AVAudioPlayerNode()
        engine.attach(player)
        let format = engine.mainMixerNode.outputFormat(forBus: 0)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(format.sampleRate)) else { return }
        buffer.frameLength = buffer.frameCapacity // zero-filled: silence
        engine.mainMixerNode.outputVolume = 0
        try engine.start()
        player.scheduleBuffer(buffer, at: nil, options: .loops)
        player.play()
        self.engine = engine
        // Another app's audio can interrupt the session; start again when it ends.
        interruption = NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt, AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
            Task { @MainActor in
                guard let self, let engine = self.engine else { return }
                try? AVAudioSession.sharedInstance().setActive(true)
                if !engine.isRunning { try? engine.start(); player.play() }
            }
        }
    }

    func stop() {
        engine?.stop(); engine = nil
        if let interruption { NotificationCenter.default.removeObserver(interruption) }
        interruption = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }
}
