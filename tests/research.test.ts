/**
 * "Find me some new customers for FeltKit." PersonalOS pursues the outcome with what the platform
 * actually offers: it discovers its capabilities from FeltKit's catalog (not a model's tool list),
 * finds the web search integration, runs the research as durable steps, and keeps the evidence
 * (what search returned) apart from its assessment.
 *
 * The search provider here is a local HTTP server answering the Brave Search API's request and
 * response shape (GET /res/v1/web/search, X-Subscription-Token, web.results[]): a stand-in for the
 * external provider only. Discovery, authorization, the integration call (FeltKit, credential
 * custody), the research agent, storage and the conversation are PersonalOS and FeltKit themselves.
 */
import { after, before, test } from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { discover, PROSPECT_NEEDS } from "../feltkit/_capabilities.js";
import { startStreamingModel } from "./fixtures/streaming-model.js";
import { domainOf, outcomeOf, planQueries, productKnowledge, prospectsFrom } from "../feltkit/_research.js";
import { PAGE_READER } from "../feltkit/research.js";
import type { PageRead } from "../feltkit/_pages.js";

const KEY = "brave_test_key_0123456789abcdef";
/**
 * Whether the installed FeltKit gives application code its full catalog (ctx.agent.catalog, with
 * permission and readiness: discovery before any call). Without it, PersonalOS discovers from its own
 * declarations and the first call establishes configuration; the outcome assertions are the same.
 */
const CATALOG = readFileSync(createRequire(import.meta.url).resolve("@feltdb/feltkit/package.json").replace(/package\.json$/, "dist/runtime/context.d.ts"), "utf8").includes("catalog(): Promise<");
const ZONE = "America/New_York";

interface Provider { url: string; requests: Array<{ q: string; count: string; key: string | undefined }>; mode: "ok" | "fail-once" | "401" | "flaky-query"; failed: Set<string>; onRequest?: (n: number) => Promise<void>; close(): Promise<void> }

/** Pages the provider "finds", by what the query is about. */
const PAGES = [
  { url: "https://www.acme-ops.com/", title: "Acme Ops | Internal tools for operations teams", description: "Acme Ops builds internal tools and dashboards in TypeScript for operations teams." },
  { url: "https://www.acme-ops.com/careers", title: "Careers - Acme Ops", description: "Hiring TypeScript engineers to build agent workflows and internal tools." },
  { url: "https://brightpipe.io/blog/agents", title: "Brightpipe: building agent-ready applications", description: "How Brightpipe ships agent-ready TypeScript applications with an internal database." },
  { url: "https://tallyhq.co.uk/", title: "Tally HQ — accounting for freelancers", description: "Simple invoicing and accounting." },
  { url: "https://github.com/someone/some-tool", title: "some-tool: internal tools in TypeScript", description: "A GitHub repository." },
  { url: "https://en.wikipedia.org/wiki/Internal_tool", title: "Internal tool - Wikipedia", description: "Encyclopedia entry about internal tools." },
  { url: "https://feltkit.dev/", title: "FeltKit", description: "FeltKit itself." },
];

async function provider(): Promise<Provider> {
  const state: Provider = { url: "", requests: [], mode: "ok", failed: new Set(), close: async () => undefined };
  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url!, "http://x");
    const q = u.searchParams.get("q") ?? "";
    state.requests.push({ q, count: u.searchParams.get("count") ?? "", key: req.headers["x-subscription-token"] as string | undefined });
    await state.onRequest?.(state.requests.length);
    if (u.pathname !== "/res/v1/web/search") return res.writeHead(404).end();
    if (req.headers["x-subscription-token"] !== KEY || state.mode === "401") return res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ type: "ErrorResponse", error: { code: "SUBSCRIPTION_TOKEN_INVALID" } }));
    if (state.mode === "fail-once" && !state.failed.has(q)) { state.failed.add(q); return res.writeHead(503).end("busy"); }
    if (state.mode === "flaky-query" && /competitors/.test(q)) return res.writeHead(500).end("down");
    const results = /alternatives|competitors/.test(q) ? PAGES.slice(2, 5) : PAGES;
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ type: "search", query: { original: q }, web: { results } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  state.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  state.close = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()); });
  return state;
}

