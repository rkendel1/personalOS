/**
 * Email, calendar and web search (feltkit/connections.ts, email.ts, calendar.ts, web.ts, turn.ts), against a
 * LOCAL STAND-IN for Google (tests/fixtures/google-api.ts) and the REAL private AuthBoundry FeltKit runs
 * (`authority.local`). Deterministic adapter testing: it shows what Anywhere Aide does given Google's
 * documented answers, not that Google gives them.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { draftProblem, instant, rawMessage, window } from "../feltkit/_google.js";
import { clockFor } from "../feltkit/_clock.js";
import { gmailMessage, startGoogleStub, type GoogleStub } from "./fixtures/google-api.js";
import { startStreamingModel } from "./fixtures/streaming-model.js";

const ZONE = "America/New_York";
const ADA = { id: "ada", type: "user" as const, roles: ["owner", "admin"] };
let google: GoogleStub;
before(async () => {
  delete process.env.AUTHBOUNDRY_URL;
  delete process.env.FELTKIT_CREDENTIAL_AUTHBOUNDRY_CHECK;
  delete process.env.WEBSEARCH_URL;
  delete process.env.OPENAISEARCH_URL;
  google = await startGoogleStub();
});
after(async () => { await google.close(); });

const ctx = { context: { timeZone: ZONE, locale: "en-US" } };
const decode = (raw: string) => Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
const bodyOf = (message: string) => Buffer.from(message.split("\r\n\r\n")[1]!.replace(/\r\n/g, ""), "base64").toString("utf8");

/** Run queued deliveries (feltkit/outbox.ts), as the job runner would. */
async function deliver(t: TestApp) {
  const jobs = (t.runtime.services as any).jobs;
  for (let i = 0; i < 20; i++) {
    await t.runtime.runServices();
    const due = (await jobs.listJobs("personalos")).filter((j: any) => ["queued", "pending"].includes(j.status) && j.type === "outbox.deliver");
    if (!due.length) return;
    for (const j of due) await jobs.executeJob("personalos", j.id, "test-worker");
  }
}
const outboxOf = async (t: TestApp, who: string) => t.as(who).query(api.outbox.list, {});

/** The person connects through the app's own action, Google redirects back, FeltKit completes it. */
async function connect(t: TestApp, who: string, id: "mail" | "calendar", account: string) {
  google.nextAccount = account;
  const r = await t.as(who).action(api.connections.connect, { id });
  assert.equal(r.configured, true, String(r.reason));
  const back = new URL((await fetch(r.url!, { redirect: "manual" })).headers.get("location")!);
  await (t.runtime as any).oauth.complete(id, back.searchParams);
  return r;
}

test("pure: a draft is exactly what was approved (no header injection), non-ASCII subjects are encoded, times carry the day's offset", () => {
  assert.match(String(draftProblem({ to: ["sam@example.com"], subject: "hi\r\nBcc: eve@evil.test", text: "x" })), /one line/);
  assert.match(String(draftProblem({ to: ["sam@example.com, eve@evil.test"], subject: "s", text: "x" })), /Not an email address/);
  assert.equal(draftProblem({ to: [], subject: "s", text: "x" }), "Who is it to? Give at least one address.");
  const m = decode(rawMessage({ to: ["sam@example.com"], subject: "Café ☕", text: "Ünïcödé body" }));
  assert.match(m, /^To: sam@example.com\r\n/);
  assert.match(m, /Subject: =\?UTF-8\?B\?/);
  assert.equal(bodyOf(m), "Ünïcödé body");
  assert.equal(instant("2026-07-01", "09:30", ZONE), "2026-07-01T09:30:00-04:00");
  assert.equal(instant("2026-12-01", "09:30", ZONE), "2026-12-01T09:30:00-05:00");
  assert.deepEqual(window("2026-11-19", 1, ZONE), { timeMin: "2026-11-19T00:00:00-05:00", timeMax: "2026-11-20T00:00:00-05:00" });
});

