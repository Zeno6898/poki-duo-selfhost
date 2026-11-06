import SwiftUI

/// The Live Activity's Lock Screen layout in each phase, drawn with the widget's own views, so it can
/// be checked without a session.
struct ActivityPreview: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                ForEach(Self.samples, id: \.0) { name, state in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(name).font(.footnote.weight(.semibold)).foregroundStyle(.secondary).textCase(.uppercase)
                        LockScreenView(state: state)
                            .padding(16)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color(white: 0.12), in: .rect(cornerRadius: 24, style: .continuous))
                            .environment(\.colorScheme, .dark)
                    }
                }
            }
            .padding()
        }
        .navigationTitle("Live Activity")
        .navigationBarTitleDisplayMode(.inline)
    }

    static let samples: [(String, PokiState)] = {
        var working = PokiState(phase: .working, headline: "tap 'Like', swipe up", thumbnailVersion: 0)
        working.app = "X"
        working.steps = [.init(text: "launch com.atebits.Tweetie2", ok: true), .init(text: "tap 'Replies'", ok: true), .init(text: "tap [212, 640]", ok: false)]
        var standing = PokiState(phase: .idle, headline: "On. Waiting for an agent", thumbnailVersion: 0)
        standing.runnerPaused = true
        var pairing = PokiState(phase: .pairing, headline: "Pairing code", thumbnailVersion: 0)
        pairing.pin = "482913"
        var setup = PokiState(phase: .setup, headline: "Setting up Poki", thumbnailVersion: 0)
        setup.guide = .init(number: 2, count: 6, title: SetupStep.developerMode.title, hint: SetupStep.developerMode.hint)
        var approval = PokiState(phase: .approval, headline: "Approve: send message", thumbnailVersion: 0)
        approval.approval = PendingApproval(id: "a", app: "Messages", summary: "type 'On my way' and tap Send", expires: Date().addingTimeInterval(90))
        return [("Working", working), ("Standing by", standing), ("Pairing", pairing), ("Setup", setup), ("Approval", approval)]
    }()
}
