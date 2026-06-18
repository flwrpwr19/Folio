// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Folio",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "Folio", targets: ["FolioApp"])
    ],
    targets: [
        .executableTarget(
            name: "FolioApp",
            path: "FolioApp/Sources/FolioApp"
        )
    ]
)