/**
 * The companies' own pages, as the page reader would find them (feltkit/_pages.ts reads the real web;
 * tests/pages.test.ts covers it against a local server). Brightpipe's home page is down and Tally's is
 * rendered by scripts: each says so, and neither is treated as saying anything.
 */
const SITE: Record<string, Omit<PageRead, "url" | "finalUrl" | "ms">> = {
  "https://www.acme-ops.com/": { status: "read", httpStatus: 200, title: "Acme Ops", detail: "", text: "Acme Ops builds internal tools for operations teams.\nOur platform team writes every internal tool in TypeScript and is moving approvals to agent workflows this year.\nWe serve 400 logistics companies across North America, from dispatch to billing, with dashboards our own engineers maintain." },
  "https://www.acme-ops.com/careers": { status: "read", httpStatus: 200, title: "Careers - Acme Ops", detail: "", text: "Careers at Acme Ops.\nWe are hiring senior TypeScript engineers to build agent workflows and internal tools for our operations customers.\nYou will own the internal database layer and the approval flows that our dispatchers rely on every day of the week." },
  "https://brightpipe.io/blog/agents": { status: "read", httpStatus: 200, title: "Brightpipe: building agent-ready applications", detail: "", text: "How Brightpipe ships agent-ready TypeScript applications with an internal database.\nEvery customer-facing workflow at Brightpipe now has an agent path, and our applications keep their state in an embedded database so agents can act safely." },
  "https://brightpipe.io/": { status: "unavailable", httpStatus: 503, title: "", detail: "the site answered HTTP 503", text: "" },
  "https://tallyhq.co.uk/": { status: "extraction-failed", httpStatus: 200, title: "Tally HQ", detail: "only 12 characters of readable text (the page may be rendered by scripts)", text: "" },
};
const pagesRead: string[] = [];
(globalThis as any)[PAGE_READER] = async (url: string) => {
  pagesRead.push(url);
  const page = SITE[url] ?? { status: "unavailable" as const, httpStatus: null, title: "", detail: "could not be fetched: ENOTFOUND", text: "" };
  return { url, finalUrl: url, ms: 1, ...page };
};

let search: Provider;
before(async () => { search = await provider(); });
after(async () => { await search.close(); });

function configure(on: boolean) {
  if (on) { process.env.WEBSEARCH_URL = search.url; process.env.FELTKIT_CREDENTIAL_WEBSEARCH = KEY; }
  else { delete process.env.WEBSEARCH_URL; delete process.env.FELTKIT_CREDENTIAL_WEBSEARCH; }
}
const delayed: string[] = [];
/** Run research's queued steps (AppPort Services jobs) the way the services worker does, until none is left. */
async function settle(t: TestApp) {
  const jobs = (t.runtime.services as any).jobs;
  for (let i = 0; i < 300; i++) {
    await t.runtime.runServices();
    // A step scheduled for later (a back-off) runs now: the test stands in for the wait.
    const due = (await jobs.listJobs("personalos")).filter((j: any) => j.type === "research.step" && ["queued", "scheduled", "pending"].includes(j.status));
    delayed.push(...due.filter((j: any) => Date.parse(j.runAt ?? 0) > Date.now() + 1000).map((j: any) => j.id));
    if (!due.length) return;
    for (const j of due) await jobs.executeJob("personalos", j.id, "test-worker");
  }
  throw new Error("research did not settle");
}
const say = (t: TestApp, text: string, conversationId?: string) =>
  t.as("ada").action(api.turn.turn, { text, clientId: `c-${Math.random().toString(36).slice(2)}`, ...(conversationId ? { conversationId } : {}) }, { context: { timeZone: ZONE, locale: "en-US" } });
async function knowsFeltKit(t: TestApp) {
  await t.as("ada").mutation(api.memory.add, { kind: "project", subject: "feltkit", content: "FeltKit is a TypeScript framework for building internal tools and agent-ready applications on an embedded database." });
}
const latestRun = async (t: TestApp) => (await t.as("ada").query(api.research.list, {}))[0]!;
const detail = async (t: TestApp, runId: string) => t.as("ada").query(api.research.get, { runId });
const transcript = async (t: TestApp, conversationId: string) => (await t.as("ada").query(api.conversations.messagesOf, { conversationId })).map((m) => `${m.role}: ${m.text}`).join("\n");

