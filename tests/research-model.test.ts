/**
 * Research with a model, and with the other web search provider. The model is a scripted local
 * server speaking OpenAI's chat completions (tests/fixtures/streaming-model.ts); OpenAI's web search is
 * a local server answering the Responses API's request and response shape; company pages come from a
 * stand-in page reader. Each stands in for an external service only: routing, planning acceptance,
 * search, selection, page reading, assessment validation, storage and the conversation are PersonalOS
 * and FeltKit themselves. The real services are exercised by scripts/research-live.mjs (docs/RESEARCH.md).
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { PAGE_READER } from "../feltkit/research.js";
import { openAiResults } from "../feltkit/_search.js";
import { acceptAssessment, acceptPlan, acceptSelection, ownSite } from "../feltkit/_researchmodel.js";
import type { PageRead } from "../feltkit/_pages.js";
import { startStreamingModel } from "./fixtures/streaming-model.js";

const KEY = "sk-test-openai-0123456789";
const ZONE = "America/New_York";
const ada = { id: "ada", type: "user" as const, roles: ["owner", "admin"] };

/** What OpenAI's web search "returns": sources found, and a message citing some of them. */
const SOURCES = ["https://liveblocks.io/?utm_source=openai", "https://ably.com/solutions/multiplayer-collaboration?utm_source=openai", "https://en.wikipedia.org/wiki/Collaborative_software", "https://partykit.io/"];
function responsesBody(q: string) {
  const text = `1. **Ably**: realtime collaboration SDKs ([ably.com](${SOURCES[1]})).\n2. **PartyKit**: multiplayer servers for collaborative apps ([partykit.io](${SOURCES[3]})).\nAlso see https://invented.example/ which was not a result.`;
  return {
    id: "resp_1", object: "response", model: "gpt-4.1-mini",
    output: [
      { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: q, sources: SOURCES.map((url) => ({ type: "url", url })) } },
      { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text, annotations: [
        { type: "url_citation", start_index: 0, end_index: text.indexOf(")).") + 2, title: "Ably Realtime | Multiplayer collaboration", url: SOURCES[1] },
        { type: "url_citation", start_index: text.indexOf("\n2."), end_index: text.indexOf(")).\nAlso") + 2, title: "PartyKit", url: SOURCES[3] },
      ] }] },
    ],
    usage: { input_tokens: 8000, output_tokens: 300 },
  };
}

let openai: { url: string; requests: Array<{ auth?: string; body: any }>; close(): Promise<void> };
before(async () => {
  const requests: Array<{ auth?: string; body: any }> = [];
  const server: Server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || "{}");
    requests.push({ auth: req.headers.authorization, body });
    if (req.url !== "/v1/responses" || req.method !== "POST") return res.writeHead(404).end();
    if (req.headers.authorization !== `Bearer ${KEY}`) return res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Incorrect API key" } }));
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(responsesBody(String(body.input))));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  openai = { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests, close: () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); }) };
});
after(async () => { await openai.close(); });

const SITE: Record<string, Omit<PageRead, "url" | "finalUrl" | "ms">> = {
  "https://ably.com/solutions/multiplayer-collaboration": { status: "read", httpStatus: 200, title: "Multiplayer collaboration | Ably", detail: "", text: "Power realtime collaboration with fully featured SDKs.\nAdd live cursors, avatar stacks and component locking to any web app in days, not months.\nAbly Spaces is the SDK for building collaborative environments, priced per message." },
  "https://ably.com/": { status: "read", httpStatus: 200, title: "Ably: realtime experience infrastructure", detail: "", text: "Ably is the platform that powers synchronized digital experiences in realtime for millions of simultaneously connected devices across the world.\nPub/sub messaging, presence and collaboration features for developers." },
  "https://partykit.io/": { status: "extraction-failed", httpStatus: 200, title: "PartyKit", detail: "only 40 characters of readable text (the page may be rendered by scripts)", text: "" },
};
function usePages() {
  (globalThis as any)[PAGE_READER] = async (url: string) => ({ url, finalUrl: url, ms: 1, ...(SITE[url] ?? { status: "unavailable", httpStatus: 404, title: "", detail: "the site answered HTTP 404", text: "" }) });
}

