import AppKit
import SwiftUI

struct WindowConfigurator: NSViewRepresentable {
    func makeNSView(context: Context) -> WindowConfiguratorView {
        WindowConfiguratorView()
    }

    func updateNSView(_ view: WindowConfiguratorView, context: Context) {
        view.configureWindowIfNeeded()
    }
}

struct WindowDragRegion: NSViewRepresentable {
    func makeNSView(context: Context) -> DragRegionView {
        DragRegionView()
    }

    func updateNSView(_ view: DragRegionView, context: Context) {}
}

final class WindowConfiguratorView: NSView {
    private static weak var configuredWindow: NSWindow?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        configureWindowIfNeeded()
    }

    func configureWindowIfNeeded() {
        guard let window else { return }

        window.styleMask.insert([.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView])
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.minSize = NSSize(width: 980, height: 680)
        window.backgroundColor = NSColor(red: 0.025, green: 0.027, blue: 0.030, alpha: 1)

        if Self.configuredWindow !== window {
            window.setContentSize(NSSize(width: 1480, height: 920))
            window.center()
            Self.configuredWindow = window
        }
    }
}

final class DragRegionView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? {
        let trafficLightCenters = [
            CGPoint(x: 24, y: 26),
            CGPoint(x: 62, y: 26),
            CGPoint(x: 100, y: 26)
        ]

        for center in trafficLightCenters {
            let dx = point.x - center.x
            let dy = point.y - center.y
            if (dx * dx + dy * dy) < 225 {
                return nil
            }
        }

        return self
    }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 {
            window?.zoom(nil)
            return
        }

        window?.performDrag(with: event)
    }
}
