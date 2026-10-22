// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "MKProd",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "MKProd", path: "Sources/MKProd")
    ]
)
