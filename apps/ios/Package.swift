// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "VoicePractice",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "VoicePracticeCore",
            targets: ["VoicePracticeCore"]
        )
    ],
    targets: [
        .target(
            name: "VoicePracticeCore",
            dependencies: [],
            path: "Sources/VoicePracticeCore"
        ),
        .executableTarget(
            name: "VoicePracticeTests",
            dependencies: ["VoicePracticeCore"],
            path: "Tests/VoicePracticeTests"
        ),
        .testTarget(
            name: "VoicePracticeXCTests",
            dependencies: ["VoicePracticeCore"],
            path: "Tests/VoicePracticeXCTests"
        )
    ]
)
