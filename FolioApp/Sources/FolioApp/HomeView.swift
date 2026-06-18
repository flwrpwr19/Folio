import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var store: FolioStore

    private var heroItem: MediaItem? { store.selectedItem ?? store.items.first }
    private var recentItems: [MediaItem] { Array(store.items.prefix(5)) }

    var body: some View {
        HStack(spacing: 0) {
            SidebarShell {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Library")
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .foregroundStyle(FolioPalette.muted)
                    SidebarRow(title: "Home", systemName: "house", isActive: true)
                    SidebarRow(title: "Collections", systemName: "square.grid.2x2")
                    SidebarRow(title: "Folders", systemName: "folder")
                    SidebarRow(title: "All Media", systemName: "photo.on.rectangle")
                    SidebarRow(title: "Favorites", systemName: "heart")
                    SidebarRow(title: "Recently Added", systemName: "clock")
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("Sources")
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .foregroundStyle(FolioPalette.muted)
                    SidebarRow(title: "Open Folder", systemName: "folder.badge.plus", action: store.chooseFolder)
                    SidebarRow(title: store.folderTitle, systemName: "internaldrive", trailing: "\(store.items.count)")
                }

                VStack(spacing: 12) {
                    StorageCard()
                    StatusCard()
                }
            }

            mainContent
        }
        .background(FolioPalette.background)
        .ignoresSafeArea(.container, edges: .top)
    }

    private var mainContent: some View {
        ZStack {
            DotMatrixField()
                .offset(x: 70, y: -150)
                .opacity(0.62)

            ScrollView(.vertical, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 24) {
                    topBar

                    VStack(alignment: .leading, spacing: 14) {
                        Text("Recent")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(FolioPalette.text)
                        HeroAlbum(item: heroItem)
                    }

                    smartAlbums

                    VStack(alignment: .leading, spacing: 14) {
                        Text("Continue browsing")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundStyle(FolioPalette.text)

                        ScrollView(.horizontal, showsIndicators: false) {
                            HStack(spacing: 18) {
                                ForEach(recentItems) { item in
                                    RecentCard(item: item)
                                        .onTapGesture {
                                            store.select(item)
                                            store.openViewport()
                                        }
                                }
                                if recentItems.isEmpty {
                                    EmptyRecentCard()
                                }
                            }
                            .padding(.trailing, 24)
                        }
                    }
                }
                .padding(.horizontal, 32)
                .padding(.top, 32)
                .padding(.bottom, 38)
            }
        }
    }

    private var topBar: some View {
        HStack {
            Spacer(minLength: 12)
            SearchPill(placeholder: "Visual search")
            Spacer()
            HStack(spacing: 10) {
                IconButton(systemName: "slider.horizontal.3") {}
                IconButton(systemName: "bell") {}
                Button(action: store.chooseFolder) {
                    Image(systemName: "folder.badge.plus")
                        .font(.system(size: 14, weight: .regular))
                        .foregroundStyle(FolioPalette.text.opacity(0.84))
                        .frame(width: 38, height: 38)
                        .background(Circle().fill(.white.opacity(0.052)))
                }
                .buttonStyle(.plain)
            }
        }
        .frame(height: 46)
    }

    private var smartAlbums: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Smart Albums")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(FolioPalette.text)

            HStack(spacing: 16) {
                SmartAlbumCard(title: "Favorites", subtitle: "Best moments", icon: "heart", color: FolioPalette.coral)
                SmartAlbumCard(title: "Recently Added", subtitle: store.status, icon: "clock", color: FolioPalette.teal)
                SmartAlbumCard(title: "Duplicates", subtitle: "Review later", icon: "square.stack.3d.up", color: FolioPalette.amber)
            }
        }
    }
}

private struct HeroAlbum: View {
    @EnvironmentObject private var store: FolioStore
    let item: MediaItem?