test("the outcome is understood: finding customers is research, not a task list", () => {
  assert.deepEqual(outcomeOf("Find me some new customers for FeltKit.")?.product, "FeltKit");
  assert.match(outcomeOf("Find me some new customers for FeltKit.")!.objective, /evidence-backed, ranked prospect list/);
  for (const text of ["find prospects for my product", "Can you find leads for Acme Widgets?", "who would buy FeltKit"]) assert.ok(outcomeOf(text), text);
  for (const text of ["remind me to call the bank", "find my notes about Sam", "add find customers to my list"]) assert.equal(outcomeOf(text), null, text);
  const knowledge = productKnowledge("FeltKit", [{ id: "m1", content: "FeltKit is a TypeScript framework for building internal tools and agent-ready applications." }, { id: "m2", content: "Sam is my manager" }]);
  assert.deepEqual(knowledge.statements.map((s) => s.id), ["m1"], "only what the person said about the product");
  assert.ok(knowledge.keywords.includes("typescript") && knowledge.keywords.includes("internal") && !knowledge.keywords.includes("feltkit"));
  assert.ok(planQueries("FeltKit", knowledge).length >= 3);
  assert.equal(domainOf("https://tallyhq.co.uk/pricing"), "tallyhq.co.uk");
});

test("discovery classifies from the platform's catalog: available, not configured, not permitted, connectable", async () => {
  const entry = (extra: object) => ({ name: "websearch.search", allowed: true, integration: "websearch", readiness: { ready: true, problems: [] }, ...extra });
  const of = async (catalog: object[]) => (await discover({ catalog: async () => catalog as never, tools: async () => [] }, PROSPECT_NEEDS)).needs[0]!;
  assert.equal((await of([entry({})])).state, "available");
  const unconfigured = await of([entry({ readiness: { ready: false, problems: [{ message: "websearch: WEBSEARCH_URL is not set", fix: "Set WEBSEARCH_URL." }] } })]);
  assert.equal(unconfigured.state, "needs-configuration");
  assert.match(unconfigured.howToEnable!, /^Any one of these will do\. websearch\.search: Set WEBSEARCH_URL\. Or, openaisearch\.search: /, "each provider that could serve the need, and what it lacks");
  assert.equal((await of([entry({ allowed: false })])).state, "needs-authorization");
  assert.equal((await of([])).state, "connectable", "not declared: a provider can be connected, it is not 'no web access'");
  const d = await discover({ catalog: async () => [entry({})] as never, tools: async () => [] }, PROSPECT_NEEDS);
  assert.deepEqual([d.executable, d.complete], [true, false], "contact research is not connected: a partial result, not a refusal");
});