function configureOpenAiSearch(on: boolean) {
  if (on) { process.env.OPENAISEARCH_URL = openai.url; process.env.FELTKIT_CREDENTIAL_OPENAISEARCH = KEY; }
  else { delete process.env.OPENAISEARCH_URL; delete process.env.FELTKIT_CREDENTIAL_OPENAISEARCH; }
}
async function settle(t: TestApp) {
  const jobs = (t.runtime.services as any).jobs;
  for (let i = 0; i < 300; i++) {
    await t.runtime.runServices();
    const due = (await jobs.listJobs("personalos")).filter((j: any) => j.type === "research.step" && ["queued", "scheduled", "pending"].includes(j.status));
    if (!due.length) return;
    for (const j of due) await jobs.executeJob("personalos", j.id, "test-worker");
  }
  throw new Error("research did not settle");
}
const say = (t: TestApp, text: string, conversationId?: string) =>
  t.as("ada").action(api.turn.turn, { text, clientId: `c-${Math.random().toString(36).slice(2)}`, ...(conversationId ? { conversationId } : {}) }, { context: { timeZone: ZONE, locale: "en-US" } });
const json = (v: unknown) => ({ text: [JSON.stringify(v)] });
async function withModel(t: TestApp, url: string) {
  await t.runtime.services.asPrincipal(ada as never, (v) => t.runtime.services.intelligence!.set({ ...t.runtime.services.scope, provider: "ollama", model: "loop", endpoint: `${url}/v1` }, v));
}

test("OpenAI web search results are only pages the search returned or cited, without tracking parameters; the model's summary is labelled as such", () => {
  const results = openAiResults(responsesBody("q"));
  assert.deepEqual(results.map((r) => r.url).sort(), ["https://ably.com/solutions/multiplayer-collaboration", "https://en.wikipedia.org/wiki/Collaborative_software", "https://liveblocks.io/", "https://partykit.io/"]);
  assert.ok(!results.some((r) => r.url.includes("invented.example")), "a URL in the text that the search did not return is not a result");
  assert.match(results.find((r) => r.url.includes("ably"))!.description, /^Ably: realtime collaboration SDKs/);
  assert.equal(results.find((r) => r.url.includes("ably"))!.title, "Ably Realtime | Multiplayer collaboration");
  assert.deepEqual(openAiResults({ error: "x" }), []);
});

