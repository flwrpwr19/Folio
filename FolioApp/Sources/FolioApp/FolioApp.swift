import SwiftUI

@main
struct FolioApp: App {
    @StateObject private var store = FolioStore()
    @StateObject private var thumbnails = ThumbnailStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environmentObject(thumbnails)
                .frame(minWidth: 980, minHeight: 680)
                .preferredColorScheme(.dark)
                .task {
                    await store.bootstrap()
                }
        }
        .windowStyle(.hiddenTitleBar)
        .windowToolbarStyle(.unifiedCompact)
        .commands {
            CommandMenu("Folio") {
                Button("Open Folder...") {
                    store.chooseFolder()
                }
                .keyboardShortcut("o", modifiers: [.command])

                Button("Show Home") {
                    store.backHome()
                }
                .keyboardShortcut("1", modifiers: [.command])

                Button("Show Viewport") {
                    store.openViewport()
                }
                .keyboardShortcut("2", modifiers: [.command])
            }
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var store: FolioStore

    var body: some View {
        ZStack {
            FolioPalette.background.ignoresSafeArea()
            WindowConfigurator()
                .frame(width: 0, height: 0)

            DotMatrixField()
                .opacity(0.72)
                .ignoresSafeArea()

            switch store.surface {
            case .home:
                HomeView()
                    .transition(.opacity.combined(with: .scale(scale: 0.985)))
            case .viewport:
                MinimalViewport()
                    .transition(.opacity.combined(with: .scale(scale: 1.01)))
            }

            VStack(spacing: 0) {
                WindowDragRegion()
                    .frame(height: 52)
                Spacer(minLength: 0)
            }
            .allowsHitTesting(true)
        }
        .animation(.smoothFolio, value: store.surface)
    }
}