test("ACCEPTANCE: \"Find me some new customers for FeltKit\" is discovered, authorized, executed, and saved with its evidence; nothing is sent", async () => {
  configure(true);
  search.mode = "ok";
  search.requests = [];
  const t = await createTestApp();
  try {
    await knowsFeltKit(t);
    const r = await say(t, "Find me some new customers for FeltKit.");
    assert.equal(r.reason, "research running");
    const run = await latestRun(t);
    const { run: started } = await detail(t, run.id);
    // 1-3. The outcome, and the capability landscape discovered from the platform's catalog.
    assert.equal(started.product, "FeltKit");
    assert.match(started.objective, /evidence-backed/);
    const discovery = started.discovery as any;
    assert.equal(discovery.source, CATALOG ? "ctx.agent.catalog" : "ctx.agent.tools", "the platform's catalog when FeltKit provides it");
    if (CATALOG) assert.ok(discovery.capabilitiesSeen > 9, `more than the nine model tools (${discovery.capabilitiesSeen})`);
    assert.deepEqual(discovery.needs.map((n: any) => [n.need, n.state, n.capability]), [["web search", "available", "websearch.search"], ["page retrieval", "available", null], ["contact research", "connectable", null]]);
    if (CATALOG) assert.deepEqual(discovery.needs[0].alternatives.map((a: any) => [a.capability, a.state]), [["websearch.search", "available"], ["openaisearch.search", "needs-configuration"]], "the other provider is known, and why it is not used");
    if (!CATALOG) assert.match(discovery.needs[0].problems[0], /first call will tell/, "without the catalog, available means declared, and says so");
    assert.ok(started.profile.statements.length === 1, "the profile is the person's own statement about FeltKit");
    let text = await transcript(t, r.conversationId);
    assert.match(text, /finding qualified prospects for FeltKit/);
    assert.doesNotMatch(text, /no web access|can't search|cannot search/i);

    // 4-5. Executed through the websearch integration, with the stored credential (sent by FeltKit, never seen by code).
    await settle(t);
    assert.ok(search.requests.length >= 3);
    assert.ok(search.requests.every((x) => x.key === KEY && x.count === "10"));
    const done = await detail(t, run.id);
    assert.equal(done.run.status, "completed");
    assert.ok(done.run.queries.every((q: any) => q.state === "done"));

    // 6-8. Evidence-backed prospects, persisted; facts are what sources returned, apart from the assessment.
    assert.ok(done.sources.length > 0);
    assert.ok(done.prospects.length >= 2);
    const domains = done.prospects.map((p: any) => p.domain);
    assert.ok(domains.includes("acme-ops.com") && domains.includes("brightpipe.io"));
    assert.deepEqual(done.prospects.map((p: any) => p.company), ["Acme Ops", "Brightpipe", "Tally HQ"], "names from the pages' titles");
    const acmeFacts = done.prospects.find((p: any) => p.domain === "acme-ops.com")!.facts;
    assert.equal(acmeFacts.filter((f: any) => f.kind === "search-result").length, 2, "one search-result fact per page, however many searches returned it");
    assert.ok(acmeFacts.filter((f: any) => f.kind === "quote").length >= 2, `and quotes from its pages, which were read: ${JSON.stringify({ acmeFacts, pagesRead, pages: done.sources.filter((x: any) => x.kind === "page").map((x: any) => [x.url, x.status]), cands: done.run.candidates, kw: done.run.profile.keywords })}`);
    assert.ok(pagesRead.includes("https://www.acme-ops.com/careers") && pagesRead.includes("https://tallyhq.co.uk/"));
    for (const excluded of ["github.com", "wikipedia.org", "feltkit.dev"]) assert.ok(!domains.includes(excluded), `${excluded} is not a prospect`);
    const LEVEL: Record<string, number> = { high: 3, medium: 2, low: 1 };
    const order = done.prospects.map((p: any) => LEVEL[p.assessment.fit]! * 10 + LEVEL[p.assessment.confidence]!);
    assert.deepEqual(order, [...order].sort((a: number, b: number) => b - a), "ranked by fit, then confidence: one scale whatever the basis");
    assert.deepEqual(done.prospects.map((p: any) => p.rank), done.prospects.map((_: unknown, i: number) => i + 1));
    const sourceById = new Map(done.sources.map((s: any) => [s.id, s]));
    for (const p of done.prospects) {
      for (const f of p.facts) {
        const s: any = sourceById.get(f.sourceId);
        assert.ok(s, "every fact cites a stored source");
        assert.equal(f.url, s.url);
        if (f.kind === "quote") assert.ok(s.kind === "page" && s.status === "read" && s.text.includes(f.text), "a quote is verbatim from a page that was read");
        else assert.ok(f.text.includes(s.title), "a search-result fact is what the search returned");
      }
      assert.equal(p.assessment.basis, "rules");
      assert.ok(p.assessment.rationale.every((x: any) => x.sourceIds.every((id: string) => sourceById.has(id))), "the assessment cites the sources it rests on");
      const read = done.sources.some((x: any) => x.kind === "page" && x.status === "read" && domainOf(x.url) === p.domain);
      if (!read) assert.ok(p.openQuestions.some((q: string) => /search-result text was read/.test(q)), "says its pages were not read");
      assert.match(p.nextAction, /without your approval/);
      assert.equal(typeof p.researchedAt, "number");
    }
    const acme = done.prospects.find((p: any) => p.domain === "acme-ops.com");
    assert.equal(acme?.assessment.fit, "high");
    assert.equal(done.prospects.find((p: any) => p.domain === "tallyhq.co.uk")?.assessment.fit, "low", "a weak lead is labelled weak");
    text = await transcript(t, r.conversationId);
    assert.match(text, /Research for FeltKit is done: \d+ prospects from \d+ search results \(5 of 5 searches\), with 3 of 5 pages read/);
    // Pages that were not read say why, and are never evidence.
    const pages = done.sources.filter((x: any) => x.kind === "page");
    assert.deepEqual(pages.filter((x: any) => x.status !== "read").map((x: any) => [domainOf(x.url), x.status]).sort(), [["brightpipe.io", "unavailable"], ["tallyhq.co.uk", "extraction-failed"]]);
    assert.ok(pages.filter((x: any) => x.status !== "read").every((x: any) => x.text === "" && x.detail));
    assert.ok(done.run.steps.length >= 12, "every step is recorded");
    assert.deepEqual([done.run.usage.searches, done.run.usage.pagesRequested, done.run.usage.pagesRead, done.run.usage.generations], [5, 5, 3, 0]);
    assert.match(text, /Acme Ops/);

    // 9. Nothing was sent: no proposals, no actions, and the only external calls were searches.
    const logged = await t.as("ada").query(api.actions.list, {});
    assert.deepEqual(logged.map((x: any) => [x.kind, x.status]), [["memory.remember", "succeeded"]], "only the test's own setup (saving what FeltKit is); research proposed and did nothing");
    assert.ok(search.requests.length === done.run.queries.length, "one search per planned query, nothing else");
    assert.match(text, /Nothing was sent to anyone/);
    assert.ok(!JSON.stringify(done).includes(KEY), "the provider's key is in no record");
  } finally { await t.close(); configure(false); }
});

test("missing capability: no search provider configured, the exact blocker and how to clear it; nothing invented, nothing run", async () => {
  configure(false);
  search.requests = [];
  const t = await createTestApp();
  try {
    await knowsFeltKit(t);
    const r = await say(t, "Find me some new customers for FeltKit.");
    // With the catalog it is known before anything runs; without it, the first call establishes it.
    assert.equal(r.reason, CATALOG ? "research blocked" : "research running");
    await settle(t);
    const { run, sources, prospects } = await detail(t, (await latestRun(t)).id);
    assert.equal(run.status, "blocked");
    assert.deepEqual([run.blocker.need, run.blocker.state], ["web search", "needs-configuration"]);
    assert.match(run.blocker.detail, /WEBSEARCH_URL is not set/);
    assert.match(run.blocker.detail, /credential credential-ref:websearch/);
    assert.match(run.blocker.howToEnable, /WEBSEARCH_URL/);
    assert.deepEqual([sources.length, prospects.length, search.requests.length], [0, 0, 0]);
    const text = await transcript(t, r.conversationId);
    if (CATALOG) {
      assert.match(text, /isn't a permanent limit/);
      assert.match(text, /web search: declared, not configured/);
      assert.match(text, /Nothing was searched/);
    } else {
      assert.match(text, /web search: declared; whether it is configured is checked on first use/);
      assert.match(text, /The research for FeltKit stopped: CONFIGURATION: websearch\.search is not configured: websearch: WEBSEARCH_URL is not set/);
    }
    assert.doesNotMatch(text, /no web access|I can only/i);
    // Configured later: the same objective resumes, and runs.
    configure(true);
    search.mode = "ok";
    const resumed = await say(t, "retry research", r.conversationId);
    assert.match(resumed.reason ?? "", /research retry/);
    await settle(t);
    assert.equal((await detail(t, run.id)).run.status, "completed");
  } finally { await t.close(); configure(false); }
});

test("the provider refuses the credential: blocked with the reason, not retried forever, nothing claimed", async () => {
  configure(true);
  search.mode = "401";
  search.requests = [];
  const t = await createTestApp();
  try {
    await knowsFeltKit(t);
    await say(t, "Find me some new customers for FeltKit.");
    await settle(t);
    const { run, prospects } = await detail(t, (await latestRun(t)).id);
    assert.deepEqual([run.status, run.blocker.state], ["blocked", "needs-configuration"]);
    assert.match(run.blocker.detail, /refused the credential/);
    assert.equal(search.requests.length, 1, "a refused key is not retried");
    assert.equal(prospects.length, 0);
  } finally { await t.close(); configure(false); search.mode = "ok"; }
});

test("transient provider failures are retried; a search that keeps failing leaves a partial, honest result", async () => {
  configure(true);
  search.mode = "fail-once";
  search.failed.clear();
  delayed.length = 0;
  search.requests = [];
  const t = await createTestApp();
  try {
    await knowsFeltKit(t);
    await say(t, "Find me some new customers for FeltKit.");
    await settle(t);
    const first = await detail(t, (await latestRun(t)).id);
    assert.equal(first.run.status, "completed");
    assert.ok(first.run.queries.every((q: any) => q.attempts === 2), "each search failed once, then succeeded");
    assert.ok(delayed.length >= first.run.queries.length, "each retry waited (a job scheduled for later), instead of hammering the provider");
    // One query's provider stays down: it gives up after 3 attempts; the rest still yields prospects.
    search.mode = "flaky-query";
    const r = await say(t, "Find me new prospects for FeltKit");
    await settle(t);
    const second = await detail(t, (await latestRun(t)).id);
    assert.equal(second.run.status, "partial");
    const failed = second.run.queries.filter((q: any) => q.state === "failed");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].attempts, 3);
    assert.ok(second.prospects.length > 0);
    assert.match(await transcript(t, r.conversationId), /partly done[\s\S]*1 search\(es\) failed/);
  } finally { await t.close(); configure(false); search.mode = "ok"; }
});

