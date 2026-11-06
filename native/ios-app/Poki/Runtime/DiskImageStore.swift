import Foundation
import PokiCore

/// The developer disk image the launcher mounts, kept in the app's container. PokiCore's
/// DeveloperDiskImage downloads it once from the public mirror and checks every file against the
/// SHA-384 digests in its BuildManifest.plist; this tracks the state for the setup screen.
@MainActor
@Observable
final class DiskImageStore {
    enum State: Equatable { case missing, downloading(String), ready(String), failed(String) }
    private(set) var state: State = .missing

    init() {
        if let build = try? DeveloperDiskImage.verify(AppFiles.ddiDirectory) { state = .ready(build) }
    }

    /// Checks the files again (they can be damaged or removed); false starts a fresh download.
    func recheck() -> Bool {
        if let build = try? DeveloperDiskImage.verify(AppFiles.ddiDirectory) { state = .ready(build); return true }
        state = .missing
        Task { await download() }
        return false
    }

    /// The phone would not install the image: delete it and download it again.
    func redownload() {
        if case .downloading = state { return }
        try? FileManager.default.removeItem(at: AppFiles.ddiDirectory)
        state = .missing
        Task { await download() }
    }

    var isReady: Bool { if case .ready = state { return true } else { return false } }

    func download() async {
        if case .downloading = state { return }
        state = .downloading("Starting…")
        do {
            let build = try await DeveloperDiskImage.ensure(in: AppFiles.ddiDirectory) { step in
                Task { @MainActor [weak self] in if case .downloading = self?.state { self?.state = .downloading(step) } }
            }
            state = .ready(build)
        } catch {
            state = .failed("\(error)")
        }
    }
}
