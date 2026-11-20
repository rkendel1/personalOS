/**
 * web.read (feltkit/web.ts): research's own page reader (feltkit/_pages.ts) as a chat capability. The REAL
 * reader runs against a local server: its rules are what is tested, not a stand-in for them. The test server is
 * private, so it is named as the one host the reader may read (PERSONALOS_PAGE_READER_ALLOW_HOSTS, outside
 * production only); the same server under another name is still refused.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { startStreamingModel } from "./fixtures/streaming-model.js";

const ARTICLE = `<html><head><title>Durable things</title><meta name="description" content="On building things that last."></head><body><nav>menu</nav><main><h1>Durable things</h1><p>${"The capability is the product; the engine is one implementation of it. ".repeat(8)}</p></main><script>track()</script></body></html>`;
let server: http.Server;
let base = "";
let port = 0;
before(async () => {
  process.env.PERSONALOS_PAGE_READER_ALLOW_HOSTS = "127.0.0.1";
  server = http.createServer((req, res) => {
    if (req.url === "/robots.txt") return res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /private\n");
    if (req.url === "/article") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(ARTICLE);
    if (req.url === "/app") return res.writeHead(200, { "content-type": "text/html" }).end(`<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>`);
    if (req.url === "/private") return res.writeHead(200, { "content-type": "text/html" }).end(ARTICLE);
    res.writeHead(404).end("no");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as { port: number }).port;
  base = `http://127.0.0.1:${port}`;
});
after(async () => { delete process.env.PERSONALOS_PAGE_READER_ALLOW_HOSTS; server.closeAllConnections(); await new Promise((r) => server.close(r)); });

const ctx = { context: { timeZone: "UTC", locale: "en-US" } };
const lastReply = async (t: TestApp, conversationId: string) => (await t.as("ada").query(api.conversations.messagesOf, { conversationId })).at(-1)!.text;

test("web.read keeps the reader's rules and says why: read, robots.txt, script-rendered, private address, HTTP error; every outcome is recorded with provenance", async () => {
  const t = await createTestApp();
  try {
    const ok = await t.as("ada").action(api.web.read, { url: `${base}/article` });
    assert.equal(ok.status, "read");
    assert.equal(ok.title, "Durable things");
    assert.match(ok.text, /^On building things that last\.\n(?:.*\n)*Durable things\nThe capability is the product/);
    assert.doesNotMatch(ok.text, /track\(\)/, "scripts are not page text");
    assert.equal(ok.reader, "page-reader");

    assert.deepEqual([(await t.as("ada").action(api.web.read, { url: `${base}/private` })).status], ["not-allowed"]);
    const app = await t.as("ada").action(api.web.read, { url: `${base}/app` });
    assert.equal(app.status, "extraction-failed");
    assert.match(app.detail, /rendered by scripts/);
    const local = await t.as("ada").action(api.web.read, { url: `http://localhost:${port}/article` });
    assert.equal(local.status, "not-allowed", "the same server under a name that isn't allowed is refused");
    assert.equal((await t.as("ada").action(api.web.read, { url: "http://169.254.169.254/latest/meta-data/" })).status, "not-allowed");
    const missing = await t.as("ada").action(api.web.read, { url: `${base}/nope` });
    assert.deepEqual([missing.status, missing.httpStatus], ["unavailable", 404]);

    const o = await t.as("ada").query(api.web.outcomes, {});
    assert.equal(o.total, 6);
    assert.deepEqual(o.byStatus, { read: 1, "not-allowed": 3, "extraction-failed": 1, unavailable: 1 });
    assert.equal(o.recentFailures.length, 5);
    // Grace sees none of Ada's reads; a read-only guest may not read the web at all.
    assert.equal((await t.as("grace").query(api.web.outcomes, {})).total, 0);
    await assert.rejects(t.as("guest").action(api.web.read, { url: `${base}/article` }), { code: "FORBIDDEN" });
  } finally {
    await t.close();
  }
});

test("chat without a model: a link is read and shown as the page's own text, a page it can't read says why and where to turn, and the read names its conversation", async () => {
  const t = await createTestApp();
  try {
    const r = await t.as("ada").action(api.turn.turn, { text: `read ${base}/article`, clientId: "client-read-1" }, ctx);
    assert.equal(r.reason, "web read");
    const reply = await lastReply(t, r.conversationId);
    assert.match(reply, /^\*\*Durable things\*\* \(http:\/\/127\.0\.0\.1:\d+\/article\)/);
    assert.match(reply, /The page's own text, as read/);

    const bare = await t.as("ada").action(api.turn.turn, { text: `${base}/app`, clientId: "client-read-2" }, ctx);
    assert.equal(bare.reason, "web read extraction-failed");
    assert.match(await lastReply(t, bare.conversationId), /couldn't read .*rendered by scripts.*Chrome extension or the share sheet/);

    const failure = (await t.as("ada").query(api.web.outcomes, {})).recentFailures[0]!;
    assert.deepEqual([failure.source, failure.conversationId], ["chat", bare.conversationId], "a read that started a conversation names it");
  } finally {
    await t.close();
  }
});

test("model turn: the model reads a link with web.read and gets the text with its provenance; a page that wasn't read reaches it as not read, never as content", async () => {
  const model = await startStreamingModel();
  const t = await createTestApp();
  try {
    const admin = { id: "root", type: "user" as const, roles: ["admin"] };
    await t.runtime.services.asPrincipal(admin as never, (v) => t.runtime.services.intelligence!.set({ ...t.runtime.services.scope, provider: "ollama", model: "loop", endpoint: `${model.url}/v1` }, v));
    model.scripts.push({ toolCalls: [{ id: "c1", name: "web_read", args: JSON.stringify({ url: `${base}/article` }) }, { id: "c2", name: "web_read", args: JSON.stringify({ url: `${base}/private` }) }] });
    model.scripts.push({ text: ["It argues the capability is the product (", base, "/article). The other page asks automated readers to stay out."] });
    const out = await t.as("ada").action(api.turn.turn, { text: `Summarize ${base}/article and ${base}/private`, clientId: "client-read-3" }, ctx);
    assert.equal(out.mode, "model");
    assert.ok(model.requests[0]!.body.tools.some((x: any) => x.function?.name === "web_read" || x.name === "web_read"), "web.read is offered to the model");
    const results = (model.requests[1]!.body.messages as Array<{ role: string; content: string }>).filter((m) => m.role === "tool").map((m) => JSON.parse(m.content));
    assert.equal(results[0].status, "read");
    assert.match(results[0].text, /The capability is the product/);
    assert.equal(typeof results[0].readId, "string");
    assert.equal(results[1].status, "not-allowed");
    assert.equal(results[1].text, undefined, "a page that wasn't read gives the model no text");
    assert.match(results[1].note, /NOT read/);
    const o = await t.as("ada").query(api.web.outcomes, {});
    assert.deepEqual(o.bySource.chat, { read: 1, "not-allowed": 1 });
  } finally {
    await t.close();
    await model.close();
  }
});
