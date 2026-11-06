import ActivityKit
import SwiftUI
import UniformTypeIdentifiers

/// Setup, one page in the order a new user goes: each step says what it is for, checks itself where
/// the phone can tell (loopback, pairing, permissions), and opens the right place. Steps that send
/// the person to Settings put the step and what to tap in the Live Activity, so it stays in view.
struct SetupView: View {
    @Environment(AppModel.self) private var model
    @State private var open: SetupStep?

    var body: some View {
        NavigationStack {
            List {
                Section { progress }
                ForEach(Array(SetupStep.allCases.enumerated()), id: \.element) { index, step in
                    Section {
                        StepHeader(number: index + 1, step: step, done: model.isDone(step), expanded: isOpen(step)) {
                            withAnimation(.snappy) { open = isOpen(step) ? .none : step }
                        }
                        if isOpen(step) { content(step) }
                    }
                }
                Section {
                    Label {
                        Text("The first time Poki Runner starts after the iPhone restarts, iOS asks for your passcode to allow automation. Enter it once; Poki never sees it.")
                    } icon: { Image(systemName: "lock.fill").foregroundStyle(.secondary) }
                    .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .listSectionSpacing(.compact)
            .navigationTitle("Setup")
        }
    }

    /// The first step not done is open unless the person opened another.
    private func isOpen(_ step: SetupStep) -> Bool {
        if let open { return open == step }
        return SetupStep.allCases.first { !model.isDone($0) } == step
    }

    private var progress: some View {
        let done = SetupStep.allCases.filter(model.isDone).count
        let total = SetupStep.allCases.count
        return HStack(spacing: 16) {
            Gauge(value: Double(done), in: 0...Double(total)) {
                EmptyView()
            } currentValueLabel: {
                Text("\(done)/\(total)").font(.caption.monospacedDigit().weight(.semibold))
            }
            .gaugeStyle(.accessoryCircularCapacity).tint(done == total ? .green : Brand.blue)
            VStack(alignment: .leading, spacing: 2) {
                Text(done == total ? "Poki is ready" : "Set up Poki").font(.headline)
                Text(done == total ? "Turn Poki on from the Poki tab." : "About five minutes. Everything happens on this iPhone.")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder private func content(_ step: SetupStep) -> some View {
        switch step {
        case .runner: RunnerContent()
        case .developerMode: DeveloperModeContent()
        case .loopback: LoopbackContent()
        case .pairing: PairingContent()
        case .automation: AutomationContent()
        case .background: BackgroundContent()
        }
    }
}

struct StepHeader: View {
    var number: Int
    var step: SetupStep
    var done: Bool
    var expanded: Bool
    var toggle: () -> Void

    var body: some View {
        Button(action: toggle) {
            HStack(alignment: .center, spacing: 14) {
                ZStack {
                    Circle().fill(done ? Color.green.opacity(0.18) : Brand.blue.opacity(0.14))
                    if done {
                        Image(systemName: "checkmark").font(.subheadline.weight(.bold)).foregroundStyle(.green)
                    } else {
                        Text("\(number)").font(.subheadline.weight(.semibold).monospacedDigit()).foregroundStyle(Brand.blue)
                    }
                }
                .frame(width: 32, height: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(step.title).font(.body.weight(.semibold)).foregroundStyle(.primary)
                    Text(step.summary).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.down").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(expanded ? 0 : -90))
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(step.title), \(done ? "done" : "not done")")
    }
}

/// Numbered instructions, aligned on the number column.
struct Instructions: View {
    var lines: [String]
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(lines.enumerated()), id: \.offset) { i, line in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text("\(i + 1).").font(.subheadline.monospacedDigit()).foregroundStyle(.secondary).frame(width: 20, alignment: .trailing)
                    Text(.init(line)).font(.subheadline).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

/// Opens Settings with the step in the Live Activity.
struct SettingsButton: View {
    @Environment(AppModel.self) private var model
    var step: SetupStep
    var body: some View {
        Button {
            model.guide(step)
            if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        } label: {
            Label("Open Settings", systemImage: "gear")
        }
    }
}

/// A row that marks a step the phone cannot check by itself.
struct ConfirmRow: View {
    var title: String
    @Binding var isOn: Bool
    var body: some View {
        Toggle(title, isOn: $isOn).tint(.green)
    }
}

struct StatusLine: View {
    var text: String
    var symbol: String
    var color: Color
    var body: some View {
        Label { Text(text).font(.subheadline) } icon: { Image(systemName: symbol).foregroundStyle(color) }
    }
}

struct RunnerContent: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        @Bindable var model = model
        Instructions(lines: [
            "Install **Poki Runner** (poki-runner-unsigned.ipa) with the same tool and Apple ID you used for Poki.",
            "Open **Settings > General > VPN & Device Management**, tap your Apple ID and tap **Trust**.",
            "Don't open Poki Runner yourself. Poki starts it when an agent needs the phone.",
        ])
        Text("With a free Apple ID, apps you sign yourself expire after 7 days and only 3 can be installed at a time; Poki and Poki Runner use two. A free Apple ID also can't sign a VPN, so the loopback comes from your proxy app or LocalDevVPN.")
            .font(.footnote).foregroundStyle(.secondary)
        SettingsButton(step: .runner)
        ConfirmRow(title: "Poki Runner is installed and trusted", isOn: $model.setup.runnerInstalled)
    }
}

struct DeveloperModeContent: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        @Bindable var model = model
        Instructions(lines: [
            "Open **Settings > Privacy & Security > Developer Mode**. It shows up once Poki Runner is installed.",
            "Turn it on and tap **Restart**.",
            "After the restart, unlock the iPhone and tap **Turn On**.",
        ])
        SettingsButton(step: .developerMode)
        ConfirmRow(title: "Developer Mode is on", isOn: $model.setup.developerMode)
    }
}

struct AutomationContent: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        @Bindable var model = model
        Instructions(lines: [
            "Open **Settings > Developer**. It appears after Developer Mode is on.",
            "Turn on **Enable UI Automation**.",
        ])
        SettingsButton(step: .automation)
        ConfirmRow(title: "UI Automation is on", isOn: $model.setup.uiAutomation)
    }
}

struct BackgroundContent: View {
    @Environment(AppModel.self) private var model
    var body: some View {
        if model.background.allowed {
            StatusLine(text: "Location allowed. Poki stays on in the background and never records where you are.", symbol: "checkmark.circle.fill", color: .green)
        } else if model.background.denied {
            StatusLine(text: "Location is off for Poki, so iOS stops it soon after you leave the app.", symbol: "exclamationmark.triangle.fill", color: .orange)
            SettingsButton(step: .background)
        } else {
            Text("iOS only keeps an app running in the background for a reason. Poki uses location, at the lowest accuracy, and shows the location pill while it is on.")
                .font(.subheadline).foregroundStyle(.secondary)
            Button("Allow location", systemImage: "location") { model.background.requestPermission() }
        }
        if ActivityStatus.enabled {
            StatusLine(text: "Live Activities are on. Poki shows its steps, pairing codes and approvals on the Lock Screen.", symbol: "checkmark.circle.fill", color: .green)
        } else {
            StatusLine(text: "Live Activities are off for Poki. Turn them on to see what the agent does and to approve sensitive actions.", symbol: "exclamationmark.triangle.fill", color: .orange)
            SettingsButton(step: .background)
        }
    }
}

struct PairingContent: View {
    @Environment(AppModel.self) private var model
    @State private var importing = false
    @State private var importError: String?

    var body: some View {
        switch model.pairing {
        case .pin(let pin)?:
            VStack(spacing: 6) {
                Text(pin.map(String.init).joined(separator: " "))
                    .font(.system(size: 40, weight: .bold, design: .rounded).monospacedDigit())
                    .contentTransition(.numericText())
                Text("Type this code in Settings. It is on the Lock Screen too.").font(.footnote).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity).padding(.vertical, 8)
            Button("Cancel pairing", role: .cancel) { model.cancelPairing() }
        case .advertising?:
            StatusLine(text: "Waiting for Settings. Tap Pair with Poki there.", symbol: "dot.radiowaves.left.and.right", color: Brand.blue)
            Instructions(lines: [
                "Open **Settings > Privacy & Security > Developer Mode**.",
                "Tap **Pair with Poki** and type the code that appears here and on the Lock Screen.",
            ])
            SettingsButton(step: .pairing)
            Button("Cancel pairing", role: .cancel) { model.cancelPairing() }
        case .failed(let why)?:
            StatusLine(text: why, symbol: "exclamationmark.triangle.fill", color: .orange)
            Button("Try again", systemImage: "arrow.clockwise") { model.startPairing() }
        default:
            if model.setup.pairingFile != nil {
                StatusLine(text: "Paired. The key stays on this iPhone.", symbol: "checkmark.seal.fill", color: .green)
            } else {
                Instructions(lines: [
                    "Connect to Wi-Fi and tap **Start pairing**. Allow local network access when asked.",
                    "Poki opens Settings. Go to **Privacy & Security > Developer Mode** and tap **Pair with Poki**.",
                    "Type the code shown here and on the Lock Screen.",
                ])
                Button("Start pairing", systemImage: "link") {
                    model.startPairing()
                    model.guide(.pairing)
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
                .bold()
            }
        }
        diskImage
        Button("Import a pairing file", systemImage: "square.and.arrow.down") { importing = true }
            .font(.subheadline)
            .fileImporter(isPresented: $importing, allowedContentTypes: [.propertyList, .xml, .data]) { result in
                do { try model.importPairingFile(from: result.get()); importError = nil }
                catch { importError = "That is not a pairing file: \(error.localizedDescription)" }
            }
        if let importError { Text(importError).font(.footnote).foregroundStyle(.red) }
    }

    @ViewBuilder private var diskImage: some View {
        switch model.diskImage.state {
        case .ready: StatusLine(text: "Developer disk image ready", symbol: "checkmark.circle.fill", color: .green)
        case .downloading(let step):
            HStack(spacing: 10) { ProgressView(); Text("Downloading the developer disk image: \(step)").font(.subheadline) }
        case .missing:
            Button("Download the developer disk image", systemImage: "arrow.down.circle") { Task { await model.diskImage.download() } }
        case .failed(let why):
            StatusLine(text: "Developer disk image: \(why)", symbol: "exclamationmark.triangle.fill", color: .orange)
            Button("Download again", systemImage: "arrow.clockwise") { Task { await model.diskImage.download() } }
        }
    }
}

/// The loopback, checked live: a connect to 10.7.0.1 every few seconds while this is on screen.
struct LoopbackContent: View {
    @Environment(AppModel.self) private var model
    @State private var copied = false

    var body: some View {
        let monitor = model.loopback
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: monitor.isWorking ? "checkmark.circle.fill" : monitor.state == .checking ? "circle.dotted" : "xmark.circle.fill")
                .foregroundStyle(monitor.isWorking ? .green : monitor.state == .checking ? .secondary : .orange)
            VStack(alignment: .leading, spacing: 2) {
                Text("Loopback: \(monitor.text)").font(.subheadline.weight(.semibold))
                Text(monitor.detail).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            if monitor.state != .checking {
                Image(systemName: "dot.radiowaves.left.and.right").font(.caption).foregroundStyle(.tertiary)
                    .symbolEffect(.pulse, options: .repeating).accessibilityLabel("Checked live")
            }
        }
        .onAppear { monitor.resume() }
        ForEach(ProxyApps.all) { app in proxyRow(app) }
        localDevVPN
    }

    private func proxyRow(_ app: ProxyApp) -> some View {
        let chosen = model.setup.proxyApp == app.id
        return DisclosureGroup {
            Instructions(lines: app.steps)
            switch app.install {
            case .url(let url):
                Button(app.id == "surge" ? "Install the Poki module" : "Install the Poki plugin", systemImage: "plus.circle") {
                    choose(app); UIApplication.shared.open(url)
                }
            case .toggle:
                Button("Open \(app.name)", systemImage: "arrow.up.forward.app") {
                    choose(app); if let url = URL(string: "\(app.scheme)://") { UIApplication.shared.open(url) }
                }
            case .snippet(let line):
                Text(line).font(.footnote.monospaced()).textSelection(.enabled)
                Button(copied ? "Copied" : "Copy the line", systemImage: copied ? "checkmark" : "doc.on.doc") {
                    choose(app); UIPasteboard.general.string = line; copied = true
                }
            }
        } label: {
            HStack {
                Text(app.name)
                if !app.minimumVersion.isEmpty { Text("\(app.minimumVersion) or later").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                if chosen { Text("In use").font(.caption.weight(.semibold)).foregroundStyle(.green) }
                else if app.isInstalled { Text("Installed").font(.caption).foregroundStyle(.secondary) }
            }
        }
    }

    private var localDevVPN: some View {
        DisclosureGroup {
            Instructions(lines: [
                "No proxy app? Install **LocalDevVPN**, a free loopback app made for this.",
                "Open it and tap **Connect**. It uses the VPN slot, so it replaces any other VPN while it is on.",
            ])
            Link(destination: URL(string: "https://apps.apple.com/app/id6755608044")!) {
                Label("Get LocalDevVPN on the App Store", systemImage: "arrow.down.app")
            }
            .simultaneousGesture(TapGesture().onEnded { model.setup.loopback = .proxy; model.setup.proxyApp = "localdevvpn" })
        } label: {
            HStack {
                Text("LocalDevVPN")
                Text("Free, App Store").font(.caption).foregroundStyle(.secondary)
                Spacer()
                if model.setup.proxyApp == "localdevvpn" { Text("In use").font(.caption.weight(.semibold)).foregroundStyle(.green) }
            }
        }
    }

    private func choose(_ app: ProxyApp) {
        model.setup.loopback = .proxy
        model.setup.proxyApp = app.id
        model.guide(.loopback)
    }
}

enum ActivityStatus {
    static var enabled: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }
}
