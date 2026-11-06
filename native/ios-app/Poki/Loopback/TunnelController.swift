import NetworkExtension

/// Poki's built-in loopback: a packet tunnel that only routes 10.7.0.1 and reflects it back to the
/// phone (PokiTunnel). For users with no proxy app. It takes the phone's VPN slot, which is why the
/// proxy modules exist for everyone else.
@MainActor
@Observable
final class TunnelController {
    static let providerBundle = "nz.zheha.poki.tunnel"
    private(set) var status: NEVPNStatus = .invalid
    private(set) var error: String?
    private var manager: NETunnelProviderManager?
    private var observer: NSObjectProtocol?

    var isConnected: Bool { status == .connected }
    var statusText: String {
        switch status {
        case .invalid: "Not set up"
        case .disconnected: "Off"
        case .connecting: "Connecting"
        case .connected: "On"
        case .reasserting: "Reconnecting"
        case .disconnecting: "Turning off"
        @unknown default: "Unknown"
        }
    }

    func load() async {
        do {
            let managers = try await NETunnelProviderManager.loadAllFromPreferences()
            manager = managers.first { ($0.protocolConfiguration as? NETunnelProviderProtocol)?.providerBundleIdentifier == Self.providerBundle }
            watch()
        } catch { self.error = "\(error)" }
    }

    func turnOn() async {
        do {
            let manager = self.manager ?? NETunnelProviderManager()
            let proto = NETunnelProviderProtocol()
            proto.providerBundleIdentifier = Self.providerBundle
            proto.serverAddress = "10.7.0.1 (on this iPhone)"
            manager.protocolConfiguration = proto
            manager.localizedDescription = "Poki Loopback"
            manager.isEnabled = true
            try await manager.saveToPreferences()
            try await manager.loadFromPreferences()
            self.manager = manager
            watch()
            try manager.connection.startVPNTunnel()
            error = nil
        } catch { self.error = "\(error)" }
    }

    func turnOff() { manager?.connection.stopVPNTunnel() }

    private func watch() {
        guard let manager else { status = .invalid; return }
        status = manager.connection.status
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = NotificationCenter.default.addObserver(forName: .NEVPNStatusDidChange, object: manager.connection, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.status = manager.connection.status }
        }
    }
}