test("cancellation stops between steps and keeps what was found; retry resumes the same objective", async () => {
  configure(true);
  search.mode = "ok";
  search.requests = [];
  const t = await createTestApp();
  try {
    await knowsFeltKit(t);
    const r = await say(t, "Find me some new customers for FeltKit.");
    const runId = (await latestRun(t)).id;
    // The person stops it while the second search is in flight.
    search.onRequest = async (n) => { if (n === 2) await t.as("ada").mutation(api.research.cancel, { runId }); };
    await settle(t);
    search.onRequest = undefined;
    const stopped = await detail(t, runId);
    assert.equal(stopped.run.status, "cancelled");
    assert.equal(stopped.prospects.length, 0, "no prospects from an unfinished search");
    assert.ok(stopped.run.queries.some((q: any) => q.state === "pending"), "the rest was not run");
    const searchesBefore = search.requests.length;
    assert.ok(searchesBefore <= 2);
    await say(t, "retry research", r.conversationId);
    await settle(t);
    const resumed = await detail(t, runId);
    assert.equal(resumed.run.status, "completed");
    assert.ok(resumed.prospects.length > 0);
    assert.match(await transcript(t, r.conversationId), /Stopped the research for FeltKit[\s\S]*Resuming the research/);
  } finally { await t.close(); configure(false); }
});

