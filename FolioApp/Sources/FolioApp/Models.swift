import AppKit
import Foundation
import SwiftUI

struct MediaItem: Identifiable, Hashable, Codable {
    let path: String
    let name: String
    let size: UInt64
    let modified: Int64

    var id: String { path }
    var url: URL { URL(fileURLWithPath: path) }
}

struct ScanResult: Codable {
    let root: String
    let count: Int
    let items: [MediaItem]
}

struct LibraryFolder: Identifiable, Hashable {
    let url: URL
    let itemCount: Int
    let updatedAt: Date

    var id: String { url.path }
    var title: String { url.lastPathComponent.isEmpty ? url.path : url.lastPathComponent }
}

enum FolioSurface: Equatable {
    case home
    case viewport
}

enum FolioPalette {
    static let background = Color(red: 0.025, green: 0.027, blue: 0.030)
    static let panel = Color(red: 0.075, green: 0.078, blue: 0.084)
    static let panelRaised = Color(red: 0.112, green: 0.110, blue: 0.116)
    static let text = Color(red: 0.935, green: 0.925, blue: 0.895)
    static let muted = Color(red: 0.610, green: 0.600, blue: 0.570)
    static let faint = Color(red: 0.360, green: 0.360, blue: 0.350)
    static let coral = Color(red: 0.930, green: 0.435, blue: 0.345)
    static let amber = Color(red: 0.960, green: 0.655, blue: 0.330)
    static let teal = Color(red: 0.390, green: 0.760, blue: 0.680)
    static let moss = Color(red: 0.465, green: 0.620, blue: 0.440)
}

extension URL {
    var isDisplayableImage: Bool {
        let extensions = Set([
            "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp"
        ])
        return extensions.contains(pathExtension.lowercased())
    }
}

