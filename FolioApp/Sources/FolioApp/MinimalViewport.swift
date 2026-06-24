import AppKit
import SwiftUI

struct MinimalViewport: View {
    @EnvironmentObject private var store: FolioStore
    @State private var showDetails = false

    private var selected: MediaItem? { store.selectedItem ?? store.items.first }
    private var filmstripItems: [MediaItem] {
        guard !store.items.isEmpty else { return [] }
        guard let selected, let index = store.items.firstIndex(of: selected) else {
            return Array(store.items.prefix(12))
        }
        let lower = max(0, index - 6)
        let upper = min(store.items.count, index + 7)
        return Array(store.items[lower..<upper])
    }

    var body: some View {
        VStack(spacing: 12) {
            topCommandStrip

            HStack(spacing: 12) {
                if let selected {
                    imageStage(selected)
                } else {
                    emptyViewport
                }

                if showDetails, let selected {
                    detailsPanel(selected)
                        .frame(width: 284)
                        .transition(.opacity.combined(with: .move(edge: .trailing)))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if !store.items.isEmpty {
                bottomScrubber
            }
        }
        .padding(.horizontal, 22)
        .padding(.top, 58)
        .padding(.bottom, 18)
        .animation(.smoothFolio, value: showDetails)
        .onMoveCommand { direction in
            switch direction {
            case .left:
                store.selectRelative(-1)
            case .right:
                store.selectRelative(1)
            default:
                break
            }
        }
    }

    private var topCommandStrip: some View {
        SurfaceShell(radius: 29, inset: 4, innerFill: FolioPalette.panel.opacity(0.92)) {
            HStack(spacing: 12) {
                IconButton(systemName: "chevron.left", label: "Back to library") {
                    store.backHome()
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(store.folderTitle)
                        .font(.system(size: 14, weight: .semibold, design: .rounded))
                        .foregroundStyle(FolioPalette.text)
                        .lineLimit(1)
                    Text(positionLabel)
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .foregroundStyle(FolioPalette.muted)
                }
                .frame(minWidth: 116, alignment: .leading)

                Spacer(minLength: 8)

                if let selected {
                    Text(selected.name)
                        .font(.system(size: 11, weight: .medium, design: .rounded))
                        .foregroundStyle(FolioPalette.muted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .frame(maxWidth: 360)
                        .accessibilityLabel("Selected file: \(selected.name)")
                }

                Spacer(minLength: 8)

                IconButton(systemName: "info", label: "Show file details", isActive: showDetails) {
                    showDetails.toggle()
                }
                IconButton(systemName: "arrow.up.left.and.arrow.down.right", label: "Toggle full screen") {
                    NSApp.keyWindow?.toggleFullScreen(nil)
                }
            }
            .padding(.horizontal, 8)
            .frame(height: 48)
        }
    }

    private func imageStage(_ item: MediaItem) -> some View {
        SurfaceShell(radius: 28, inset: 5, innerFill: Color.black.opacity(0.30)) {
            GeometryReader { proxy in
                ZStack {
                    LinearGradient(
                        colors: [Color.black.opacity(0.16), FolioPalette.panel.opacity(0.22)],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )

                    AsyncThumbnail(
                        item: item,
                        target: max(proxy.size.width, proxy.size.height) * 1.8,
                        contentMode: .fit
                    )
                    .padding(16)
                    .id(item.id)
                    .transition(.opacity.combined(with: .scale(scale: 0.992)))
                }
            }
        }
        .animation(.smoothFolio, value: item.id)
        .accessibilityLabel("Preview of \(item.name)")
    }

    private var bottomScrubber: some View {
        SurfaceShell(radius: 26, inset: 4, innerFill: FolioPalette.panel.opacity(0.92)) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(positionLabel)
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .foregroundStyle(FolioPalette.text.opacity(0.88))
                    Text("Use ← → to navigate")
                        .font(.system(size: 9, weight: .medium, design: .rounded))
                        .foregroundStyle(FolioPalette.muted)
                }
                .frame(width: 104, alignment: .leading)

                ScrollView(.horizontal, showsIndicators: false) {
                    LazyHStack(spacing: 9) {
                        ForEach(filmstripItems) { item in
                            FilmstripThumbnail(item: item, isSelected: item == selected)
                        }
                    }
                    .padding(.vertical, 6)
                    .padding(.horizontal, 2)
                }

                HStack(spacing: 8) {
                    IconButton(
                        systemName: "chevron.left",
                        label: "Previous image",
                        isEnabled: store.canSelectPrevious
                    ) {
                        store.selectRelative(-1)
                    }
                    IconButton(
                        systemName: "chevron.right",
                        label: "Next image",
                        isEnabled: store.canSelectNext
                    ) {
                        store.selectRelative(1)
                    }
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 78)
        }
    }

    private func detailsPanel(_ item: MediaItem) -> some View {
        SurfaceShell(radius: 27, inset: 5, innerFill: FolioPalette.panel.opacity(0.94)) {
            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        SectionEyebrow(text: "Inspector")
                        Text("File details")
                            .font(.system(size: 17, weight: .semibold, design: .rounded))
                            .foregroundStyle(FolioPalette.text)
                    }

                    Spacer()

                    IconButton(systemName: "xmark", label: "Close file details") {
                        showDetails = false
                    }
                }

                Divider()
                    .overlay(.white.opacity(0.055))

                VStack(alignment: .leading, spacing: 16) {
                    DetailRow(label: "File", value: item.name)
                    DetailRow(label: "Format", value: item.url.pathExtension.uppercased())
                    DetailRow(
                        label: "Size",
                        value: ByteCountFormatter.string(fromByteCount: Int64(item.size), countStyle: .file)
                    )
                    DetailRow(
                        label: "Modified",
                        value: Date(timeIntervalSince1970: TimeInterval(item.modified))
                            .formatted(date: .abbreviated, time: .shortened)
                    )
                    DetailRow(label: "Location", value: item.url.deletingLastPathComponent().path)
                }

                Spacer(minLength: 12)

                SecondaryActionButton(title: "Reveal in Finder", systemName: "arrow.forward.square") {
                    NSWorkspace.shared.activateFileViewerSelecting([item.url])
                }
            }
            .padding(18)
        }
    }

    private var emptyViewport: some View {
        SurfaceShell(radius: 30, inset: 6, innerFill: FolioPalette.panel.opacity(0.86)) {
            VStack(spacing: 16) {
                Image(systemName: "photo.on.rectangle.angled")
                    .font(.system(size: 38, weight: .ultraLight))
                    .foregroundStyle(FolioPalette.amber)
                Text("No images to preview")
                    .font(.system(size: 22, weight: .semibold, design: .rounded))
                    .foregroundStyle(FolioPalette.text)
                Text("Choose a folder that contains supported image files.")
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(FolioPalette.muted)
                PrimaryActionButton(title: "Choose folder", systemName: "arrow.up.right", action: store.chooseFolder)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var positionLabel: String {
        guard let index = store.selectedIndex else { return "0 items" }
        return "\((index + 1).formatted()) of \(store.items.count.formatted())"
    }
}

private struct FilmstripThumbnail: View {
    @EnvironmentObject private var store: FolioStore
    let item: MediaItem
    let isSelected: Bool

    var body: some View {
        Button {
            store.select(item)
        } label: {
            AsyncThumbnail(item: item, target: 180, contentMode: .fill)
                .frame(width: 72, height: 50)
                .clipped()
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                .padding(3)
                .background {
                    RoundedRectangle(cornerRadius: 13, style: .continuous)
                        .fill(isSelected ? FolioPalette.amber.opacity(0.96) : .white.opacity(0.045))
                }
                .overlay {
                    RoundedRectangle(cornerRadius: 13, style: .continuous)
                        .stroke(isSelected ? FolioPalette.amber.opacity(0.74) : .white.opacity(0.055), lineWidth: 0.7)
                }
        }
        .buttonStyle(FolioPressStyle())
        .accessibilityLabel(isSelected ? "Selected image: \(item.name)" : "Select \(item.name)")
        .help(item.name)
    }
}

private struct DetailRow: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased())
                .font(.system(size: 9, weight: .semibold, design: .rounded))
                .tracking(1.1)
                .foregroundStyle(FolioPalette.muted)
            Text(value)
                .font(.system(size: 12, weight: .medium, design: .rounded))
                .foregroundStyle(FolioPalette.text.opacity(0.88))
                .lineLimit(label == "Location" ? 3 : 2)
                .truncationMode(label == "Location" ? .head : .middle)
                .textSelection(.enabled)
        }
    }
}
