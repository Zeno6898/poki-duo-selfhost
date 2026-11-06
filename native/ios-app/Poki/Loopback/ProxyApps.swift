import Foundation
import UIKit

/// The proxy apps that can provide the 10.7.0.1 loopback, so users
/// keep their own VPN. Detected with canOpenURL (their schemes are listed in LSApplicationQueriesSchemes).
/// The module files live in deploy/proxy-modules/.
struct ProxyApp: Identifiable, Hashable {
    enum Install: Hashable { case url(URL), toggle(String), snippet(String) }
    let id: String
    let name: String
    let scheme: String
    let minimumVersion: String
    let install: Install
    let steps: [String]

    var isInstalled: Bool {
        guard let url = URL(string: "\(scheme)://") else { return false }
        return UIApplication.shared.canOpenURL(url)
    }
}

enum ProxyApps {
    /// Where the module files are served from. Raw GitHub of the fork for now; the relay can serve
    /// them later.
    static let modulesBase = URL(string: "https://raw.githubusercontent.com/ZhehanZhang/poki-remote/dev/ios-app/deploy/proxy-modules/")!

    static func encoded(_ url: URL) -> String {
        url.absoluteString.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? url.absoluteString
    }

    static let all: [ProxyApp] = [
        ProxyApp(id: "surge", name: "Surge", scheme: "surge", minimumVersion: "5.23.0",
                 install: .url(URL(string: "surge:///install-module?url=\(encoded(modulesBase.appendingPathComponent("poki-loopback.sgmodule")))")!),
                 steps: ["Tap Install module, then confirm in Surge.", "Turn the Poki Device Loopback module on.", "Turn on Enhanced Mode: the loopback only works in Enhanced Mode."]),
        ProxyApp(id: "loon", name: "Loon", scheme: "loon", minimumVersion: "3.5.3",
                 install: .url(URL(string: "loon://import?plugin=\(encoded(modulesBase.appendingPathComponent("poki-loopback.lpx")))")!),
                 steps: ["Tap Install plugin, then confirm in Loon.", "Make sure the plugin is enabled and Loon's VPN is on."]),
        ProxyApp(id: "shadowrocket", name: "Shadowrocket", scheme: "shadowrocket", minimumVersion: "",
                 install: .toggle("Settings > Other > Include route 10.7.0.1/32"),
                 steps: ["Open Shadowrocket.", "Go to Settings > Other and turn on Include route 10.7.0.1/32. If it is missing, update Shadowrocket.", "Keep Shadowrocket connected."]),
        ProxyApp(id: "sing-box", name: "sing-box", scheme: "sing-box", minimumVersion: "1.12.0",
                 install: .snippet("\"loopback_address\": [\"10.7.0.1\"]"),
                 steps: ["Copy the line below.", "Add it to the tun inbound of your sing-box profile, then reload the profile.", "Keep IPv6 out of the tun address list."]),
    ]
}
