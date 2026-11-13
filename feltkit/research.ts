/**
 * Research outcomes: the person asks for an outcome ("find me some new customers for FeltKit", "who
 * competes with Liveblocks?"), and PersonalOS pursues it with what the platform can actually do.
 *
 *   begin (action)  discover the capability landscape (ctx.agent.catalog: what exists, what this
 *                   person may use, what is configured), then record the run (researchstate.create)
 *   step (action)   one step per job (AppPort Services jobs: durable, leased, retried; it runs as the
 *                   run's owner and is authorized again every time). Each step reads the run, does its
 *                   work, and commits it with researchstate.advance, which applies only if the run is
 *                   still where the step found it, then queues the next step:
 *
 *     planning   a model proposes what is being asked for, criteria and searches; rules accept or reject
 *     searching  one search per step through whichever web search provider is ready (feltkit/_search.ts)
 *     selecting  which results are organizations worth reading (a model, or rules), and at most one
 *                round of refined searches
 *     reading    one organization per step: its pages read (feltkit/_pages.ts), each with what happened
 *     assessing  one organization per step: fit from what its pages say (a model, with quotes checked
 *                verbatim against the page; or rules), kept apart from the facts it cites
 *     finishing  ranked results, and the reply in the conversation
 *
 *   cancel / retry  stop between steps (what was found is kept); re-discover and resume failed steps
 *
 * Research only reads. Nothing here contacts anyone: outreach is a recommended next action, and would
 * be a consequential capability that waits for the person's approval.
 */
import { fail, FeltKitError, s, type ActionCtx } from "@feltdb/feltkit";
import { authorityPrincipal } from "./_authority.js";
import { subjectOf } from "./_invocation.js";
import { followResearch } from "./invocationstate.js";
import { api } from "./_generated/api.js";
import { app, prospects, researchRuns, researchSources } from "./app.js";
import { declaredCapabilities, describeDiscovery, PROSPECT_NEEDS, discover, type Discovery } from "./_capabilities.js";
import { companyName, domainOf, outcomeOf, planQueries, productKnowledge, prospectsFrom, type StoredSource } from "./_research.js";
import { providerOf } from "./_search.js";
import { readPage, type PageRead } from "./_pages.js";
import * as M from "./_researchmodel.js";
import { appendMessage } from "./assistant.js";
import * as ops from "./_ops.js";

const MAX_ATTEMPTS = 3;
const PAGES_PER_ORGANIZATION = 2;

export const RunView = s.object({
  runId: s.string(),
  conversationId: s.string(),
  status: s.string(),
  reply: s.string(),
  messageId: s.string(),
  replyId: s.string(),
});

type Reader = (url: string, options: { signal?: AbortSignal }) => Promise<PageRead>;
/**
 * The page reader research uses: feltkit/_pages.ts, unless a test has put one in place (the test
 * runtime loads the application as its own module graph, so the seam is process-wide, by symbol).
 */
export const PAGE_READER = Symbol.for("personalos.research.pageReader");
const pageReader = { read: ((url, options) => ((globalThis as Record<symbol, Reader | undefined>)[PAGE_READER] ?? readPage)(url, options)) as Reader };

/**
 * Start research for an outcome stated in words. Discovery runs here (an action reads the platform's
 * catalog); the run itself is recorded by `create`.
 */
export const begin = app.action({
  access: "research.run",
  args: { text: s.string({ minLength: 1, maxLength: 4000 }), conversationId: s.optional(s.string()) },
  returns: RunView,
  handler: (ctx, { text, conversationId }) => startResearch(ctx, text, conversationId),
});

/** Whether research can use a model for this person: configured, turned on in Settings, permitted. */
export async function modelUsable(ctx: ActionCtx): Promise<boolean> {
  if (!ctx.auth.has("feltkit.agent.write")) return false;
  const prefs = await ctx.runQuery(api.settings.get, {});
  return prefs.modelAssist && (await ctx.model.status()).ready;
}

/**
 * begin's work, for any action (a conversation turn calls it directly). With a model, any request the
 * model judged to be research can start; without one, only an outcome the rules recognize.
 */
export async function startResearch(ctx: ActionCtx, text: string, conversationId?: string, options: { fromTurn?: { messageId: string } } = {}) {
  const outcome = outcomeOf(text);
  const model = await modelUsable(ctx);
  if (!outcome && !model) fail("INVALID_ARGUMENT", "That isn't a research outcome I can pursue without a model (for example: \"find me new customers for <product>\").");
  const discovery = await discover(ctx.agent, PROSPECT_NEEDS, { declared: declaredCapabilities() });
  return ctx.runMutation(api.researchstate.create, {
    text,
    product: outcome?.product ?? "",
    objective: outcome?.objective ?? text.slice(0, 1000),
    discovery: discovery as unknown as Record<string, unknown>,
    planning: model ? "model" : "rules",
    ...(conversationId ? { conversationId } : {}),
    ...(options.fromTurn ? { fromTurn: options.fromTurn } : {}),
  });
}

/** retry's work, for any action. */
export async function retryResearch(ctx: ActionCtx, runId: string) {
  const discovery = await discover(ctx.agent, PROSPECT_NEEDS, { declared: declaredCapabilities() });
  return ctx.runMutation(api.researchstate.resume, { runId, discovery: discovery as unknown as Record<string, unknown> });
}

/** Re-discover and resume a blocked, failed or stopped run (after configuring a provider, or a transient failure). */
export const retry = app.action({
  access: "research.run",
  args: { runId: s.string() },
  returns: RunView,
  handler: (ctx, { runId }) => retryResearch(ctx, runId),
});

