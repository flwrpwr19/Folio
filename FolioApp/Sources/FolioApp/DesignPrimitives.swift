import SwiftUI

extension Animation {
    static let smoothFolio = Animation.timingCurve(0.22, 1.0, 0.36, 1.0, duration: 0.48)
    static let folioQuick = Animation.timingCurve(0.32, 0.72, 0.0, 1.0, duration: 0.24)
}

struct AmbientBackdrop: View {
    var body: some View {
        ZStack {
            FolioPalette.background

            RadialGradient(
                colors: [FolioPalette.teal.opacity(0.075), .clear],
                center: UnitPoint(x: 0.72, y: 0.06),
                startRadius: 0,
                endRadius: 560
            )

            RadialGradient(
                colors: [FolioPalette.coral.opacity(0.055), .clear],
                center: UnitPoint(x: 0.98, y: 0.92),
                startRadius: 0,
                endRadius: 520
            )

            DotMatrixField()
                .opacity(0.48)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}

struct DotMatrixField: View {
    private let columns = 56
    private let rows = 34

    var body: some View {
        Canvas { context, size in
            let xStep = size.width / CGFloat(columns)
            let yStep = size.height / CGFloat(rows)

            for row in 0..<rows {
                for column in 0..<columns {
                    let x = CGFloat(column) * xStep + xStep * 0.5
                    let y = CGFloat(row) * yStep + yStep * 0.5
                    let wave = sin((Double(column) * 0.37) + (Double(row) * 0.44))
                    let horizontalBias = sin((Double(column) / Double(columns)) * .pi)
                    let opacity = max(0.0, (wave + 1.0) * 0.055 * horizontalBias)
                    let radius = 0.65 + max(0, wave) * 0.65
                    let color = column > columns / 2 ? FolioPalette.amber : FolioPalette.teal

                    context.fill(
                        Path(ellipseIn: CGRect(x: x, y: y, width: radius, height: radius)),
                        with: .color(color.opacity(opacity))
                    )
                }
            }
        }
        .mask(
            RadialGradient(
                colors: [.black, .black.opacity(0.42), .clear],
                center: UnitPoint(x: 0.72, y: 0.36),
                startRadius: 70,
                endRadius: 760
            )
        )
    }
}

struct SurfaceShell<Content: View>: View {
    var radius: CGFloat = 24
    var inset: CGFloat = 5
    var innerFill = FolioPalette.panel
    @ViewBuilder let content: Content

    var body: some View {
        content
            .background {
                RoundedRectangle(cornerRadius: max(0, radius - inset), style: .continuous)
                    .fill(innerFill)
                    .overlay(alignment: .top) {
                        RoundedRectangle(cornerRadius: max(0, radius - inset), style: .continuous)
                            .stroke(.white.opacity(0.055), lineWidth: 0.7)
                    }
            }
            .clipShape(RoundedRectangle(cornerRadius: max(0, radius - inset), style: .continuous))
            .padding(inset)
            .background {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(.white.opacity(0.035))
                    .overlay {
                        RoundedRectangle(cornerRadius: radius, style: .continuous)
                            .stroke(.white.opacity(0.065), lineWidth: 0.7)
                    }
            }
    }
}

struct SectionEyebrow: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 10, weight: .semibold, design: .rounded))
            .tracking(1.7)
            .foregroundStyle(FolioPalette.muted)
    }
}

struct IconButton: View {
    let systemName: String
    let label: String
    var isActive = false
    var isEnabled = true
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 13, weight: .light))
                .foregroundStyle(iconColor)
                .frame(width: 36, height: 36)
                .background {
                    Circle()
                        .fill(isActive ? FolioPalette.coral.opacity(0.18) : .white.opacity(0.055))
                        .overlay {
                            Circle()
                                .stroke(isActive ? FolioPalette.coral.opacity(0.22) : .white.opacity(0.07), lineWidth: 0.7)
                        }
                }
        }
        .buttonStyle(FolioPressStyle())
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.34)
        .accessibilityLabel(label)
        .help(label)
        .animation(.folioQuick, value: isActive)
    }

    private var iconColor: Color {
        isActive ? FolioPalette.coral : FolioPalette.text.opacity(0.84)
    }
}

struct PrimaryActionButton: View {
    let title: String
    let systemName: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Text(title)
                    .font(.system(size: 13, weight: .semibold, design: .rounded))

                Image(systemName: systemName)
                    .font(.system(size: 11, weight: .semibold))
                    .frame(width: 28, height: 28)
                    .background(Circle().fill(.black.opacity(0.14)))
            }
            .foregroundStyle(Color(red: 0.10, green: 0.08, blue: 0.065))
            .padding(.leading, 18)
            .padding(.trailing, 6)
            .frame(height: 40)
            .background(Capsule().fill(FolioPalette.amber))
        }
        .buttonStyle(FolioPressStyle())
        .accessibilityLabel(title)
        .help(title)
    }
}

