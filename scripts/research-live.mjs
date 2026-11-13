/**
 * Research against the real world: a real model, a real web search provider, real company sites.
 *
 *   AI_GATEWAY_API_KEY=… node scripts/research-live.mjs [outDir]    (or OPENAI_API_KEY=…)
 *
 * Runs `feltkit dev` in a fresh state directory with:
 *   - the model: gpt-4.1-mini through Vercel AI Gateway (FeltKit's custom provider) when
 *     AI_GATEWAY_API_KEY is set, else OpenAI (`feltkit model set`); the key in FeltKit's credential
 *     custody (FELTKIT_CREDENTIAL_<ID>, set in the child's environment only, never printed);
 *   - web search: OpenAI's web search through the same service (credential `openaisearch`). Brave is used
 *     instead when WEBSEARCH_URL and FELTKIT_CREDENTIAL_WEBSEARCH are set;
 *   - page reading: the open web (feltkit/_pages.ts).
 * It asks three things in words, through the conversation (as a person would): customers for FeltKit;
 * the same need phrased differently; and FeltKit's competitors. During the first run it kills the server
 * (the whole process group) and starts it again on the same state; during the second it stops the run
 * and retries it. It writes what happened, measured, to <outDir>/research-live.json. Nothing in it is a
 * stand-in: if a key or the network is missing, it fails and says so.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, ref } from "@feltdb/feltkit/client";

const out = process.argv[2] ?? ".";
mkdirSync(out, { recursive: true });
// Vercel AI Gateway when AI_GATEWAY_API_KEY is set (model and search), else OpenAI directly.
const GATEWAY = Boolean(process.env.AI_GATEWAY_API_KEY) && process.env.RESEARCH_LIVE_PROVIDER !== "openai";
const KEY = GATEWAY ? process.env.AI_GATEWAY_API_KEY : process.env.OPENAI_API_KEY;
if (!KEY) { console.error("Neither AI_GATEWAY_API_KEY nor OPENAI_API_KEY is set: no real model or search to run against. Nothing was run."); process.exit(2); }
const MODEL = process.env.RESEARCH_LIVE_MODEL ?? (GATEWAY ? "openai/gpt-4.1-mini" : "gpt-4.1-mini");
const state = process.env.RESEARCH_LIVE_STATE ?? mkdtempSync(join(tmpdir(), "pos-research-live-"));
const env = {
  ...process.env, FELTKIT_STATE_DIR: state, NO_COLOR: "1",
  // Into credential custody by environment (FELTKIT_CREDENTIAL_<ID>), in the child only; never printed.
  ...(GATEWAY ? { FELTKIT_CREDENTIAL_AI_GATEWAY: KEY } : { FELTKIT_CREDENTIAL_OPENAI: KEY }),
  FELTKIT_CREDENTIAL_OPENAISEARCH: KEY,
  OPENAISEARCH_URL: process.env.OPENAISEARCH_URL ?? (GATEWAY ? "https://ai-gateway.vercel.sh" : "https://api.openai.com"),
  OPENAISEARCH_MODEL: process.env.OPENAISEARCH_MODEL ?? MODEL,
};
for (const k of ["PORT", "FELTKIT_PORT", "FELTDB_URL", "FELTDB_ENDPOINT"]) delete env[k];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function cli(args, input) {
  const r = spawnSync("npx", ["feltkit", ...args], { env, encoding: "utf8", input });
  if (r.status !== 0) throw new Error(`feltkit ${args[0]} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}
const session = JSON.parse(cli(["session", "create", "--id", "owner", "--role", "owner", "--role", "admin", "--type", "user", "--label", "research-live", "--json"]));
cli(GATEWAY
  ? ["model", "set", "--provider", "custom", "--model", MODEL, "--endpoint", "https://ai-gateway.vercel.sh/v1", "--credential", "credential-ref:ai-gateway"]
  : ["model", "set", "--provider", "openai", "--model", MODEL, "--credential", "credential-ref:openai"]);
log(`state ${state}; model ${MODEL} via ${GATEWAY ? "Vercel AI Gateway" : "OpenAI"}; search ${env.OPENAISEARCH_URL}; keys in custody from the environment, not shown`);

let dev = null;
async function start() {
  dev = spawn("npx", ["feltkit", "dev", "--port", "0"], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let text = "";
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`feltkit dev did not start:\n${text}`)), 120_000);
    const look = (d) => { text += d; const m = /App\s+(http:\/\/localhost:\d+)/.exec(text); if (m) { clearTimeout(timer); resolve(m[1]); } };
    dev.stdout.on("data", look); dev.stderr.on("data", look);
    dev.once("exit", (c) => reject(new Error(`feltkit dev exited ${c}:\n${text}`)));
  });
  dev.stdout.removeAllListeners("data"); dev.stderr.removeAllListeners("data"); dev.removeAllListeners("exit");
  dev.stdout.resume(); dev.stderr.resume();
  return url;
}
async function kill(signal = "SIGKILL") {
  if (!dev) return;
  const exited = new Promise((r) => dev.once("exit", r));
  try { process.kill(-dev.pid, signal); } catch {}
  await exited;
  dev = null;
  // npx exits before the server under it: wait until the process holding the state's lock is gone.
  let holder = null;
  try { holder = JSON.parse(readFileSync(join(state, "owner.lock"), "utf8")).pid; } catch {}
  for (let i = 0; holder && i < 100; i += 1) {
    try { process.kill(holder, 0); } catch { break; }
    try { process.kill(holder, signal); } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
}

let client;
const api = { turn: ref("turn:turn"), get: ref("research:get"), list: ref("research:list"), cancel: ref("research:cancel"), retry: ref("research:retry"), remember: ref("memory:add"), messages: ref("conversations:messagesOf"), settings: ref("settings:update"), status: ref("turn:modelStatus") };
function connect(url) {
  let token = session.token;
  client = createClient({ url, session: "bearer", tokens: { get: () => token, set: (t) => { token = t ?? token; } } });
}
const context = { timeZone: "America/New_York", locale: "en-US" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(runId, until, { timeoutMs = 20 * 60_000 } = {}) {
  const started = Date.now();
  for (;;) {
    let d = null;
    try { d = await client.query(api.get, { runId }); } catch (e) { if (Date.now() - started > timeoutMs) throw e; }
    if (d && until(d.run)) return d;
    if (Date.now() - started > timeoutMs) throw new Error(`run ${runId} did not reach the expected state: ${d?.run.status}/${d?.run.phase}`);
    await sleep(1500);
  }
}

async function ask(text) {
  const t0 = Date.now();
  const r = await client.action(api.turn, { text, clientId: `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` }, { context });
  const runs = await client.query(api.list, {});
  const run = runs.find((x) => x.conversationId === r.conversationId && x.createdAt >= t0 - 1000);
  return { turn: r, runId: run?.id ?? null, turnMs: Date.now() - t0 };
}

function summarize(label, request, d, wallMs, turn, events) {
  const { run, sources, prospects } = d;
  const pages = sources.filter((s) => s.kind === "page");
  const pageStatus = {};
  for (const p of pages) pageStatus[p.status] = (pageStatus[p.status] ?? 0) + 1;
  const u = run.usage ?? {};
  // Assumed list prices (USD per 1M tokens) for an estimate only; the provider's invoice is authoritative.
  const PRICE = { "gpt-4.1-mini": { in: 0.4, out: 1.6 }, "gpt-4.1": { in: 2, out: 8 } }[MODEL.replace(/^openai\//, "")] ?? null;
  const SEARCH_CALL = 0.01; // assumed per web_search tool call (USD); search content tokens are billed at the model's rate
  const estimate = PRICE ? ((u.inputTokens + (u.searchInputTokens ?? 0)) * PRICE.in + (u.outputTokens + (u.searchOutputTokens ?? 0)) * PRICE.out) / 1e6 + (u.searches - u.searchFailures) * SEARCH_CALL : null;
  return {
    label, request, routed: turn.turn.mode === "model" ? `model turn (${turn.turn.reason ?? "no research"})` : `rules (${turn.turn.reason})`,
    runId: run.id, status: run.status, kind: run.kind, subject: run.product, objective: run.objective,
    plan: { basis: run.plan?.basis, criteria: run.plan?.criteria, rejected: run.plan?.rejected ?? [], generation: run.plan?.generation ?? null },
    searches: run.queries.map((q) => ({ text: q.text, origin: q.origin, state: q.state, results: q.results ?? 0, provider: q.provider, ms: q.ms, attempts: q.attempts, error: q.error ?? null })),
    selection: { basis: run.selection?.basis, rejected: run.selection?.rejected ?? [] },
    candidates: (run.candidates ?? []).map((c) => ({ name: c.name, domain: c.domain, state: c.state, verdict: c.verdict ?? null })),
    pages: { requested: pages.length, byStatus: pageStatus, failures: pages.filter((p) => p.status !== "read").map((p) => ({ url: p.url, status: p.status, detail: p.detail })) },
    results: prospects.map((p) => ({
      rank: p.rank, company: p.company, website: p.website, fit: p.assessment.fit, confidence: p.assessment.confidence, basis: p.assessment.basis, why: p.assessment.whyFeltKit,
      generationId: p.assessment.generation?.generationId ?? null, rejectedQuotes: p.assessment.rejectedQuotes ?? 0,
      quotes: p.facts.filter((f) => f.kind === "quote").map((f) => ({ text: f.text, url: f.url })),
      searchResults: p.facts.filter((f) => f.kind !== "quote").length,
      rationale: p.assessment.rationale.map((r) => r.text), openQuestions: p.openQuestions,
    })),
    usage: u, estimatedCostUsd: estimate == null ? null : Math.round(estimate * 10000) / 10000,
    wallMs, turnMs: turn.turnMs,
    stepCount: (run.steps ?? []).length, stepMsByPhase: Object.fromEntries(Object.entries((run.steps ?? []).reduce((a, s) => ((a[s.phase] = (a[s.phase] ?? 0) + s.ms), a), {}))),
    events,
    blocker: run.blocker ?? null,
  };
}

const report = { at: new Date().toISOString(), model: `${MODEL} via ${GATEWAY ? "Vercel AI Gateway (custom provider)" : "OpenAI"}`, search: process.env.WEBSEARCH_URL ? "brave (websearch)" : `openai web search (openaisearch) at ${env.OPENAISEARCH_URL}`, runs: [] };
try {
  let url = await start();
  connect(url);
  log("feltkit dev", url);
  const status = await client.action(api.status, {});
  if (!status.ready) throw new Error(`the model is not ready: ${JSON.stringify(status.problems)}`);
  await client.mutation(api.remember, { kind: "project", subject: "feltkit", content: "FeltKit is my product: a TypeScript framework for building applications on an embedded database (FeltDB), with auth, background jobs, HTTP integrations with credential custody, and an agent runtime where AI models propose actions and people approve them. It's for developers and teams building internal tools and agent-ready business applications." });

  // 1. Customers, with a restart in the middle.
  {
    const request = "Find potential customers for FeltKit";
    const t0 = Date.now();
    const turn = await ask(request);
    if (!turn.runId) throw new Error(`no research run started: ${JSON.stringify(turn.turn)}`);
    log("run 1", turn.runId, turn.turn.reason);
    const before = await waitFor(turn.runId, (r) => r.phase === "reading" || r.status !== "running");
    const events = [];
    if (before.run.status === "running") {
      const stepsBefore = before.run.steps.length;
      log("killing feltkit dev mid-run (phase", before.run.phase + ")");
      await kill("SIGKILL");
      const down = Date.now();
      url = await start();
      connect(url);
      log("restarted", url);
      const after = await waitFor(turn.runId, (r) => (r.steps?.length ?? 0) > stepsBefore || r.status !== "running");
      events.push({ event: "restart", phase: before.run.phase, stepsBefore, resumedAfterMs: Date.now() - down, nextStep: after.run.steps.at(-1) });
      log("resumed after restart:", JSON.stringify(after.run.steps.at(-1)));
    }
    const done = await waitFor(turn.runId, (r) => r.status !== "running");
    report.runs.push(summarize("customers", request, done, Date.now() - t0, turn, events));
    log("run 1", done.run.status, done.prospects.length, "results");
  }

  // 2. The same need, phrased differently; stopped while searching, then retried.
  {
    const request = "Which companies would actually pay for something like FeltKit? I want a short list worth reaching out to.";
    const t0 = Date.now();
    const turn = await ask(request);
    if (!turn.runId) throw new Error(`no research run started: ${JSON.stringify(turn.turn)}`);
    log("run 2", turn.runId, turn.turn.reason);
    const events = [];
    const mid = await waitFor(turn.runId, (r) => r.phase === "searching" && r.queries.some((q) => q.state === "done") || r.status !== "running");
    if (mid.run.status === "running") {
      await client.mutation(api.cancel, { runId: turn.runId });
      const stopped = await client.query(api.get, { runId: turn.runId });
      const stepsAtStop = stopped.run.steps.length;
      await sleep(15_000);
      const later = await client.query(api.get, { runId: turn.runId });
      events.push({ event: "stop", status: later.run.status, stepsAtStop, stepsAfter15s: later.run.steps.length, searchesDone: later.run.queries.filter((q) => q.state === "done").length, searchesPending: later.run.queries.filter((q) => q.state === "pending").length });
      log("stopped:", JSON.stringify(events.at(-1)));
      await client.action(api.retry, { runId: turn.runId });
      events.push({ event: "retry" });
    }
    const done = await waitFor(turn.runId, (r) => r.status !== "running");
    report.runs.push(summarize("customers, phrased differently", request, done, Date.now() - t0, turn, events));
    log("run 2", done.run.status, done.prospects.length, "results");
  }

  // 3. A second objective: competitors.
  {
    const request = "Who are FeltKit's main competitors?";
    const t0 = Date.now();
    const turn = await ask(request);
    if (!turn.runId) throw new Error(`no research run started: ${JSON.stringify(turn.turn)}`);
    log("run 3", turn.runId, turn.turn.reason);
    const done = await waitFor(turn.runId, (r) => r.status !== "running");
    report.runs.push(summarize("competitors", request, done, Date.now() - t0, turn, []));
    log("run 3", done.run.status, done.prospects.length, "results");
  }
} catch (error) {
  report.error = String(error?.stack ?? error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await kill("SIGTERM");
  const text = JSON.stringify(report, null, 2);
  if (text.includes(KEY)) throw new Error("refusing to write a report that contains the key");
  writeFileSync(join(out, "research-live.json"), text);
  log("wrote", join(out, "research-live.json"));
}
