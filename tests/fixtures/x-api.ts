/**
 * LOCAL STAND-IN FOR THE X API. NOT X.
 *
 * A loopback HTTP server that answers the three X API v2 requests PersonalOS's `x` integration makes,
 * in the shapes docs.x.com documents for them:
 *   GET  /2/users/me                       the account the token belongs to (the bot)
 *   GET  /2/users/:id/mentions             posts mentioning it: data, includes.users/tweets, meta
 *   POST /2/tweets                         a reply: { text, reply: { in_reply_to_tweet_id } }
 *
 * And the OAuth 2.0 endpoints X documents for a confidential client (authorize, token with HTTP Basic,
 * revoke), so the bot's grant goes through FeltKit's OAuth lifecycle as it would against X. Token
 * response fields and refresh-token rotation are NOT documented by X: here they follow RFC 6749, with
 * rotation, which is one possibility, not X's established behavior.
 *
 * It establishes how PersonalOS behaves GIVEN those responses (and given failures the test chooses).
 * It says nothing about X itself: rate limits, pricing, field availability, token scopes and
 * delivery latency are X's, and are not simulated. A test passing here is not real-X acceptance.
 */
import http from "node:http";
import { createHash } from "node:crypto";
import type net from "node:net";

export interface StubPost { id: string; text: string; author_id: string; conversation_id: string; created_at: string; referenced_tweets?: Array<{ type: string; id: string }> }

export interface XStub {
  url: string;
  client: { id: string; secret: string };
  /** Access tokens the API accepts now, and refresh tokens the token endpoint accepts. */
  access: Set<string>;
  refresh: Set<string>;
  /** expires_in the token endpoint answers with. */
  expiresIn: number;
  tokenRequests: Array<{ grant: string }>;
  revoked: string[];
  bot: { id: string; username: string };
  users: Map<string, string>;
  posts: StubPost[];
  replies: Array<{ id: string; text: string; inReplyTo: string; authorization: string | undefined }>;
  requests: Array<{ method: string; path: string; query: Record<string, string> }>;
  /** The next POST /2/tweets answers this way instead of posting. "timeout" never answers. */
  replyFailures: Array<429 | 403 | 500 | "timeout">;
  /** Answer the next mentions request as if since_id were this (X delivering mentions again). */
  repeatFrom: string | null;
  /** Answer every request 401 (an expired or wrong token). */
  unauthorized: boolean;
  /** A post that mentions the bot. Returns its id. */
  mention(o: { author: string; username?: string; text: string; inReplyTo?: string; quoting?: string }): string;
  /** A post that does not mention the bot (a thread's root, say). */
  post(o: { author: string; username?: string; text: string }): string;
  close(): Promise<void>;
}

