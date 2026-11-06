import CryptoKit
import Foundation
import ImageIO
import PokiCore
import UniformTypeIdentifiers

/// PokiCore, linked: the on-phone MCP server behind the relay. This maps its events onto the shell's,
/// and answers its host questions (signing key, connector hashes, JPEG encoding, the runner's state).
final class LiveCore: CoreSession {
    private let host: AppCoreHost
    private let core: PokiCore
    let events: AsyncStream<ShellEvent>
    private let continuation: AsyncStream<ShellEvent>.Continuation
    private var pump: Task<Void, Never>?

    init(host: AppCoreHost) {
        self.host = host
        core = PokiCore(config: CoreConfig(), host: host)
        (events, continuation) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(64))
        let continuation = self.continuation
        pump = Task { [core] in
            for await event in core.events { continuation.yield(Self.map(event)) }
        }
    }

    deinit { pump?.cancel() }

    func start() { core.start() }
    func stop() { core.stop(); continuation.yield(.relay(.off)) }
    func resolveApproval(id: String, approved: Bool) { core.resolveApproval(id: id, approved: approved) }
    func accessChanged() { core.accessChanged() }

    private static func map(_ event: CoreEvent) -> ShellEvent {
        switch event {
        case .relay(.connecting): return .relay(.connecting)
        case .relay(.ready): return .relay(.ready)
        case .relay(.offline(let why)): return .relay(.offline(why))
        case .toolStarted(let activity): return .toolStarted(name: activity.name, summary: activity.summary)
        case .toolFinished(let activity, let outcome, let facts):
            let delivery: String
            switch outcome { case .done(let text): delivery = text; case .failed(let text): delivery = "failed: \(text)" }
            return .toolFinished(summary: activity.summary, delivery: delivery, app: facts.app, thumbnail: facts.thumbnail)
        case .approvalRequested(let approval):
            return .approvalRequested(PendingApproval(id: approval.id, app: approval.app, summary: approval.summary, expires: approval.expires))
        case .approvalEnded(let id, let approved): return .approvalEnded(id: id, approved: approved)
        }
    }
}

/// The relay key PokiCore signs with: the app's Ed25519 key from the keychain.
struct DeviceKey: RelayKey {
    let key: Curve25519.Signing.PrivateKey
    var publicKey: Data { key.publicKey.rawRepresentation }
    func sign(_ message: Data) throws -> Data { try key.signature(for: message) }
}

/// PokiCore's host. PokiCore holds it weakly, so AppModel keeps it. Thread-safe: PokiCore calls it from
/// its own tasks.
final class AppCoreHost: CoreHost, @unchecked Sendable {
    private let lock = NSLock()
    private var key: Curve25519.Signing.PrivateKey?
    private var hashes: [String] = []
    private var runner: RunnerState = .starting("not started")
    private var restart: (@Sendable () -> Void)?

    func update(key: Curve25519.Signing.PrivateKey?, hashes: [String]) { lock.withLock { self.key = key; self.hashes = hashes } }
    func update(runner: RunnerState) { lock.withLock { self.runner = runner } }
    func onRestart(_ action: @escaping @Sendable () -> Void) { lock.withLock { restart = action } }

    func signingKey() throws -> RelayKey {
        guard let key = lock.withLock({ self.key }) else { throw NSError(domain: "Poki", code: 1, userInfo: [NSLocalizedDescriptionKey: "no relay key in the keychain"]) }
        return DeviceKey(key: key)
    }
    func accessHashes() -> [String] { lock.withLock { hashes } }
    func runnerState() -> RunnerState { lock.withLock { runner } }
    func restartRunner() { lock.withLock { restart }?() }

    func jpeg(fromPNG png: Data, width: Int, quality: Double) throws -> Data {
        guard let source = CGImageSourceCreateWithData(png as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: Self.maxSide(source, width: width)] as CFDictionary) else {
            throw NSError(domain: "Poki", code: 2, userInfo: [NSLocalizedDescriptionKey: "the screenshot is not an image"])
        }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { throw NSError(domain: "Poki", code: 3) }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw NSError(domain: "Poki", code: 4) }
        return out as Data
    }

    /// The thumbnail size limit is the longer side; a portrait screenshot `width` wide has a longer
    /// height, so the limit is the height that width gives.
    private static func maxSide(_ source: CGImageSource, width: Int) -> Int {
        guard let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let w = props[kCGImagePropertyPixelWidth] as? Double, let h = props[kCGImagePropertyPixelHeight] as? Double, w > 0 else { return width }
        return Int((Double(width) * max(w, h) / w).rounded())
    }
}

extension RunnerStatus {
    /// The launcher's state as PokiCore's RunnerState.
    var coreState: RunnerState {
        switch state {
        case "running": return .running
        case "failed": return .failed(detail ?? "the runner stopped", fix: fix)
        default: return .starting(title)
        }
    }
}
