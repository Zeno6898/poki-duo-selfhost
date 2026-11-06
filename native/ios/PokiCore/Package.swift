// swift-tools-version: 5.10
// PokiCore: the MCP server that runs on the phone. No UIKit or SwiftUI, so it builds and tests on Linux;
// what only iOS has (the keychain, ImageIO, the runner launcher) comes in through CoreHost.
import PackageDescription

let package = Package(
    name: "PokiCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "PokiCore", targets: ["PokiCore"])],
    targets: [
        .target(name: "PokiCore"),
        .testTarget(name: "PokiCoreTests", dependencies: ["PokiCore"]),
        // Drives look/do against a real WebDriverAgent in the iOS Simulator (CI's simulator job).
        .executableTarget(name: "poki-sim-check", dependencies: ["PokiCore"]),
    ]
)