test("the rules decide what of a model's proposal is accepted", () => {
  const plan = acceptPlan({ kind: "competitors", subject: "Liveblocks", objective: "o", criteria: ["c"], queries: ["liveblocks alternatives", "LIVEBLOCKS ALTERNATIVES", "see https://x.com", ...Array.from({ length: 8 }, (_, i) => `query ${i}`)] });
  assert.ok(!("error" in plan));
  if ("error" in plan) return;
  assert.equal(plan.queries.length, 6, "at most six searches");
  assert.ok(plan.rejected.some((r) => /contains a URL/.test(r)) && plan.rejected.some((r) => /over the limit/.test(r)));
  assert.match((acceptPlan({ kind: "everything", subject: "x", queries: ["a b c"] }) as any).error, /not one of/);
  assert.match((acceptPlan(null) as any).error, /not a JSON object/);

  const results = [{ ref: "R1", sourceId: "s1", url: "https://ably.com/x", title: "Ably", text: "", query: "q" }, { ref: "R2", sourceId: "s2", url: "https://en.wikipedia.org/wiki/X", title: "W", text: "", query: "q" }, { ref: "R3", sourceId: "s3", url: "https://ably.com/y", title: "Ably", text: "", query: "q" }];
  const sel = acceptSelection({ candidates: [{ ref: "R1", name: "Ably", why: "w" }, { ref: "R2", name: "Wikipedia" }, { ref: "R9", name: "Invented" }], refine: ["more results", "more results", "x", "beta query", "gamma query"] }, results, { mayRefine: true, searched: ["q"], excludeDomains: [] });
  assert.ok(!("error" in sel));
  if ("error" in sel) return;
  assert.deepEqual(sel.candidates.map((c) => [c.domain, c.sourceIds]), [["ably.com", ["s1", "s3"]]], "only results the search returned, directories excluded, all of a domain's results are its evidence");
  assert.ok(sel.rejected.some((r) => /R9.*not one of the results/.test(r)));
  assert.deepEqual(sel.refine, ["more results", "beta query"], "at most two refinements, no repeats, none too short");

  const evidence = [{ ref: "P1", sourceId: "p1", url: "https://ably.com/", kind: "page" as const, status: "read", title: "", text: "Ably powers  synchronized digital experiences\nin realtime." }, { ref: "P2", sourceId: "p2", url: "https://ably.com/z", kind: "page" as const, status: "unavailable", title: "", text: "HTTP 404" }, { ref: "R1", sourceId: "s1", url: "https://ably.com/x", kind: "search" as const, textKind: "provider-summary", title: "", text: "Ably makes SDKs for collaboration." }];
  const a = acceptAssessment({ fit: "high", confidence: "high", facts: [{ ref: "P1", quote: "Ably powers synchronized digital experiences in realtime." }, { ref: "P1", quote: "Ably has 10,000 customers." }, { ref: "R1", quote: "Ably makes SDKs for collaboration." }, { ref: "P2", quote: "HTTP 404" }], rationale: [{ text: "ok", refs: ["P1"] }, { text: "no refs", refs: ["P9"] }] }, evidence);
  assert.ok(!("error" in a));
  if ("error" in a) return;
  assert.deepEqual(a.facts.map((f) => f.sourceId), ["p1"], "only verbatim quotes from pages that were read; never a search summary, never an unread page");
  assert.deepEqual([a.offered, a.rejectedQuotes, a.confidence], [4, 3, "medium"], "one verified quote caps confidence at medium");
  assert.deepEqual(a.rationale.map((r) => r.text), ["ok"]);
});

