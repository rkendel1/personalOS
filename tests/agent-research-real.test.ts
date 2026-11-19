/**
 * An agent outside Anywhere Aide runs research for a person over /appport, under their grants to it and a
 * research budget only they set (FeltKit's delegated execution, the REAL private AuthBoundry, real HTTP,
 * real durable jobs, Anywhere Aide's own research pipeline). Every billable call (here: a web search through
 * the websearch integration) is charged to the run before it is made, and none is made past its budget,
 * after it is cancelled, or once the person revokes the grant.
 *
 * The search provider is a local HTTP server answering the Brave Search API's shape (as in
 * tests/research.test.ts), and pages come through the research page-reader seam: stand-ins for the
 * outside world only. No model is configured, so research plans by its rules and its only billable calls
 * are searches, which the stand-in counts exactly.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { startServer } from "@feltdb/feltkit/server";
import { api } from "../feltkit/_generated/api.js";
import { PAGE_READER } from "../feltkit/research.js";

function skipReason(): string | false {
  const require = createRequire(import.meta.url);
  const feltkit = dirname(require.resolve("@feltdb/feltkit/package.json"));
  if (!existsSync(join(feltkit, "dist/runtime/delegation.js"))) return "the installed @feltdb/feltkit has no delegated /appport (needs a release after 0.3.32)";
  try {
    if ((require(require.resolve("@authboundry/local/package.json")).version as string) === "0.1.0") return "@authboundry/local 0.1.0 has no per-agent delegation";
  } catch { return "@authboundry/local is not installed"; }
  return false;
}
const SKIP = skipReason();
const KEY = "brave_test_key_0123456789abcdef";
const EVE = { id: "eve", type: "agent" as const, roles: ["agent"] };
const ADA = { id: "ada", type: "user" as const, roles: ["owner"] };
const RESULTS = [
  { url: "https://www.acme-ops.com/", title: "Acme Ops | Internal tools", description: "Acme Ops builds internal tools in TypeScript for operations teams." },
  { url: "https://brightpipe.io/", title: "Brightpipe", description: "Brightpipe ships agent-ready applications." },
];

let t: TestApp;
let server: { url: string; close(): unknown };
let search: { url: string; requests: string[]; onRequest?: (n: number) => Promise<void>; close(): Promise<void> };
let token = "";
let n = 0;

before(async () => {
  if (SKIP) return;
  delete process.env.AUTHBOUNDRY_URL;
  delete process.env.FELTKIT_CREDENTIAL_AUTHBOUNDRY_CHECK;
  const state = { url: "", requests: [] as string[], onRequest: undefined as undefined | ((n: number) => Promise<void>), close: async () => undefined };
  const http: Server = createServer(async (req, res) => {
    const q = new URL(req.url!, "http://x").searchParams.get("q") ?? "";
    state.requests.push(q);
    await state.onRequest?.(state.requests.length);
    if (req.headers["x-subscription-token"] !== KEY) return res.writeHead(401).end();
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ type: "search", query: { original: q }, web: { results: RESULTS } }));
  });
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  state.url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  state.close = () => new Promise((r) => { http.closeAllConnections(); http.close(() => r(undefined)); });
  search = state;
  process.env.WEBSEARCH_URL = search.url;
  process.env.FELTKIT_CREDENTIAL_WEBSEARCH = KEY;
  (globalThis as Record<symbol, unknown>)[PAGE_READER] = async (url: string) => ({ url, finalUrl: url, status: "read", httpStatus: 200, title: "Acme Ops", detail: "", text: "Acme Ops builds internal tools in TypeScript for operations teams.", ms: 1 });
  t = await createTestApp();
  server = await startServer({ runtime: t.runtime as never, projectDir: process.cwd(), port: 0, dashboard: { enabled: false, adminToken: `fka_${"x".repeat(43)}`, dir: null } });
  token = (await (t.runtime as any).issueSession(EVE, { kind: "agent", via: "cli" })).token;
});
after(async () => {
  delete (globalThis as Record<symbol, unknown>)[PAGE_READER];
  delete process.env.WEBSEARCH_URL;
  delete process.env.FELTKIT_CREDENTIAL_WEBSEARCH;
  await server?.close();
  await t?.close();
  await search?.close();
});

async function appport(capability: string, input: unknown, onBehalfOf: string, idempotencyKey?: string) {
  const res = await fetch(`${server.url}/appport`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-appport-on-behalf-of": onBehalfOf },
    body: JSON.stringify({ protocol: "appport/1", type: "request", requestId: `r_${++n}`, capability: { name: capability, version: 1 }, input, ...(idempotencyKey ? { idempotencyKey } : {}) }),
  });
  return (await res.json()) as any;
}
const grantEve = (who: string, capabilities: string[]) => t.as(who).action(api.delegation.set, { agent: "eve", capabilities });
const runsOf = (who: string) => t.as(who).query(api.research.list, {});
const budgetOf = (who: string) => t.as(who).query(api.delegation.researchBudget, { agent: "eve" });
const ALL = ["research.start", "research.list", "research.get", "research.cancel", "research.retry"];
const TEXT = "Find me some new customers for FeltKit";

/** Run the queued research steps the way the services worker does, until none is left (or `limit` steps ran). */
async function settle(limit = 200) {
  const jobs = (t.runtime.services as any).jobs;
  let ran = 0;
  for (let i = 0; i < 300 && ran < limit; i++) {
    await t.runtime.runServices();
    const due = (await jobs.listJobs("personalos")).filter((j: any) => j.type === "research.step" && ["queued", "scheduled", "pending"].includes(j.status));
    if (!due.length) return ran;
    for (const j of due) {
      if (ran >= limit) break;
      await jobs.executeJob("personalos", j.id, "test-worker");
      ran += 1;
    }
  }
  return ran;
}

