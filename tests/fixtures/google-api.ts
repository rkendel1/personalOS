/**
 * LOCAL STAND-IN FOR GOOGLE (OAuth 2.0, Gmail API, Calendar API). NOT GOOGLE.
 *
 * A loopback server answering the requests Anywhere Aide's `mail` and `calendar` integrations make, in the
 * shapes Google documents for them:
 *   GET  /o/oauth2/v2/auth                      authorization (redirects back with code and state)
 *   POST /token                                 authorization code (PKCE) and refresh grants
 *   POST /revoke                                RFC 7009 revocation
 *   GET  /gmail/v1/users/me/messages            { messages: [{ id, threadId }] }
 *   GET  /gmail/v1/users/me/messages/:id        format=metadata: { id, threadId, labelIds, snippet, payload.headers }
 *   POST /gmail/v1/users/me/messages/send       { raw } → { id, threadId, labelIds: ["SENT"] }
 *   GET  /calendar/v3/calendars/primary/events  { items: [...] }
 *   POST /calendar/v3/calendars/primary/events  the event → { id, htmlLink, ... }
 *
 * Each access token belongs to the account it was issued for (the `login_hint` the test passes, else
 * "ada@example.com"), so a request answered with another person's data would show. It says nothing about
 * Google's quotas, consent screens or verification; passing here is not acceptance against Google.
 */
import http from "node:http";
import { createHash, randomBytes } from "node:crypto";
import type net from "node:net";

export interface GoogleStub {
  url: string;
  client: { id: string; secret: string };
  /** access token → account */
  tokens: Map<string, string>;
  /** account → its inbox (format=metadata messages) */
  inbox: Map<string, Array<Record<string, unknown>>>;
  /** account → its events */
  events: Map<string, Array<Record<string, unknown>>>;
  sent: Array<{ account: string; raw: string }>;
  inserted: Array<{ account: string; body: any }>;
  revoked: string[];
  requests: Array<{ method: string; path: string; account: string | null }>;
  /** Who the next authorization is for. */
  nextAccount: string;
  close(): Promise<void>;
}

