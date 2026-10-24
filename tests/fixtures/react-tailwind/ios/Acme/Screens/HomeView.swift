import SwiftUI

struct HomeView: View {
    var body: some View {
        Text("Hi")
            .foregroundStyle(Palette.ink)
            .background(Color(hex: 0xFF0000))
            .foregroundColor(.black)
    }
}