/** Stop a run between steps. What it found so far is kept. */
export const cancel = app.mutation({
  access: "research.run",
  args: { runId: s.string() },
  handler: async (ctx, { runId }) => {
    const run = await ops.own<any>(ctx, researchRuns, runId, "research run");
    if (run.status !== "running" && run.status !== "blocked") return { status: run.status, conversationId: run.conversationId ?? null, messageId: null, replyId: null };
    await ctx.db.patch(researchRuns, runId, { status: "cancelled", cancelRequested: true, updatedAt: Date.now(), completedAt: Date.now() });
    await followResearch(ctx, run, "cancelled", `You stopped the research for ${run.product}. What it found is kept; say "retry research" to continue.`);
    const replyId = run.conversationId ? await appendMessage(ctx, run.conversationId, { role: "assistant", text: `Stopped the research for ${run.product}. What I found so far is kept; say "retry research" to continue.` }) : null;
    return { status: "cancelled", conversationId: run.conversationId ?? null, messageId: replyId, replyId };
  },
});

export const list = app.query({
  access: "research.read",
  handler: async (ctx) => (await ctx.db.find(researchRuns, { owner: ops.me(ctx) }, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: 50 })).map((r: any) => ({
    id: r.id, kind: r.kind, product: r.product, request: r.request, status: r.status, phase: r.phase ?? null, conversationId: r.conversationId ?? null, createdAt: r.createdAt, completedAt: r.completedAt ?? null, prospectCount: r.prospectCount ?? 0, blocker: r.blocker ?? null,
    queries: r.queries.map((q: any) => ({ text: q.text, state: q.state, attempts: q.attempts, results: q.results ?? null, origin: q.origin ?? "plan" })),
  })),
});

/** One run with its evidence: sources (what was found and read) and results (facts citing them, assessments apart). */
export const get = app.query({
  access: "research.read",
  args: { runId: s.string() },
  handler: async (ctx, { runId }) => {
    const run = await ops.own<any>(ctx, researchRuns, runId, "research run");
    const sources = await ctx.db.find(researchSources, { runId });
    const found = (await ctx.db.find(prospects, { runId })).sort((a: any, b: any) => a.rank - b.rank);
    return { run, sources, prospects: found };
  },
});

function failureOf(error: unknown): { transient: boolean; state: "needs-configuration" | "needs-authorization" | "failed"; detail: string } {
  const e = error as { code?: string; message?: string; details?: { status?: number | null } };
  const status = e.details?.status ?? null;
  const detail = `${e.code ?? "ERROR"}${status ? ` (${status})` : ""}: ${String(e.message ?? error).slice(0, 300)}`;
  if (e.code === "CONFIGURATION") return { transient: false, state: "needs-configuration", detail };
  if (e.code === "FORBIDDEN" || e.code === "UNAUTHORIZED") return { transient: false, state: "needs-authorization", detail };
  if (e.code === "UPSTREAM_REJECTED" && (status === 401 || status === 403)) return { transient: false, state: "needs-configuration", detail: `The search provider refused the credential: ${detail}` };
  if (e.code === "UPSTREAM_REJECTED" && status === 429) return { transient: true, state: "failed", detail };
  if (e.code === "UPSTREAM_REJECTED") return { transient: false, state: "failed", detail };
  return { transient: true, state: "failed", detail };
}

type Run = any;
type Source = { id: string; position?: number; retrievedAt?: number; url: string; title: string; text: string; query: string; kind?: "search" | "page" | "shared"; status?: string; textKind?: string; provider: string; detail?: string };
type StepView = { run: Run; sources: Source[]; prospects: any[]; memories: Array<{ id: string; content: string; status?: string }> };
type Outcome = {
  patch: Record<string, unknown>;
  sources?: Record<string, unknown>[];
  pagesFor?: string;
  prospects?: Record<string, unknown>[];
  ranks?: Array<{ id: string; rank: number }>;
  usage?: Record<string, number>;
  outcome: string;
  reply?: string;
  next: boolean;
  delayMs?: number;
};

/** One research step, run by the job `research.step` as the run's owner. */
export const step = app.action({
  access: "research.work",
  args: { runId: s.string() },
  handler: async (ctx, { runId }) => {
    const view = (await ctx.runQuery(api.researchstate.forStep, { runId })) as StepView | null;
    if (!view || view.run.status !== "running" || view.run.cancelRequested) return { ran: null };
    const run = view.run;
    const phase: string = run.phase ?? "searching";
    const started = Date.now();
    // Work an invocation started from outside PersonalOS runs on the person's delegation, so every step
    // asks again: a delegation revoked mid-run stops the next step.
    if (run.invocationId && phase !== "finishing") {
      const denied = await delegationDenied(ctx, run, phase);
      if (denied) {
        const r = await ctx.runMutation(api.researchstate.advance, { runId, expectUpdatedAt: run.updatedAt, patch: { status: "blocked", blocker: denied }, step: { phase, ms: Date.now() - started, outcome: `stopped: ${denied.detail}`.slice(0, 500) }, reply: `I stopped this research: ${denied.detail} ${denied.howToEnable} What I found before this is kept.`, next: false });
        return { ran: phase, applied: r.applied, stopped: "authority" };
      }
    }
    let out: Outcome;
    switch (phase) {
      case "planning": out = await planStep(ctx, view); break;
      case "searching": out = await searchStep(ctx, view); break;
      case "selecting": out = await selectStep(ctx, view); break;
      case "reading": out = await readStep(ctx, view); break;
      case "assessing": out = await assessStep(ctx, view); break;
      default: out = finishStep(view);
    }
    const r = await ctx.runMutation(api.researchstate.advance, {
      runId, expectUpdatedAt: run.updatedAt, patch: out.patch,
      ...(out.sources ? { sources: out.sources } : {}), ...(out.pagesFor ? { pagesFor: out.pagesFor } : {}),
      ...(out.prospects ? { prospects: out.prospects } : {}), ...(out.ranks ? { ranks: out.ranks } : {}),
      ...(out.usage ? { usage: out.usage } : {}),
      step: { phase, ms: Date.now() - started, outcome: out.outcome.slice(0, 500) },
      ...(out.reply ? { reply: out.reply } : {}),
      next: out.next,
      ...(out.delayMs ? { delayMs: out.delayMs } : {}),
    });
    return { ran: phase, applied: r.applied };
  },
});