test("REAL-SHAPED: a differently phrased request, routed by the model, planned by it, searched with OpenAI's web search, pages read, assessed with checked quotes", async () => {
  configureOpenAiSearch(true);
  usePages();
  const model = await startStreamingModel();
  const t = await createTestApp();
  try {
    await withModel(t, model.url);
    // 1. The turn: the model judges this to be research and proposes it; PersonalOS starts it.
    model.scripts.push({ toolCalls: [{ id: "call_1", name: "research_start", args: JSON.stringify({ goal: "competitors of Liveblocks" }) }] });
    // 2. Plan (one query is rejected by the rules: it contains a URL).
    model.scripts.push(json({ kind: "competitors", subject: "Liveblocks", subjectSummary: "Realtime collaboration infrastructure for web apps.", objective: "Identify companies offering realtime collaboration infrastructure that competes with Liveblocks.", criteria: ["Sells realtime collaboration SDKs or APIs to developers"], queries: ["liveblocks alternatives", "realtime collaboration SDK companies", "https://liveblocks.io competitors"] }));
    // 3. Selection (results R1 Ably, R2 PartyKit, R3 Liveblocks, R4 Wikipedia): the subject itself, an
    //    encyclopedia and an invented ref are rejected.
    model.scripts.push(json({ candidates: [{ ref: "R1", name: "Ably", why: "Realtime collaboration SDKs." }, { ref: "R2", name: "PartyKit", why: "Multiplayer servers." }, { ref: "R3", name: "Liveblocks" }, { ref: "R4", name: "Wikipedia" }, { ref: "R77", name: "Invented Inc" }], refine: [] }));
    // 4. Ably: one real quote, one fabricated (dropped).
    model.scripts.push(json({ offersSimilarProduct: true, fit: "high", confidence: "high", fitSummary: "Sells collaboration SDKs (live cursors, locking) to developers, as Liveblocks does.", facts: [{ ref: "P1", quote: "Add live cursors, avatar stacks and component locking to any web app in days, not months." }, { ref: "P1", quote: "Ably is the market leader in collaboration with 90% share." }], rationale: [{ text: "Its collaboration SDK covers the same features.", refs: ["P1"] }], openQuestions: ["Pricing relative to Liveblocks is unknown."] }));
    // 5. PartyKit: its page could not be read; the model rules it out on what little there is.
    model.scripts.push(json({ fit: "not-a-fit", confidence: "low", fitSummary: "Only a search summary is available; nothing read confirms it competes.", facts: [], rationale: [], openQuestions: [] }));

    const r = await say(t, "Who else sells something like Liveblocks? I want to know who we're up against.");
    assert.equal(r.mode, "model", JSON.stringify(r));
    assert.match(r.reason ?? "", /^research started /, JSON.stringify({ r, msgs: await t.as("ada").query(api.conversations.messagesOf, { conversationId: r.conversationId }), tools: model.requests[0]?.body.tools?.map((x: any) => x.function?.name) }));
    const runId = r.reason!.split(" ").at(-1)!;
    const messages = await t.as("ada").query(api.conversations.messagesOf, { conversationId: r.conversationId });
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"], "one message from the person, one reply: the research starting");
    assert.match(messages[1]!.text, /On it\. I checked what this PersonalOS can use/);
    assert.match(messages[1]!.text, /web search: available \(openaisearch\.search\)/, "Brave is not configured; OpenAI's web search serves the need");

    await settle(t);
    const { run, sources, prospects } = await t.as("ada").query(api.research.get, { runId });
    assert.equal(run.status, "completed");
    assert.deepEqual([run.kind, run.product, run.plan.basis], ["competitors", "Liveblocks", "model"]);
    assert.ok(run.plan.generation.generationId, "the plan cites the generation that proposed it");
    assert.ok(run.plan.rejected.some((x: string) => /contains a URL/.test(x)));
    assert.deepEqual(run.queries.map((q: any) => [q.text, q.state, q.provider]), [["liveblocks alternatives", "done", "openai-web-search"], ["realtime collaboration SDK companies", "done", "openai-web-search"]]);
    assert.ok(openai.requests.every((x) => x.auth === `Bearer ${KEY}` && x.body.tools[0].type === "web_search"), "the key from custody, only for web search");
    const search = sources.filter((x: any) => x.kind === "search");
    assert.ok(search.every((x: any) => x.textKind === "provider-summary" && x.provider === "openai-web-search"));
    assert.ok(search.every((x: any) => !x.url.includes("utm_source") && !x.url.includes("invented.example")));
    assert.ok(run.selection.rejected.some((x: string) => /R77/.test(x)) && run.selection.rejected.some((x: string) => /wikipedia/.test(x)) && run.selection.rejected.some((x: string) => /liveblocks\.io/.test(x)), JSON.stringify(run.selection.rejected));
    assert.deepEqual(run.candidates.map((c: any) => [c.domain, c.state]), [["ably.com", "assessed"], ["partykit.io", "rejected"]]);
    assert.match(run.candidates[1].verdict, /nothing read confirms/, "a negative finding, and what it rests on");

    // Pages: what happened to each.
    const pages = sources.filter((x: any) => x.kind === "page");
    assert.deepEqual(pages.map((x: any) => [x.url, x.status]).sort(), [["https://ably.com/", "read"], ["https://ably.com/solutions/multiplayer-collaboration", "read"], ["https://partykit.io/", "extraction-failed"]]);

    // The assessment: model basis with its generation, quotes verified, the fabricated one dropped.
    assert.equal(prospects.length, 1);
    const ably = prospects[0];
    assert.deepEqual([ably.company, ably.assessment.basis, ably.assessment.fit, ably.assessment.rejectedQuotes, ably.assessment.confidence], ["Ably", "model", "high", 1, "medium"]);
    assert.ok(ably.assessment.generation?.generationId);
    const quotes = ably.facts.filter((f: any) => f.kind === "quote");
    assert.deepEqual(quotes.map((f: any) => f.text), ["Add live cursors, avatar stacks and component locking to any web app in days, not months."]);
    const page = sources.find((x: any) => x.id === quotes[0].sourceId);
    assert.ok(page?.text.includes(quotes[0].text), "the quote is in the stored page text, word for word");
    assert.ok(!JSON.stringify(ably).includes("90% share"), "the invented claim is nowhere in the result");

    // Generations are recorded on the run's agent task; usage is counted.
    const generations = await t.runtime.agent.generations(run.taskId, ada as never);
    assert.equal(generations.length, 4, "plan, selection, two assessments");
    assert.deepEqual([run.usage.generations, run.usage.searches, run.usage.pagesRequested, run.usage.pagesRead, run.usage.quotesOffered, run.usage.quotesVerified], [4, 2, 3, 2, 2, 1]);
    const text = (await t.as("ada").query(api.conversations.messagesOf, { conversationId: r.conversationId })).map((m) => m.text).join("\n");
    assert.match(text, /Plan: looking for competitors of Liveblocks/);
    assert.match(text, /Research for Liveblocks is done: 1 competitor/);
    assert.match(text, /Looked at and ruled out: PartyKit/, text.slice(-1500));
    assert.ok(!JSON.stringify({ run, sources, prospects }).includes(KEY));
    assert.deepEqual(await t.as("ada").query(api.actions.list, {}), [], "nothing was done on the person's behalf");
  } finally { await t.close(); await model.close(); configureOpenAiSearch(false); delete (globalThis as any)[PAGE_READER]; }
});

