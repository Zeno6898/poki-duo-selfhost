import CoreImage.CIFilterBuiltins
import SwiftUI

/// The MCP address for each client: shown as text, a QR code and a copy button. Each client gets its
/// own secret, so one can be revoked without the others.
struct ConnectView: View {
    @Environment(AppModel.self) private var model
    @State private var newName = ""
    @State private var shown: ConnectorSecret?
    @State private var copied = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent("Relay", value: model.relayStatus.text)
                    LabeledContent("Device label") {
                        if model.identity.label.isEmpty { Text("Not created yet") }
                        else { Text(model.identity.label.prefix(12) + "…").font(.body.monospaced()) }
                    }
                } footer: {
                    Text("The relay passes requests to this phone while Poki is open or running in the background. It stores nothing; when the phone is offline, clients get a clear error.")
                }
                Section("Connectors") {
                    ForEach(model.identity.secrets) { secret in
                        Button { shown = secret } label: {
                            LabeledContent(secret.name) { Text(secret.created, style: .date).foregroundStyle(.secondary) }
                        }
                        .swipeActions { Button("Revoke", role: .destructive) { model.revoke(secret) } }
                    }
                    HStack {
                        TextField("Name, such as Claude", text: $newName)
                        Button("Add") { shown = model.addConnector(name: newName); newName = "" }
                            .buttonStyle(.glassProminent)
                    }
                }
                if let error = model.identity.error {
                    Section {
                        Label(Self.friendly(error), systemImage: "exclamationmark.triangle.fill").font(.subheadline).foregroundStyle(.orange)
                    }
                }
            }
            .navigationTitle("Connect")
            .sheet(item: $shown) { secret in connector(secret) }
        }
    }

    /// Keychain errors in words. -34018 means the app's signature has no keychain access (an unsigned
    /// or wrongly signed build); everything else shows its code.
    static func friendly(_ error: String) -> String {
        if error.contains("-34018") {
            return "Poki can't use the keychain, so it has no key for the relay yet. Install Poki again with your signing tool, then open this tab."
        }
        return "Poki couldn't read its relay key from the keychain (\(error))."
    }

    private func connector(_ secret: ConnectorSecret) -> some View {
        let url = model.identity.url(for: secret).absoluteString
        return NavigationStack {
            VStack(spacing: 24) {
                if let qr = QRCode.image(url) {
                    Image(uiImage: qr).interpolation(.none).resizable().scaledToFit()
                        .frame(maxWidth: 260).padding(20)
                        .background(.white, in: .rect(cornerRadius: 24))
                }
                Text(url).font(.footnote.monospaced()).textSelection(.enabled).multilineTextAlignment(.center)
                    .padding().glassEffect(.regular, in: .rect(cornerRadius: 20))
                Button(copied ? "Copied" : "Copy address", systemImage: copied ? "checkmark" : "doc.on.doc") {
                    UIPasteboard.general.string = url
                    copied = true
                }
                .buttonStyle(.glassProminent).controlSize(.large)
                Text("Add this address as a remote MCP server in your client. Anyone with it can control this phone while Poki runs, so keep it private, and revoke it here if it leaks.")
                    .font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                Spacer()
            }
            .padding()
            .navigationTitle(secret.name)
            .navigationBarTitleDisplayMode(.inline)
            .onDisappear { copied = false }
        }
        .presentationDetents([.large])
    }
}

enum QRCode {
    static func image(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.transformed(by: CGAffineTransform(scaleX: 10, y: 10)),
              let cg = CIContext().createCGImage(output, from: output.extent) else { return nil }
        return UIImage(cgImage: cg)
    }
}