/**
 * Whether the person's delegation to PersonalOS still allows research (AuthBoundry, on their behalf).
 * A denial is the reason to stop; an authority that cannot answer is thrown, so the job tries again.
 */
async function delegationDenied(ctx: ActionCtx, run: Run, phase: string): Promise<{ need: string; state: string; detail: string; howToEnable: string } | null> {
  const decision = await ctx.authority.decide({ capability: "personalos.research.run", onBehalfOf: authorityPrincipal(run.owner), context: { invocation: String(run.invocationId).slice(0, 100), step: phase } });
  if (decision.outcome === "unavailable" || decision.outcome === "invalid") throw new FeltKitError("UNAVAILABLE", `The authority could not decide (${decision.reason ?? decision.outcome}); the step will try again.`);
  if (decision.allowed) return null;
  return { need: "your permission", state: "needs-authorization", detail: `PersonalOS is no longer allowed to research for you (personalos.research.run${decision.reason ? `: ${decision.reason}` : ""}).`, howToEnable: "Restore the delegation in AuthBoundry, then say \"retry research\"." };
}

// ── The model ───────────────────────────────────────────────────────────────────────────────────

/** Ask the run's model one question. Its answer is a recorded generation on the run's agent task. */
async function ask(ctx: ActionCtx, run: Run, prompt: { system: string; user: string }, maxTokens: number) {
  const started = Date.now();
  const taskId: string = run.taskId ?? (await ctx.agent.openTask({ key: `research:${run.id}`, objective: String(run.objective).slice(0, 500) })).taskId;
  try {
    const g = await ctx.model.generate({ taskId, messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }], maxTokens, temperature: 0 });
    const generation: M.Generation = { generationId: g.generationId, memoryId: g.memoryId, model: `${g.receipt.provider}/${g.receipt.model}` };
    const usage = { generations: 1, inputTokens: g.usage?.inputTokens ?? 0, outputTokens: g.usage?.outputTokens ?? 0, modelMs: Date.now() - started, ...(g.usage?.cost != null ? { costUsd: g.usage.cost } : {}) };
    return { taskId, json: M.jsonOf(g.text), generation, usage, error: null as string | null, transient: false };
  } catch (error) {
    const e = error as { code?: string; message?: string };
    const message = String(e.message ?? error);
    // Worth waiting for: a rate limit or a passing outage. Not: exhausted credit, a refused key.
    const transient = /rate.?limit|retry after|timed? ?out|ECONNRESET|HTTP 50[234]/i.test(message) && !/insufficient_quota|credit/i.test(message);
    return { taskId, json: null, generation: null, usage: { generations: 1, inputTokens: 0, outputTokens: 0, modelMs: Date.now() - started }, error: `${e.code ?? "ERROR"}: ${message.slice(0, 300)}`, transient };
  }
}

const MODEL_RETRIES = 4;
/** A transient model refusal: the same step again later (the run is unchanged but for the count), up to MODEL_RETRIES. */
function waitForModel(run: Run, a: { taskId: string; usage: Record<string, number>; error: string | null; transient: boolean }, phase: string): Outcome | null {
  const tries = run.modelRetries ?? 0;
  if (!a.error || !a.transient || tries >= MODEL_RETRIES) return null;
  const delayMs = 15_000 * (tries + 1);
  return { patch: { taskId: a.taskId, modelRetries: tries + 1 }, usage: a.usage, outcome: `${phase}: the model is busy (${a.error.slice(0, 200)}); trying again in ${delayMs / 1000}s`, next: true, delayMs };
}

const modelRun = (run: Run) => run.plan?.basis === "model";
const subjectDomains = (run: Run) => {
  const label = String(run.product).toLowerCase().replace(/[^a-z0-9]/g, "");
  return (d: string) => d.split(".")[0] === label;
};

// ── Steps ───────────────────────────────────────────────────────────────────────────────────────

