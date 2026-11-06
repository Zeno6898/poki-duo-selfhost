import NetworkExtension

/// Poki's built-in loopback: routes only 10.7.0.1 into the tunnel and sends every IPv4 packet for it
/// straight back with source and destination swapped, so a connection from Poki to 10.7.0.1:<port>
/// arrives at this phone's own <port> (docs/ios-core.md, section 4). The same idea as LocalDevVPN and
/// StosVPN. Nothing else is routed: no default route, no DNS, no IPv6.
///
/// Swapping the two addresses leaves the IPv4 header checksum and the TCP/UDP checksums valid, since
/// both are ones'-complement sums in which the two addresses appear symmetrically.
final class PacketTunnelProvider: NEPacketTunnelProvider {
    static let device = "10.7.0.1"
    static let local = "10.7.0.2"

    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        let settings = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: Self.device)
        let ipv4 = NEIPv4Settings(addresses: [Self.local], subnetMasks: ["255.255.255.0"])
        ipv4.includedRoutes = [NEIPv4Route(destinationAddress: Self.device, subnetMask: "255.255.255.255")]
        ipv4.excludedRoutes = []
        settings.ipv4Settings = ipv4
        settings.mtu = 1500
        setTunnelNetworkSettings(settings) { [weak self] error in
            if error == nil { self?.readLoop() }
            completionHandler(error)
        }
    }

    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        completionHandler()
    }

    private func readLoop() {
        packetFlow.readPackets { [weak self] packets, protocols in
            guard let self else { return }
            var out: [Data] = [], outProtocols: [NSNumber] = []
            for (packet, proto) in zip(packets, protocols) {
                if let reflected = Self.reflect(packet) { out.append(reflected); outProtocols.append(proto) }
            }
            if !out.isEmpty { self.packetFlow.writePackets(out, withProtocols: outProtocols) }
            self.readLoop()
        }
    }

    /// The packet with its IPv4 source and destination swapped, or nil when it is not IPv4 to 10.7.0.1.
    static func reflect(_ packet: Data) -> Data? {
        guard packet.count >= 20 else { return nil }
        var bytes = [UInt8](packet)
        guard bytes[0] >> 4 == 4, bytes[16] == 10, bytes[17] == 7, bytes[18] == 0, bytes[19] == 1 else { return nil }
        for i in 0..<4 { bytes.swapAt(12 + i, 16 + i) }
        return Data(bytes)
    }
}
