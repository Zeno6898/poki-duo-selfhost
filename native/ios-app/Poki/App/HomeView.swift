import SwiftUI

/// The Poki tab. Top to bottom: a hero card (on/off, what Poki is doing, the power button, three live
/// status tiles), an approval card when the agent needs the person, the "Now" card while an agent
/// works (current step, elapsed time, the latest screen, Stop), setup progress until setup is done,
/// the agent's recent steps as a timeline, and the runner's settings.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    var openSetup: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    HeroCard(openSetup: openSetup)
                    ForEach(model.approvals, id: \.id) { ApprovalCard(approval: $0) }
                    if model.sessionOn, !model.runnerPaused, model.activityText != "Idle" || !model.recentSteps.isEmpty { NowCard() }
                    if !model.setupComplete { SetupCard(openSetup: openSetup) }
                    ForEach(Issue.current(model)) { IssueCard(issue: $0, openSetup: openSetup) }
                    StepsCard()
                    if model.sessionOn { RunnerCard() }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Poki")
            .navigationBarTitleDisplayMode(.inline)
            .animation(.snappy, value: model.sessionOn)
            .animation(.snappy, value: model.approvals.count)
            .animation(.snappy, value: model.runnerPaused)
        }
    }
}

// MARK: Cards

/// A rounded card on the grouped background, like Settings and Health.
private struct Card<Content: View>: View {
    var padding: CGFloat = 16
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 12) { content }
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemGroupedBackground), in: .rect(cornerRadius: 22, style: .continuous))
    }
}

private struct CardTitle: View {
    var text: String
    var symbol: String
    var tint: Color = .secondary
    var body: some View {
        Label(text, systemImage: symbol).font(.subheadline.weight(.semibold)).foregroundStyle(tint)
    }
}

private struct HeroCard: View {
    @Environment(AppModel.self) private var model
    var openSetup: () -> Void

    var body: some View {
        VStack(spacing: 18) {
            HStack(alignment: .center, spacing: 14) {
                Image("Bear").resizable().scaledToFit().frame(width: 64, height: 64)
                    .clipShape(.rect(cornerRadius: 16, style: .continuous))
                    .shadow(color: .black.opacity(0.2), radius: 8, y: 4)
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.sessionOn ? "Poki is on" : "Poki is off").font(.title2.weight(.bold))
                    Text(subtitle).font(.subheadline).foregroundStyle(.white.opacity(0.85)).lineLimit(2)
                        .contentTransition(.opacity)
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: 8) {
                StatusTile(title: "Agents", value: model.sessionOn ? agentsValue : "Off", symbol: "antenna.radiowaves.left.and.right",
                           health: !model.sessionOn ? .off : model.relayStatus == .ready ? .good : .waiting)
                StatusTile(title: "Runner", value: model.sessionOn ? model.runner.title : "Off", symbol: "hand.tap.fill",
                           health: !model.sessionOn ? .off : model.runner.isRunning ? .good : model.runner.state == "failed" ? .bad : model.runnerPaused ? .off : .waiting)
                StatusTile(title: "Loopback", value: model.loopback.text, symbol: "arrow.triangle.2.circlepath",
                           health: model.loopback.isWorking ? .good : model.loopback.state == .checking ? .waiting : .bad)
            }
            Button {
                if !model.sessionOn && model.setup.pairingFile == nil { openSetup() }
                else { model.sessionOn ? model.stopSession() : model.startSession() }
            } label: {
                Label(model.sessionOn ? "Turn off" : model.setup.pairingFile == nil ? "Set up Poki" : "Turn on",
                      systemImage: model.sessionOn || model.setup.pairingFile != nil ? "power" : "checklist")
                    .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 6)
                    .foregroundStyle(model.sessionOn ? Color.white : Brand.blue)
            }
            .buttonStyle(.borderedProminent).buttonBorderShape(.capsule).controlSize(.large)
            .tint(model.sessionOn ? Color.white.opacity(0.22) : Color.white)
        }
        .foregroundStyle(.white)
        .padding(18)
        .background(
            LinearGradient(colors: model.sessionOn ? [Brand.blue, Color(red: 0.32, green: 0.36, blue: 0.98)] : [Color(red: 0.22, green: 0.26, blue: 0.38), Color(red: 0.12, green: 0.14, blue: 0.24)],
                           startPoint: .topLeading, endPoint: .bottomTrailing),
            in: .rect(cornerRadius: 26, style: .continuous))
        .shadow(color: (model.sessionOn ? Brand.blue : .black).opacity(0.22), radius: 16, y: 8)
        .padding(.top, 4)
    }

    private var agentsValue: String {
        switch model.relayStatus {
        case .ready: "Online"
        case .connecting: "Connecting"
        case .offline: "Offline"
        case .off: "Off"
        }
    }

    private var subtitle: String {
        guard model.sessionOn else { return model.setup.pairingFile == nil ? "Finish setup to turn Poki on." : "Turn on so your agents can use this iPhone." }
        if !model.approvals.isEmpty { return "Waiting for your OK." }
        if model.activityText != "Idle" { return model.activityText }
        return model.runnerPaused ? "Ready. The runner starts when an agent asks." : "Ready for the agent's next step."
    }
}

