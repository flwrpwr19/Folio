import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var store: FolioStore

    private var heroItem: MediaItem? { store.selectedItem ?? store.items.first }
    private var latestItems: [MediaItem] { Array(store.items.prefix(7)) }
    private var totalBytes: UInt64 { store.items.reduce(0) { $0 + $1.size } }

    var body: some View {
        HStack(spacing: 0) {
            sidebar
            mainContent
        }
        .background(Color.clear)
    }

    private var sidebar: some View {
        SidebarShell {
            VStack(alignment: .leading, spacing: 7) {
                SectionEyebrow(text: "Library")
                    .padding(.horizontal, 12)
                    .padding(.bottom, 2)
                SidebarRow(title: "Home", systemName: "house", isActive: true)
                SidebarRow(title: "Browse media", systemName: "photo.on.rectangle") {
                    store.openViewport()
                }
            }

            VStack(alignment: .leading, spacing: 7) {
                SectionEyebrow(text: "Source")
                    .padding(.horizontal, 12)
                    .padding(.bottom, 2)
                SidebarRow(
                    title: store.folderURL == nil ? "Choose folder" : store.folderTitle,
                    systemName: store.folderURL == nil ? "folder.badge.plus" : "internaldrive",
                    trailing: store.folderURL == nil ? nil : store.items.count.formatted(),
                    action: store.chooseFolder
                )
            }

            Spacer(minLength: 0)

            LibraryStatus(
                title: store.isScanning ? "Scanning library" : (store.items.isEmpty ? "No media loaded" : "Library ready"),
                detail: store.isScanning ? "Finding supported images" : sidebarStatusDetail,
                isActive: store.isScanning
            )
            .padding(.bottom, 22)
        }
    }

    private var mainContent: some View {
        ScrollView(.vertical, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 22) {
                header

                if store.items.isEmpty && !store.isScanning {
                    EmptyLibraryCard()
                } else {
                    overview
                    latestSection
                }
            }
            .padding(.horizontal, 28)
            .padding(.top, 62)
            .padding(.bottom, 28)
        }
        .frame(maxWidth: .infinity)
    }

    private var header: some View {
        HStack(alignment: .bottom, spacing: 20) {
            VStack(alignment: .leading, spacing: 7) {
                SectionEyebrow(text: "Local media library")
                Text(store.folderURL == nil ? "Your visual archive" : store.folderTitle)
                    .font(.system(size: 29, weight: .semibold, design: .rounded))
                    .foregroundStyle(FolioPalette.text)
                    .lineLimit(1)
                Text(headerSubtitle)
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(FolioPalette.muted)
            }

            Spacer(minLength: 12)

            PrimaryActionButton(
                title: store.folderURL == nil ? "Choose folder" : "Change folder",
                systemName: "arrow.up.right",
                action: store.chooseFolder
            )
        }
    }

    private var overview: some View {
        HStack(spacing: 14) {
            LibraryHero(item: heroItem)
                .frame(maxWidth: .infinity)

            VStack(spacing: 14) {
                LibraryStatCard(
                    eyebrow: "Media",
                    value: store.items.count.formatted(),
                    caption: store.items.count == 1 ? "image ready to browse" : "images ready to browse",
                    systemName: "photo.stack",
                    accent: FolioPalette.teal
                )

                LibraryStatCard(
                    eyebrow: "On disk",
                    value: ByteCountFormatter.string(fromByteCount: Int64(clamping: totalBytes), countStyle: .file),
                    caption: "read directly from this folder",
                    systemName: "internaldrive",
                    accent: FolioPalette.amber
                )
            }
            .frame(width: 242)
        }
        .frame(height: 282)
    }

    private var latestSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Latest media")
                        .font(.system(size: 17, weight: .semibold, design: .rounded))
                        .foregroundStyle(FolioPalette.text)
                    Text("Most recently modified in this folder")
                        .font(.system(size: 11, weight: .medium, design: .rounded))
                        .foregroundStyle(FolioPalette.muted)
                }

                Spacer()

                Button("View all") {
                    store.openViewport()
                }
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .foregroundStyle(FolioPalette.amber)
                .buttonStyle(FolioPressStyle())
                .help("Browse all media")
            }

            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 12) {
                    ForEach(latestItems) { item in
                        LatestMediaCard(item: item)
                    }
                }
                .padding(.vertical, 2)
                .padding(.trailing, 18)
            }
        }
    }

    private var headerSubtitle: String {
        if store.isScanning { return "Scanning for supported images…" }
        guard !store.items.isEmpty else { return "Open a folder to start browsing, with nothing imported or uploaded." }
        return "\(store.items.count.formatted()) items · \(statusDetail)"
    }

    private var statusDetail: String {
        guard let modified = store.items.map(\.modified).max(), modified > 0 else {
            return store.items.isEmpty ? "Choose a local image folder" : "Stored locally"
        }
        let date = Date(timeIntervalSince1970: TimeInterval(modified))
        return "Latest change \(date.formatted(.relative(presentation: .named)))"
    }

    private var sidebarStatusDetail: String {
        guard let modified = store.items.map(\.modified).max(), modified > 0 else {
            return store.items.isEmpty ? "Choose a local image folder" : "Stored locally"
        }
        let date = Date(timeIntervalSince1970: TimeInterval(modified))
        return "Updated \(date.formatted(.relative(presentation: .named)))"
    }
}

private struct LibraryHero: View {
    @EnvironmentObject private var store: FolioStore
    let item: MediaItem?