test("an unusable model answer never becomes the plan: the rules plan when they recognize the request, else a stop that says why", async () => {
  configureOpenAiSearch(true);
  usePages();
  const model = await startStreamingModel();
  const t = await createTestApp();
  try {
    await withModel(t, model.url);
    model.scripts.push({ text: ["Sure! I'd search for some companies."] }); // plan: not JSON
    const started = await t.as("ada").action(api.research.begin, { text: "Find me some new customers for FeltKit" });
    await t.runtime.runServices();
    const jobs = (t.runtime.services as any).jobs;
    const [job] = (await jobs.listJobs("personalos")).filter((j: any) => j.type === "research.step");
    await jobs.executeJob("personalos", job.id, "test-worker");
    const { run } = await t.as("ada").query(api.research.get, { runId: started.runId });
    assert.deepEqual([run.plan.basis, run.phase, run.status], ["rules", "searching", "running"]);
    assert.match(run.plan.rejected[0], /not a JSON object/);

    model.scripts.push({ text: ['{"kind": "everything", "subject": "x", "queries": ["a b"]}'] });
    const other = await t.as("ada").action(api.research.begin, { text: "What's going on with realtime sync startups lately?" });
    await settle(t);
    const failed = (await t.as("ada").query(api.research.get, { runId: other.runId })).run;
    assert.deepEqual([failed.status, failed.blocker.need], ["failed", "a research plan"]);
    assert.match(failed.blocker.detail, /kind "everything" is not one of/);
  } finally { await t.close(); await model.close(); configureOpenAiSearch(false); delete (globalThis as any)[PAGE_READER]; }
});