private struct StatusTile: View {
    enum Health { case good, waiting, bad, off }
    var title: String
    var value: String
    var symbol: String
    var health: Health

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Image(systemName: symbol).font(.caption.weight(.semibold))
                Spacer(minLength: 0)
                Circle().fill(color).frame(width: 8, height: 8)
                    .shadow(color: color.opacity(health == .off ? 0 : 0.8), radius: 3)
            }
            Text(title).font(.caption2.weight(.medium)).foregroundStyle(.white.opacity(0.75))
            Text(value).font(.footnote.weight(.semibold)).lineLimit(1).minimumScaleFactor(0.8)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.white.opacity(0.14), in: .rect(cornerRadius: 14, style: .continuous))
        .accessibilityElement(children: .combine)
    }

    private var color: Color {
        switch health {
        case .good: Color(red: 0.4, green: 0.95, blue: 0.5)
        case .waiting: .yellow
        case .bad: .orange
        case .off: .white.opacity(0.35)
        }
    }
}

private struct ApprovalCard: View {
    @Environment(AppModel.self) private var model
    var approval: PendingApproval

    var body: some View {
        Card {
            CardTitle(text: "Needs your OK", symbol: "hand.raised.fill", tint: .orange)
            VStack(alignment: .leading, spacing: 4) {
                Text(approval.summary).font(.title3.weight(.semibold)).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 4) {
                    Text("In \(approval.app) · expires in")
                    Text(timerInterval: Date()...max(Date(), approval.expires), countsDown: true).monospacedDigit()
                }
                .font(.subheadline).foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
                Button(role: .destructive) { model.resolve(approval, approved: false) } label: { Text("Deny").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered).tint(.red)
                Button { model.resolve(approval, approved: true) } label: { Text("Allow").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).tint(.green)
            }
            .controlSize(.large).buttonBorderShape(.capsule)
        }
        .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(.orange.opacity(0.6), lineWidth: 1.5))
    }
}

/// What the agent is doing now: the current (or last) step, how long it has been working, the latest
/// screen, and Stop.
private struct NowCard: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Card {
            HStack(alignment: .top, spacing: 14) {
                VStack(alignment: .leading, spacing: 8) {
                    CardTitle(text: working ? "Working" : "Last step", symbol: working ? "waveform" : "checkmark.circle", tint: Brand.blue)
                        .symbolEffect(.variableColor.iterative, options: .repeating, isActive: working)
                    Text(current).font(.title3.weight(.semibold)).lineLimit(3).contentTransition(.opacity)
                    if let app = model.recentSteps.last?.detail, !working { Text(app).font(.subheadline).foregroundStyle(.secondary).lineLimit(1) }
                    Spacer(minLength: 0)
                    Button(role: .destructive) { model.pauseRunner() } label: { Label("Stop", systemImage: "stop.fill").padding(.horizontal, 6) }
                        .buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.regular)
                        .disabled(!model.approvals.isEmpty)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                ScreenThumbnail(version: model.recentSteps.count)
            }
        }
    }

    private var working: Bool { model.activityText != "Idle" }
    private var current: String { working ? model.activityText : model.recentSteps.last?.text ?? "Waiting for the agent" }
}

