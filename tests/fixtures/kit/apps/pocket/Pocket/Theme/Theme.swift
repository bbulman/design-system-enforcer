import SwiftUI

enum Kit {
    enum C {
        static let ink = Color(hex: 0x1F2937)        // --color-ink
        static let brand = Color(hex: 0xC2410C)      // --brand
        static let surface = Color(hex: 0xFFFDF9)    // --bg-surface
        static let veil = Color.white.opacity(0.85)  // --overlay-medium
        static let line = Color(hex: 0xE0E0EA)
    }
}

enum Tone: Hashable {
    case quiz, poll
    var accent: Color {
        switch self {
        case .quiz: Color(hex: 0x7C3AED)
        case .poll: Color(hex: 0x0891B2)
        }
    }
}
