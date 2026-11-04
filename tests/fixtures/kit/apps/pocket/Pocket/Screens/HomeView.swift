import SwiftUI

struct HomeView: View {
    var body: some View {
        VStack(spacing: 12) {
            Text("Kit")
                .font(.custom("Kitserif-Bold", size: 28, relativeTo: .title))
                .foregroundStyle(Kit.C.ink)
            Text("A made-up app for the enforcer's tests")
                .font(.custom("Kitsans-Regular", size: 16, relativeTo: .body))
        }
        .background(Kit.C.surface)
    }
}
