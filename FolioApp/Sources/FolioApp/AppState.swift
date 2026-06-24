import AppKit
import Foundation
import SwiftUI

@MainActor
final class FolioStore: ObservableObject {
    @Published var surface: FolioSurface = .home
    @Published var items: [MediaItem] = []
    @Published var selectedItem: MediaItem?
    @Published var folderURL: URL?
    @Published var isScanning = false
    @Published var status = "Ready"

    private let scanner = MediaScanner()
    private let defaults = UserDefaults.standard
    private let lastFolderKey = "folio.lastFolder"

    var folderTitle: String {
        folderURL?.lastPathComponent.nonEmpty ?? "No folder selected"
    }

    var selectedIndex: Int? {
        guard let selectedItem else { return items.isEmpty ? nil : 0 }
        return items.firstIndex(of: selectedItem)
    }

    var canSelectPrevious: Bool {
        guard let selectedIndex else { return false }
        return selectedIndex > 0
    }

    var canSelectNext: Bool {
        guard let selectedIndex else { return false }
        return selectedIndex < items.count - 1
    }

    var libraryFolders: [LibraryFolder] {
        if let folderURL {
            return [
                LibraryFolder(url: folderURL, itemCount: items.count, updatedAt: Date()),
                LibraryFolder(url: folderURL.deletingLastPathComponent(), itemCount: max(0, items.count / 2), updatedAt: Date())
            ]
        }

        if let sampleURL = Self.sampleFolderURL {
            return [LibraryFolder(url: sampleURL, itemCount: 0, updatedAt: Date())]
        }

        return []
    }

    func bootstrap() async {
        if let savedPath = defaults.string(forKey: lastFolderKey) {
            let savedURL = URL(fileURLWithPath: savedPath)
            if FileManager.default.fileExists(atPath: savedURL.path) {
                await open(folder: savedURL, showViewport: false)
                return
            }
        }

        if let sampleURL = Self.sampleFolderURL {
            await open(folder: sampleURL, showViewport: false)
        }
    }

    func chooseFolder() {
        let panel = NSOpenPanel()
        panel.title = "Open an image folder"
        panel.prompt = "Open"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false

        if panel.runModal() == .OK, let url = panel.url {
            Task { await open(folder: url, showViewport: true) }
        }
    }

    func open(folder: URL, showViewport: Bool) async {
        isScanning = true
        status = "Scanning"
        folderURL = folder
        defaults.set(folder.path, forKey: lastFolderKey)

        do {
            let result = try await scanner.scan(url: folder)
            items = result.items
            selectedItem = result.items.first
            surface = showViewport ? .viewport : .home
            status = "\(result.count.formatted()) items"
        } catch {
            status = "Scan failed"
            items = []
            selectedItem = nil
        }

        isScanning = false
    }

    func openViewport() {
        if selectedItem == nil {
            selectedItem = items.first
        }
        surface = .viewport
    }

    func backHome() {
        surface = .home
    }

    func select(_ item: MediaItem) {
        selectedItem = item
    }

    func selectRelative(_ offset: Int) {
        guard !items.isEmpty else { return }
        let currentIndex = selectedItem.flatMap { selected in items.firstIndex(of: selected) } ?? 0
        let newIndex = min(max(currentIndex + offset, 0), items.count - 1)
        selectedItem = items[newIndex]
    }

    static var sampleFolderURL: URL? {
        let current = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        let candidates = [
            current.appendingPathComponent("Testing/GPS"),
            current.appendingPathComponent("Testing")
        ]
        return candidates.first { FileManager.default.fileExists(atPath: $0.path) }
    }
}

private extension String {
    var nonEmpty: String? {
        isEmpty ? nil : self
    }
}