async function planStep(ctx: ActionCtx, view: StepView): Promise<Outcome> {
  const { run } = view;
  const words = String(run.request).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  const statements = view.memories.filter((m) => words.some((w) => m.content.toLowerCase().includes(w))).slice(0, 12).map((m) => m.content);
  const sharedSource = run.seed?.sourceId ? view.sources.find((x) => x.id === run.seed.sourceId) : undefined;
  const shared = run.seed ? { url: run.seed.url, ...(run.seed.title ? { title: run.seed.title } : {}), ...(sharedSource?.text ? { text: sharedSource.text } : {}) } : undefined;
  const prompt = M.planPrompt({ request: run.request, statements, landscape: describeDiscovery(run.discovery as Discovery), today: new Date().toISOString().slice(0, 10), ...(shared ? { shared } : {}) });
  const a = await ask(ctx, run, prompt, 900);
  const wait = waitForModel(run, a, "planning");
  if (wait) return wait;
  const plan = a.error ? { error: `the model could not be reached (${a.error})` } : M.acceptPlan(a.json, { shared: Boolean(run.seed) });
  if ("error" in plan) {
    // Not accepted: the rules plan if they recognize the request, else the run stops and says why.
    const named = run.seed ? subjectOf(run.request) : null;
    if (named && run.seed) {
      // A shared page and a named subject: the rules can assess that organization without a plan.
      const knowledge = productKnowledge(named, view.memories);
      return {
        patch: { taskId: a.taskId, modelRetries: 0, product: named, profile: knowledge, phase: "reading", plan: { basis: "rules", criteria: knowledge.keywords.map((k) => `mentions "${k}"`), rejected: [plan.error.slice(0, 300)], scope: "this" }, queries: [], ...seedCandidate(run, sharedSource) },
        usage: a.usage, outcome: `model plan rejected (${plan.error}); rules: assess the shared organization for ${named}`,
        reply: `The model's plan wasn't usable (${plan.error}), so I'm assessing ${domainOf(run.seed.url)} for ${named} by my standard rules.`,
        next: true,
      };
    }
    const outcome = outcomeOf(run.request);
    if (!outcome) {
      return { patch: { taskId: a.taskId, status: "failed", phase: "done", completedAt: Date.now(), blocker: { need: "a research plan", state: "failed", detail: `The model's plan was not usable: ${plan.error}.`.slice(0, 1000) } }, usage: a.usage, outcome: `plan rejected: ${plan.error}`, reply: `I couldn't plan this research: the model's plan was not usable (${plan.error}). Nothing was searched. Say "retry research" to try again.`, next: false };
    }
    const knowledge = productKnowledge(outcome.product, view.memories);
    const queries = planQueries(outcome.product, knowledge);
    return {
      patch: { taskId: a.taskId, modelRetries: 0, product: outcome.product, objective: outcome.objective, profile: knowledge, phase: "searching", plan: { basis: "rules", criteria: knowledge.keywords.map((k) => `mentions "${k}"`), rejected: [plan.error.slice(0, 300)] }, queries: queries.map((text) => ({ text, state: "pending", attempts: 0, origin: "plan" })) },
      usage: a.usage, outcome: `model plan rejected (${plan.error}); rules plan: ${queries.length} searches`,
      reply: `The model's plan wasn't usable (${plan.error}), so I'm using my standard plan: ${queries.length} searches (${queries.map((q) => `"${q}"`).join(", ")}).`,
      next: true,
    };
  }
  const knowledge = productKnowledge(plan.subject, view.memories);
  const noun = plan.kind === "competitors" ? "competitors" : plan.kind === "prospects" ? "potential customers" : "organizations";
  if (plan.scope === "this" && run.seed) {
    const domain = domainOf(run.seed.url)!;
    const as = plan.kind === "competitors" ? "a competitor of" : plan.kind === "prospects" ? "a potential customer for" : "a match for";
    return {
      patch: {
        taskId: a.taskId, modelRetries: 0, kind: plan.kind, product: plan.subject, objective: plan.objective, profile: knowledge, phase: "reading",
        plan: { basis: "model", criteria: plan.criteria, generation: a.generation!, scope: "this", ...(plan.subjectSummary ? { summary: plan.subjectSummary } : {}), ...(plan.rejected.length ? { rejected: plan.rejected.map((x) => x.slice(0, 300)).slice(0, 20) } : {}) },
        queries: [], ...seedCandidate(run, sharedSource),
      },
      usage: a.usage,
      outcome: `model plan accepted: assess ${domain} as ${plan.kind} of ${plan.subject}`,
      reply: [
        `Plan: find out whether ${domain} could be ${as} ${plan.subject}. ${plan.objective}`,
        plan.subjectSummary ? `What I'm going on: ${plan.subjectSummary}` : "",
        plan.criteria.length ? `A good match:\n${plan.criteria.map((c) => `- ${c}`).join("\n")}` : "",
        "I'll read its own pages, assess it against this, and keep every quote with its link.",
      ].filter(Boolean).join("\n"),
      next: true,
    };
  }
  return {
    patch: {
      taskId: a.taskId, modelRetries: 0, kind: plan.kind, product: plan.subject, objective: plan.objective, profile: knowledge, phase: "searching",
      plan: { basis: "model", criteria: plan.criteria, generation: a.generation!, ...(plan.subjectSummary ? { summary: plan.subjectSummary } : {}), ...(plan.rejected.length ? { rejected: plan.rejected.map((x) => x.slice(0, 300)).slice(0, 20) } : {}) },
      queries: plan.queries.map((text) => ({ text, state: "pending", attempts: 0, origin: "plan" })),
    },
    usage: a.usage,
    outcome: `model plan accepted: ${plan.kind}, ${plan.queries.length} searches${plan.rejected.length ? `, ${plan.rejected.length} item(s) rejected` : ""}`,
    reply: [
      `Plan: looking for ${noun} of ${plan.subject}. ${plan.objective}`,
      plan.subjectSummary ? `What I'm going on: ${plan.subjectSummary}` : "",
      plan.criteria.length ? `A good match:\n${plan.criteria.map((c) => `- ${c}`).join("\n")}` : "",
      `Searches (${plan.queries.length}): ${plan.queries.map((q) => `"${q}"`).join(", ")}.`,
      "Then I'll read the most promising organizations' own pages, assess each against this, and keep every quote with its link.",
    ].filter(Boolean).join("\n"),
    next: true,
  };
}

