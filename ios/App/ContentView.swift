import SwiftUI

struct ContentView: View {
    @State private var credentials = CredentialStore.load()

    var body: some View {
        if let credentials {
            SharesView(credentials: credentials) { self.credentials = nil }
        } else {
            SignInView { self.credentials = $0 }
        }
    }
}

/// Sign in to your PersonalOS (FeltKit's own accounts). The session is kept in the Keychain group the
/// share extension reads; no password or API key is stored.
struct SignInView: View {
    var onSignedIn: (Credentials) -> Void
    @State private var server = "http://"
    @State private var email = ""
    @State private var password = ""
    @State private var create = false
    @State private var working = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("PersonalOS address", text: $server).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                } footer: {
                    Text("Your PersonalOS: for example http://your-mac.local:3000 on your own network, or its https address.")
                }
                Section {
                    TextField("Email", text: $email).keyboardType(.emailAddress).textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Password", text: $password).textContentType(create ? .newPassword : .password)
                    Toggle("Create an account", isOn: $create)
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
                Section {
                    Button(working ? "Signing in…" : create ? "Create account" : "Sign in") { Task { await signIn() } }
                        .disabled(working || email.isEmpty || password.isEmpty || URL(string: server)?.host == nil)
                }
            }
            .navigationTitle("PersonalOS")
        }
    }

    private func signIn() async {
        guard let url = URL(string: server.trimmingCharacters(in: .whitespacesAndNewlines)) else { return }
        working = true
        defer { working = false }
        do {
            let signedIn = try await PersonalOSClient(server: url, token: nil).signIn(email: email, password: password, create: create)
            let credentials = Credentials(server: url, token: signedIn.token, account: email, expiresAt: signedIn.expiresAt)
            guard CredentialStore.save(credentials) else { error = "Couldn't keep the session in the Keychain."; return }
            password = ""
            onSignedIn(credentials)
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// What you shared with PersonalOS, newest first, and what became of each: accepted, working on it,
/// needs your approval, done, or couldn't finish. Each opens in PersonalOS.
struct SharesView: View {
    let credentials: Credentials
    var onSignedOut: () -> Void
    @State private var rows: [InvocationRow] = []
    @State private var error: String?
    @Environment(\.openURL) private var openURL

    private var client: PersonalOSClient { PersonalOSClient(credentials: credentials) }

    var body: some View {
        NavigationStack {
            List {
                if rows.isEmpty && error == nil {
                    Text("Nothing shared yet. In Safari (or any app), tap Share, then PersonalOS.").foregroundStyle(.secondary)
                }
                if let error { Text(error).foregroundStyle(.red) }
                ForEach(rows) { row in
                    Button { openURL(client.link(for: row.open)) } label: { RowView(row: row) }
                }
            }
            .navigationTitle("Shared with PersonalOS")
            .refreshable { await refresh() }
            .task { await refresh() }
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Text("Signed in as \(credentials.account)")
                        Button("Open PersonalOS") { openURL(credentials.server) }
                        Button("Sign out", role: .destructive) { Task { await signOut() } }
                    } label: { Image(systemName: "person.crop.circle") }
                }
            }
        }
    }

    private func refresh() async {
        do {
            rows = try await client.recentInvocations()
            error = nil
        } catch let failure as PersonalOSError {
            if case .server(let code, _, _) = failure, code == "UNAUTHORIZED" { CredentialStore.clear(); onSignedOut(); return }
            error = failure.localizedDescription
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func signOut() async {
        await client.signOut()
        CredentialStore.clear()
        onSignedOut()
    }
}

private struct RowView: View {
    let row: InvocationRow

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(row.shared.first?.title ?? row.shared.first?.url ?? "Shared text").font(.headline).lineLimit(1)
                Spacer()
                Text(row.stateLabel).font(.caption).padding(.horizontal, 6).padding(.vertical, 2).background(color.opacity(0.15), in: Capsule()).foregroundStyle(color)
            }
            if !row.instruction.isEmpty { Text("“\(row.instruction)”").font(.subheadline) }
            Text(row.message).font(.caption).foregroundStyle(.secondary).lineLimit(4)
            Text(Date(timeIntervalSince1970: row.createdAt / 1000), style: .relative).font(.caption2).foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
    }

    private var color: Color {
        switch row.state {
        case "completed": return .green
        case "failed": return .red
        case "needs_approval": return .orange
        default: return .blue
        }
    }
}
