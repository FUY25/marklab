// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "MarkLabMacOS",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "MarkLabMacOS", targets: ["MarkLabMacOS"]),
    .executable(name: "MarkLabApp", targets: ["MarkLabApp"]),
  ],
  dependencies: [
    .package(url: "https://github.com/sparkle-project/Sparkle", exact: "2.9.2"),
  ],
  targets: [
    .target(name: "MarkLabMacOS"),
    .executableTarget(
      name: "MarkLabApp",
      dependencies: [
        "MarkLabMacOS",
        .product(name: "Sparkle", package: "Sparkle"),
      ],
      resources: [.process("Resources")],
      linkerSettings: [
        .unsafeFlags(["-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks"]),
      ]
    ),
    .testTarget(name: "MarkLabMacOSTests", dependencies: ["MarkLabMacOS", "MarkLabApp"]),
  ]
)