test("a step applies only where it found the run: a duplicate (a job re-run after a restart) or a stopped run changes nothing", async () => {
  configureOpenAiSearch(true);
  const t = await createTestApp();
  try {
    await t.as("ada").mutation(api.memory.add, { kind: "project", subject: "feltkit", content: "FeltKit is a TypeScript framework for internal tools." });
    const started = await t.as("ada").action(api.research.begin, { text: "Find me some new customers for FeltKit" });
    const { run } = await t.as("ada").query(api.research.get, { runId: started.runId });
    const step = { phase: "searching", ms: 1, outcome: "test" };
    const first = await t.as("ada").mutation(api.researchstate.advance, { runId: run.id, expectUpdatedAt: run.updatedAt, patch: {}, sources: [{ url: "https://a.example/", title: "A", text: "", query: "q", provider: "test", retrievedAt: 1, kind: "search" }], step, next: false });
    const again = await t.as("ada").mutation(api.researchstate.advance, { runId: run.id, expectUpdatedAt: run.updatedAt, patch: {}, sources: [{ url: "https://a.example/", title: "A", text: "", query: "q", provider: "test", retrievedAt: 1, kind: "search" }], step, next: false });
    assert.deepEqual([first.applied, again.applied], [true, false]);
    assert.equal((await t.as("ada").query(api.research.get, { runId: run.id })).sources.length, 1, "the duplicate stored nothing");
    await assert.rejects(t.as("grace").mutation(api.researchstate.advance, { runId: run.id, expectUpdatedAt: 0, patch: {}, step, next: false }), (e: any) => e.code === "NOT_FOUND" || e.code === "FORBIDDEN");
    await t.as("ada").mutation(api.research.cancel, { runId: run.id });
    const current = (await t.as("ada").query(api.research.get, { runId: run.id })).run;
    assert.equal((await t.as("ada").mutation(api.researchstate.advance, { runId: run.id, expectUpdatedAt: current.updatedAt, patch: { status: "completed" }, step, next: false })).applied, false, "a stopped run is not advanced");
  } finally { await t.close(); configureOpenAiSearch(false); }
});

test("the model's provider refusing (as an over-quota 429 does) degrades the plan to the rules, with the provider's error kept as evidence", async () => {
  configureOpenAiSearch(true);
  usePages();
  // Found against the real provider: a long 429 body once made the step fail validation and retry forever.
  const body = JSON.stringify({ error: { message: `You have no credits remaining. ${"x".repeat(600)}`, type: "insufficient_quota", code: "credit_balance_exhausted" } });
  const server: Server = createServer((_req, res) => res.writeHead(429, { "content-type": "application/json" }).end(body));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const t = await createTestApp();
  try {
    await withModel(t, `http://127.0.0.1:${(server.address() as { port: number }).port}`);
    await t.as("ada").mutation(api.memory.add, { kind: "project", subject: "feltkit", content: "FeltKit is a TypeScript framework for internal tools." });
    const started = await t.as("ada").action(api.research.begin, { text: "Find potential customers for FeltKit" });
    await settle(t);
    const { run, prospects } = await t.as("ada").query(api.research.get, { runId: started.runId });
    assert.equal(run.plan.basis, "rules");
    assert.match(run.plan.rejected[0], /could not be reached.*429/s);
    assert.ok(run.plan.rejected[0].length <= 300);
    assert.equal(run.status, "completed", "the research still ran, on the rules");
    assert.ok(prospects.length > 0 && prospects.every((p: any) => p.assessment.basis === "rules"));
    assert.ok(run.candidates.every((c: any) => /model assessment rejected|assessed by rules/.test(c.verdict ?? "")) || run.candidates.length === 0);
  } finally { await t.close(); server.closeAllConnections(); server.close(); configureOpenAiSearch(false); delete (globalThis as any)[PAGE_READER]; }
});


test("an organization is read on its own site, never on the page that merely named it", () => {
  for (const [name, domain] of [["Encore.ts", "encore.dev"], ["Sourcetool", "trysourcetool.com"], ["Agent UI", "agentui.ai"], ["Actian Zen Database", "actian.com"], ["Thoughtworks", "thoughtworks.com"], ["Ably", "ably.com"]] as const) assert.ok(ownSite(name, domain), `${name} ${domain}`);
  // Found live: each was named in an article or list on another site, whose home page was then read.
  for (const [name, domain] of [["NocoBase", "libhunt.com"], ["Internal", "techtarget.com"], ["Nimbl", "tooljet.com"]] as const) assert.ok(!ownSite(name, domain), `${name} ${domain}`);
  const results = [{ ref: "R1", sourceId: "s1", url: "https://www.libhunt.com/l/typescript", title: "Top TypeScript internal tools", text: "", query: "q" }];
  const sel = acceptSelection({ candidates: [{ ref: "R1", name: "NocoBase", why: "listed" }] }, results, { mayRefine: false, searched: [], excludeDomains: [] });
  assert.ok(!("error" in sel) && sel.candidates.length === 0 && /named on libhunt\.com, which is not its own site/.test(sel.rejected[0]!));
});

