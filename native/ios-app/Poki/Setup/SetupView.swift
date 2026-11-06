import SwiftUI
import UniformTypeIdentifiers

/// Setup, in the order a new user does it. Each step can be revisited; nothing here needs a computer.
struct SetupView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        NavigationStack {
            List {
                Section {
                    step(1, "Turn on Developer Mode", done: model.setup.developerMode) { DeveloperModeStep() }
                    step(2, "Pair this iPhone with Poki", done: model.setup.pairingFile != nil) { PairingStep() }
                    step(3, "Allow UI Automation", done: model.setup.uiAutomation) { UIAutomationStep() }
                    step(4, "Set up the loopback", done: model.setup.loopbackChosen) { LoopbackStep() }
                    step(5, "First session: enter your passcode", done: model.setup.passcodeNoted) { PasscodeStep() }
                } footer: {
                    Text("Poki controls this iPhone through Apple's own developer services, on the phone itself. Your pairing file and keys never leave it.")
                }
            }
            .navigationTitle("Setup")
        }
    }

    private func step<Destination: View>(_ number: Int, _ title: String, done: Bool, @ViewBuilder destination: @escaping () -> Destination) -> some View {
        NavigationLink(destination: destination) {
            HStack(spacing: 14) {
                Image(systemName: done ? "checkmark.circle.fill" : "\(number).circle")
                    .font(.title2).foregroundStyle(done ? .green : Brand.blue)
                Text(title)
            }
        }
    }
}

/// Shared layout for a step: a short explanation, numbered instructions, and the actions.
struct StepPage<Actions: View>: View {
    var title: String
    var symbol: String
    var intro: String
    var steps: [String]
    @ViewBuilder var actions: Actions

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Image(systemName: symbol).font(.system(size: 44)).foregroundStyle(Brand.blue)
                    .frame(width: 88, height: 88).glassEffect(.regular.tint(Brand.blue.opacity(0.2)), in: .circle)
                    .frame(maxWidth: .infinity)
                Text(intro).font(.body)
                if !steps.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(steps.enumerated()), id: \.offset) { i, text in
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Text("\(i + 1)").font(.headline.monospacedDigit()).frame(width: 24)
                            Text(.init(text))
                        }
                    }
                }
                .padding().frame(maxWidth: .infinity, alignment: .leading)
                .glassEffect(.regular, in: .rect(cornerRadius: 20))
                }
                actions
            }
            .padding()
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
    }
}

struct DeveloperModeStep: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        StepPage(title: "Developer Mode", symbol: "hammer.fill",
                 intro: "Developer Mode lets the phone run Poki's runner, the part that taps and types for your agent.",
                 steps: ["Open **Settings > Privacy & Security > Developer Mode**.",
                         "Turn **Developer Mode** on and tap **Restart**.",
                         "After the restart, unlock the phone and tap **Turn On** when asked.",
                         "If Developer Mode is not listed, install the Poki Runner app first (it makes the option appear), then come back."]) {
            Button("Open Settings", systemImage: "gear") { open(UIApplication.openSettingsURLString) }.buttonStyle(.glass)
            DoneToggle(title: "Developer Mode is on", isOn: Binding(get: { model.setup.developerMode }, set: { model.setup.developerMode = $0 }))
        }
    }
}

struct PairingStep: View {
    @Environment(AppModel.self) private var model
    @State private var importing = false
    @State private var importError: String?