/// The latest screen the agent saw, drawn like a small phone.
private struct ScreenThumbnail: View {
    var version: Int
    var body: some View {
        if let url = SharedContainer.thumbnailURL, let image = UIImage(contentsOfFile: url.path) {
            Image(uiImage: image).resizable().scaledToFill()
                .frame(width: 66, height: 136)
                .clipShape(.rect(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(.separator, lineWidth: 1))
                .id(version)
                .accessibilityLabel("The latest screen")
        }
    }
}

private struct SetupCard: View {
    @Environment(AppModel.self) private var model
    var openSetup: () -> Void

    var body: some View {
        let done = SetupStep.allCases.filter(model.isDone).count
        let total = SetupStep.allCases.count
        Button(action: openSetup) {
            Card {
                HStack(spacing: 14) {
                    Gauge(value: Double(done), in: 0...Double(total)) { Text("Setup") } currentValueLabel: {
                        Text("\(done)/\(total)").font(.caption.weight(.semibold).monospacedDigit())
                    }
                    .gaugeStyle(.accessoryCircularCapacity).tint(Brand.blue)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Finish setup").font(.headline).foregroundStyle(.primary)
                        Text(next.map { "Next: \($0.title)" } ?? "Almost there").font(.subheadline).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                }
            }
        }
        .buttonStyle(.plain)
    }

    private var next: SetupStep? { SetupStep.allCases.first { !model.isDone($0) } }
}

/// Something that keeps agents from using the phone, with the one thing the person has to do.
struct Issue: Identifiable {
    enum Fix { case setup, settings, retry, none }
    var id: String
    var symbol: String
    var title: String
    var text: String
    var fix: Fix

    var button: String? {
        switch fix {
        case .setup: "Open Setup"
        case .settings: "Open Settings"
        case .retry: "Try again"
        case .none: nil
        }
    }

    @MainActor static func current(_ model: AppModel) -> [Issue] {
        var out: [Issue] = []
        if model.sessionOn {
            let runner = model.runner
            if runner.state == "failed" {
                let fix = runner.fix ?? ""
                let kind: Fix = fix.contains("Install Poki Runner") || fix.contains("Pair again") || fix.contains("setup") ? .setup : fix.contains("Developer Mode") ? .settings : .retry
                out.append(Issue(id: "runner", symbol: "hand.tap.fill", title: "The runner stopped",
                                 text: fix.isEmpty ? (runner.detail.map { "\($0.prefix(1).uppercased())\($0.dropFirst())." } ?? "Poki starts it again on the next agent request.") : fix, fix: kind))
            } else if runner.state == "waiting_network", let fix = runner.fix, fix.contains("internet") {
                out.append(Issue(id: "network", symbol: "wifi.exclamationmark", title: "Waiting for the internet", text: fix, fix: .none))
            } else if runner.state == "waiting_network" || !model.loopback.isWorking && model.loopback.state != .checking {
                out.append(Issue(id: "loopback", symbol: "arrow.triangle.2.circlepath", title: "Loopback is off",
                                 text: model.loopback.detail, fix: .setup))
            }
            if case .offline = model.relayStatus {
                out.append(Issue(id: "relay", symbol: "wifi.exclamationmark", title: "Agents can't reach this iPhone",
                                 text: "Poki is offline. Check that the phone has internet; Poki reconnects by itself.", fix: .none))
            }
            if model.background.denied {
                out.append(Issue(id: "location", symbol: "location.slash.fill", title: "Poki can't stay on in the background",
                                 text: "Allow location access for Poki (Settings > Poki > Location > Always). Poki uses it only to keep running; it never records where you are.", fix: .settings))
            }
        }
        if let problem = model.problem {
            out.append(Issue(id: "problem", symbol: "exclamationmark.triangle.fill", title: "Needs attention", text: problem, fix: problem.contains("Pair") || problem.contains("disk image") ? .setup : .none))
        }
        if let problem = model.activityProblem {
            out.append(Issue(id: "activity", symbol: "rectangle.badge.xmark", title: "Live Activity is off", text: problem, fix: .settings))
        }
        return out
    }
}

private struct IssueCard: View {
    @Environment(AppModel.self) private var model
    var issue: Issue
    var openSetup: () -> Void

