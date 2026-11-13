/**
 * LOCAL STAND-IN FOR THE X API. NOT X.
 *
 * A loopback HTTP server that answers the three X API v2 requests PersonalOS's `x` integration makes,
 * in the shapes docs.x.com documents for them:
 *   GET  /2/users/me                       the account the token belongs to (the bot)
 *   GET  /2/users/:id/mentions             posts mentioning it: data, includes.users/tweets, meta
 *   POST /2/tweets                         a reply: { text, reply: { in_reply_to_tweet_id } }
 *
 * It establishes how PersonalOS behaves GIVEN those responses (and given failures the test chooses).
 * It says nothing about X itself: rate limits, pricing, field availability, token scopes and
 * delivery latency are X's, and are not simulated. A test passing here is not real-X acceptance.
 */
import http from "node:http";
import type net from "node:net";

export interface StubPost { id: string; text: string; author_id: string; conversation_id: string; created_at: string; referenced_tweets?: Array<{ type: string; id: string }> }

export interface XStub {
  url: string;
  token: string;
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
  const state: XStub = {
    url: "", token: "x-stub-token-not-a-real-credential", bot: { id: "1700000000000000001", username: "considered_done" },
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
      if (state.unauthorized || req.headers.authorization !== `Bearer ${state.token}`) return send(401, { title: "Unauthorized", type: "about:blank", status: 401, detail: "Unauthorized" });
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
  process.env.FELTKIT_CREDENTIAL_X = state.token;
  state.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  return state;
}