    var body: some View {
        Button {
            if item == nil {
                store.chooseFolder()
            } else {
                store.openViewport()
            }
        } label: {
            SurfaceShell(radius: 28, inset: 5, innerFill: FolioPalette.panelRaised) {
                ZStack(alignment: .bottomLeading) {
                    if let item {
                        AsyncThumbnail(item: item, target: 920, contentMode: .fill)
                            .frame(maxWidth: .infinity)
                            .frame(height: 272)
                            .clipped()
                    } else {
                        LinearGradient(
                            colors: [FolioPalette.panelRaised, FolioPalette.panel],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                        .frame(height: 272)
                    }

                    LinearGradient(
                        colors: [.clear, .black.opacity(0.16), .black.opacity(0.82)],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                    .frame(height: 272)

                    HStack(alignment: .bottom, spacing: 14) {
                        VStack(alignment: .leading, spacing: 5) {
                            SectionEyebrow(text: "Current folder")
                                .foregroundStyle(.white.opacity(0.62))
                            Text(store.folderTitle)
                                .font(.system(size: 22, weight: .semibold, design: .rounded))
                                .foregroundStyle(.white)
                                .lineLimit(1)
                            Text("\(store.items.count.formatted()) items")
                                .font(.system(size: 12, weight: .medium, design: .rounded))
                                .foregroundStyle(.white.opacity(0.68))
                        }

                        Spacer(minLength: 12)

                        Image(systemName: item == nil ? "folder.badge.plus" : "arrow.up.right")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 36, height: 36)
                            .background(Circle().fill(.white.opacity(0.14)))
                    }
                    .padding(20)
                }
                .frame(maxWidth: .infinity)
                .frame(height: 272)
                .clipped()
            }
            .frame(height: 282)
            .clipped()
        }
        .buttonStyle(FolioPressStyle())
        .folioHoverLift()
        .accessibilityLabel(item == nil ? "Choose an image folder" : "Browse \(store.folderTitle)")
        .help(item == nil ? "Choose an image folder" : "Open the media viewer")
    }
}

private struct LibraryStatCard: View {
    let eyebrow: String
    let value: String
    let caption: String
    let systemName: String
    let accent: Color

    var body: some View {
        SurfaceShell(radius: 23, inset: 5, innerFill: accent.opacity(0.07)) {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    SectionEyebrow(text: eyebrow)
                    Spacer()
                    Image(systemName: systemName)
                        .font(.system(size: 13, weight: .light))
                        .foregroundStyle(accent)
                        .frame(width: 32, height: 32)
                        .background(Circle().fill(accent.opacity(0.10)))
                }

                Spacer(minLength: 8)

                Text(value)
                    .font(.system(size: 25, weight: .semibold, design: .rounded))
                    .foregroundStyle(FolioPalette.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                Text(caption)
                    .font(.system(size: 10, weight: .medium, design: .rounded))
                    .foregroundStyle(FolioPalette.muted)
                    .lineLimit(1)
            }
            .padding(15)
        }
        .frame(maxHeight: .infinity)
    }
}

private struct LatestMediaCard: View {
    @EnvironmentObject private var store: FolioStore
    let item: MediaItem

    var body: some View {
        Button {
            store.select(item)
            store.openViewport()
        } label: {
            SurfaceShell(radius: 18, inset: 4, innerFill: FolioPalette.panelRaised) {
                ZStack(alignment: .bottomLeading) {
                    AsyncThumbnail(item: item, target: 360, contentMode: .fill)
                        .frame(width: 148, height: 104)
                        .clipped()

                    LinearGradient(
                        colors: [.clear, .black.opacity(0.76)],
                        startPoint: .center,
                        endPoint: .bottom
                    )

                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.name)
                            .font(.system(size: 10, weight: .semibold, design: .rounded))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                        Text(ByteCountFormatter.string(fromByteCount: Int64(item.size), countStyle: .file))
                            .font(.system(size: 9, weight: .medium, design: .rounded))
                            .foregroundStyle(.white.opacity(0.62))
                    }
                    .frame(width: 126, alignment: .leading)
                    .padding(11)
                }
                .frame(width: 148, height: 104)
                .clipped()
            }
        }
        .buttonStyle(FolioPressStyle())
        .folioHoverLift()
        .accessibilityLabel("Open \(item.name)")
        .help(item.name)
    }
}

private struct EmptyLibraryCard: View {
    @EnvironmentObject private var store: FolioStore

    var body: some View {
        SurfaceShell(radius: 30, inset: 6, innerFill: FolioPalette.panel.opacity(0.82)) {
            HStack(spacing: 26) {
                ZStack {
                    Circle()
                        .fill(FolioPalette.amber.opacity(0.10))
                        .frame(width: 92, height: 92)
                    Image(systemName: "photo.on.rectangle.angled")
                        .font(.system(size: 30, weight: .ultraLight))
                        .foregroundStyle(FolioPalette.amber)
                }

                VStack(alignment: .leading, spacing: 8) {
                    SectionEyebrow(text: "Start here")
                    Text("Open an image folder")
                        .font(.system(size: 24, weight: .semibold, design: .rounded))
                        .foregroundStyle(FolioPalette.text)
                    Text("Folio reads your files in place. Nothing is imported, moved, or uploaded.")
                        .font(.system(size: 12, weight: .medium, design: .rounded))
                        .foregroundStyle(FolioPalette.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 18)

                PrimaryActionButton(title: "Choose folder", systemName: "arrow.up.right", action: store.chooseFolder)
            }
            .padding(28)
            .frame(minHeight: 210)
        }
    }
}