async function searchStep(ctx: ActionCtx, view: StepView): Promise<Outcome> {
  const { run } = view;
  const queries = [...run.queries];
  const index = queries.findIndex((q: any) => q.state === "pending");
  if (index < 0) return { patch: { phase: "selecting" }, outcome: "searches done", next: true };
  const q = queries[index];
  const need = (run.discovery as Discovery).needs.find((n) => n.need === "web search");
  const provider = providerOf(need?.capability ?? null);
  if (!provider) {
    const blocker = { need: "web search", state: need?.state ?? "missing", detail: `No web search provider is ready (${need?.capability ?? "none declared"}).`, ...(need?.howToEnable ? { howToEnable: need.howToEnable } : {}) };
    return { patch: { status: "blocked", blocker }, outcome: blocker.detail, reply: `The research for ${run.product} stopped: ${blocker.detail} ${blocker.howToEnable ?? ""}`.trim(), next: false };
  }
  const started = Date.now();
  try {
    const output = await ctx.integrations.invoke(provider.capability, provider.input(q.text));
    const results = provider.results(output);
    const at = Date.now();
    queries[index] = { ...q, state: "done", attempts: q.attempts + 1, results: results.length, at, provider: provider.provider, ms: at - started };
    const sources = results.map((r, position) => ({ position, url: r.url, title: r.title, text: [r.description, ...(r.extra ?? [])].filter(Boolean).join(" … ").slice(0, 4000), query: q.text, provider: provider.provider, retrievedAt: at, kind: "search", textKind: provider.textKind }));
    const reported = (output as { usage?: { input_tokens?: number; output_tokens?: number } } | null)?.usage;
    const tokens: Record<string, number> = reported ? { searchInputTokens: reported.input_tokens ?? 0, searchOutputTokens: reported.output_tokens ?? 0 } : {};
    return { patch: { queries }, sources, usage: { searches: 1, searchMs: at - started, ...tokens }, outcome: `"${q.text}" via ${provider.provider}: ${results.length} results`, next: true };
  } catch (error) {
    const f = failureOf(error);
    const attempts = q.attempts + 1;
    const usage = { searches: 1, searchFailures: 1, searchMs: Date.now() - started };
    if (!f.transient) {
      // Not something a retry fixes: stop, say exactly what is missing, keep what was found.
      queries[index] = { ...q, state: "failed", attempts, error: f.detail, at: Date.now(), provider: provider.provider };
      const howToEnable = f.state === "needs-configuration" ? `Check the ${provider.capability.split(".")[0]} integration's endpoint and credential (Studio → Integrations), then retry the research.` : f.state === "needs-authorization" ? "Ask an administrator to grant the research permission, then retry." : undefined;
      const blocker = { need: "web search", state: f.state, detail: f.detail, ...(howToEnable ? { howToEnable } : {}) };
      return { patch: { queries, status: "blocked", blocker }, usage, outcome: `"${q.text}" failed: ${f.detail}`, reply: `The research for ${run.product} stopped: ${f.detail.replace(/\.+$/, "")}. ${howToEnable ?? ""} What I found before this is kept.`.replace(/\s+/g, " ").trim(), next: false };
    }
    queries[index] = attempts >= MAX_ATTEMPTS ? { ...q, state: "failed", attempts, error: f.detail, at: Date.now(), provider: provider.provider } : { ...q, attempts, error: f.detail };
    // Transient (a rate limit, an outage): try again after a pause that grows with each attempt.
    return { patch: { queries }, usage, outcome: `"${q.text}" attempt ${attempts} failed: ${f.detail}`, next: true, delayMs: attempts >= MAX_ATTEMPTS ? 0 : 5_000 * attempts };
  }
}

/** The organization the person shared, as the one candidate to read and assess. */
function seedCandidate(run: Run, shared?: Source) {
  const domain = domainOf(run.seed.url)!;
  return { candidates: [{ domain, name: companyName(run.seed.title ?? "", domain), sourceIds: shared ? [shared.id] : [], why: "You shared it.", state: "pending" }], selection: { basis: "rules", rejected: [] } };
}

/** Search results, one per URL, with short refs (R1…) for a model. */
function resultRefs(sources: Source[]): M.ResultRef[] {
  const seen = new Set<string>();
  // In the order found: by search, then by the provider's ranking (stored order is not kept).
  const ordered = [...sources].sort((a, b) => (a.retrievedAt ?? 0) - (b.retrievedAt ?? 0) || (a.position ?? 0) - (b.position ?? 0) || a.url.localeCompare(b.url));
  return ordered.filter((x) => x.kind === "search" || x.kind === undefined).filter((x) => !seen.has(x.url) && seen.add(x.url)).map((x, i) => ({ ref: `R${i + 1}`, sourceId: x.id, url: x.url, title: x.title, text: x.text, query: x.query }));
}

