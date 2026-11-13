import Foundation

/// What went wrong, in the person's terms, and whether trying again could help.
enum PersonalOSError: LocalizedError {
    case server(code: String, message: String, status: Int)
    case notSignedIn
    case badResponse(Int)
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .server(let code, let message, _):
            switch code {
            case "UNAUTHORIZED": return "Your PersonalOS session has ended. Open PersonalOS and sign in again."
            default: return message
            }
        case .notSignedIn: return "Open the PersonalOS app and sign in first."
        case .badResponse(let status): return "PersonalOS answered unexpectedly (HTTP \(status))."
        case .transport(let detail): return "Couldn't reach PersonalOS (\(detail))."
        }
    }

    /// A retry with the same invocation id is always safe; these are the cases where it can help.
    var retryable: Bool {
        switch self {
        case .server(let code, _, let status): return code == "CONFLICT" && status == 409 || code == "UNAVAILABLE" || status >= 500
        case .transport: return true
        case .badResponse(let status): return status >= 500
        case .notSignedIn: return false
        }
    }
}

/// The PersonalOS HTTP API (FeltKit): bearer session, `POST /api/<kind>/<module>:<function>` with `{ args }`.
struct PersonalOSClient {
    let server: URL
    let token: String?
    var session: URLSession = .shared

    init(server: URL, token: String?) {
        self.server = server
        self.token = token
    }

    init(credentials: Credentials) {
        self.init(server: credentials.server, token: credentials.token)
    }

    // MARK: Account (FeltKit built-in accounts)

    struct SignedIn: Decodable {
        var token: String
        var expiresAt: String?
    }

    /// Sign in (or create the account) with email and password: FeltKit answers a non-browser client with its session token.
    func signIn(email: String, password: String, create: Bool) async throws -> SignedIn {
        struct Body: Encodable { var email: String; var password: String }
        let data = try await post(path: create ? "/api/auth/signup" : "/api/auth/signin", body: Body(email: email, password: password), authorized: false)
        if let signedIn = try? JSONDecoder().decode(SignedIn.self, from: data) { return signedIn }
        struct Verify: Decodable { var message: String? }
        let verify = try? JSONDecoder().decode(Verify.self, from: data)
        throw PersonalOSError.server(code: "VERIFY", message: verify?.message ?? "Check your e-mail to verify the account, then sign in.", status: 201)
    }

    /// End this session in PersonalOS (it stops working everywhere, including the share extension).
    func signOut() async {
        struct Empty: Encodable {}
        _ = try? await post(path: "/api/auth/signout", body: Empty(), authorized: true)
    }

    // MARK: Invocations

    /// Submit a share. A refusal that says "safe to retry" (two deliveries at once) is retried with
    /// the same id, which PersonalOS answers with the first one's receipt.
    func submit(_ envelope: InvocationEnvelope) async throws -> Receipt {
        struct Args: Encodable { var envelope: InvocationEnvelope }
        var attempt = 0
        while true {
            do {
                return try await call("mutation", "invocations:submit", args: Args(envelope: envelope))
            } catch let error as PersonalOSError where error.retryable && attempt < 3 {
                attempt += 1
                try await Task.sleep(nanoseconds: UInt64(attempt) * 700_000_000)
            }
        }
    }

    func recentInvocations(limit: Int = 20) async throws -> [InvocationRow] {
        struct Args: Encodable { var limit: Int }
        return try await call("query", "invocationstate:list", args: Args(limit: limit))
    }

    /// Where to open an invocation's result in PersonalOS.
    func link(for open: String) -> URL {
        URL(string: server.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + "/" + open) ?? server
    }

    // MARK: HTTP

    private struct Answer<T: Decodable>: Decodable {
        var ok: Bool
        var value: T?
        var error: Failure?
    }

    private struct Failure: Decodable {
        var code: String
        var message: String
    }

    /// An error answer: `{ ok: false, error: { code, message } }` with an HTTP error status.
    private struct Refusal: Decodable {
        var error: Failure?
    }

    /// A function call's body: `{ args }`. (Swift allows no types nested in a generic function.)
    private struct CallBody<B: Encodable>: Encodable {
        var args: B
    }

    private func call<T: Decodable, A: Encodable>(_ kind: String, _ name: String, args: A) async throws -> T {
        let data = try await post(path: "/api/\(kind)/\(name)", body: CallBody(args: args), authorized: true)
        let answer = try JSONDecoder().decode(Answer<T>.self, from: data)
        guard answer.ok, let value = answer.value else {
            throw PersonalOSError.server(code: answer.error?.code ?? "ERROR", message: answer.error?.message ?? "PersonalOS refused the request.", status: 200)
        }
        return value
    }

    private func post<B: Encodable>(path: String, body: B, authorized: Bool) async throws -> Data {
        guard let url = URL(string: server.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")) + path) else { throw PersonalOSError.transport("bad server address") }
        var request = URLRequest(url: url, timeoutInterval: 30)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue(TimeZone.current.identifier, forHTTPHeaderField: "x-feltkit-time-zone")
        request.setValue(Locale.current.identifier.replacingOccurrences(of: "_", with: "-"), forHTTPHeaderField: "x-feltkit-locale")
        if authorized {
            guard let token else { throw PersonalOSError.notSignedIn }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "authorization")
        }
        request.httpBody = try JSONEncoder().encode(body)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw PersonalOSError.transport(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(status) { return data }
        if let refusal = try? JSONDecoder().decode(Refusal.self, from: data), let failure = refusal.error {
            throw PersonalOSError.server(code: failure.code, message: failure.message, status: status)
        }
        throw PersonalOSError.badResponse(status)
    }
}