test("email: connect grants mail.read and mail.send; recent mail is the person's own; a send carries exactly the draft and is in Activity; withdrawing send stops the next one; disconnecting revokes", async () => {
  const t = await createTestApp();
  try {
    google.inbox.set("ada@example.com", [gmailMessage("m1", "Sam <sam@example.com>", "Q4 plan", "Can we meet &amp; talk?"), gmailMessage("m2", "news@example.com", "Digest", "weekly", false)]);
    google.inbox.set("grace@example.com", [gmailMessage("g1", "x@example.com", "Grace's secret", "private")]);

    let list = await t.as("ada").action(api.connections.list, {});
    assert.equal(list.connections.find((c) => c.id === "mail")!.state, "not_connected");
    await connect(t, "ada", "mail", "ada@example.com");
    list = await t.as("ada").action(api.connections.list, {});
    const mail = list.connections.find((c) => c.id === "mail")!;
    assert.equal(list.grantsAvailable, true, String(list.grantsReason));
    assert.equal(mail.state, "connected");
    assert.deepEqual(mail.capabilities.map((c) => [c.id, c.granted]), [["mail.read", true], ["mail.send", true]]);

    const recent = await t.as("ada").action(api.email.recent, { query: "is:unread" }, ctx);
    assert.deepEqual(recent.map((m) => [m.subject, m.unread, m.snippet]), [["Q4 plan", true, "Can we meet & talk?"]]);
    assert.ok(google.requests.filter((r) => r.path.startsWith("/gmail")).every((r) => r.account === "ada@example.com"));

    // Grace never connected: she gets nothing, and never Ada's mail.
    await assert.rejects(t.as("grace").action(api.email.recent, {}, ctx), (e: any) => e.code === "FAILED_PRECONDITION" || e.code === "FORBIDDEN");
    assert.ok(!google.requests.some((r) => r.account === "grace@example.com"));

    const queued = await t.as("ada").mutation(api.email.send, { to: ["sam@example.com"], subject: "Re: Q4 plan", text: "Tuesday at 10 works." });
    assert.equal(queued.status, "queued");
    assert.equal(google.sent.length, 0, "queued, not yet sent");
    await deliver(t);
    assert.equal((await outboxOf(t, "ada"))[0]!.status, "sent");
    assert.equal(google.sent.length, 1);
    assert.equal(google.sent[0]!.account, "ada@example.com");
    const sent = decode(google.sent[0]!.raw);
    assert.match(sent, /^To: sam@example.com\r\nSubject: Re: Q4 plan\r\n/);
    assert.equal(bodyOf(sent), "Tuesday at 10 works.");
    const activity = (await t.as("ada").query(api.actions.list, {})) as Array<{ kind: string; status: string; evidence?: { id: string } }>;
    const row = activity.find((a) => a.kind === "email.send")!;
    assert.deepEqual([row.status, row.evidence?.id], ["succeeded", "sent1"]);

    // Changing what connected surfaces may do keeps the connection's grants.
    await t.as("ada").action(api.delegation.set, { capabilities: ["personalos.tasks.read"] });
    list = await t.as("ada").action(api.connections.list, {});
    assert.deepEqual(list.connections.find((c) => c.id === "mail")!.capabilities.map((c) => c.granted), [true, true]);

    // Withdrawn: AuthBoundry refuses the very next send, and nothing reaches Google.
    await t.as("ada").action(api.connections.allow, { capability: "mail.send", allowed: false });
    await t.as("ada").mutation(api.email.send, { to: ["sam@example.com"], subject: "again", text: "x" });
    await deliver(t);
    const refused = (await outboxOf(t, "ada"))[0]!;
    assert.deepEqual([refused.status, refused.error?.code], ["failed", "FORBIDDEN"]);
    assert.equal(google.sent.length, 1);
    // Reading is still allowed.
    assert.equal((await t.as("ada").action(api.email.recent, {}, ctx)).length, 2);

    const gone = await t.as("ada").action(api.connections.disconnect, { id: "mail" });
    assert.equal(gone.disconnected, true);
    assert.ok(google.revoked.length >= 1);
    list = await t.as("ada").action(api.connections.list, {});
    const after = list.connections.find((c) => c.id === "mail")!;
    assert.equal(after.state, "not_connected");
    assert.deepEqual(after.capabilities.map((c) => c.granted), [false, false]);
    assert.equal((await t.as("ada").action(api.delegation.list, {})).capabilities.find((c) => c.id === "personalos.tasks.read")!.granted, true, "surface grants untouched");
  } finally {
    await t.close();
  }
});