    var body: some View {
        Button(action: store.openViewport) {
            ZStack(alignment: .bottomLeading) {
                if let item {
                    AsyncThumbnail(item: item, target: 1200, contentMode: .fill)
                        .frame(maxWidth: .infinity)
                        .aspectRatio(2.55, contentMode: .fit)
                        .clipped()
                } else {
                    LinearGradient(
                        colors: [FolioPalette.panelRaised, FolioPalette.panel],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                    .frame(maxWidth: .infinity)
                    .aspectRatio(2.55, contentMode: .fit)
                }

                LinearGradient(
                    colors: [.clear, .black.opacity(0.62)],
                    startPoint: .center,
                    endPoint: .bottom
                )

                HStack(spacing: 14) {
                    Image(systemName: "folder.fill")
                        .font(.system(size: 22, weight: .regular))
                        .foregroundStyle(FolioPalette.text.opacity(0.85))
                        .frame(width: 50, height: 50)
                        .background(RoundedRectangle(cornerRadius: 15, style: .continuous).fill(.white.opacity(0.13)))

                    VStack(alignment: .leading, spacing: 4) {
                        Text(store.folderTitle)
                            .font(.system(size: 22, weight: .semibold))
                        Text("\(store.items.count.formatted()) items  ·  \(store.isScanning ? "Scanning" : "Updated now")")
                            .font(.system(size: 14, weight: .medium))
                            .foregroundStyle(FolioPalette.text.opacity(0.72))
                    }

                    Spacer()

                    Image(systemName: "chevron.right")
                        .font(.system(size: 21, weight: .semibold))
                        .foregroundStyle(FolioPalette.text)
                        .frame(width: 48, height: 48)
                        .background(Circle().fill(.black.opacity(0.25)).overlay(Circle().stroke(.white.opacity(0.1), lineWidth: 1)))
                }
                .padding(22)
            }
            .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .stroke(.white.opacity(0.11), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.18), radius: 28, x: 0, y: 18)
        }
        .buttonStyle(.plain)
    }
}

private struct SmartAlbumCard: View {
    let title: String
    let subtitle: String
    let icon: String
    let color: Color

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 20, weight: .regular))
                .foregroundStyle(.white.opacity(0.9))
                .frame(width: 44, height: 44)
                .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(color.opacity(0.36)))
            VStack(alignment: .leading, spacing: 5) {
                Text(title)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(FolioPalette.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.78)
                Text(subtitle)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(FolioPalette.muted)
                    .lineLimit(1)
            }
            Spacer()
            Image(systemName: "chevron.right")
                .foregroundStyle(FolioPalette.text.opacity(0.64))
        }
        .padding(.horizontal, 18)
        .frame(maxWidth: .infinity, minHeight: 82)
        .background {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(color.opacity(0.085))
                .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(.white.opacity(0.070), lineWidth: 1))
        }
    }
}

private struct RecentCard: View {
    let item: MediaItem

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            AsyncThumbnail(item: item, target: 420, contentMode: .fill)
                .frame(width: 176, height: 126)
                .clipped()
            LinearGradient(colors: [.clear, .black.opacity(0.72)], startPoint: .top, endPoint: .bottom)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.name)
                    .lineLimit(1)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(FolioPalette.text)
                Text(ByteCountFormatter.string(fromByteCount: Int64(item.size), countStyle: .file))
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(FolioPalette.text.opacity(0.68))
            }
            .padding(14)
        }
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).stroke(.white.opacity(0.08), lineWidth: 1))
    }
}

private struct EmptyRecentCard: View {
    @EnvironmentObject private var store: FolioStore

    var body: some View {
        Button(action: store.chooseFolder) {
            VStack(spacing: 12) {
                Image(systemName: "folder.badge.plus")
                    .font(.system(size: 24, weight: .regular))
                    .foregroundStyle(FolioPalette.amber)
                Text("Open a folder")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(FolioPalette.text)
            }
            .frame(width: 176, height: 126)
            .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(.white.opacity(0.052)))
        }
        .buttonStyle(.plain)
    }
}

private struct StorageCard: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Library Storage")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(FolioPalette.muted)
            Text("Local only")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(FolioPalette.text.opacity(0.85))
            GeometryReader { proxy in
                Capsule()
                    .fill(.white.opacity(0.11))
                    .overlay(alignment: .leading) {
                        Capsule()
                            .fill(FolioPalette.teal)
                            .frame(width: proxy.size.width * 0.38)
                    }
            }
            .frame(height: 5)
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.white.opacity(0.048)))
    }
}

private struct StatusCard: View {
    @EnvironmentObject private var store: FolioStore

    var body: some View {
        HStack {
            Image(systemName: store.isScanning ? "waveform" : "checkmark.circle")
                .foregroundStyle(store.isScanning ? FolioPalette.amber : FolioPalette.teal)
            Text(store.isScanning ? "Scanning" : "All Good")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(FolioPalette.text.opacity(0.85))
            Spacer()
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(.white.opacity(0.048)))
    }
}
