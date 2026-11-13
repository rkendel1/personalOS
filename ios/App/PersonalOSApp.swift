import SwiftUI

/// The PersonalOS iOS app: sign in once (the share extension uses the same session), then follow what
/// you shared. The work itself happens in PersonalOS; this app and its extension only submit and show.
@main
struct PersonalOSApp: App {
    var body: some Scene {
        WindowGroup { ContentView() }
    }
}
