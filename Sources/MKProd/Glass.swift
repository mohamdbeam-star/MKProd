import SwiftUI

/// Liquid Glass design system. On macOS 26 the real glass material is used (translucent,
/// refracting what's behind it, with specular edges); earlier systems get a frosted material
/// that reads the same way. Standard controls, toolbars, sidebars and inspectors pick up
/// Liquid Glass automatically from the macOS 26 SDK; these helpers cover our own surfaces.
enum MKGlass {
    static let cardRadius: CGFloat = 14
}

/// A floating card: content panel, dashboard tile, board card, popover.
struct MKCard: ViewModifier {
    var radius: CGFloat = MKGlass.cardRadius
    var tint: Color? = nil
    var interactive = false

    func body(content: Content) -> some View {
        #if compiler(>=6.2)
        // Built with the macOS 26 SDK: real Liquid Glass when running on macOS 26.
        if #available(macOS 26.0, *) {
            content.glassEffect(glass, in: .rect(cornerRadius: radius))
        } else {
            frosted(content)
        }
        #else
        // Older toolchain (no glassEffect in the SDK): frosted material everywhere.
        frosted(content)
        #endif
    }

    private func frosted(_ content: Content) -> some View {
        content
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Color.white.opacity(0.35), lineWidth: 0.5).blendMode(.plusLighter))
            .overlay(RoundedRectangle(cornerRadius: radius, style: .continuous).strokeBorder(Color.primary.opacity(0.07)))
            .shadow(color: .black.opacity(0.06), radius: 10, y: 4)
    }

    #if compiler(>=6.2)
    @available(macOS 26.0, *)
    private var glass: Glass {
        var g: Glass = .regular
        if let tint { g = g.tint(tint) }
        if interactive { g = g.interactive() }
        return g
    }
    #endif
}

extension View {
    /// Liquid Glass card surface (see `MKCard`).
    func mkCard(radius: CGFloat = MKGlass.cardRadius, tint: Color? = nil, interactive: Bool = false) -> some View {
        modifier(MKCard(radius: radius, tint: tint, interactive: interactive))
    }

    /// Full-bleed reading surface (inspector, editors): a thin frosted layer over the backdrop.
    func mkSurface() -> some View {
        background(.ultraThinMaterial)
    }
}

/// Soft, tinted backdrop behind every page so the glass has colour and depth to refract.
/// Mirrors the website's body gradient.
struct MKBackdrop: View {
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)
            LinearGradient(colors: [Color.accentColor.opacity(scheme == .dark ? 0.14 : 0.10), .clear, Color(hex: "#12B5CB").opacity(scheme == .dark ? 0.10 : 0.07)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
            Circle().fill(Color.accentColor.opacity(scheme == .dark ? 0.20 : 0.16)).frame(width: 460, height: 460).blur(radius: 110).offset(x: -220, y: -240)
            Circle().fill(Color(hex: "#D6409F").opacity(scheme == .dark ? 0.12 : 0.09)).frame(width: 420, height: 420).blur(radius: 120).offset(x: 320, y: -160)
            Circle().fill(Color(hex: "#12B5CB").opacity(scheme == .dark ? 0.12 : 0.09)).frame(width: 520, height: 520).blur(radius: 130).offset(x: 180, y: 320)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}
