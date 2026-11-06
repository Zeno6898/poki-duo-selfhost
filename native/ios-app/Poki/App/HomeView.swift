import SwiftUI

struct HomeView: View {
    @Environment(AppModel.self) private var model
    var openSetup: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    header
                    if !model.setup.isComplete { setupCard }
                    GlassEffectContainer(spacing: 16) {
                        VStack(spacing: 12) {
                            StatusRow(title: "Runner", value: model.runner.title, symbol: "cpu", good: model.runner.isRunning, detail: model.runner.fix ?? model.runner.detail)
                            StatusRow(title: "Relay", value: model.relayStatus.text, symbol: "antenna.radiowaves.left.and.right", good: model.relayStatus == .ready, detail: nil)
                            StatusRow(title: "Loopback", value: loopbackText, symbol: "arrow.triangle.2.circlepath", good: loopbackGood, detail: nil)
                        }
                    }
                    if !model.approvals.isEmpty { approvalsCard }
                    activityCard
                    if let problem = model.problem {
                        Text(problem).font(.callout).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading)
                            .padding().glassEffect(.regular.tint(.red.opacity(0.15)), in: .rect(cornerRadius: 20))
                    }
                }
                .padding()
            }
            .navigationTitle("Poki")
            .safeAreaInset(edge: .bottom) { sessionButton.padding() }
        }
    }

    private var header: some View {
        VStack(spacing: 8) {
            Image("Bear").resizable().scaledToFit().frame(width: 112, height: 112)
                .clipShape(.rect(cornerRadius: 26, style: .continuous))
                .shadow(color: Brand.blue.opacity(0.3), radius: 16, y: 6)
            Text(model.sessionOn ? model.activityText : "Your iPhone, for your agents")
                .font(.headline).foregroundStyle(.secondary)
        }
        .padding(.top, 8)
    }

    private var setupCard: some View {
        Button(action: openSetup) {
            Label("Finish setup to let agents use this iPhone", systemImage: "arrow.right.circle.fill")
                .frame(maxWidth: .infinity, alignment: .leading).padding()
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.tint(Brand.blue.opacity(0.2)).interactive(), in: .rect(cornerRadius: 20))
    }

    private var approvalsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Waiting for your approval", systemImage: "hand.raised.fill").font(.headline)
            ForEach(model.approvals, id: \.id) { approval in
                VStack(alignment: .leading, spacing: 8) {
                    Text(approval.summary).font(.body)
                    Text("\(approval.app) · expires \(approval.expires, style: .relative)").font(.caption).foregroundStyle(.secondary)
                    HStack {
                        Button("Deny", role: .destructive) { model.resolve(approval, approved: false) }.buttonStyle(.glass)
                        Button("Approve") { model.resolve(approval, approved: true) }.buttonStyle(.glassProminent)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding()
        .glassEffect(.regular.tint(.orange.opacity(0.2)), in: .rect(cornerRadius: 20))
    }

    private var activityCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Last action").font(.caption).foregroundStyle(.secondary)
            Text(model.lastAction ?? "Nothing yet").font(.body.monospaced())
        }
        .frame(maxWidth: .infinity, alignment: .leading).padding()
        .glassEffect(.regular, in: .rect(cornerRadius: 20))
    }

    private var sessionButton: some View {
        Button {
            model.sessionOn ? model.stopSession() : model.startSession()
        } label: {
            Label(model.sessionOn ? "Stop" : "Start", systemImage: model.sessionOn ? "stop.fill" : "play.fill")
                .font(.headline).frame(maxWidth: .infinity).padding(.vertical, 6)
        }
        .buttonStyle(.glassProminent).controlSize(.large)
        .tint(model.sessionOn ? .red : Brand.blue)
    }

    private var loopbackText: String {
        switch model.setup.loopback {
        case .none: "Not chosen"
        case .builtIn: "Built-in: \(model.tunnel.statusText)"
        case .proxy: ProxyApps.all.first { $0.id == model.setup.proxyApp }?.name ?? "Proxy app"
        }
    }
    private var loopbackGood: Bool { model.setup.loopback == .builtIn ? model.tunnel.isConnected : model.setup.loopback == .proxy }
}

struct StatusRow: View {
    var title: String
    var value: String
    var symbol: String
    var good: Bool
    var detail: String?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol).font(.title3).frame(width: 28).foregroundStyle(good ? Brand.blue : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.caption).foregroundStyle(.secondary)
                Text(value).font(.body)
                if let detail, !detail.isEmpty { Text(detail).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer()
            Circle().fill(good ? Color.green : Color.secondary.opacity(0.4)).frame(width: 10, height: 10).padding(.top, 6)
        }
        .padding()
        .glassEffect(.regular, in: .rect(cornerRadius: 20))
    }
}
