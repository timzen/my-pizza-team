// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MyPizzaTeamMenu",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "MyPizzaTeamMenu",
            path: "Sources"
        ),
    ]
)
