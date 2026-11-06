import Foundation
import Network

/// One address of this phone, as getifaddrs reports it.
struct LocalAddress { let interface: String; let address: String; let family: Int32 }

func localAddresses() -> [LocalAddress] {
    var result: [LocalAddress] = []
    var list: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&list) == 0, let first = list else { return result }
    defer { freeifaddrs(list) }
    for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
        let entry = pointer.pointee
        guard let sa = entry.ifa_addr else { continue }
        let family = Int32(sa.pointee.sa_family)
        guard family == AF_INET || family == AF_INET6 else { continue }
        var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        let length = socklen_t(family == AF_INET ? MemoryLayout<sockaddr_in>.size : MemoryLayout<sockaddr_in6>.size)
        guard getnameinfo(sa, length, &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST) == 0 else { continue }
        result.append(LocalAddress(interface: String(cString: entry.ifa_name), address: String(cString: host), family: family))
    }
    return result
}

/// What one TCP connect attempt saw, raw.
struct ProbeResult: Identifiable {
    let id = UUID()
    let label: String
    let target: String
    var outcome: String = "running"
    var detail: String = ""
    var firstBytes: String = ""
    var milliseconds: Int = 0
}

/// Connects with Network.framework, waits up to `timeout` for ready, then for the first bytes.
func probe(label: String, host: String, port: UInt16 = 49152, timeout: TimeInterval = 3) async -> ProbeResult {
    var result = ProbeResult(label: label, target: "\(host):\(port)")
    let started = Date()
    let parameters = NWParameters.tcp
    parameters.prohibitedInterfaceTypes = []
    let connection = NWConnection(host: NWEndpoint.Host(host), port: NWEndpoint.Port(rawValue: port)!, using: parameters)
    let queue = DispatchQueue(label: "probe.\(label)")
    let outcome: (String, String) = await withCheckedContinuation { continuation in
        var done = false
        let finish = { (state: String, detail: String) in
            queue.async { if !done { done = true; continuation.resume(returning: (state, detail)) } }
        }
        connection.stateUpdateHandler = { state in
            switch state {
            case .ready: finish("connected", "")
            case .failed(let error): finish(isRefused(error) ? "refused" : "failed", "\(error)")
            case .waiting(let error): finish(isRefused(error) ? "refused" : "waiting", "\(error)")
            default: break
            }
        }
        connection.start(queue: queue)
        queue.asyncAfter(deadline: .now() + timeout) { finish("timeout", "no answer within \(Int(timeout)) s") }
    }
    result.outcome = outcome.0
    result.detail = outcome.1
    if outcome.0 == "connected" {
        result.firstBytes = await withCheckedContinuation { continuation in
            var done = false
            let finish = { (text: String) in queue.async { if !done { done = true; continuation.resume(returning: text) } } }
            connection.receive(minimumIncompleteLength: 1, maximumLength: 64) { data, _, complete, error in
                if let data, !data.isEmpty { finish(data.map { String(format: "%02x", $0) }.joined(separator: " ")) }
                else if let error { finish("receive error: \(error)") }
                else if complete { finish("closed by the other side, no bytes") }
                else { finish("") }
            }
            queue.asyncAfter(deadline: .now() + 1.5) { finish("(nothing within 1.5 s)") }
        }
    }
    connection.cancel()
    result.milliseconds = Int(Date().timeIntervalSince(started) * 1000)
    return result
}

private func isRefused(_ error: NWError) -> Bool {
    if case .posix(let code) = error { return code == .ECONNREFUSED }
    return false
}

/// The interface that carries the loopback address 10.7.0.x a proxy app's tunnel assigns, if any, and
/// whether that interface also has an IPv6 address (tools that look for this loopback skip such
/// interfaces, so the proxy's IPv6 tunnel interface should be off).
struct LoopbackInterface { let interface: String; let address: String; let ipv6: [String] }

func loopbackInterface(_ addresses: [LocalAddress] = localAddresses()) -> LoopbackInterface? {
    guard let v4 = addresses.first(where: { $0.family == AF_INET && $0.address.hasPrefix("10.7.0.") }) else { return nil }
    let v6 = addresses.filter { $0.interface == v4.interface && $0.family == AF_INET6 }.map(\.address)
    return LoopbackInterface(interface: v4.interface, address: v4.address, ipv6: v6)
}

/// The checks. Primary: 10.7.0.1, which the user's proxy app (Surge, Loon, sing-box, Shadowrocket)
/// reflects back to this phone, on lockdown (62078), RemotePairing (49152) and a random port. Secondary: the Wi-Fi
/// IPv4 address of en0, loopback and en0's link-local IPv6, on 49152.
func runChecks() async -> [ProbeResult] {
    let addresses = localAddresses()
    let wifi4 = addresses.first { $0.interface == "en0" && $0.family == AF_INET }
    let link6 = addresses.first { $0.interface == "en0" && $0.family == AF_INET6 && $0.address.lowercased().hasPrefix("fe80") }
    var results: [ProbeResult] = []
    results.append(await probe(label: "Reflected lockdown (10.7.0.1)", host: "10.7.0.1", port: 62078))
    results.append(await probe(label: "Reflected RemotePairing (10.7.0.1)", host: "10.7.0.1", port: 49152))
    // The tunnel's second connection goes to a port the phone picks, and reflect matches the address
    // on any port: on a port nothing listens on, refused means reachable, a timeout means not.
    let arbitrary = UInt16.random(in: 50000...59999)
    var random = await probe(label: "Reflected arbitrary port (10.7.0.1)", host: "10.7.0.1", port: arbitrary)
    if random.outcome == "refused" { random.detail = "refused: the reflection reaches the phone on any port. " + random.detail }
    results.append(random)
    if let wifi4 { results.append(await probe(label: "Wi-Fi IPv4 (en0)", host: wifi4.address)) }
    else { results.append(ProbeResult(label: "Wi-Fi IPv4 (en0)", target: "-", outcome: "no address", detail: "en0 has no IPv4 address: is Wi-Fi on?")) }
    results.append(await probe(label: "Loopback", host: "127.0.0.1"))
    if let link6 {
        let host = link6.address.contains("%") ? link6.address : "\(link6.address)%en0"
        results.append(await probe(label: "Link-local IPv6 (en0)", host: host))
    } else { results.append(ProbeResult(label: "Link-local IPv6 (en0)", target: "-", outcome: "no address", detail: "en0 has no fe80:: address")) }
    return results
}