test("authorization: research and its evidence are the owner's; another account sees none of it, a viewer cannot start it", async () => {
  configure(true);
  search.mode = "ok";
  const t = await createTestApp();
  try {
    await knowsFeltKit(t);
    await say(t, "Find me some new customers for FeltKit.");
    await settle(t);
    const runId = (await latestRun(t)).id;
    await assert.rejects(t.as("grace").query(api.research.get, { runId }), (e: any) => e.code === "NOT_FOUND");
    assert.deepEqual(await t.as("grace").query(api.research.list, {}), []);
    await assert.rejects(t.as("guest").action(api.research.begin, { text: "Find me some new customers for FeltKit." }), (e: any) => e.code === "FORBIDDEN");
  } finally { await t.close(); configure(false); }
});

test("prospects keep sources and assessments apart, cite only stored sources, and skip directories and the product itself", () => {
  const knowledge = productKnowledge("FeltKit", [{ id: "m", content: "FeltKit builds internal tools in TypeScript for agent workflows." }]);
  const sources = PAGES.map((p, i) => ({ id: `s${i}`, url: p.url, title: p.title, text: p.description, query: i < 3 ? "q1" : "q2" }));
  const drafts = prospectsFrom("FeltKit", knowledge, sources, { pagesRead: false });
  assert.deepEqual(drafts.map((d) => d.domain).sort(), ["acme-ops.com", "brightpipe.io", "tallyhq.co.uk"]);
  for (const d of drafts) for (const f of d.facts) assert.ok(sources.some((s) => s.id === f.sourceId && s.url === f.url));
  assert.equal(drafts[0]!.facts.length, 2, "both Acme pages are its evidence");
});

