import SwiftUI
import UIKit

/// The share sheet's one job: send what was shared, and what to do with it, to PersonalOS, and say
/// that PersonalOS has it. It executes nothing: PersonalOS does the work after this closes.
@MainActor
final class ShareModel: ObservableObject {
    enum Phase: Equatable {
        case loading
        case ready
        case sending
        case accepted(Receipt)
        case failed(String, retryable: Bool)
        case notSignedIn
        case unsupported(String)
    }

    @Published var phase: Phase = .loading
    @Published var instruction = ""
    private(set) var content = SharedContent()
    /// One id for this share, kept across retries: a retry is never a second request.
    let invocationId = "ios-" + UUID().uuidString.lowercased()
    private let submittedAt = Date().timeIntervalSince1970 * 1000

    func load(_ items: [NSExtensionItem]) async {
        content = await SharedContent.load(from: items)
        if CredentialStore.load() == nil { phase = .notSignedIn; return }
        if let refusal = content.refusal, content.context.isEmpty { phase = .unsupported(refusal); return }
        phase = content.context.isEmpty ? .unsupported("There's nothing here PersonalOS can take.") : .ready
    }

    func send() async {
        guard let credentials = CredentialStore.load() else { phase = .notSignedIn; return }
        phase = .sending
        let envelope = InvocationEnvelope(
            invocationId: invocationId,
            surface: .init(device: UIDevice.current.name, version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String),
            instruction: String(instruction.trimmingCharacters(in: .whitespacesAndNewlines).prefix(InvocationLimits.instructionChars)),
            context: content.context,
            submittedAt: submittedAt,
            timeZone: TimeZone.current.identifier
        )
        do {
            let receipt = try await PersonalOSClient(credentials: credentials).submit(envelope)
            phase = .accepted(receipt)
        } catch let error as PersonalOSError {
            if case .server(let code, _, _) = error, code == "UNAUTHORIZED" { CredentialStore.clear(); phase = .notSignedIn; return }
            phase = .failed(error.localizedDescription, retryable: error.retryable)
        } catch {
            phase = .failed(error.localizedDescription, retryable: true)
        }
    }

    var preview: String { content.summary }
}

struct ShareView: View {
    @ObservedObject var model: ShareModel
    var onDone: () -> Void
    var onCancel: () -> Void

    private let suggestions = ["Research this", "Remember this", "Remind me to read this tomorrow"]

    var body: some View {
        NavigationStack {
            Group {
                switch model.phase {
                case .loading:
                    ProgressView()
                case .notSignedIn:
                    message(icon: "person.crop.circle.badge.exclamationmark", title: "Sign in first", text: "Open the PersonalOS app and sign in, then share again.")
                case .unsupported(let reason):
                    message(icon: "doc.badge.ellipsis", title: "Can't share this yet", text: reason)
                case .accepted(let receipt):
                    message(icon: "checkmark.circle.fill", title: receipt.replayed ? "Already with PersonalOS" : "PersonalOS has it", text: receipt.message)
                case .ready, .sending, .failed:
                    compose
                }
            }
            .navigationTitle("PersonalOS")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { toolbar }
        }
    }

    private var compose: some View {
        Form {
            Section("Sharing") {
                Text(model.preview).font(.subheadline).lineLimit(3)
                if let url = model.content.url { Text(url.absoluteString).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                if let selection = model.content.selection { Text("“\(selection.prefix(200))”").font(.caption).foregroundStyle(.secondary).lineLimit(3) }
            }
            Section {
                TextField("What should PersonalOS do? (optional)", text: $model.instruction, axis: .vertical)
                    .lineLimit(2...6)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(suggestions, id: \.self) { s in
                            Button(s) { model.instruction = s }.buttonStyle(.bordered).font(.caption)
                        }
                    }
                }
            } footer: {
                Text("PersonalOS works on it after you close this, and checks what you've allowed it to do. Nothing is sent to anyone.")
            }
            if case .failed(let reason, let retryable) = model.phase {
                Section { Text(reason).foregroundStyle(.red) } footer: { if retryable { Text("Tap Send to try again; it won't be sent twice.") } }
            }
        }
        .disabled(model.phase == .sending)
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        switch model.phase {
        case .accepted, .notSignedIn, .unsupported:
            ToolbarItem(placement: .confirmationAction) { Button("Done", action: onDone) }
        default:
            ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) }
            ToolbarItem(placement: .confirmationAction) {
                if model.phase == .sending { ProgressView() } else { Button("Send") { Task { await model.send() } }.disabled(model.phase == .loading) }
            }
        }
    }

    private func message(icon: String, title: String, text: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: icon).font(.system(size: 44)).foregroundStyle(.tint)
            Text(title).font(.headline)
            Text(text).font(.subheadline).multilineTextAlignment(.center).foregroundStyle(.secondary)
        }
        .padding()
    }
}