async function selectStep(ctx: ActionCtx, view: StepView): Promise<Outcome> {
  const { run } = view;
  const results = resultRefs(view.sources);
  const isSubject = subjectDomains(run);
  const exclude = [...new Set(results.map((r) => domainOf(r.url)).filter((d): d is string => Boolean(d) && isSubject(d!)))];
  if (!results.length) return { patch: { phase: "finishing", candidates: [] }, outcome: "no search results to choose from", next: true };
  const searched = run.queries.map((q: any) => q.text);
  if (modelRun(run) && (await ctx.model.status()).ready) {
    const mayRefine = !run.queries.some((q: any) => q.origin === "refinement");
    const a = await ask(ctx, run, M.selectionPrompt({ kind: run.kind, subject: run.product, objective: run.objective, criteria: run.plan?.criteria ?? [], results, mayRefine, searched }), 1500);
    const wait = waitForModel(run, a, "selecting");
    if (wait) return wait;
    const sel = a.error ? { error: `the model could not be reached (${a.error})` } : M.acceptSelection(a.json, results, { mayRefine, searched, excludeDomains: exclude });
    if (!("error" in sel)) {
      const selection = { basis: "model", generation: a.generation!, ...(sel.rejected.length ? { rejected: sel.rejected.slice(0, 20).map((x) => x.slice(0, 300)) } : {}) };
      if (sel.refine.length) {
        const queries = [...run.queries, ...sel.refine.map((text) => ({ text, state: "pending", attempts: 0, origin: "refinement" }))];
        return { patch: { taskId: a.taskId, modelRetries: 0, queries, phase: "searching", selection }, usage: a.usage, outcome: `refining: ${sel.refine.length} more searches (${sel.candidates.length} candidates so far)`, reply: `The first results were thin in places, so I'm running ${sel.refine.length} more specific search${sel.refine.length === 1 ? "" : "es"}: ${sel.refine.map((q) => `"${q}"`).join(", ")}.`, next: true };
      }
      const candidates = sel.candidates.map((c) => ({ ...c, state: "pending" }));
      return {
        patch: { taskId: a.taskId, modelRetries: 0, candidates, selection, phase: candidates.length ? "reading" : "finishing" },
        usage: a.usage, outcome: `${candidates.length} organizations chosen from ${results.length} results${sel.rejected.length ? ` (${sel.rejected.length} choices rejected)` : ""}`,
        ...(candidates.length ? { reply: `From ${results.length} search results I picked ${candidates.length} to look at closely: ${candidates.map((c) => c.name).join(", ")}. Reading their own pages now.` } : {}),
        next: true,
      };
    }
    // The model's choice was not usable: choose by the rules instead, and say so in the record.
    const r = rulesSelection(run, view.sources, exclude, `model selection rejected: ${sel.error}`);
    return { ...r, patch: { ...r.patch, modelRetries: 0 }, usage: a.usage };
  }
  return rulesSelection(run, view.sources, exclude, "chosen by rules");
}

function rulesSelection(run: Run, sources: Source[], exclude: string[], why: string): Outcome {
  const drafts = prospectsFrom(run.product, run.profile, sources.filter((x) => x.kind !== "page") as StoredSource[], { ownDomains: exclude, pagesRead: false, kind: run.kind });
  const candidates = drafts.slice(0, M.LIMITS.candidates).map((d) => ({ domain: d.domain, name: d.company, sourceIds: [...new Set(d.facts.map((f) => f.sourceId))], why: d.assessment.whyFeltKit, state: "pending" }));
  return { patch: { candidates, selection: { basis: "rules", rejected: [why.slice(0, 300)] }, phase: candidates.length ? "reading" : "finishing" }, outcome: `${candidates.length} organizations (${why})`, next: true };
}

/** The pages to read for an organization: the pages search found on its own domain, then its home page. */
function pagesToRead(candidate: any, sources: Source[]): string[] {
  const own = sources.filter((x) => candidate.sourceIds.includes(x.id) && domainOf(x.url) === candidate.domain).map((x) => x.url);
  return [...new Set([...own, `https://${candidate.domain}/`])].slice(0, PAGES_PER_ORGANIZATION);
}

async function readStep(ctx: ActionCtx, view: StepView): Promise<Outcome> {
  const { run } = view;
  const candidates = [...(run.candidates ?? [])];
  const index = candidates.findIndex((c: any) => c.state === "pending");
  if (index < 0) return { patch: { phase: "assessing" }, outcome: "pages read", next: true };
  const c = candidates[index];
  const reads: PageRead[] = [];
  for (const url of pagesToRead(c, view.sources)) {
    const page = await pageReader.read(url, { signal: ctx.signal });
    // Two addresses that land on the same page (thoughtworks.com → www.thoughtworks.com) are one page.
    if (!reads.some((r) => r.finalUrl === page.finalUrl)) reads.push(page);
  }
  const at = Date.now();
  const sources = reads.map((p) => ({ url: p.finalUrl.slice(0, 1000), title: (p.title || p.finalUrl).slice(0, 300), text: p.status === "read" ? p.text : "", query: `read for ${c.name}`, provider: "page-reader", retrievedAt: at, kind: "page", textKind: "page-text", status: p.status, ...(p.httpStatus ? { httpStatus: p.httpStatus } : {}), detail: p.detail.slice(0, 500) }));
  candidates[index] = { ...c, state: "read" };
  const ok = reads.filter((p) => p.status === "read").length;
  return {
    patch: { candidates }, sources, pagesFor: c.domain,
    usage: { pagesRequested: reads.length, pagesRead: ok, pageMs: reads.reduce((n, p) => n + p.ms, 0) },
    outcome: `${c.domain}: ${reads.map((p) => `${p.status}${p.httpStatus ? ` ${p.httpStatus}` : ""}`).join(", ")}`,
    next: true,
  };
}