export async function startXStub(): Promise<XStub> {
  let next = 1_890_000_000_000_000_000n;
  const nextId = () => String(next++);
  const all = new Map<string, StubPost>();
  const codes = new Map<string, { challenge: string; redirect: string }>();
  const tok = (p: string) => `${p}-${(next++).toString(36)}-stub-not-a-real-credential`;
  const state: XStub = {
    url: "", client: { id: "x-stub-client", secret: "x-stub-client-secret-not-real" }, access: new Set(), refresh: new Set(), expiresIn: 7200, tokenRequests: [], revoked: [], bot: { id: "1700000000000000001", username: "considered_done" },
    users: new Map([["1700000000000000001", "considered_done"]]), posts: [], replies: [], requests: [], replyFailures: [], repeatFrom: null, unauthorized: false,
    mention: (o) => {
      const id = nextId();
      if (o.username) state.users.set(o.author, o.username);
      const parent = o.inReplyTo ? all.get(o.inReplyTo) : undefined;
      const p: StubPost = {
        id, text: o.text, author_id: o.author, conversation_id: parent?.conversation_id ?? id, created_at: new Date().toISOString(),
        ...(o.inReplyTo || o.quoting ? { referenced_tweets: [...(o.inReplyTo ? [{ type: "replied_to", id: o.inReplyTo }] : []), ...(o.quoting ? [{ type: "quoted", id: o.quoting }] : [])] } : {}),
      };
      all.set(id, p);
      state.posts.push(p);
      return id;
    },
    post: (o) => {
      const id = nextId();
      if (o.username) state.users.set(o.author, o.username);
      all.set(id, { id, text: o.text, author_id: o.author, conversation_id: id, created_at: new Date().toISOString() });
      return id;
    },
    close: async () => undefined,
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const u = new URL(req.url ?? "/", "http://stub");
      state.requests.push({ method: req.method ?? "", path: u.pathname, query: Object.fromEntries(u.searchParams) });
      const send = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      // OAuth 2.0 (docs.x.com: /i/oauth2/authorize, /2/oauth2/token, /2/oauth2/revoke; confidential client = Basic).
      if (u.pathname === "/i/oauth2/authorize") {
        const code = tok("code");
        codes.set(code, { challenge: u.searchParams.get("code_challenge") ?? "", redirect: u.searchParams.get("redirect_uri") ?? "" });
        const back = new URL(u.searchParams.get("redirect_uri")!);
        back.searchParams.set("code", code);
        back.searchParams.set("state", u.searchParams.get("state") ?? "");
        res.writeHead(302, { location: back.toString() }).end();
        return;
      }
      if (u.pathname === "/2/oauth2/token" || u.pathname === "/2/oauth2/revoke") {
        const form = Object.fromEntries(new URLSearchParams(body));
        if (req.headers.authorization !== `Basic ${Buffer.from(`${state.client.id}:${state.client.secret}`).toString("base64")}`) return send(401, { error: "invalid_client" });
        if (u.pathname === "/2/oauth2/revoke") {
          state.revoked.push(form.token ?? "");
          state.access.delete(form.token ?? "");
          state.refresh.delete(form.token ?? "");
          return send(200, { revoked: true });
        }
        state.tokenRequests.push({ grant: form.grant_type ?? "" });
        const issue = () => {
          const access = tok("at");
          const refresh = tok("rt");
          state.access.add(access);
          state.refresh.add(refresh);
          return { token_type: "bearer", expires_in: state.expiresIn, access_token: access, scope: "tweet.read users.read tweet.write offline.access", refresh_token: refresh };
        };
        if (form.grant_type === "authorization_code") {
          const c = codes.get(form.code ?? "");
          codes.delete(form.code ?? "");
          if (!c || c.redirect !== form.redirect_uri || c.challenge !== createHash("sha256").update(form.code_verifier ?? "").digest("base64url")) return send(400, { error: "invalid_request" });
          return send(200, issue());
        }
        if (form.grant_type === "refresh_token") {
          if (!state.refresh.delete(form.refresh_token ?? "")) return send(400, { error: "invalid_request" });
          return send(200, issue());
        }
        return send(400, { error: "unsupported_grant_type" });
      }
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      if (state.unauthorized || !bearer || !state.access.has(bearer)) return send(401, { title: "Unauthorized", type: "about:blank", status: 401, detail: "Unauthorized" });
      if (req.method === "GET" && u.pathname === "/2/users/me") return send(200, { data: { id: state.bot.id, name: "Considered Done", username: state.bot.username } });
      const m = /^\/2\/users\/([0-9]+)\/mentions$/.exec(u.pathname);
      if (req.method === "GET" && m) {
        if (m[1] !== state.bot.id) return send(403, { title: "Forbidden", status: 403 });
        const since = state.repeatFrom ?? u.searchParams.get("since_id") ?? undefined;
        state.repeatFrom = null;
        const max = Number(u.searchParams.get("max_results") ?? 10);
        const found = state.posts.filter((p) => since === undefined || BigInt(p.id) > BigInt(since)).sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1)).slice(0, max);
        if (!found.length) return send(200, { meta: { result_count: 0 } });
        const authors = [...new Set(found.map((p) => p.author_id))];
        const refs = found.flatMap((p) => (p.referenced_tweets ?? []).map((r) => all.get(r.id))).filter(Boolean) as StubPost[];
        return send(200, {
          data: found,
          includes: { users: authors.map((id) => ({ id, name: state.users.get(id) ?? id, username: state.users.get(id) ?? `user${id.slice(-4)}` })), ...(refs.length ? { tweets: refs.map((r) => ({ id: r.id, text: r.text, author_id: r.author_id })) } : {}) },
          meta: { result_count: found.length, newest_id: found[0]!.id, oldest_id: found.at(-1)!.id },
        });
      }
      if (req.method === "POST" && u.pathname === "/2/tweets") {
        const failure = state.replyFailures.shift();
        if (failure === "timeout") return; // never answers
        if (failure) return send(failure, { title: failure === 429 ? "Too Many Requests" : failure === 403 ? "Forbidden" : "Internal Error", status: failure });
        const b = JSON.parse(body || "{}");
        const id = nextId();
        state.replies.push({ id, text: b.text, inReplyTo: b.reply?.in_reply_to_tweet_id, authorization: req.headers.authorization });
        return send(201, { data: { id, text: b.text, edit_history_tweet_ids: [id] } });
      }
      send(404, { title: "Not Found", status: 404 });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  state.url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  process.env.X_API_URL = state.url;
  process.env.X_TOKEN_URL = `${state.url}/2/oauth2/token`;
  process.env.X_AUTHORIZE_URL = `${state.url}/i/oauth2/authorize`;
  process.env.X_REVOKE_URL = `${state.url}/2/oauth2/revoke`;
  process.env.X_CLIENT_ID = state.client.id;
  process.env.FELTKIT_CREDENTIAL_X_CLIENT_SECRET = state.client.secret;
  delete process.env.FELTKIT_CREDENTIAL_X;
  // Where X sends the operator back after authorizing (FeltKit's /api/integrations/x/oauth/callback).
  process.env.FELTKIT_PUBLIC_URL ??= "http://127.0.0.1:9";
  state.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  return state;
}
