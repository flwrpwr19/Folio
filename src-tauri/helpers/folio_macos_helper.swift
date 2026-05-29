import AppKit
import AVKit
import CoreHaptics
import Foundation
import ObjectiveC
import Vision

final class SharePickerDelegate: NSObject, NSSharingServicePickerDelegate {
    let done: () -> Void
    init(done: @escaping () -> Void) { self.done = done }
    func sharingServicePicker(_ sharingServicePicker: NSSharingServicePicker, didChoose service: NSSharingService?) {
        done()
    }
}

func shareFile(path: String) {
    let url = URL(fileURLWithPath: path)
    guard FileManager.default.fileExists(atPath: path) else {
        fputs("file not found\n", stderr)
        exit(2)
    }

    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.activate(ignoringOtherApps: true)

    let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 2, height: 2),
        styleMask: [.borderless],
        backing: .buffered,
        defer: false
    )
    window.isOpaque = false
    window.backgroundColor = .clear
    window.level = .floating
    window.center()
    window.makeKeyAndOrderFront(nil)

    guard let view = window.contentView else { exit(2) }
    let picker = NSSharingServicePicker(items: [url])
    let delegate = SharePickerDelegate {
        NSApp.stop(nil)
        exit(0)
    }
    picker.delegate = delegate
    objc_setAssociatedObject(picker, "folio_delegate", delegate, .OBJC_ASSOCIATION_RETAIN)
    picker.show(relativeTo: view.bounds, of: view, preferredEdge: .minY)
    app.run()
}

func performHaptic(style: String) {
    guard CHHapticEngine.capabilitiesForHardware().supportsHaptics else {
        exit(0)
    }
    do {
        let engine = try CHHapticEngine()
        try engine.start()
        let intensity: Float
        switch style {
        case "snap", "heavy": intensity = 0.85
        case "medium": intensity = 0.55
        default: intensity = 0.35
        }
        let event = CHHapticEvent(
            eventType: .hapticTransient,
            parameters: [
                CHHapticEventParameter(parameterID: .hapticIntensity, value: intensity),
                CHHapticEventParameter(parameterID: .hapticSharpness, value: 0.45),
            ],
            relativeTime: 0
        )
        let pattern = try CHHapticPattern(events: [event], parameters: [])
        let player = try engine.makePlayer(with: pattern)
        try player.start(atTime: 0)
        Thread.sleep(forTimeInterval: 0.08)
        exit(0)
    } catch {
        fputs("haptic error: \(error.localizedDescription)\n", stderr)
        exit(2)
    }
}

struct ClassifyLabel: Codable {
    let label: String
    let confidence: Double
}

func classifyImage(path: String) {
    let url = URL(fileURLWithPath: path)
    guard let cgImage = NSImage(contentsOf: url)?.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        print("[]")
        exit(0)
    }

    let request = VNClassifyImageRequest()
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    do {
        try handler.perform([request])
        let observations = request.results ?? []
        let labels: [ClassifyLabel] = observations
            .filter { $0.confidence >= 0.08 }
            .sorted { $0.confidence > $1.confidence }
            .prefix(8)
            .map { ClassifyLabel(label: $0.identifier, confidence: Double($0.confidence)) }
        let data = try JSONEncoder().encode(labels)
        if let json = String(data: data, encoding: .utf8) {
            print(json)
        } else {
            print("[]")
        }
        exit(0)
    } catch {
        fputs("classify error: \(error.localizedDescription)\n", stderr)
        print("[]")
        exit(0)
    }
}

final class LivePhotoPanel: NSWindow {
    var player: AVPlayer?
    override func close() {
        player?.pause()
        player = nil
        super.close()
    }
}

func playLivePhoto(videoPath: String) {
    let url = URL(fileURLWithPath: videoPath)
    guard FileManager.default.fileExists(atPath: videoPath) else {
        fputs("video not found\n", stderr)
        exit(2)
    }

    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    app.activate(ignoringOtherApps: true)

    let player = AVPlayer(url: url)
    let playerView = AVPlayerView()
    playerView.player = player
    playerView.controlsStyle = .none
    playerView.frame = NSRect(x: 0, y: 0, width: 420, height: 420)

    let panel = LivePhotoPanel(
        contentRect: playerView.frame,
        styleMask: [.borderless, .fullSizeContentView],
        backing: .buffered,
        defer: false
    )
    panel.player = player
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.level = .floating
    panel.contentView = playerView
    panel.center()
    panel.makeKeyAndOrderFront(nil)

    player.actionAtItemEnd = .none
    player.play()

    let loop = NotificationCenter.default.addObserver(
        forName: .AVPlayerItemDidPlayToEndTime,
        object: player.currentItem,
        queue: .main
    ) { _ in
        player.seek(to: .zero)
        player.play()
    }

    DispatchQueue.main.asyncAfter(deadline: .now() + 8) {
        NotificationCenter.default.removeObserver(loop)
        panel.close()
        NSApp.stop(nil)
        exit(0)
    }

    app.run()
}

let args = CommandLine.arguments
guard args.count >= 2 else {
    fputs("usage: folio_macos_helper <share|haptic|classify|livephoto> ...\n", stderr)
    exit(2)
}

switch args[1] {
case "share":
    guard args.count >= 3 else { exit(2) }
    shareFile(path: args[2])
case "haptic":
    performHaptic(style: args.count >= 3 ? args[2] : "light")
case "classify":
    guard args.count >= 3 else { exit(2) }
    classifyImage(path: args[2])
case "livephoto":
    guard args.count >= 3 else { exit(2) }
    playLivePhoto(videoPath: args[2])
default:
    fputs("unknown command: \(args[1])\n", stderr)
    exit(2)
}