async function assessStep(ctx: ActionCtx, view: StepView): Promise<Outcome> {
  const { run } = view;
  const candidates = [...(run.candidates ?? [])];
  const index = candidates.findIndex((c: any) => c.state === "read");
  if (index < 0) return { patch: { phase: "finishing" }, outcome: "assessments done", next: true };
  const c = candidates[index];
  const byId = new Map(view.sources.map((x) => [x.id, x]));
  const pages = (c.pageIds ?? []).map((id: string) => byId.get(id)).filter(Boolean) as Source[];
  const found = c.sourceIds.map((id: string) => byId.get(id)).filter(Boolean) as Source[];
  const evidence: M.Evidence[] = [
    ...pages.map((x, i) => ({ ref: `P${i + 1}`, sourceId: x.id, url: x.url, kind: "page" as const, status: x.status ?? "read", title: x.title, text: x.status === "read" ? x.text : (x.detail ?? "") })),
    ...found.filter((x) => x.kind === "shared").map((x, i) => ({ ref: `S${i + 1}`, sourceId: x.id, url: x.url, kind: "shared" as const, title: x.title, text: x.text })),
    ...found.filter((x) => x.kind !== "shared").map((x, i) => ({ ref: `R${i + 1}`, sourceId: x.id, url: x.url, kind: "search" as const, textKind: x.textKind ?? "search-snippet", title: x.title, text: x.text })),
  ];
  const pagesRead = pages.filter((p) => p.status === "read").length;
  const unread = pages.filter((p) => p.status !== "read").map((p) => `${p.url}: ${p.status} (${p.detail ?? ""})`);
  const at = Date.now();
  if (modelRun(run) && (await ctx.model.status()).ready) {
    const a = await ask(ctx, run, M.assessmentPrompt({ kind: run.kind, subject: run.product, subjectSummary: run.plan?.summary || (run.profile?.statements ?? []).map((x: any) => x.text).join(" ").slice(0, 600), objective: run.objective, criteria: run.plan?.criteria ?? [], candidate: c, evidence }), 1200);
    const wait = waitForModel(run, a, `assessing ${c.domain}`);
    if (wait) return wait;
    const x = a.error ? { error: `the model could not be reached (${a.error})` } : M.acceptAssessment(a.json, evidence, run.kind);
    if (!("error" in x)) {
      const usage = { ...a.usage, quotesOffered: x.offered, quotesVerified: x.facts.length };
      const negative = x.fit === "not-a-fit";
      candidates[index] = { ...c, state: negative ? "rejected" : "assessed", verdict: (x.fitSummary || x.fit).slice(0, 500) };
      if (negative) return { patch: { taskId: a.taskId, modelRetries: 0, candidates }, usage, outcome: `${c.domain}: not a fit (${pagesRead} page(s) read)`, next: true };
      const facts = [...x.facts, ...found.filter((s) => s.kind !== "shared").slice(0, 2).map((s) => ({ sourceId: s.id, url: s.url, text: s.text ? `${s.title}: ${s.text}`.slice(0, 1000) : s.title, kind: "search-result" }))];
      const score = ({ high: 3, medium: 2, low: 1 } as Record<string, number>)[x.fit]! + Math.min(x.facts.length, 5) * 0.1;
      const prospect = {
        rank: 0, company: c.name, domain: c.domain, website: `https://${c.domain}`, facts,
        assessment: {
          basis: "model", method: `A model's assessment (${a.generation!.model}) of ${pagesRead} page(s) read from its site and ${found.length} search result(s), against the plan's criteria. Quotes were checked word for word against the pages; ${x.rejectedQuotes} that did not match were dropped.`,
          generation: a.generation!, rejectedQuotes: x.rejectedQuotes, ...(x.offersSimilarProduct != null ? { offersSimilarProduct: x.offersSimilarProduct } : {}),
          fit: x.fit, score, whyFeltKit: x.fitSummary || c.why, rationale: x.rationale, confidence: x.confidence,
        },
        openQuestions: [...(pagesRead ? [] : ["None of its own pages could be read; this rests on search results only."]), ...unread.map((u) => `Not read: ${u}`).slice(0, 2), ...x.openQuestions].slice(0, 8),
        nextAction: `Review the evidence. If it fits, I can draft an introduction to ${c.name}, but nothing is sent without your approval.`,
        researchedAt: at,
      };
      return { patch: { taskId: a.taskId, modelRetries: 0, candidates }, prospects: [prospect], usage, outcome: `${c.domain}: ${x.fit} fit, ${x.facts.length}/${x.offered} quotes verified`, next: true };
    }
    // Not usable: assess this one by the rules, and record why.
    const r = rulesAssessment(run, c, [...found, ...pages], at);
    candidates[index] = { ...c, state: "assessed", verdict: `model assessment rejected (${x.error}); assessed by rules` };
    return { patch: { taskId: a.taskId, modelRetries: 0, candidates }, prospects: r, usage: a.usage, outcome: `${c.domain}: model assessment rejected (${x.error}); rules`, next: true };
  }
  const r = rulesAssessment(run, c, [...found, ...pages], at);
  candidates[index] = { ...c, state: "assessed", verdict: "assessed by rules" };
  return { patch: { candidates }, prospects: r, outcome: `${c.domain}: rules assessment`, next: true };
}

function rulesAssessment(run: Run, c: any, sources: Source[], at: number) {
  const drafts = prospectsFrom(run.product, run.profile, sources as StoredSource[], { kind: run.kind });
  const d = drafts.find((x) => x.domain === c.domain);
  return d ? [{ rank: 0, ...d, company: c.name || d.company, researchedAt: at }] : [];
}

