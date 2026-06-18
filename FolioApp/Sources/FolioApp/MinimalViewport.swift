import SwiftUI

struct MinimalViewport: View {
    @EnvironmentObject private var store: FolioStore
    @State private var showDetails = false
    @State private var showChrome = true

    private var selected: MediaItem? { store.selectedItem ?? store.items.first }
    private var filmstripItems: [MediaItem] {
        guard !store.items.isEmpty else { return [] }
        guard let selected, let index = store.items.firstIndex(of: selected) else {
            return Array(store.items.prefix(10))
        }
        let lower = max(0, index - 4)
        let upper = min(store.items.count, index + 6)
        return Array(store.items[lower..<upper])
    }

    var body: some View {
        ZStack {
            FolioPalette.background.ignoresSafeArea()
            DotMatrixField()
                .opacity(0.46)
                .offset(x: 140, y: 120)

            if let selected {
                imageStage(selected)
                    .padding(.horizontal, 30)
                    .padding(.top, 30)
                    .padding(.bottom, 118)
            } else {
                emptyViewport
            }

            if showChrome {
                VStack {
                    topCommandStrip
                    Spacer()
                    bottomScrubber
                }
                .padding(.horizontal, 34)
                .padding(.top, 28)
                .padding(.bottom, 28)
                .transition(.opacity.combined(with: .scale(scale: 0.985)))
            }

            if showDetails, let selected {
                detailsPopover(selected)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                    .padding(.trailing, 56)
                    .padding(.bottom, 134)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            withAnimation(.smoothFolio) { showChrome.toggle() }
        }
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
        .animation(.smoothFolio, value: showChrome)
        .animation(.smoothFolio, value: showDetails)
    }

    private func imageStage(_ item: MediaItem) -> some View {
        GeometryReader { proxy in
            ZStack {
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .fill(FolioPalette.panel.opacity(0.52))

                AsyncThumbnail(item: item, target: max(proxy.size.width, proxy.size.height) * 1.8, contentMode: .fit)
                    .padding(18)

                VStack {
                    Spacer()
                    HStack {
                        tinyMetadata(item)
                        Spacer()
                    }
                    .padding(28)
                    .opacity(showChrome ? 1 : 0)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 26, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 26, style: .continuous)
                    .stroke(.white.opacity(0.085), lineWidth: 1)
            )
            .shadow(color: .black.opacity(0.25), radius: 38, x: 0, y: 22)
        }
    }

    private var topCommandStrip: some View {
        HStack(spacing: 14) {
            IconButton(systemName: "chevron.left") { store.backHome() }

            VStack(alignment: .leading, spacing: 2) {
                Text(store.folderTitle)
                    .font(.system(size: 16, weight: .semibold, design: .rounded))
                    .foregroundStyle(FolioPalette.text)
                Text("\(store.items.count.formatted())")
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .foregroundStyle(FolioPalette.muted)
            }

            Spacer()

            SearchPill(placeholder: "Visual search")
                .frame(width: 310)

            IconButton(systemName: "info", isActive: showDetails) {
                showDetails.toggle()
            }
            IconButton(systemName: "arrow.up.left.and.arrow.down.right") {}
        }
        .padding(8)
        .background {
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(FolioPalette.panel.opacity(0.78))
                .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).stroke(.white.opacity(0.08), lineWidth: 1))
                .shadow(color: .black.opacity(0.16), radius: 24, x: 0, y: 16)
        }
    }

    private var bottomScrubber: some View {
        HStack(spacing: 14) {
            Text("\(store.items.count.formatted()) items")
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .foregroundStyle(FolioPalette.text.opacity(0.74))
                .frame(width: 92, alignment: .leading)

            ScrollView(.horizontal, showsIndicators: false) {
                LazyHStack(spacing: 12) {
                    ForEach(filmstripItems) { item in
                        Button {
                            store.select(item)
                        } label: {
                            AsyncThumbnail(item: item, target: 180, contentMode: .fill)
                                .frame(width: 92, height: 62)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                                        .stroke(item == selected ? FolioPalette.coral : .white.opacity(0.08), lineWidth: item == selected ? 2 : 1)
                                )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, 8)
            }

            HStack(spacing: 10) {
                IconButton(systemName: "chevron.left") { store.selectRelative(-1) }
                IconButton(systemName: "chevron.right") { store.selectRelative(1) }
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 10)
        .frame(height: 96)
        .background {
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(FolioPalette.panel.opacity(0.82))
                .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).stroke(.white.opacity(0.08), lineWidth: 1))
                .shadow(color: .black.opacity(0.18), radius: 28, x: 0, y: 16)
        }
    }

    private func tinyMetadata(_ item: MediaItem) -> some View {
        HStack(spacing: 14) {
            Image(systemName: "heart")
            Text(item.name)
                .lineLimit(1)
            Text("5 stars")
                .foregroundStyle(FolioPalette.amber)
        }
        .font(.system(size: 13, weight: .semibold, design: .rounded))
        .foregroundStyle(FolioPalette.text.opacity(0.86))
        .padding(.horizontal, 16)
        .frame(height: 42)
        .background {
            Capsule()
                .fill(.black.opacity(0.34))
                .overlay(Capsule().stroke(.white.opacity(0.10), lineWidth: 1))
        }
    }

    private func detailsPopover(_ item: MediaItem) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Details")
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(FolioPalette.text)
                Spacer()
                Button {
                    showDetails = false
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundStyle(FolioPalette.muted)
                }
                .buttonStyle(.plain)
            }

            VStack(alignment: .leading, spacing: 10) {
                DetailRow(label: "File", value: item.name)
                DetailRow(label: "Size", value: ByteCountFormatter.string(fromByteCount: Int64(item.size), countStyle: .file))
                DetailRow(label: "Modified", value: Date(timeIntervalSince1970: TimeInterval(item.modified)).formatted(date: .abbreviated, time: .shortened))
            }

            HStack(spacing: 8) {
                ForEach([FolioPalette.teal, FolioPalette.moss, FolioPalette.amber, FolioPalette.coral], id: \.self) { color in
                    Circle()
                        .fill(color.opacity(0.72))
                        .frame(width: 20, height: 20)
                }
            }
        }
        .padding(20)
        .frame(width: 292)
        .background {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(FolioPalette.panel.opacity(0.90))
                .overlay(RoundedRectangle(cornerRadius: 24, style: .continuous).stroke(.white.opacity(0.09), lineWidth: 1))
                .shadow(color: .black.opacity(0.20), radius: 24, x: 0, y: 16)
        }
    }

    private var emptyViewport: some View {
        VStack(spacing: 18) {
            Image(systemName: "photo.on.rectangle.angled")
                .font(.system(size: 48, weight: .light))
                .foregroundStyle(FolioPalette.amber)
            Text("Open an image folder")
                .font(.system(size: 24, weight: .semibold, design: .rounded))
                .foregroundStyle(FolioPalette.text)
            Button("Open Folder", action: store.chooseFolder)
                .buttonStyle(.borderedProminent)
                .tint(FolioPalette.coral)
        }
    }
}

private struct DetailRow: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.system(size: 11, weight: .semibold, design: .rounded))
                .foregroundStyle(FolioPalette.muted)
            Text(value)
                .font(.system(size: 13, weight: .medium, design: .rounded))
                .foregroundStyle(FolioPalette.text.opacity(0.86))
                .lineLimit(2)
        }
    }
}
