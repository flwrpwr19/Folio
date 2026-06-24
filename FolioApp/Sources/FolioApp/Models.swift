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
    static let background = Color(red: 0.018, green: 0.020, blue: 0.023)
    static let sidebar = Color(red: 0.032, green: 0.036, blue: 0.040).opacity(0.96)
    static let panel = Color(red: 0.064, green: 0.068, blue: 0.074)
    static let panelRaised = Color(red: 0.088, green: 0.092, blue: 0.100)
    static let text = Color(red: 0.955, green: 0.946, blue: 0.915)
    static let muted = Color(red: 0.625, green: 0.620, blue: 0.595)
    static let faint = Color(red: 0.355, green: 0.360, blue: 0.355)
    static let coral = Color(red: 0.925, green: 0.430, blue: 0.335)
    static let amber = Color(red: 0.965, green: 0.670, blue: 0.340)
    static let teal = Color(red: 0.370, green: 0.770, blue: 0.680)
    static let moss = Color(red: 0.470, green: 0.630, blue: 0.450)
}

extension URL {
    var isDisplayableImage: Bool {
        let extensions = Set([
            "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp"
        ])
        return extensions.contains(pathExtension.lowercased())
    }
}