function finishStep(view: StepView): Outcome {
  const { run } = view;
  // One scale for every result, however it was assessed: fit, then confidence, then verified quotes.
  const LEVEL: Record<string, number> = { high: 3, medium: 2, low: 1 };
  const quotes = (p: any) => p.facts.filter((f: any) => f.kind === "quote").length;
  const ranked = [...view.prospects].sort((a, b) => (LEVEL[b.assessment.fit] ?? 0) - (LEVEL[a.assessment.fit] ?? 0) || (LEVEL[b.assessment.confidence] ?? 0) - (LEVEL[a.assessment.confidence] ?? 0) || quotes(b) - quotes(a) || b.assessment.score - a.assessment.score || a.domain.localeCompare(b.domain));
  const ranks = ranked.map((p, i) => ({ id: p.id, rank: i + 1 }));
  const searches = run.queries.length;
  const failed = run.queries.filter((q: any) => q.state === "failed");
  const searchSources = view.sources.filter((x) => x.kind !== "page");
  const pages = view.sources.filter((x) => x.kind === "page");
  const read = pages.filter((x) => x.status === "read").length;
  const rejected = (run.candidates ?? []).filter((c: any) => c.state === "rejected");
  const noun = run.kind === "competitors" ? "competitor" : run.kind === "organizations" ? "organization" : "prospect";
  const at = Date.now();
  if (run.plan?.scope === "this" && run.seed) {
    // One organization the person shared: the answer is a verdict on it, with what it rests on.
    const c = (run.candidates ?? [])[0];
    const p = ranked[0];
    const pageLine = pages.length ? `${read} of ${pages.length} of its pages read${pages.some((x) => x.status !== "read") ? ` (${pages.filter((x) => x.status !== "read").map((x) => `${x.url}: ${x.status}`).join("; ")})` : ""}` : "none of its pages could be read";
    const as = run.kind === "competitors" ? "a competitor of" : run.kind === "prospects" ? "a customer for" : "a match for";
    const done = Boolean(p) || c?.state === "rejected";
    const terms = p ? p.assessment.rationale.map((r: any) => /"([^"]+)"/.exec(r.text)?.[1]).filter(Boolean) : [];
    const verdict = p && p.assessment.basis === "rules"
      // Keyword rules can't tell a buyer from a vendor: say what they found, and no more.
      ? `${p.company} (${p.website}) uses ${terms.length} of the terms you use for ${run.product}${terms.length ? ` (${terms.slice(0, 6).join(", ")})` : ""}. That is a keyword match, not a judgment of whether it could be ${as} ${run.product}: it may as easily sell something similar. Turn the model on in Settings for an assessment.`
      : p ? `${p.company} (${p.website}) could be ${as} ${run.product}: ${p.assessment.fit} fit, ${p.assessment.confidence} confidence. ${p.assessment.whyFeltKit}`
      : c?.state === "rejected" ? `${c.name} (${c.domain}) doesn't look like ${as} ${run.product}. ${c.verdict ?? ""}` : `I couldn't assess ${c?.domain ?? run.seed.url}: ${pageLine}.`;
    const quotes = p ? p.facts.filter((f: any) => f.kind === "quote" || f.kind === "shared") : [];
    const text = [
      verdict,
      ...(done ? [`Evidence: ${quotes.length} quote(s) checked word for word against ${pageLine}${p ? `; ${p.assessment.basis === "model" ? "a model's assessment, checked by rules" : "a keyword match"}` : ""}.`] : []),
      ...quotes.slice(0, 3).map((f: any) => `- "${String(f.text).slice(0, 240)}" (${f.url})`),
      ...(p?.openQuestions?.length ? [`Not established: ${p.openQuestions.slice(0, 3).join(" ")}`] : []),
      "Open Research for the full evidence. Nothing was sent to anyone.",
    ].join("\n");
    return { patch: { status: done ? "completed" : "failed", phase: "done", prospectCount: ranked.length, completedAt: at }, ranks, outcome: `${done ? "completed" : "failed"}: ${p ? `${p.assessment.fit} fit` : c?.state ?? "not assessed"}, ${read}/${pages.length} pages read`, reply: text, next: false };
  }
  const status = searchSources.length === 0 ? "failed" : failed.length ? "partial" : "completed";
  const text = status === "failed"
    ? `I couldn't find anything for ${run.product}: ${failed.length} of ${searches} searches failed${failed[0]?.error ? ` (${failed[0].error})` : ""}, and the rest returned nothing. Say "retry research" to try again.`
    : [
        `Research for ${run.product} is ${status === "partial" ? "partly done" : "done"}: ${ranked.length} ${noun}${ranked.length === 1 ? "" : "s"} from ${searchSources.length} search results (${searches - failed.length} of ${searches} searches), with ${read} of ${pages.length} pages read.`,
        ...ranked.slice(0, 6).map((p, i) => `${i + 1}. ${p.company} (${p.website}): ${p.assessment.fit} fit, ${p.assessment.confidence} confidence. ${p.assessment.whyFeltKit} [${p.facts.filter((f: any) => f.kind === "quote").length} quote(s), ${p.assessment.basis === "model" ? "model assessment" : "keyword match"}]`),
        ...(rejected.length ? [``, `Looked at and ruled out: ${rejected.map((c: any) => `${c.name} (${c.verdict})`).join("; ")}`.slice(0, 1500)] : []),
        "",
        "Facts are quotes from pages I read (or what a search returned, marked as such), each with its link; the assessment is separate. Open Research to review the evidence.",
        ...(failed.length ? [`${failed.length} search(es) failed (${failed.map((q: any) => `"${q.text}"`).join(", ")}); say "retry research" to run them again.`] : []),
        "Nothing was sent to anyone. If one fits, ask me to draft an introduction: it will wait for your approval.",
      ].join("\n");
  return { patch: { status, phase: "done", prospectCount: ranked.length, completedAt: at }, ranks, outcome: `${status}: ${ranked.length} results, ${rejected.length} ruled out, ${read}/${pages.length} pages read`, reply: text, next: false };
}