    var body: some View {
        Card {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: issue.symbol).font(.body.weight(.semibold)).foregroundStyle(.orange)
                    .frame(width: 34, height: 34).background(.orange.opacity(0.14), in: .circle)
                VStack(alignment: .leading, spacing: 4) {
                    Text(issue.title).font(.headline)
                    Text(issue.text).font(.subheadline).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    if let button = issue.button {
                        Button(button) { act() }
                            .buttonStyle(.bordered).buttonBorderShape(.capsule).controlSize(.small).tint(.orange)
                            .padding(.top, 4)
                    }
                }
                Spacer(minLength: 0)
            }
        }
    }

    private func act() {
        switch issue.fix {
        case .setup: openSetup()
        case .settings: if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
        case .retry: model.runnerPaused ? model.wakeRunner() : model.restartRunner()
        case .none: break
        }
    }
}

/// The agent's recent steps as a timeline, newest first, each with an icon for the kind of action.
private struct StepsCard: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Card {
            CardTitle(text: "Recent steps", symbol: "clock.arrow.circlepath")
            if model.recentSteps.isEmpty {
                Text("Steps from your agent show up here and on the Lock Screen.")
                    .font(.subheadline).foregroundStyle(.secondary)
            } else {
                let steps = Array(model.recentSteps.suffix(8).reversed())
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(steps.enumerated()), id: \.element.id) { i, step in
                        HStack(alignment: .top, spacing: 12) {
                            VStack(spacing: 0) {
                                Image(systemName: Self.symbol(for: step.text))
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(step.ok ? Brand.blue : .orange)
                                    .frame(width: 30, height: 30)
                                    .background((step.ok ? Brand.blue : Color.orange).opacity(0.12), in: .circle)
                                if i < steps.count - 1 { Rectangle().fill(.separator).frame(width: 1.5).frame(maxHeight: .infinity) }
                            }
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(alignment: .firstTextBaseline) {
                                    Text(step.text).font(.subheadline.weight(.medium)).lineLimit(2)
                                    Spacer(minLength: 8)
                                    Text(step.at, style: .time).font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
                                }
                                Text(step.detail).font(.caption).foregroundStyle(step.ok ? Color.secondary : Color.orange).lineLimit(1)
                            }
                            .padding(.bottom, i < steps.count - 1 ? 14 : 0)
                        }
                    }
                }
            }
        }
    }

    static func symbol(for text: String) -> String {
        let verb = text.split(separator: " ").first.map(String.init) ?? ""
        switch verb {
        case "Tap": return "hand.tap.fill"
        case "Press": return text.hasSuffix("button") ? "button.horizontal.top.press.fill" : "keyboard"
        case "Type": return "character.cursor.ibeam"
        case "Swipe", "Scroll": return "hand.draw.fill"
        case "Drag": return "hand.point.up.left.and.text.fill"
        case "Zoom": return "arrow.up.left.and.arrow.down.right"
        case "Open": return "app.badge"
        case "Look": return "eye.fill"
        case "Wait": return "hourglass"
        default: return "sparkles"
        }
    }
}

private struct RunnerCard: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        Card {
            CardTitle(text: "Runner", symbol: "hand.tap")
            HStack {
                if model.runnerPaused {
                    Button("Start now", systemImage: "play.fill") { model.wakeRunner() }
                } else {
                    Button("Stop runner", systemImage: "stop.fill", role: .destructive) { model.pauseRunner() }
                        .disabled(!model.approvals.isEmpty)
                }
                Spacer()
            }
            .buttonStyle(.bordered).buttonBorderShape(.capsule)
            Divider()
            LabeledContent("Stop when idle for") {
                Picker("Stop when idle for", selection: $model.idleStopSeconds) {
                    Text("30 seconds").tag(30)
                    Text("1 minute").tag(60)
                    Text("2 minutes").tag(120)
                    Text("5 minutes").tag(300)
                    Text("Never").tag(0)
                }
                .pickerStyle(.menu).labelsHidden()
            }
            Text("iOS shows its automation banner only while the runner is on. Poki starts it when an agent asks and stops it when the agent goes quiet. Don't close Poki Runner while an agent works.")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }
}
