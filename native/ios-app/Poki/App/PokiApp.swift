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
    @Environment(\.scenePhase) private var scenePhase
    @State private var tab = RootView.launchTab

    enum Tabs: String, Hashable { case home, setup, connect, debug, activity }

    /// `-pokiScreen setup` (and so on) opens that screen at launch, for the build's screenshots.
    static var launchTab: Tabs {
        UserDefaults.standard.string(forKey: "pokiScreen").flatMap(Tabs.init(rawValue:)) ?? .home
    }

    var body: some View {
        TabView(selection: $tab) {
            Tab("Poki", systemImage: "pawprint.fill", value: Tabs.home) { HomeView(openSetup: { tab = .setup }) }
            Tab("Setup", systemImage: "checklist", value: Tabs.setup) { SetupView() }
                .badge(model.setupComplete ? 0 : SetupStep.allCases.filter { !model.isDone($0) }.count)
            Tab("Connect", systemImage: "qrcode", value: Tabs.connect) { ConnectView() }
            Tab("Debug", systemImage: "stethoscope", value: Tabs.debug) { ProbeView() }
            if tab == .activity {
                Tab("Live Activity", systemImage: "rectangle.inset.filled", value: Tabs.activity) { NavigationStack { ActivityPreview() } }
            }
        }
        .tabBarMinimizeBehavior(.onScrollDown)
        .tint(Brand.blue)
        .onChange(of: scenePhase, initial: true) { _, phase in
            if phase == .active { model.becameActive() } else if phase == .background { model.wentToBackground() }
        }
        .onOpenURL { _ in tab = .home }
    }
}
