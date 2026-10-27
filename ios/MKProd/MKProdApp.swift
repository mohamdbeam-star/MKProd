import SwiftUI

/// MK Prod for iPhone and iPad: the same app as the website, Windows and Android, in a native
/// shell. Every feature and screen comes from the site, so it is always identical and current;
/// the shell adds the home-screen icon, a launch screen, safe-area handling, native dialogs,
/// file downloads to the share sheet, external links in Safari, an offline screen and
/// mkprod:// links.
@main
struct MKProdApp: App {
    @StateObject private var web = WebModel()

    var body: some Scene {
        WindowGroup {
            ContentView(web: web)
                .onOpenURL { web.open($0) }
        }
    }
}

struct ContentView: View {
    @ObservedObject var web: WebModel

    var body: some View {
        ZStack {
            Color("LaunchBackground").ignoresSafeArea()
            WebView(webView: web.webView)
                .ignoresSafeArea()               // the page pads itself with env(safe-area-inset-*)
                .opacity(web.loaded ? 1 : 0)
            if !web.loaded && !web.offline {
                VStack(spacing: 18) {
                    Image("Logo").resizable().frame(width: 96, height: 96)
                        .shadow(color: .black.opacity(0.15), radius: 12, y: 6)
                    ProgressView()
                }
                .transition(.opacity)
            }
            if web.offline { OfflineView { web.retry() } }
        }
        .animation(.easeOut(duration: 0.25), value: web.loaded)
        .animation(.easeOut(duration: 0.2), value: web.offline)
    }
}

struct OfflineView: View {
    var retry: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image("Logo").resizable().frame(width: 72, height: 72).opacity(0.9)
            Text("You're offline").font(.title2.bold())
            Text("MK Prod needs a connection to open. Your data is safe and syncs as soon as you're back online.")
                .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
            Button(action: retry) { Text("Try again").frame(minWidth: 140) }
                .buttonStyle(.borderedProminent).controlSize(.large)
        }
        .padding(32)
        .frame(maxWidth: 420)
    }
}
