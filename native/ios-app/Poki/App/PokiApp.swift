import SwiftUI

@main
struct PokiApp: App {
    @State private var model = AppModel()

    init() {
        // PokiLauncher (Rust) and the relay write to sockets the other side may have closed. In an app,
        // unlike a Rust executable, nothing ignores SIGPIPE, and it would end the whole app.
        signal(SIGPIPE, SIG_IGN)
    }

    var body: some Scene {
        WindowGroup {
            RootView().environment(model)
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @State private var tab = Tabs.home

    enum Tabs: Hashable { case home, setup, connect, debug }

    var body: some View {
        TabView(selection: $tab) {
            Tab("Poki", systemImage: "pawprint.fill", value: Tabs.home) { HomeView(openSetup: { tab = .setup }) }
            Tab("Setup", systemImage: "checklist", value: Tabs.setup) { SetupView() }
                .badge(model.setup.isComplete ? 0 : 1)
            Tab("Connect", systemImage: "qrcode", value: Tabs.connect) { ConnectView() }
            Tab("Debug", systemImage: "stethoscope", value: Tabs.debug) { ProbeView() }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .tint(Brand.blue)
    }
}

enum Brand {
    static let blue = Color(red: 0x20 / 255, green: 0x84 / 255, blue: 0xFD / 255)
}