struct SecondaryActionButton: View {
    let title: String
    let systemName: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Image(systemName: systemName)
                    .font(.system(size: 12, weight: .light))
                Text(title)
                    .font(.system(size: 12, weight: .semibold, design: .rounded))
            }
            .foregroundStyle(FolioPalette.text.opacity(0.88))
            .padding(.horizontal, 14)
            .frame(height: 36)
            .background {
                Capsule()
                    .fill(.white.opacity(0.06))
                    .overlay(Capsule().stroke(.white.opacity(0.075), lineWidth: 0.7))
            }
        }
        .buttonStyle(FolioPressStyle())
        .accessibilityLabel(title)
        .help(title)
    }
}

struct SidebarRow: View {
    let title: String
    let systemName: String
    var isActive = false
    var trailing: String?
    var action: () -> Void = {}

    @State private var isHovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 11) {
                Image(systemName: systemName)
                    .font(.system(size: 13, weight: .light))
                    .frame(width: 18)
                Text(title)
                    .font(.system(size: 13, weight: .medium, design: .rounded))
                    .lineLimit(1)
                Spacer(minLength: 8)
                if let trailing {
                    Text(trailing)
                        .font(.system(size: 11, weight: .semibold, design: .rounded))
                        .foregroundStyle(FolioPalette.muted)
                }
            }
            .foregroundStyle(isActive ? FolioPalette.text : FolioPalette.text.opacity(0.72))
            .padding(.horizontal, 12)
            .frame(height: 38)
            .background {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(rowFill)
                    .overlay {
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .stroke(isActive ? .white.opacity(0.075) : .clear, lineWidth: 0.7)
                    }
            }
        }
        .buttonStyle(FolioPressStyle())
        .onHover { isHovering = $0 }
        .animation(.folioQuick, value: isHovering)
        .accessibilityLabel(title)
        .help(title)
    }

    private var rowFill: Color {
        if isActive { return .white.opacity(0.085) }
        return isHovering ? .white.opacity(0.045) : .clear
    }
}

struct SidebarShell<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack(spacing: 11) {
                DotLogo()
                Text("Folio")
                    .font(.system(size: 22, weight: .semibold, design: .rounded))
                    .foregroundStyle(FolioPalette.text)
            }
            .padding(.top, 68)

            content

            Spacer(minLength: 18)
        }
        .padding(.leading, 24)
        .padding(.trailing, 16)
        .frame(width: 220)
        .background {
            FolioPalette.sidebar
                .overlay(alignment: .trailing) {
                    LinearGradient(
                        colors: [.clear, .white.opacity(0.08), .clear],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                    .frame(width: 0.7)
                }
        }
    }
}

struct LibraryStatus: View {
    let title: String
    let detail: String
    let isActive: Bool

    var body: some View {
        SurfaceShell(radius: 17, inset: 4, innerFill: FolioPalette.panel.opacity(0.86)) {
            HStack(spacing: 10) {
                Circle()
                    .fill(isActive ? FolioPalette.amber : FolioPalette.teal)
                    .frame(width: 7, height: 7)
                    .shadow(color: (isActive ? FolioPalette.amber : FolioPalette.teal).opacity(0.45), radius: 5)

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.system(size: 12, weight: .semibold, design: .rounded))
                        .foregroundStyle(FolioPalette.text.opacity(0.88))
                    Text(detail)
                        .font(.system(size: 10, weight: .medium, design: .rounded))
                        .foregroundStyle(FolioPalette.muted)
                        .lineLimit(1)
                }

                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .frame(height: 48)
        }
    }
}

struct DotLogo: View {
    var body: some View {
        Canvas { context, _ in
            for row in 0..<3 {
                for column in 0..<3 {
                    let fade = Double(row + column) * 0.07
                    let color = (row + column).isMultiple(of: 2) ? FolioPalette.amber : FolioPalette.teal
                    context.fill(
                        Path(ellipseIn: CGRect(x: CGFloat(column) * 6.5, y: CGFloat(row) * 6.5, width: 3.4, height: 3.4)),
                        with: .color(color.opacity(0.78 - fade))
                    )
                }
            }
        }
        .frame(width: 18, height: 18)
        .accessibilityHidden(true)
    }
}

struct FolioPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.975 : 1)
            .opacity(configuration.isPressed ? 0.86 : 1)
            .animation(.folioQuick, value: configuration.isPressed)
    }
}

private struct HoverLiftModifier: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isHovering = false

    func body(content: Content) -> some View {
        content
            .scaleEffect(isHovering && !reduceMotion ? 1.006 : 1)
            .offset(y: isHovering && !reduceMotion ? -2 : 0)
            .onHover { isHovering = $0 }
            .animation(.smoothFolio, value: isHovering)
    }
}

extension View {
    func folioHoverLift() -> some View {
        modifier(HoverLiftModifier())
    }
}
