import AppKit
import ImageIO
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class ThumbnailStore: ObservableObject {
    private let cache = NSCache<NSString, NSImage>()

    init() {
        cache.countLimit = 800
        cache.totalCostLimit = 512 * 1024 * 1024
    }

    func image(for item: MediaItem, target: CGFloat) async -> NSImage? {
        let scale = NSScreen.main?.backingScaleFactor ?? 2
        let pixelTarget = max(128, Int(target * scale))
        let key = "\(item.path)-\(pixelTarget)" as NSString

        if let cached = cache.object(forKey: key) {
            return cached
        }

        let path = item.path
        let image = await Task.detached(priority: .userInitiated) {
            Self.decodeThumbnail(path: path, maxPixelSize: pixelTarget)
        }.value

        if let image {
            let cost = Int(image.size.width * image.size.height * 4)
            cache.setObject(image, forKey: key, cost: cost)
        }

        return image
    }

    nonisolated private static func decodeThumbnail(path: String, maxPixelSize: Int) -> NSImage? {
        let url = URL(fileURLWithPath: path) as CFURL
        let options: [CFString: Any] = [
            kCGImageSourceShouldCache: false,
            kCGImageSourceShouldCacheImmediately: false
        ]

        guard let source = CGImageSourceCreateWithURL(url, options as CFDictionary) else {
            return NSImage(contentsOfFile: path)
        }

        let thumbnailOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixelSize
        ]

        guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, thumbnailOptions as CFDictionary) else {
            return NSImage(contentsOfFile: path)
        }

        return NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
    }
}

struct AsyncThumbnail: View {
    @EnvironmentObject private var thumbnailStore: ThumbnailStore
    let item: MediaItem
    let target: CGFloat
    let contentMode: ContentMode

    @State private var image: NSImage?

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: contentMode)
            } else {
                Rectangle()
                    .fill(
                        LinearGradient(
                            colors: [
                                FolioPalette.panelRaised.opacity(0.8),
                                FolioPalette.panel.opacity(0.9)
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .overlay {
                        ProgressView()
                            .controlSize(.small)
                            .tint(FolioPalette.amber)
                            .opacity(0.55)
                    }
            }
        }
        .task(id: "\(item.id)-\(target)") {
            image = await thumbnailStore.image(for: item, target: target)
        }
    }
}
