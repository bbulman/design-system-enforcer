import SwiftUI

struct MainView: View {
    var body: some View {
        Text("Desk")
            .font(.custom("Kitsans-Regular", fixedSize: 13))
            .foregroundStyle(Desk.ink)
            .background(Desk.page)
    }
}