    var body: some View {
        StepPage(title: "Pair", symbol: "link",
                 intro: "Pairing gives Poki a key to this phone's developer services. It is made on the phone, kept on the phone, and works without a computer (iOS 27 or later).",
                 steps: ["Tap **Start pairing** below and allow Local Network access.",
                         "Open **Settings > Privacy & Security > Developer Mode**, scroll down, and tap **Pair with Poki**.",
                         "Enter the PIN shown in Poki's Live Activity at the top of the screen.",
                         "Come back to Poki. The step is ticked once the pairing is saved."]) {
            pairingStatus
            diskImageStatus
            HStack {
                Button("Start pairing", systemImage: "dot.radiowaves.left.and.right") { model.startPairing() }.buttonStyle(.glassProminent)
                if model.pairing != nil { Button("Cancel") { model.cancelPairing() }.buttonStyle(.glass) }
            }
            Divider()
            Text("Already have a pairing file (from StikDebug, SideStore or a Mac)?").font(.footnote).foregroundStyle(.secondary)
            Button("Import a pairing file", systemImage: "square.and.arrow.down") { importing = true }.buttonStyle(.glass)
            if let importError { Text(importError).font(.footnote).foregroundStyle(.red) }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.propertyList, .xml, .data]) { result in
            do { try model.importPairingFile(from: result.get()); importError = nil }
            catch { importError = "That file is not a pairing file: \(error.localizedDescription)" }
        }
    }

    @ViewBuilder private var diskImageStatus: some View {
        switch model.diskImage.state {
        case .ready(let build): Label("Developer disk image ready (\(build))", systemImage: "checkmark.circle").font(.footnote).foregroundStyle(.secondary)
        case .downloading(let step): ProgressView { Text("Developer disk image: \(step)").font(.footnote) }
        case .missing: Button("Download the developer disk image", systemImage: "arrow.down.circle") { Task { await model.diskImage.download() } }.buttonStyle(.glass)
        case .failed(let why):
            VStack(alignment: .leading) {
                Label("Developer disk image: \(why)", systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.orange)
                Button("Try again") { Task { await model.diskImage.download() } }.buttonStyle(.glass)
            }
        }
    }

    @ViewBuilder private var pairingStatus: some View {
        switch model.pairing {
        case .none:
            if model.setup.pairingFile != nil { Label("Paired", systemImage: "checkmark.seal.fill").foregroundStyle(.green) }
        case .advertising?: Label("Waiting for Settings: tap Pair with Poki", systemImage: "hourglass")
        case .pin(let pin)?: Text(pin).font(.system(size: 44, weight: .bold, design: .rounded).monospacedDigit()).frame(maxWidth: .infinity)
        case .paired?: Label("Paired", systemImage: "checkmark.seal.fill").foregroundStyle(.green)
        case .failed(let why)?: Label(why, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange)
        }
    }
}

struct UIAutomationStep: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        StepPage(title: "UI Automation", symbol: "hand.tap.fill",
                 intro: "UI Automation lets the runner tap, swipe and type in other apps. It appears once Developer Mode is on.",
                 steps: ["Open **Settings > Developer**.",
                         "Turn on **Enable UI Automation**.",
                         "If **Developer** is missing from Settings, finish Developer Mode and pairing first, then start a session once."]) {
            Button("Open Settings", systemImage: "gear") { open(UIApplication.openSettingsURLString) }.buttonStyle(.glass)
            DoneToggle(title: "UI Automation is on", isOn: Binding(get: { model.setup.uiAutomation }, set: { model.setup.uiAutomation = $0 }))
        }
    }
}

struct PasscodeStep: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        StepPage(title: "First session", symbol: "lock.open.fill",
                 intro: "The first time the runner starts after setup (and after each restart of the phone), iOS asks for your passcode to allow automation. Poki cannot enter it for you, by design.",
                 steps: ["Keep the phone unlocked and in hand when you tap **Start** for the first time.",
                         "When iOS asks for the passcode, enter it.",
                         "After that, sessions start without asking until the phone restarts."]) {
            DoneToggle(title: "Got it", isOn: Binding(get: { model.setup.passcodeNoted }, set: { model.setup.passcodeNoted = $0 }))
        }
    }
}

struct DoneToggle: View {
    var title: String
    @Binding var isOn: Bool
    var body: some View {
        Toggle(title, isOn: $isOn).padding().glassEffect(.regular, in: .rect(cornerRadius: 16))
    }
}

@MainActor func open(_ string: String) {
    if let url = URL(string: string) { UIApplication.shared.open(url) }
}
