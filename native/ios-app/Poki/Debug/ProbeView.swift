import SwiftUI

struct ProbeView: View {
    @State private var results: [ProbeResult] = []
    @State private var running = false
    @State private var addresses: [LocalAddress] = localAddresses()
    @StateObject private var hold = Hold()

    var body: some View {
        NavigationStack {
            List {
                Section {
                    NavigationLink("Live Activity preview") { ActivityPreview() }
                }
                Section("Proxy loopback interface") {
                    if let loop = loopbackInterface(addresses) {
                        Text("\(loop.interface)  \(loop.address)").font(.headline.monospaced())
                        Text(loop.ipv6.isEmpty ? "no IPv6 on this interface" : "IPv6 present: \(loop.ipv6.joined(separator: ", "))")
                            .font(.caption.monospaced()).foregroundStyle(loop.ipv6.isEmpty ? Color.secondary : Color.orange)
                    } else {
                        Label("No interface has a 10.7.0.x address. Check that your proxy app is on and its loopback module is enabled.", systemImage: "exclamationmark.triangle").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                Section("Checks") {
                    ForEach(results) { r in
                        VStack(alignment: .leading, spacing: 4) {
                            Text("\(r.label): \(r.outcome)").font(.headline)
                            Text("\(r.target)  \(r.milliseconds) ms").font(.caption.monospaced())
                            if !r.detail.isEmpty { Text(r.detail).font(.caption.monospaced()).foregroundStyle(.secondary) }
                            if !r.firstBytes.isEmpty { Text("first bytes: \(r.firstBytes)").font(.caption.monospaced()) }
                        }.textSelection(.enabled)
                    }
                    Button(running ? "Running…" : "Run checks") { Task { await run() } }.disabled(running)
                }
                Section("Background hold") {
                    LabeledContent("Port on 10.7.0.1") {
                        TextField("49152", text: $hold.port).keyboardType(.numberPad).multilineTextAlignment(.trailing).monospacedDigit()
                    }
                    Picker("Experiment", selection: $hold.experiment) { ForEach(Hold.Experiment.allCases) { Text($0.rawValue).tag($0) } }
                        .disabled(hold.holding)
                    HStack {
                        Button("Start hold") { hold.start() }.disabled(hold.holding)
                        Spacer()
                        Button("Stop", role: .destructive) { hold.stop() }.disabled(!hold.holding)
                    }.buttonStyle(.borderless)
                    Text("Start, then leave the app for a while and come back. The log shows suspension gaps and when the connection closed.").font(.caption).foregroundStyle(.secondary)
                    ForEach(hold.log.indices, id: \.self) { i in Text(hold.log[i]).font(.caption2.monospaced()).textSelection(.enabled) }
                }
                Section("Addresses") {
                    ForEach(addresses.indices, id: \.self) { i in
                        Text("\(addresses[i].interface)  \(addresses[i].address)").font(.caption.monospaced()).textSelection(.enabled)
                    }
                }
            }
            .navigationTitle("Debug")
            .task { await run() }
        }
    }

    private func run() async {
        running = true
        addresses = localAddresses()
        results = await runChecks()
        running = false
    }
}
