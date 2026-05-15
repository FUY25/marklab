// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "MarkLabMacOS",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "MarkLabMacOS", targets: ["MarkLabMacOS"]),
    .executable(name: "MarkLabApp", targets: ["MarkLabApp"]),
  ],
  targets: [
    .target(name: "MarkLabMacOS"),
    .executableTarget(name: "MarkLabApp", dependencies: ["MarkLabMacOS"]),
    .testTarget(name: "MarkLabMacOSTests", dependencies: ["MarkLabMacOS"]),
  ]
)
