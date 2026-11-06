import SwiftUI

/// The loopback: connections from Poki to 10.7.0.1 must come back to this phone. Users with a proxy
/// app keep it and add Poki's module; everyone else uses the tunnel built into Poki.
struct LoopbackStep: View {
    @Environment(AppModel.self) private var model
    @State private var copied = false

    var body: some View {
        StepPage(title: "Loopback", symbol: "arrow.triangle.2.circlepath",
                 intro: "Poki reaches this phone's developer services at 10.7.0.1, an address that loops back to the phone. iOS runs one VPN at a time, so if you already use a proxy app, it can do this for Poki and keep working as before.",
                 steps: []) {
            builtIn
            Text("Or use your proxy app").font(.headline).padding(.top, 8)
            ForEach(ProxyApps.all) { app in proxyCard(app) }
            Text("The loopback only carries Poki's own connections to 10.7.0.1. Nothing else is routed, and nothing leaves the phone.")
                .font(.footnote).foregroundStyle(.secondary)
        }
        .task { await model.tunnel.load() }
    }

    private var builtIn: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label("Built-in loopback", systemImage: "shield.lefthalf.filled").font(.headline)
                Spacer()
                if model.setup.loopback == .builtIn { Image(systemName: "checkmark.circle.fill").foregroundStyle(.green) }
            }
            Text("No other app needed. Uses the VPN slot, so turn it off to use another VPN.").font(.callout).foregroundStyle(.secondary)
            HStack {
                Text(model.tunnel.statusText).font(.callout.monospaced())
                Spacer()
                if model.tunnel.isConnected {
                    Button("Turn off") { model.tunnel.turnOff() }.buttonStyle(.glass)
                } else {
                    Button("Turn on") { Task { await model.tunnel.turnOn(); model.setup.loopback = .builtIn; model.setup.proxyApp = nil } }.buttonStyle(.glassProminent)
                }
            }
            if let error = model.tunnel.error { Text(error).font(.caption).foregroundStyle(.red) }
        }
        .padding().glassEffect(.regular, in: .rect(cornerRadius: 20))
    }

    private func proxyCard(_ app: ProxyApp) -> some View {
        let chosen = model.setup.loopback == .proxy && model.setup.proxyApp == app.id
        return VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(app.name).font(.headline)
                if !app.minimumVersion.isEmpty { Text("\(app.minimumVersion)+").font(.caption).foregroundStyle(.secondary) }
                Spacer()
                if chosen { Image(systemName: "checkmark.circle.fill").foregroundStyle(.green) }
                else if app.isInstalled { Text("Installed").font(.caption).foregroundStyle(.secondary) }
            }
            ForEach(Array(app.steps.enumerated()), id: \.offset) { i, text in
                Text("\(i + 1). \(text)").font(.callout)
            }
            HStack {
                switch app.install {
                case .url(let url):
                    Button(app.id == "surge" ? "Install module" : "Install plugin", systemImage: "plus.circle") { UIApplication.shared.open(url) }
                        .buttonStyle(.glassProminent).disabled(!app.isInstalled)
                case .toggle:
                    Button("Open \(app.name)", systemImage: "arrow.up.forward.app") { open("\(app.scheme)://") }
                        .buttonStyle(.glassProminent).disabled(!app.isInstalled)
                case .snippet(let line):
                    Button(copied ? "Copied" : "Copy line", systemImage: "doc.on.doc") { UIPasteboard.general.string = line; copied = true }
                        .buttonStyle(.glassProminent)
                }
                Button(chosen ? "In use" : "Use this") {
                    model.setup.loopback = .proxy; model.setup.proxyApp = app.id
                    if model.tunnel.isConnected { model.tunnel.turnOff() }
                }
                .buttonStyle(.glass).disabled(chosen)
            }
        }
        .padding().glassEffect(.regular, in: .rect(cornerRadius: 20))
        .opacity(app.isInstalled || chosen ? 1 : 0.6)
    }
}