/** A refusal before anything ran: no run recorded, no search made, the budget untouched. */
async function refusedBeforeWork(attempt: Promise<any>, owner: string, why: string, code = "FORBIDDEN") {
  const [runs, searches, budget] = [await runsOf(owner), search.requests.length, await budgetOf(owner)];
  const r = await attempt;
  assert.equal(r.ok, false, `${why}: ${JSON.stringify(r)}`);
  assert.equal(r.error.code, code, `${why}: ${JSON.stringify(r.error)}`);
  await settle();
  assert.deepEqual(await runsOf(owner), runs, `${why}: no run`);
  assert.equal(search.requests.length, searches, `${why}: no billable call`);
  assert.deepEqual(await budgetOf(owner), budget, `${why}: budget untouched`);
}

test("an agent runs Ada's research only with her grant and within the budget she set; cancel and revocation stop spending", { skip: SKIP }, async () => {
  await t.as("ada").action(api.delegation.registerAgent, { id: "eve" });

  // Direct research by the person is unchanged and unbudgeted; it also tells us what a full run searches.
  const own = await t.as("ada").action(api.research.begin, { text: TEXT });
  await settle();
  const full = search.requests.length;
  const mine = (await runsOf("ada")).find((r) => r.id === own.runId)!;
  assert.deepEqual([mine.status, mine.budget], ["completed", null]);
  assert.ok(full >= 3, `a full run searched ${full} times`);

  // Fail closed: no grant; a grant but no budget; no budget named; more than is left.
  await refusedBeforeWork(appport("research.start", { text: TEXT, budget: 2 }, "ada"), "ada", "no grant");
  await grantEve("ada", ALL);
  await refusedBeforeWork(appport("research.start", { text: TEXT, budget: 2 }, "ada"), "ada", "no budget set");
  await t.as("ada").mutation(api.delegation.setResearchBudget, { agent: "eve", calls: 10 });
  await refusedBeforeWork(appport("research.start", { text: TEXT }, "ada"), "ada", "no budget named", "INVALID_INPUT");
  await refusedBeforeWork(appport("research.start", { text: TEXT, budget: 11 }, "ada"), "ada", "more than allowed");

  // Only Ada sets the budget: not a capability, and refused under any delegation.
  await refusedBeforeWork(appport("delegation.setresearchbudget", { agent: "eve", calls: 1000 }, "ada"), "ada", "not a capability", "UNKNOWN_CAPABILITY");
  await assert.rejects(grantEve("ada", [...ALL, "delegation.setResearchBudget"]), /Not something an agent can be given/);
  const delegation = { agent: "eve", agentAuthority: "agent:eve", person: "ada", onBehalfOf: "user:ada", capability: "research.start", decisionId: "d", delegationId: "g", authorityMode: null };
  const raised = await (t.runtime as any).call("delegation:setResearchBudget", { agent: "eve", calls: 1000 }, { principal: ADA, via: "appport", delegation });
  assert.deepEqual([raised.ok, raised.error?.code], [false, "FORBIDDEN"]);
  assert.equal((await budgetOf("ada"))!.calls, 10);

  // Start: recorded in Anywhere Aide, attributed, 2 calls reserved. It stops before its third search.
  let searches = search.requests.length;
  const started = await appport("research.start", { text: TEXT, budget: 2 }, "ada", "eve-r1");
  assert.equal(started.ok, true, JSON.stringify(started));
  const runId = started.output.runId;
  assert.deepEqual(started.output.budget, { agent: "agent:eve", allocation: 2, charged: 0, released: false });
  assert.deepEqual(await budgetOf("ada"), { agent: "agent:eve", calls: 10, reserved: 2, left: 8 });
  const again = await appport("research.start", { text: TEXT, budget: 2 }, "ada", "eve-r1");
  assert.deepEqual(again.output, started.output, "the same key: the same run");
  assert.equal((await runsOf("ada")).filter((r) => r.budget).length, 1);
  const startAction = (await t.as("ada").query(api.actions.list, {})).find((a) => a.kind === "research.start" && a.evidence?.id === runId)!;
  assert.deepEqual([startAction.via, startAction.delegation?.agent, startAction.delegation?.capability], ["agent", "eve", "research.start"]);
  const audit = (await (t.runtime as any).auditTrail()).find((r: any) => r.authority.delegation?.decisionId === startAction.delegation!.decisionId);
  assert.deepEqual([audit.function, audit.principal.id], ["researchstate:start", "ada"]);

  await settle();
  assert.equal(search.requests.length - searches, 2, "exactly the two calls it was given");
  let run = (await appport("research.get", { runId }, "ada")).output.run;
  assert.deepEqual([run.status, run.blocker?.need, run.budget.charged, run.usage.searches], ["blocked", "research budget", 2, 2]);

  // Read: Ada's run only, its own sources, facts citing those sources.
  const detail = (await appport("research.get", { runId }, "ada")).output;
  assert.ok(detail.sources.length > 0 && detail.sources.every((x: any) => x.runId === runId && x.owner === "ada"));
  const graces = await t.as("grace").action(api.research.begin, { text: "Find me some new customers for Grace's Garden" });
  assert.equal((await appport("research.get", { runId: graces.runId }, "ada")).error.code, "NOT_FOUND", "Grace's run does not exist for Ada");
  assert.ok((await appport("research.list", {}, "ada")).output.every((r: any) => r.id !== graces.runId));
  await settle();
  searches = search.requests.length;

  // Retry continues within budget: adding calls comes from what Ada allows, and nothing more.
  await refusedBeforeWork(appport("research.retry", { runId, budget: 9 }, "ada"), "ada", "more than is left");
  const resumed = await appport("research.retry", { runId, budget: full }, "ada", "eve-r2");
  assert.equal(resumed.output.status, "running", JSON.stringify(resumed));
  await settle();
  run = (await appport("research.get", { runId }, "ada")).output.run;
  assert.equal(run.status, "completed");
  assert.equal(run.budget.charged, run.usage.searches, "every search charged, none uncharged");
  assert.ok(run.budget.charged <= run.budget.allocation);
  const left = await budgetOf("ada");
  assert.deepEqual([left!.reserved, left!.left], [run.budget.charged, 10 - run.budget.charged], "the unused allocation came back when it finished");
  const prospects = (await appport("research.get", { runId }, "ada")).output.prospects;
  const sourceIds = new Set((await appport("research.get", { runId }, "ada")).output.sources.map((x: any) => x.id));
  assert.ok(prospects.every((p: any) => p.runId === runId && p.facts.every((f: any) => sourceIds.has(f.sourceId))), "facts cite this run's sources");

  // A completed run is read again unchanged, and never runs again.
  searches = search.requests.length;
  assert.deepEqual((await appport("research.get", { runId }, "ada")).output.run, run);
  const done = await appport("research.retry", { runId }, "ada", "eve-r3");
  assert.equal(done.error.code, "feltkit.FAILED_PRECONDITION");
  assert.equal((await appport("research.retry", { runId }, "ada", "eve-r3")).error.code, "feltkit.FAILED_PRECONDITION");
  await settle();
  assert.equal(search.requests.length, searches, "no research ran");

  // Concurrent starts cannot together reserve more than is left.
  const before = (await budgetOf("ada"))!.left;
  const racing = await Promise.all([1, 2, 3, 4].map((i) => appport("research.start", { text: TEXT, budget: 2 }, "ada", `race-${i}`)));
  const won = racing.filter((r) => r.ok);
  assert.ok(won.length * 2 <= before && won.length >= 1, `${won.length} of 4 reserved from ${before}`);
  assert.equal((await budgetOf("ada"))!.left, before - won.length * 2);
  for (const r of won) await appport("research.cancel", { runId: r.output.runId }, "ada");
  assert.equal((await budgetOf("ada"))!.left, before, "cancelled before any step: all given back");
  await settle();

  // Cancel mid-search: the call in flight finishes, its result is discarded, nothing more is called.
  const live = await appport("research.start", { text: TEXT, budget: 5 }, "ada", "eve-r4");
  searches = search.requests.length;
  search.onRequest = async (k) => {
    if (k === searches + 1) {
      const c = await appport("research.cancel", { runId: live.output.runId }, "ada");
      assert.equal(c.output.status, "cancelled");
    }
  };
  await settle();
  search.onRequest = undefined;
  assert.equal(search.requests.length - searches, 1, "one search was in flight; none started after the cancel");
  run = (await appport("research.get", { runId: live.output.runId }, "ada")).output.run;
  assert.deepEqual([run.status, run.cancelledBy, run.budget.charged, run.budget.released, run.usage?.searches ?? 0], ["cancelled", "agent:eve", 1, true, 0], "charged for the call in flight; its result was discarded");
  const cancelledAgain = await appport("research.cancel", { runId: live.output.runId }, "ada");
  assert.equal(cancelledAgain.output.status, "cancelled", "repeating it changes nothing");
  assert.ok((await t.as("ada").query(api.actions.list, {})).some((a) => a.kind === "research.cancel" && a.input.runId === live.output.runId && a.delegation?.agent === "eve"));

  // A restart does not resume it.
  await server.close();
  await t.restart();
  server = await startServer({ runtime: t.runtime as never, projectDir: process.cwd(), port: 0, dashboard: { enabled: false, adminToken: `fka_${"x".repeat(43)}`, dir: null } });
  await settle();
  assert.equal(search.requests.length - searches, 1, "nothing ran after the restart");
  assert.equal((await t.as("ada").query(api.research.get, { runId: live.output.runId })).run.status, "cancelled");

  // The agent may resume what it stopped, never what Ada stopped, nor a run it did not start.
  const ownCancel = await appport("research.start", { text: TEXT, budget: 1 }, "ada", "eve-r5");
  await t.as("ada").mutation(api.research.cancel, { runId: ownCancel.output.runId });
  await refusedBeforeWork(appport("research.retry", { runId: ownCancel.output.runId }, "ada"), "ada", "Ada stopped it");
  await refusedBeforeWork(appport("research.retry", { runId: own.runId }, "ada"), "ada", "Ada's own run");
  // Ada herself may resume it, even stopped before discovery: it starts from discovery again.
  assert.equal((await t.as("ada").mutation(api.researchstate.retryRun, { runId: ownCancel.output.runId })).status, "running");
  await t.as("ada").mutation(api.research.cancel, { runId: ownCancel.output.runId });
  await settle();

  // Revoking the grant stops a running run at its next step, and blocks the next call.
  const revoked = await appport("research.start", { text: TEXT, budget: 3 }, "ada", "eve-r6");
  searches = search.requests.length;
  await grantEve("ada", []);
  await settle();
  assert.equal(search.requests.length, searches, "no search after revocation");
  run = (await t.as("ada").query(api.research.get, { runId: revoked.output.runId })).run;
  assert.deepEqual([run.status, run.blocker?.state], ["blocked", "needs-authorization"]);
  await refusedBeforeWork(appport("research.retry", { runId: revoked.output.runId }, "ada"), "ada", "revoked");
  await refusedBeforeWork(appport("research.start", { text: TEXT, budget: 1 }, "ada"), "ada", "revoked");
});
