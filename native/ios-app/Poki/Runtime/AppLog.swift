import Foundation

/// What Poki did and why, for the Debug tab's Copy log: runner starts, stops and restarts (with the
/// reason), agent steps, approvals, relay and Live Activity changes. Kept in memory (the last 600
/// lines) and in a file in Caches so a log survives Poki being closed. Never holds typed text or
/// keys: steps are logged with their plain labels, which hide what is typed into password fields.
@MainActor
@Observable
final class AppLog {
    static let shared = AppLog()

    private(set) var lines: [String] = []
    private let limit = 600
    private let file: URL? = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.appendingPathComponent("poki-log.txt")
    private let stamp: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "HH:mm:ss.SSS"
        return f
    }()

    private init() {
        if let file, let text = try? String(contentsOf: file, encoding: .utf8) {
            lines = Array(text.split(separator: "\n").map(String.init).suffix(limit))
        }
        add("app", "Poki started (\(Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?") build \(Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"))")
    }

    func add(_ area: String, _ message: String) {
        let line = "\(stamp.string(from: Date())) [\(area)] \(message)"
        lines.append(line)
        if lines.count > limit { lines.removeFirst(lines.count - limit) }
        save()
    }

    func clear() {
        lines = []
        save()
    }

    /// The whole log as text, with a header that says which phone and system it came from.
    var text: String {
        let info = ProcessInfo.processInfo
        let header = "Poki log, \(ISO8601DateFormatter().string(from: Date())), iOS \(info.operatingSystemVersionString)"
        return ([header] + lines).joined(separator: "\n")
    }

    private var pending = false
    private func save() {
        guard !pending else { return }
        pending = true
        // Written at most once a second, off the main thread.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self else { return }
            self.pending = false
            let text = self.lines.joined(separator: "\n")
            guard let file = self.file else { return }
            DispatchQueue.global(qos: .utility).async { try? text.write(to: file, atomically: true, encoding: .utf8) }
        }
    }
}
