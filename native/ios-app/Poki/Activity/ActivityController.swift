import ActivityKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Runs the one Live Activity: started when a session starts, updated from PokiCore's events, ended
/// when the session stops. It shows what the agent is doing, the last action, a small screenshot,
/// pairing PINs, and Approve/Deny for sensitive actions.
@MainActor
final class ActivityController {
    private var activity: Activity<PokiActivityAttributes>?
    private(set) var state = PokiActivityAttributes.ContentState(phase: .idle, headline: "Ready", thumbnailVersion: 0)
    private(set) var lastError: String?

    var enabled: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    func start(deviceName: String) {
        guard activity == nil, enabled else { return }
        // A Live Activity left from an earlier run of the app is replaced.
        for old in Activity<PokiActivityAttributes>.activities { Task { await old.end(nil, dismissalPolicy: .immediate) } }
        do {
            activity = try Activity.request(attributes: PokiActivityAttributes(deviceName: deviceName), content: content(), pushType: nil)
        } catch { lastError = "\(error)" }
    }

    func end() {
        guard let activity else { return }
        self.activity = nil
        Task { await activity.end(nil, dismissalPolicy: .immediate) }
    }

    func update(_ change: (inout PokiActivityAttributes.ContentState) -> Void) {
        change(&state)
        guard let activity else { return }
        let content = content()
        Task { await activity.update(content) }
    }

    /// Writes a thumbnail, at most about 160 points wide, to the App Group container for the widget.
    func setThumbnail(_ jpeg: Data?) {
        guard let jpeg, let url = SharedContainer.thumbnailURL, let small = Self.shrink(jpeg, maxPixels: 240) else { return }
        try? small.write(to: url, options: .atomic)
        update { $0.thumbnailVersion += 1 }
    }

    private func content() -> ActivityContent<PokiActivityAttributes.ContentState> {
        // Approvals are urgent; everything else is not, so iOS does not light up the screen for it.
        ActivityContent(state: state, staleDate: nil, relevanceScore: state.approval == nil ? 50 : 100)
    }

    private static func shrink(_ data: Data, maxPixels: Int) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: maxPixels] as CFDictionary) else { return nil }
        let out = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.6] as CFDictionary)
        return CGImageDestinationFinalize(destination) ? out as Data : nil
    }
}