test("with a model: the outcome still goes to research (not the model's tool list), and the model's context is the discovered landscape, not invented limits", async () => {
  const model = await startStreamingModel();
  const t = await createTestApp();
  const admin = { id: "root", type: "user" as const, roles: ["admin"] };
  try {
    await t.runtime.services.asPrincipal(admin as never, (v) => t.runtime.services.intelligence!.set({ ...t.runtime.services.scope, provider: "ollama", model: "loop", endpoint: `${model.url}/v1` }, v));
    configure(true);
    await knowsFeltKit(t);
    const r = await say(t, "Find me some new customers for FeltKit.");
    assert.equal(r.reason, "research running");
    assert.equal(model.requests.length, 0, "the model did not decide what PersonalOS can do");
    // The follow-up from the bug report, answered by the model: its context says what discovery found.
    model.scripts.push({ text: ["Yes: web search is available here, and the research is running."] });
    await say(t, "Are you sure you can't search the web?", r.conversationId);
    const system = String(model.requests.at(-1)!.body.messages[0].content);
    assert.match(system, CATALOG ? /web search: available \(websearch\.search\)/ : /web search: declared; whether it is configured is checked on first use \(websearch\.search\)/);
    assert.match(system, /page retrieval: available/);
    assert.match(system, /contact research: no provider connected/);
    assert.match(system, /Never say a capability does not exist, or that you have no web access, unless the list above says so/);
    assert.doesNotMatch(system, /there is no such integration/);
    // Not configured: the model is told exactly that, with what is missing.
    configure(false);
    model.scripts.push({ text: ["Web search is set up but not configured yet."] });
    await say(t, "can you search the web?", r.conversationId);
    assert.match(String(model.requests.at(-1)!.body.messages[0].content), CATALOG ? /web search: declared, not configured \(websearch\.search\): websearch\.search: websearch: WEBSEARCH_URL is not set[\s\S]*openaisearch\.search: openaisearch: OPENAISEARCH_URL is not set/ : /web search: declared; whether it is configured is checked on first use \(websearch\.search\)/);
  } finally { await t.close(); await model.close(); configure(false); }
});

test("on a FeltKit without ctx.agent.catalog, discovery falls back to the caller's tools and says which inventory it used", async () => {
  const d = await discover({ tools: async () => [{ name: "websearch.search" }, { name: "tasks.create" }] }, PROSPECT_NEEDS);
  assert.deepEqual([d.source, d.needs[0]!.state], ["ctx.agent.tools", "available"]);
  const absent = await discover({ tools: async () => [{ name: "tasks.create" }] }, PROSPECT_NEEDS);
  assert.equal(absent.needs[0]!.state, "needs-authorization", "absent from the caller's tools: not permitted or not declared, said as such");
  assert.match(absent.needs[0]!.problems[0]!, /may not be permitted for your account, or not declared/);
});

test("without a model, \"are you sure you can't search the web?\" is answered from discovery, not a fixed list of what I do", async () => {
  const t = await createTestApp();
  try {
    configure(true);
    const yes = await say(t, "Are you sure you can't search the web?");
    assert.equal(yes.reason, "capabilities");
    let text = await transcript(t, yes.conversationId);
    assert.match(text, CATALOG ? /Yes\. Web search is available to me here/ : /Web search is set up in this PersonalOS; whether its provider is configured is checked when research first uses it/);
    assert.match(text, /What I checked \(\d+ capabilities\)/);
    assert.doesNotMatch(text, /With the model off I handle tasks/);
    configure(false);
    const not = await say(t, "can you browse the web?", yes.conversationId);
    text = await transcript(t, not.conversationId);
    if (CATALOG) assert.match(text, /Not right now, and it isn't a fixed limit: web search is set up but not configured\. Any one of these will do\. websearch\.search: Set WEBSEARCH_URL/);
    else assert.match(text, /whether its provider is configured is checked when research first uses it/);
  } finally { await t.close(); configure(false); }
});
