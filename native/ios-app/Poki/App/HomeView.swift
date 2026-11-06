import SwiftUI

/// The Poki tab: whether Poki is on, what it is doing, and the controls an owner needs: on/off, stop
/// the runner, approvals, and the agent's recent steps.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    var openSetup: () -> Void

    var body: some View {
        NavigationStack {
            List {
                Section { header }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets())
                if !model.setupComplete {
                    Section {
                        Button(action: openSetup) {
                            HStack(spacing: 14) {
                                Image(systemName: "checklist").font(.title3).foregroundStyle(Brand.blue).frame(width: 28)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("Finish setup").font(.body.weight(.semibold)).foregroundStyle(.primary)
                                    Text("\(SetupStep.allCases.filter { !model.isDone($0) }.count) steps left before agents can use this iPhone.")
                                        .font(.subheadline).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
                if !model.approvals.isEmpty { approvals }
                Section("Status") {
                    StatusRow(title: "Agents", value: model.sessionOn ? model.relayStatus.text : "Off", symbol: "antenna.radiowaves.left.and.right",
                              state: !model.sessionOn ? .off : model.relayStatus == .ready ? .good : .waiting)
                    StatusRow(title: "Runner", value: model.sessionOn ? model.runner.title : "Off", symbol: "hand.tap",
                              state: !model.sessionOn ? .off : model.runner.isRunning ? .good : model.runner.state == "failed" ? .bad : .waiting,
                              detail: model.sessionOn ? (model.runner.fix ?? model.runner.detail) : nil)
                    StatusRow(title: "Loopback", value: model.loopback.text, symbol: "arrow.triangle.2.circlepath",
                              state: model.loopback.isWorking ? .good : model.loopback.state == .checking ? .waiting : .bad,
                              detail: model.loopback.isWorking ? nil : model.loopback.detail)
                }
                if model.sessionOn { runnerSection }
                stepsSection
                if let problem = model.problem ?? model.activityProblem {
                    Section { Label(problem, systemImage: "exclamationmark.triangle.fill").foregroundStyle(.orange).font(.subheadline) }
                }
            }
            .navigationTitle("Poki")
            .navigationBarTitleDisplayMode(.inline)
            .safeAreaInset(edge: .bottom) { powerButton.padding(.horizontal).padding(.bottom, 8) }
        }
    }

    private var header: some View {
        VStack(spacing: 10) {
            Image("Bear").resizable().scaledToFit().frame(width: 96, height: 96)
                .clipShape(.rect(cornerRadius: 22, style: .continuous))
                .shadow(color: Brand.blue.opacity(0.25), radius: 14, y: 6)
            Text(model.sessionOn ? "Poki is on" : "Poki is off").font(.title2.weight(.bold))
            Text(subtitle).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
    }

    private var subtitle: String {
        guard model.sessionOn else { return "Turn Poki on so your agents can use this iPhone." }
        if model.activityText != "Idle" { return model.activityText }
        return model.runnerPaused ? "Waiting for an agent. The runner starts when one asks." : "Ready for the agent."
    }

    private var approvals: some View {
        Section {
            ForEach(model.approvals, id: \.id) { approval in
                VStack(alignment: .leading, spacing: 10) {
                    Text(approval.summary).font(.body.weight(.semibold))
                    Text("\(approval.app) · expires \(approval.expires, style: .relative)").font(.footnote).foregroundStyle(.secondary)
                    HStack(spacing: 12) {
                        Button(role: .destructive) { model.resolve(approval, approved: false) } label: { Text("Deny").frame(maxWidth: .infinity) }
                            .buttonStyle(.bordered)
                        Button { model.resolve(approval, approved: true) } label: { Text("Approve").frame(maxWidth: .infinity) }
                            .buttonStyle(.borderedProminent).tint(.green)
                    }
                    .controlSize(.large)
                }
                .padding(.vertical, 4)
            }
        } header: {
            Label("Needs your approval", systemImage: "hand.raised.fill").foregroundStyle(.orange)
        }
    }

    private var runnerSection: some View {
        @Bindable var model = model
        return Section {
            if model.runnerPaused {
                Button("Start the runner now", systemImage: "play.circle") { model.wakeRunner() }
            } else {
                Button("Stop the runner", systemImage: "stop.circle") { model.pauseRunner() }
                    .disabled(!model.approvals.isEmpty)
            }
            Picker("Stop when idle for", selection: $model.idleStopSeconds) {
                Text("30 seconds").tag(30)
                Text("1 minute").tag(60)
                Text("2 minutes").tag(120)
                Text("5 minutes").tag(300)
                Text("Never").tag(0)
            }
        } header: {
            Text("Runner")
        } footer: {
            Text("iOS shows the automation banner only while the runner is on. Poki starts it when an agent asks and stops it when the agent goes quiet.")
        }
    }

    private var stepsSection: some View {
        Section("Recent steps") {
            if model.recentSteps.isEmpty {
                Text("Nothing yet. Steps from your agent show up here and on the Lock Screen.").font(.subheadline).foregroundStyle(.secondary)
            } else {
                ForEach(model.recentSteps.suffix(8).reversed()) { step in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Image(systemName: step.ok ? "checkmark.circle.fill" : "xmark.circle.fill").foregroundStyle(step.ok ? .green : .orange)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(step.text).font(.subheadline).lineLimit(2)
                            Text(step.detail).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer(minLength: 8)
                        Text(step.at, style: .time).font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
                    }
                }
            }
        }
    }

    private var powerButton: some View {
        Button {
            model.sessionOn ? model.stopSession() : model.startSession()
        } label: {
            Label(model.sessionOn ? "Turn off" : "Turn on", systemImage: "power")
                .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 6)
        }
        .buttonStyle(.glassProminent).controlSize(.large)
        .tint(model.sessionOn ? .red : Brand.blue)
        .disabled(!model.sessionOn && model.setup.pairingFile == nil)
    }
}

struct StatusRow: View {
    enum Health { case good, waiting, bad, off }
    var title: String
    var value: String
    var symbol: String
    var state: Health
    var detail: String? = nil

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Image(systemName: symbol).foregroundStyle(Brand.blue).frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(title)
                    Spacer()
                    Text(value).foregroundStyle(.secondary).lineLimit(1)
                    Circle().fill(color).frame(width: 8, height: 8)
                }
                if let detail, !detail.isEmpty { Text(detail).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
            }
        }
    }

    private var color: Color {
        switch state {
        case .good: .green
        case .waiting: .yellow
        case .bad: .orange
        case .off: Color.secondary.opacity(0.4)
        }
    }
}
