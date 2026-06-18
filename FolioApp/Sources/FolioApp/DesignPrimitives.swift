import SwiftUI

extension Animation {
    static let smoothFolio = Animation.timingCurve(0.22, 1.0, 0.36, 1.0, duration: 0.42)
    static let folioQuick = Animation.timingCurve(0.32, 0.72, 0.0, 1.0, duration: 0.22)
}

struct DotMatrixField: View {
    private let columns = 50
    private let rows = 20

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 24.0)) { timeline in
            Canvas { context, size in
                let time = timeline.date.timeIntervalSinceReferenceDate
                let xStep = size.width / CGFloat(columns)
                let yStep = size.height / CGFloat(rows)

                for row in 0..<rows {
                    for column in 0..<columns {
                        let x = CGFloat(column) * xStep + xStep * 0.5
                        let y = CGFloat(row) * yStep + yStep * 0.5
                        let wave = sin((Double(column) * 0.34) + (Double(row) * 0.42) + time * 0.45)
                        let verticalBias = sin((Double(row) / Double(rows)) * .pi)
                        let opacity = max(0.0, (wave + 1.0) * 0.11 * verticalBias)
                        let radius = 0.85 + max(0, wave) * 0.95
                        let color = column > columns / 2 ? FolioPalette.amber : FolioPalette.teal

                        context.fill(
                            Path(ellipseIn: CGRect(x: x, y: y, width: radius, height: radius)),
                            with: .color(color.opacity(opacity))
                        )
                    }
                }
            }
        }
        .allowsHitTesting(false)
        .mask(
            RadialGradient(
                colors: [.black, .black.opacity(0.58), .clear],
                center: .center,
                startRadius: 90,
                endRadius: 860
            )
        )
    }
}

struct GlassPanel<Content: View>: View {
    var radius: CGFloat = 24
    var opacity: Double = 0.76
    @ViewBuilder let content: Content

    var body: some View {
        content
            .background {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(FolioPalette.panel.opacity(opacity))
                    .overlay(
                        RoundedRectangle(cornerRadius: radius, style: .continuous)
                            .stroke(.white.opacity(0.075), lineWidth: 1)
                    )
                    .shadow(color: .black.opacity(0.18), radius: 28, x: 0, y: 18)
            }
    }
}

struct IconButton: View {
    let systemName: String
    var isActive = false
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 14, weight: .regular))
                .foregroundStyle(isActive ? FolioPalette.coral : FolioPalette.text.opacity(0.82))
                .frame(width: 38, height: 38)
                .background {
                    Circle()
                        .fill(isActive ? FolioPalette.coral.opacity(0.14) : .white.opacity(0.055))
                        .overlay(Circle().stroke(.white.opacity(0.08), lineWidth: 1))
                }
        }
        .buttonStyle(.plain)
        .contentShape(Circle())
        .scaleEffect(isActive ? 1.02 : 1.0)
        .animation(.folioQuick, value: isActive)
    }
}

struct SearchPill: View {
    let placeholder: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 14, weight: .regular))
                .foregroundStyle(FolioPalette.text.opacity(0.72))
            Text(placeholder)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(FolioPalette.text.opacity(0.70))
            Spacer()
            Text("⌘K")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(FolioPalette.muted)
        }
        .padding(.horizontal, 18)
        .frame(width: 350, height: 44)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.white.opacity(0.055))
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(.white.opacity(0.075), lineWidth: 1)
                )
        }
    }
}

struct SidebarRow: View {
    let title: String
    let systemName: String
    var isActive = false
    var trailing: String?
    var action: () -> Void = {}

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image(systemName: systemName)
                .font(.system(size: 14, weight: .regular))
                    .frame(width: 18)
                Text(title)
                    .font(.system(size: 13, weight: .medium))
                Spacer()
                if let trailing {
                    Text(trailing)
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(FolioPalette.muted)
                }
            }
            .foregroundStyle(isActive ? FolioPalette.text : FolioPalette.text.opacity(0.74))
            .padding(.horizontal, 12)
            .frame(height: 36)
            .background {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .fill(isActive ? .white.opacity(0.085) : .clear)
                    .overlay(
                        RoundedRectangle(cornerRadius: 11, style: .continuous)
                            .stroke(isActive ? .white.opacity(0.08) : .clear, lineWidth: 1)
                    )
            }
        }
        .buttonStyle(.plain)
    }
}

struct SidebarShell<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack(spacing: 12) {
                DotLogo()
                Text("Folio")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(FolioPalette.text)
            }
            .padding(.top, 76)

            content

            Spacer(minLength: 0)
        }
        .padding(.leading, 28)
        .padding(.trailing, 18)
        .frame(width: 236)
        .background {
            Rectangle()
                .fill(FolioPalette.panel.opacity(0.52))
                .overlay(alignment: .trailing) {
                    Rectangle().fill(.white.opacity(0.07)).frame(width: 1)
                }
        }
    }
}

struct DotLogo: View {
    var body: some View {
        Canvas { context, _ in
            for row in 0..<3 {
                for column in 0..<3 {
                    let delay = Double(row + column) * 0.07
                    let color = (row + column).isMultiple(of: 2) ? FolioPalette.amber : FolioPalette.teal
                    context.fill(
                        Path(ellipseIn: CGRect(x: CGFloat(column) * 6.5, y: CGFloat(row) * 6.5, width: 3.4, height: 3.4)),
                        with: .color(color.opacity(0.72 - delay))
                    )
                }
            }
        }
        .frame(width: 18, height: 18)
    }
}
