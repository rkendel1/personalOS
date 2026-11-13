import Foundation

/// `personalos.invocation/1` (docs/INVOCATION-CONTRACT.md): what this surface submits. There is no
/// principal in it: PersonalOS takes who is asking from the session, never from the envelope.
struct InvocationEnvelope: Encodable {
    var contract: String = "personalos.invocation/1"
    /// Chosen once per share and sent unchanged on every retry, so a retry is never a second request.
    var invocationId: String
    var surface: Surface
    /// What the person asked, in their words (may be empty).
    var instruction: String
    /// What they shared: data, never instructions.
    var context: [ContextItem]
    /// Milliseconds since 1970, by this device's clock.
    var submittedAt: Double
    var timeZone: String
    var returnTo = ReturnTo()

    struct Surface: Encodable {
        var adapter = "ios-share"
        var device: String?
        var version: String?
    }

    struct ReturnTo: Encodable {
        var kind = "personalos"
    }
}

struct ContextItem: Encodable, Equatable {
    /// "url", "text", "selection" or "document".
    var kind: String
    var url: String?
    var title: String?
    var text: String?
    var name: String?
    var mediaType: String?
    var size: Int?
}

/// What PersonalOS answers: accepted, and where to follow it.
struct Receipt: Decodable, Equatable {
    var contract: String
    var invocationId: String
    /// accepted, processing, needs_approval, completed or failed.
    var state: String
    var replayed: Bool
    var receivedAt: Double
    var conversationId: String
    /// A path below the PersonalOS address (#/chat/<id>, #/research).
    var open: String
    var message: String
    var error: ErrorInfo?

    struct ErrorInfo: Decodable, Equatable {
        var code: String
        var message: String
    }
}

/// One of the person's recent invocations, as the app lists them.
struct InvocationRow: Decodable, Identifiable, Equatable {
    var invocationId: String
    var state: String
    var open: String
    var message: String
    var adapter: String
    var instruction: String
    var shared: [Shared]
    var createdAt: Double
    var error: Receipt.ErrorInfo?

    var id: String { invocationId }

    struct Shared: Decodable, Equatable {
        var kind: String
        var url: String?
        var title: String?
    }

    /// The words the person sees for each state.
    var stateLabel: String {
        switch state {
        case "accepted": return "Accepted"
        case "processing": return "Working on it"
        case "needs_approval": return "Needs your approval"
        case "completed": return "Done"
        case "failed": return "Couldn't finish"
        default: return state
        }
    }
}

/// Text documents PersonalOS reads, and its limits (the server enforces them too).
enum InvocationLimits {
    static let documentTypes: Set<String> = ["text/plain", "text/markdown", "text/csv", "text/html"]
    static let documentBytes = 256 * 1024
    static let textChars = 20_000
    static let instructionChars = 2_000
}
