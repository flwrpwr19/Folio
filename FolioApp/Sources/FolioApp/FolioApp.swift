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

            CommandMenu("Navigate") {
                Button("Previous Image") {
                    store.selectRelative(-1)
                }
                .keyboardShortcut(.leftArrow, modifiers: [])
                .disabled(store.surface != .viewport || !store.canSelectPrevious)

                Button("Next Image") {
                    store.selectRelative(1)
                }
                .keyboardShortcut(.rightArrow, modifiers: [])
                .disabled(store.surface != .viewport || !store.canSelectNext)
            }
        }
    }
}

struct RootView: View {
    @EnvironmentObject private var store: FolioStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            AmbientBackdrop()
            WindowConfigurator()
                .frame(width: 0, height: 0)

            switch store.surface {
            case .home:
                HomeView()
                    .transition(.opacity.combined(with: .scale(scale: 0.985)))
            case .viewport:
                MinimalViewport()
                    .transition(.opacity.combined(with: .scale(scale: 1.01)))
            }

            VStack(spacing: 0) {
                HStack(spacing: 0) {
                    Color.clear
                        .frame(width: 86)
                        .allowsHitTesting(false)
                    WindowDragRegion()
                }
                    .frame(height: 52)
                Spacer(minLength: 0)
            }
            .allowsHitTesting(true)
        }
        .animation(reduceMotion ? nil : .smoothFolio, value: store.surface)
    }
}
