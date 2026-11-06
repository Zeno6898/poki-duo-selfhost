// swift-tools-version: 5.10
// relay-check: runs PokiCore's relay client against a live relay, from Linux or macOS, with no phone.
// The runner address points nowhere, so tools answer "runner not running"; the MCP plumbing is real.
import PackageDescription

let package = Package(
    name: "RelayCheck",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(path: "../PokiCore"),
        .package(url: "https://github.com/apple/swift-crypto.git", "3.0.0"..<"4.0.0"),
    ],
    targets: [
        .executableTarget(name: "relay-check", dependencies: [
            .product(name: "PokiCore", package: "PokiCore"),
            .product(name: "Crypto", package: "swift-crypto"),
        ]),
    ]
)