test("a rate-limited model is waited for, not replaced: the step runs again later and the model's plan is used", async () => {
  configureOpenAiSearch(true);
  usePages();
  const model = await startStreamingModel();
  let refused = 0;
  // Two rate-limit refusals (as the gateway gave live), then the scripted model.
  const gate: Server = createServer(async (req, res) => {
    if (refused < 2) { refused += 1; return res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Rate limit exceeded for openai/gpt-4.1-mini: this team's limit of 5 requests per minute was reached. Retry after 7s.", type: "rate_limit_exceeded" } })); }
    let raw = "";
    for await (const c of req) raw += c;
    const upstream = await fetch(`${model.url}${req.url}`, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
    res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "text/event-stream" });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise<void>((r) => gate.listen(0, "127.0.0.1", () => r()));
  const t = await createTestApp();
  try {
    await withModel(t, `http://127.0.0.1:${(gate.address() as { port: number }).port}`);
    model.scripts.push(json({ kind: "competitors", subject: "Liveblocks", objective: "Find competitors.", criteria: [], queries: ["liveblocks alternatives"] }));
    model.scripts.push(json({ candidates: [], refine: [] }));
    const started = await t.as("ada").action(api.research.begin, { text: "Who competes with Liveblocks?" });
    await settle(t);
    const { run } = await t.as("ada").query(api.research.get, { runId: started.runId });
    assert.equal(refused, 2);
    assert.deepEqual([run.plan.basis, run.kind, run.status], ["model", "competitors", "completed"], "the plan is the model's, after waiting");
    const waits = run.steps.filter((x: any) => /the model is busy/.test(x.outcome));
    assert.equal(waits.length, 2, "each wait is recorded with the provider's reason");
    assert.match(waits[0].outcome, /Rate limit exceeded/);
    assert.equal(run.modelRetries, 0, "the count starts over once the model answers");
  } finally { await t.close(); await model.close(); gate.closeAllConnections(); gate.close(); configureOpenAiSearch(false); delete (globalThis as any)[PAGE_READER]; }
});


test("what the model reads from the evidence (does it sell something like the subject?) decides by rule: a vendor is never a prospect, and a non-vendor never a competitor", () => {
  const evidence = [{ ref: "P1", sourceId: "p1", url: "https://windmill.dev/", kind: "page" as const, status: "read", title: "", text: "Windmill is an open-source developer platform to build internal tools and workflows." }];
  const answer = { offersSimilarProduct: true, fit: "high", confidence: "high", fitSummary: "Builds internal tools.", facts: [{ ref: "P1", quote: "Windmill is an open-source developer platform to build internal tools and workflows." }], rationale: [] };
  const asProspect = acceptAssessment(answer, evidence, "prospects") as any;
  assert.deepEqual([asProspect.fit, asProspect.overruled], ["not-a-fit", "it offers a product like the subject: a competitor, not a prospect"], "found live: Windmill, Ciao, Relpin and Sourcetool were rated high-fit customers");
  assert.match(asProspect.fitSummary, /^Ruled out: /);
  assert.equal((acceptAssessment(answer, evidence, "competitors") as any).fit, "high");
  assert.equal((acceptAssessment({ ...answer, offersSimilarProduct: false }, evidence, "competitors") as any).fit, "not-a-fit");
  assert.equal((acceptAssessment({ ...answer, offersSimilarProduct: undefined }, evidence, "prospects") as any).fit, "high", "no answer: the model's fit stands, and nothing is assumed");
});