test("calendar and the built-in assistant (no model): today's events from the person's calendar, an event added at local time, and a web search that says no provider is configured", async () => {
  const t = await createTestApp();
  try {
    const clock = clockFor(ZONE);
    await connect(t, "ada", "calendar", "ada@example.com");
    google.events.set("ada@example.com", [{ id: "e1", status: "confirmed", summary: "Standup", start: { dateTime: instant(clock.today, "09:30", ZONE) }, end: { dateTime: instant(clock.today, "09:45", ZONE) } }]);

    await t.as("ada").mutation(api.calendar.create, { title: "Dentist", date: clock.today, time: "15:00", durationMinutes: 45, attendees: ["sam@example.com"], timeZone: ZONE });
    await deliver(t);
    const made = (await outboxOf(t, "ada"))[0]!;
    assert.deepEqual([made.status, made.externalId], ["sent", "ev1"]);
    assert.deepEqual(google.inserted[0]!.body.start, { dateTime: instant(clock.today, "15:00", ZONE), timeZone: ZONE });
    assert.deepEqual(google.inserted[0]!.body.end, { dateTime: instant(clock.today, "15:45", ZONE), timeZone: ZONE });

    const r = await t.as("ada").action(api.turn.turn, { text: "What's on my calendar today?", clientId: "client-cal-1" }, ctx);
    assert.equal(r.reason, "calendar");
    const reply = (await t.as("ada").query(api.conversations.messagesOf, { conversationId: r.conversationId })).at(-1)!;
    assert.match(reply.text, /09:30–09:45 Standup/);
    assert.match(reply.text, /15:00–15:45 Dentist/);

    // Mail isn't connected: it says so, and how to fix it.
    const m = await t.as("ada").action(api.turn.turn, { text: "Any new emails?", clientId: "client-mail-1" }, ctx);
    assert.match((await t.as("ada").query(api.conversations.messagesOf, { conversationId: m.conversationId })).at(-1)!.text, /isn't connected.*Settings → Connections/);

    // No search provider configured here: it says exactly that, never pretends.
    const w = await t.as("ada").action(api.turn.turn, { text: "search the web for FeltKit", clientId: "client-web-1" }, ctx);
    assert.equal(w.reason, "web search unavailable");
    assert.match((await t.as("ada").query(api.conversations.messagesOf, { conversationId: w.conversationId })).at(-1)!.text, /No web search provider is configured.*WEBSEARCH_URL/);
  } finally {
    await t.close();
  }
});

test("model turn: the model reads the inbox, proposes an email, and nothing is sent until the owner approves that exact draft", async () => {
  const model = await startStreamingModel();
  const t = await createTestApp();
  try {
    const admin = { id: "root", type: "user" as const, roles: ["admin"] };
    await t.runtime.services.asPrincipal(admin as never, (v) => t.runtime.services.intelligence!.set({ ...t.runtime.services.scope, provider: "ollama", model: "loop", endpoint: `${model.url}/v1` }, v));
    google.inbox.set("ada@example.com", [gmailMessage("m9", "Sam <sam@example.com>", "Lunch?", "Thursday?")]);
    google.sent.length = 0;
    await connect(t, "ada", "mail", "ada@example.com");

    model.scripts.push({ text: ["Checking. "], toolCalls: [{ id: "call_mail", name: "email_recent", args: JSON.stringify({ query: "is:unread" }) }] });
    model.scripts.push({ text: ["Sam asks about lunch. I've drafted a yes."], toolCalls: [{ id: "call_send", name: "email_send", args: JSON.stringify({ to: ["sam@example.com"], subject: "Re: Lunch?", text: "Thursday works." }) }] });
    model.scripts.push({ text: ["It's waiting for your approval."] });

    const out = await t.as("ada").action(api.turn.turn, { text: "Anything from Sam? Say yes to lunch.", clientId: "client-model-1" }, ctx);
    assert.equal(out.mode, "model");
    assert.match(JSON.stringify(model.requests[0]!.body.messages[0]), /email \(Gmail\) is connected/);
    assert.match(JSON.stringify(model.requests[1]!.body.messages), /Lunch\?/, "the model saw the inbox read");
    const reply = (await t.as("ada").query(api.conversations.messagesOf, { conversationId: out.conversationId })).at(-1)!;
    const proposal = reply.agent!.proposals.find((p) => p.capability === "email.send")!;
    assert.deepEqual([proposal.effect, proposal.state], ["consequential", "proposed"]);
    assert.equal(google.sent.length, 0, "nothing sent before approval");

    await t.runtime.agent.approveOwn(proposal.taskId, proposal.actionId, ADA);
    await deliver(t);
    assert.equal(google.sent.length, 1);
    assert.equal(bodyOf(decode(google.sent[0]!.raw)), "Thursday works.");
    const row = ((await t.as("ada").query(api.actions.list, {})) as Array<{ kind: string; via: string; proposedBy?: { model: string } }>).find((a) => a.kind === "email.send")!;
    assert.deepEqual([row.via, row.proposedBy?.model], ["model", "ollama/loop"]);
  } finally {
    await t.close();
    await model.close();
  }
});

test("web search with a provider configured (a Brave-shaped stand-in): the built-in assistant answers with linked results, and the model's web.search reads them", async () => {
  const http = await import("node:http");
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://stub");
    seen.push(`${u.pathname}?q=${u.searchParams.get("q")} key=${req.headers["x-subscription-token"]}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ web: { results: [{ title: "FeltKit on npm", url: "https://www.npmjs.com/package/@feltdb/feltkit", description: "A <strong>database</strong> and app platform." }] } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.WEBSEARCH_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.FELTKIT_CREDENTIAL_WEBSEARCH = "test-search-key";
  const model = await startStreamingModel();
  const t = await createTestApp();
  try {
    const r = await t.as("ada").action(api.turn.turn, { text: "search the web for feltkit", clientId: "client-web-2" }, ctx);
    assert.equal(r.reason, "web search via brave");
    const text = (await t.as("ada").query(api.conversations.messagesOf, { conversationId: r.conversationId })).at(-1)!.text;
    assert.match(text, /\[FeltKit on npm\]\(https:\/\/www\.npmjs\.com\/package\/@feltdb\/feltkit\) — A database and app platform\./);
    assert.deepEqual(seen, ["/res/v1/web/search?q=feltkit key=test-search-key"]);

    const admin = { id: "root", type: "user" as const, roles: ["admin"] };
    await t.runtime.services.asPrincipal(admin as never, (v) => t.runtime.services.intelligence!.set({ ...t.runtime.services.scope, provider: "ollama", model: "loop", endpoint: `${model.url}/v1` }, v));
    model.scripts.push({ toolCalls: [{ id: "call_web", name: "web_search", args: JSON.stringify({ query: "feltkit release" }) }] });
    model.scripts.push({ text: ["FeltKit is on npm (https://www.npmjs.com/package/@feltdb/feltkit)."] });
    const m = await t.as("ada").action(api.turn.turn, { text: "What is FeltKit? Look it up.", clientId: "client-web-3" }, ctx);
    assert.equal(m.mode, "model");
    assert.match(JSON.stringify(model.requests[1]!.body.messages), /FeltKit on npm/);
    assert.equal(seen.at(-1), "/res/v1/web/search?q=feltkit release key=test-search-key");
  } finally {
    await t.close();
    await model.close();
    server.close();
    delete process.env.WEBSEARCH_URL;
    delete process.env.FELTKIT_CREDENTIAL_WEBSEARCH;
  }
});