export async function startGoogleStub(): Promise<GoogleStub> {
  const codes = new Map<string, { account: string; challenge: string; redirect: string }>();
  const state: GoogleStub = {
    url: "", client: { id: "test-client.apps.googleusercontent.com", secret: "test-client-secret" },
    tokens: new Map(), inbox: new Map(), events: new Map(), sent: [], inserted: [], revoked: [], requests: [], nextAccount: "ada@example.com",
    close: async () => undefined,
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://stub");
      const send = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      const bearer = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ""))?.[1];
      const account = bearer ? state.tokens.get(bearer) ?? null : null;
      state.requests.push({ method: req.method ?? "", path: u.pathname, account });

      if (u.pathname === "/o/oauth2/v2/auth") {
        // Google's own parameters must survive FeltKit adding its own.
        if (u.searchParams.get("access_type") !== "offline") return send(400, { error: "access_type offline expected" });
        const code = randomBytes(8).toString("hex");
        codes.set(code, { account: state.nextAccount, challenge: u.searchParams.get("code_challenge") ?? "", redirect: u.searchParams.get("redirect_uri") ?? "" });
        const back = new URL(u.searchParams.get("redirect_uri")!);
        back.searchParams.set("code", code);
        back.searchParams.set("state", u.searchParams.get("state") ?? "");
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }
      if (u.pathname === "/token" && req.method === "POST") {
        const f = new URLSearchParams(body);
        if (f.get("client_id") !== state.client.id || f.get("client_secret") !== state.client.secret) return send(401, { error: "invalid_client" });
        if (f.get("grant_type") === "authorization_code") {
          const c = codes.get(f.get("code") ?? "");
          codes.delete(f.get("code") ?? "");
          const verifier = f.get("code_verifier") ?? "";
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          if (!c || c.challenge !== challenge) return send(400, { error: "invalid_grant" });
          const access = `at-${randomBytes(8).toString("hex")}`;
          state.tokens.set(access, c.account);
          return send(200, { access_token: access, refresh_token: `rt-${c.account}`, expires_in: 3599, token_type: "Bearer", scope: "granted" });
        }
        return send(400, { error: "unsupported_grant_type" });
      }
      if (u.pathname === "/revoke" && req.method === "POST") {
        const token = new URLSearchParams(body).get("token") ?? "";
        state.revoked.push(token);
        state.tokens.delete(token);
        return send(200, {});
      }
      if (!account) return send(401, { error: { code: 401, message: "Request had invalid authentication credentials." } });

      if (u.pathname === "/gmail/v1/users/me/messages" && req.method === "GET") {
        const all = state.inbox.get(account) ?? [];
        const unread = u.searchParams.get("q")?.includes("is:unread");
        const max = Number(u.searchParams.get("maxResults") ?? 100);
        const picked = all.filter((m) => !unread || (m.labelIds as string[]).includes("UNREAD")).slice(0, max);
        return send(200, { messages: picked.map((m) => ({ id: m.id, threadId: m.threadId })), resultSizeEstimate: picked.length });
      }
      const one = /^\/gmail\/v1\/users\/me\/messages\/([A-Za-z0-9_-]+)$/.exec(u.pathname);
      if (one && req.method === "GET") {
        if (u.searchParams.get("format") !== "metadata") return send(400, { error: "metadata only in this stand-in" });
        const m = (state.inbox.get(account) ?? []).find((x) => x.id === one[1]);
        return m ? send(200, m) : send(404, { error: { code: 404, message: "Requested entity was not found." } });
      }
      if (u.pathname === "/gmail/v1/users/me/messages/send" && req.method === "POST") {
        const raw = JSON.parse(body).raw as string;
        state.sent.push({ account, raw });
        return send(200, { id: `sent${state.sent.length}`, threadId: `t${state.sent.length}`, labelIds: ["SENT"] });
      }
      if (u.pathname === "/calendar/v3/calendars/primary/events" && req.method === "GET") {
        const min = Date.parse(u.searchParams.get("timeMin") ?? "");
        const max = Date.parse(u.searchParams.get("timeMax") ?? "");
        const items = (state.events.get(account) ?? []).filter((e: any) => { const at = Date.parse(e.start.dateTime ?? e.start.date); return at >= min && at < max; });
        return send(200, { kind: "calendar#events", items });
      }
      if (u.pathname === "/calendar/v3/calendars/primary/events" && req.method === "POST") {
        const ev = JSON.parse(body);
        const made = { ...ev, id: `ev${state.inserted.length + 1}`, status: "confirmed", htmlLink: `https://calendar.google.com/event?eid=ev${state.inserted.length + 1}` };
        state.inserted.push({ account, body: ev });
        state.events.set(account, [...(state.events.get(account) ?? []), made]);
        return send(200, made);
      }
      send(404, { error: { code: 404, message: `no route ${req.method} ${u.pathname}` } });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  state.url = `http://127.0.0.1:${port}`;
  process.env.GOOGLE_CLIENT_ID = state.client.id;
  process.env.FELTKIT_CREDENTIAL_GOOGLE_CLIENT_SECRET = state.client.secret;
  process.env.GOOGLE_AUTHORIZE_URL = `${state.url}/o/oauth2/v2/auth?access_type=offline&prompt=consent`;
  process.env.GOOGLE_TOKEN_URL = `${state.url}/token`;
  process.env.GOOGLE_REVOKE_URL = `${state.url}/revoke`;
  process.env.GMAIL_API_URL = state.url;
  process.env.GCAL_API_URL = state.url;
  // Where Google returns people to (FeltKit's callback). The test reads the redirect instead of following it.
  process.env.FELTKIT_PUBLIC_URL ??= "http://localhost:3000";
  state.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  return state;
}

/** A Gmail message as format=metadata returns it. */
export const gmailMessage = (id: string, from: string, subject: string, snippet: string, unread = true) => ({
  id, threadId: `th-${id}`, labelIds: unread ? ["UNREAD", "INBOX"] : ["INBOX"], snippet,
  payload: { headers: [{ name: "From", value: from }, { name: "Subject", value: subject }, { name: "Date", value: "Wed, 18 Nov 2026 09:00:00 -0500" }] },
});
