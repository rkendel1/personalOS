/**
 * The writes behind research.begin and research.retry (feltkit/research.ts): recording a run, its plan
 * and its discovery, and replying in the conversation. Separate from research.ts so those actions can
 * name them through the generated API.
 */
import { fail, s, type MutationCtx } from "@feltdb/feltkit";
import { app, conversations, memories, messages, prospects, researchBudgets, researchRuns, researchSources } from "./app.js";
import { describeDiscovery, type Discovery } from "./_capabilities.js";
import { companyName, domainOf, outcomeOf, planQueries, productKnowledge } from "./_research.js";
import { followResearch } from "./invocationstate.js";
import { appendMessage } from "./assistant.js";
import * as ops from "./_ops.js";

const RunView = s.object({ runId: s.string(), conversationId: s.string(), status: s.string(), reply: s.string(), messageId: s.string(), replyId: s.string() });
const titleOf = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}…` : text);

function blockerOf(d: Discovery) {
  const n = d.needs.find((x) => x.required && x.state !== "available");
  return n ? { need: n.need, state: n.state, detail: n.problems.join(" ") || `${n.need} is ${n.state.replace("-", " ")}.`, ...(n.howToEnable ? { howToEnable: n.howToEnable } : {}) } : undefined;
}

function startReply(product: string, queries: string[], d: Discovery, knowledge: { statements: unknown[] }): string {
  const lines = [`On it: finding qualified prospects for ${product}. I checked what this Anywhere Aide can do for that (${d.capabilitiesSeen} capabilities):`, describeDiscovery(d), ""];
  lines.push(knowledge.statements.length
    ? `I'm working from what you've told me about ${product} (${knowledge.statements.length} saved note${knowledge.statements.length === 1 ? "" : "s"}).`
    : `You haven't told me what ${product} does, so I'm starting from its name; tell me who it's for and I'll sharpen the search.`);
  lines.push(`Plan: ${queries.length} web searches (${queries.map((q) => `"${q}"`).join(", ")}), then each company found is checked against how ${product} is described, ranked, and saved with its sources. I'll post the result here.`);
  if (!d.complete) lines.push("What isn't available only limits the result (each prospect says what was not verified).");
  lines.push("I won't contact anyone: outreach waits for your approval.");
  return lines.join("\n");
}

function blockedReply(product: string, d: Discovery, blocker: NonNullable<ReturnType<typeof blockerOf>>): string {
  return [
    `I can't run this research yet, and it isn't a permanent limit: ${blocker.need} is the missing piece. Here is what I checked (${d.capabilitiesSeen} capabilities):`,
    describeDiscovery(d),
    "",
    `To unblock it: ${blocker.howToEnable ?? "connect a provider for it."}`,
    `Your request is saved as the objective (find prospects for ${product}); say "retry research" once that's done and I'll pick it up. Nothing was searched, and I have no results to show you.`,
  ].join("\n");
}

/** The first step's job: research runs as durable jobs (feltkit/research.ts step), as the run's owner. */
export const STEP_JOB = "research.step";
const enqueueStep = (ctx: { afterCommit: { jobs: { enqueue(type: string, payload: Record<string, unknown>, options?: { maxAttempts?: number; runAt?: string }): unknown } } }, runId: string, delayMs = 0) =>
  ctx.afterCommit.jobs.enqueue(STEP_JOB, { runId }, { maxAttempts: 3, ...(delayMs > 0 ? { runAt: new Date(Date.now() + delayMs).toISOString() } : {}) });

function planningReply(d: Discovery): string {
  return [
    `On it. I checked what this Anywhere Aide can use for research (${d.capabilitiesSeen} capabilities):`,
    describeDiscovery(d),
    "",
    "Next I'll work out exactly what you're after and plan the searches; the plan will appear here, then the results with their sources. You can say \"stop research\" at any point; what's found is kept.",
    "I won't contact anyone: outreach waits for your approval.",
  ].join("\n");
}

/**
 * Record a research run and its first reply. Called by `begin` with what discovery found. With a model,
 * the plan is the first step (`planning: "model"`); without one, it is made here from the rules.
 * From a model turn (`fromTurn`), the turn has already recorded the person's message and records the
 * reply itself (returned here), so the conversation has one of each.
 */
export const create = app.mutation({
  access: "research.run",
  args: {
    text: s.string({ minLength: 1, maxLength: 4000 }),
    product: s.string({ maxLength: 120 }),
    objective: s.string({ maxLength: 1000 }),
    discovery: s.record(s.unknown()),
    conversationId: s.optional(s.string()),
    planning: s.optional(s.enum(["rules", "model"] as const)),
    fromTurn: s.optional(s.object({ messageId: s.string() })),
    /**
     * Started by an invocation from outside Anywhere Aide (feltkit/invocations.ts): its id (each step then
     * re-checks the person's delegation), and what they shared: the page to look at, and any text.
     */
    fromInvocation: s.optional(s.object({
      invocationId: s.string(),
      adapter: s.string(),
      seedUrl: s.optional(s.string({ maxLength: 2000 })),
      seedTitle: s.optional(s.string({ maxLength: 300 })),
      sharedText: s.optional(s.string({ maxLength: 20_000 })),
    })),
  },
  returns: RunView,
  handler: async (ctx, args) => {
    const owner = ops.me(ctx);
    const planning = args.planning ?? "rules";
    if (planning === "rules" && !args.product.trim()) fail("INVALID_ARGUMENT", "Without a model, research needs a product to look for customers for.");
    let conversationId = args.conversationId;
    if (conversationId) await ops.own(ctx, conversations, conversationId, "conversation");
    else if (args.fromTurn) fail("INVALID_ARGUMENT", "A turn's research needs its conversation.");
    else conversationId = await ctx.db.insert(conversations, { owner, title: titleOf(args.text), createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 });
    let messageId: string;
    if (args.fromTurn) {
      const m = await ctx.db.get(messages, args.fromTurn.messageId);
      if (!m || m.owner !== owner || m.conversationId !== conversationId) fail("NOT_FOUND", "message not found");
      messageId = m.id;
    } else messageId = await appendMessage(ctx, conversationId, { role: "user", text: args.text });
    const discovery = args.discovery as unknown as Discovery;
    const known = (await ctx.db.find(memories, { owner })).map((m: any) => ({ id: m.id, content: String(m.content), status: m.status }));
    const knowledge = productKnowledge(args.product || "\u0000", known);
    const inv = args.fromInvocation;
    const seedDomain = inv?.seedUrl ? domainOf(inv.seedUrl) : null;
    // A shared page with a known subject: assess that organization; nothing to search for.
    const assessSeed = planning === "rules" && Boolean(seedDomain);
    const queries = planning === "rules" && !assessSeed ? planQueries(args.product, knowledge) : [];
    // With a page to look at, web search is not required: the page itself can be read and assessed.
    const blocker = seedDomain ? undefined : blockerOf(discovery);
    const now = Date.now();
    const runId = await ctx.db.insert(researchRuns, {
      owner, kind: "prospects", request: args.text, product: args.product || "(planning)", objective: args.objective,
      status: blocker ? "blocked" : "running",
      phase: planning === "model" ? "planning" : assessSeed ? "reading" : "searching",
      ...(planning === "rules" ? { plan: { basis: "rules" as const, criteria: knowledge.keywords.map((k) => `mentions "${k}"`), ...(assessSeed ? { scope: "this" as const } : {}) } } : {}),
      discovery: args.discovery,
      profile: knowledge,
      queries: queries.map((text) => ({ text, state: "pending" as const, attempts: 0, origin: "plan" as const })),
      ...(blocker ? { blocker } : {}),
      ...(inv ? { invocationId: inv.invocationId } : {}),
      conversationId, createdAt: now, updatedAt: now,
    });
    if (inv?.seedUrl && seedDomain) {
      // What the person shared is evidence of its own kind: their link, and any text they selected.
      const sourceId = await ctx.db.insert(researchSources, { owner, runId, url: inv.seedUrl, title: (inv.seedTitle ?? seedDomain).slice(0, 300), text: (inv.sharedText ?? "").slice(0, 20_000), query: "shared by you", provider: inv.adapter, retrievedAt: now, kind: "shared", textKind: "user-shared" });
      await ctx.db.patch(researchRuns, runId, {
        seed: { url: inv.seedUrl, ...(inv.seedTitle ? { title: inv.seedTitle } : {}), sourceId },
        ...(assessSeed ? { candidates: [{ domain: seedDomain, name: companyName(inv.seedTitle ?? "", seedDomain), sourceIds: [sourceId], why: "You shared it.", state: "pending" as const }], selection: { basis: "rules" as const, rejected: [] } } : {}),
      });
    }
    const reply = blocker
      ? blockedReply(args.product || "this request", discovery, blocker)
      : planning === "model" ? planningReply(discovery)
      : assessSeed ? `On it: looking at ${seedDomain} for ${args.product}. I'll read its own pages, assess it, and post what I find here with its sources. I won't contact anyone.`
      : startReply(args.product, queries, discovery, knowledge);
    const replyId = args.fromTurn ? "" : await appendMessage(ctx, conversationId, { role: "assistant", text: reply });
    if (!blocker) enqueueStep(ctx, runId);
    return { runId, conversationId, status: blocker ? "blocked" : "running", reply, messageId, replyId };
  },
});

export const resume = app.mutation({
  access: "research.run",
  args: { runId: s.string(), discovery: s.record(s.unknown()) },
  returns: RunView,
  handler: async (ctx, { runId, discovery }) => resumeRun(ctx, await ops.own<any>(ctx, researchRuns, runId, "research run"), discovery as unknown as Discovery),
});

/**
 * Resume a stopped run (resume, retryRun). A completed run is never run again. A run an agent started
 * continues only within its budget: the calls it has not charged are reserved again if they were released,
 * plus any `more` the caller asks for, from what the owner still allows that agent.
 */
async function resumeRun(ctx: MutationCtx, run: any, d: Discovery, more = 0) {
    const runId = run.id;
    if (run.status === "running") return { runId, conversationId: run.conversationId, status: run.status, reply: "Still running.", messageId: "", replyId: "" };
    if (run.status === "completed") fail("FAILED_PRECONDITION", "This research is complete. Ask again to start a new one.");
    let budget = run.budget;
    if (budget) {
      const allocation = budget.allocation + more;
      if (allocation - budget.charged <= 0) fail("FORBIDDEN", `This research has used all ${budget.allocation} calls it was given; retry it with more (budget) to continue.`);
      const need = (budget.released ? budget.allocation - budget.charged : 0) + more;
      if (need > 0) await reserve(ctx, run.owner, budget.agent, need);
      budget = { ...budget, allocation, released: false };
    } else if (more) fail("INVALID_ARGUMENT", "This research has no budget to add to.");
    if (!Array.isArray((d as { needs?: unknown } | undefined)?.needs)) {
      // Stopped before its first step discovered anything: it starts there again.
      await ctx.db.patch(researchRuns, runId, { status: "running", phase: "discovering", ...(budget ? { budget } : {}), cancelRequested: false, cancelledBy: undefined, blocker: undefined, completedAt: undefined, updatedAt: Date.now() });
      enqueueStep(ctx, runId);
      return { runId, conversationId: run.conversationId, status: "running", reply: "Starting the research again.", messageId: "", replyId: "" };
    }
    const discovery = d as unknown as Record<string, unknown>;
    const blocker = blockerOf(d);
    const queries = run.queries.map((q: any) => (q.state === "failed" ? { ...q, state: "pending", attempts: 0, error: undefined } : q));
    const candidates = run.candidates?.map((c: any) => (c.state === "failed" ? { ...c, state: c.pageIds?.length ? "read" : "pending", attempts: 0 } : c));
    // Failed searches run again; so does the step after them (selection) if it already ran without them.
    const rerun = queries.some((q: any, i: number) => q.state === "pending" && run.queries[i].state === "failed");
    const phase = rerun && run.phase && run.phase !== "planning" ? "searching" : run.phase === "done" ? "finishing" : run.phase;
    const status = blocker ? "blocked" : "running";
    await ctx.db.patch(researchRuns, runId, { status, discovery, queries, ...(candidates ? { candidates } : {}), ...(phase ? { phase } : {}), ...(budget ? { budget } : {}), cancelRequested: false, cancelledBy: undefined, blocker: blocker ?? undefined, completedAt: undefined, updatedAt: Date.now() });
    const left = queries.filter((q: any) => q.state === "pending").length;
    const reply = blocker ? blockedReply(run.product, d, blocker) : `Resuming the research for ${run.product}${left ? `: ${left} search(es) to go` : ""}.`;
    const replyId = run.conversationId ? await appendMessage(ctx, run.conversationId, { role: "assistant", text: reply }) : "";
    if (!blocker) enqueueStep(ctx, runId);
    await followResearch(ctx, run, status, reply);
    return { runId, conversationId: run.conversationId, status, reply, messageId: replyId, replyId };
}


/** Record a question about what Anywhere Aide can do, and the answer discovery gave (no model involved). */
export const answer = app.mutation({
  access: "assistant.send",
  args: { text: s.string({ minLength: 1, maxLength: 4000 }), reply: s.string({ minLength: 1, maxLength: 8000 }), conversationId: s.optional(s.string()) },
  returns: s.object({ conversationId: s.string(), messageId: s.string(), replyId: s.string() }),
  handler: async (ctx, args) => {
    const owner = ops.me(ctx);
    let conversationId = args.conversationId;
    if (conversationId) await ops.own(ctx, conversations, conversationId, "conversation");
    else conversationId = await ctx.db.insert(conversations, { owner, title: titleOf(args.text), createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 });
    const messageId = await appendMessage(ctx, conversationId, { role: "user", text: args.text });
    const replyId = await appendMessage(ctx, conversationId, { role: "assistant", text: args.reply });
    return { conversationId, messageId, replyId };
  },
});


/** What a step needs: the run, its sources, and whether it is still the owner's to run. */
export const forStep = app.query({
  access: "research.work",
  args: { runId: s.string() },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(researchRuns, runId);
    if (!run || run.owner !== ops.me(ctx)) return null;
    const sources = await ctx.db.find(researchSources, { runId });
    const found = await ctx.db.find(prospects, { runId });
    const known = (await ctx.db.find(memories, { owner: run.owner })).map((m: any) => ({ id: m.id, content: String(m.content), status: m.status }));
    return { run, sources, prospects: found, memories: known };
  },
});

export const ZERO_USAGE = { generations: 0, inputTokens: 0, outputTokens: 0, modelMs: 0, searches: 0, searchFailures: 0, searchMs: 0, pagesRequested: 0, pagesRead: 0, pageMs: 0, quotesOffered: 0, quotesVerified: 0 };

/**
 * Apply one step's result, if the run is still where the step found it (status running, same
 * `updatedAt`): a stopped run, or a step that already ran (a job retried after a restart), changes
 * nothing. Sources are inserted; `pagesFor` attaches the new page sources to a candidate; the next
 * step is queued only if this one committed.
 */
export const advance = app.mutation({
  access: "research.work",
  args: {
    runId: s.string(),
    expectUpdatedAt: s.number(),
    patch: s.record(s.unknown()),
    sources: s.optional(s.array(s.record(s.unknown()))),
    pagesFor: s.optional(s.string()),
    prospects: s.optional(s.array(s.record(s.unknown()))),
    ranks: s.optional(s.array(s.object({ id: s.string(), rank: s.number() }))),
    usage: s.optional(s.record(s.number())),
    step: s.object({ phase: s.string(), ms: s.number(), outcome: s.string({ maxLength: 500 }) }),
    reply: s.optional(s.string({ maxLength: 8000 })),
    next: s.boolean(),
    /** Run the next step after this long (a provider asked to wait: a rate limit). */
    delayMs: s.optional(s.integer({ minimum: 0, maximum: 600000 })),
  },
  returns: s.object({ applied: s.boolean(), sourceIds: s.array(s.string()) }),
  handler: async (ctx, a) => {
    const run = await ctx.db.get(researchRuns, a.runId);
    if (!run || run.owner !== ops.me(ctx)) fail("NOT_FOUND", "research run not found");
    if (run.status !== "running" || run.cancelRequested || run.updatedAt !== a.expectUpdatedAt) return { applied: false, sourceIds: [] };
    const now = Date.now();
    const sourceIds: string[] = [];
    for (const src of a.sources ?? []) sourceIds.push(await ctx.db.insert(researchSources, { ...(src as any), owner: run.owner, runId: run.id }));
    for (const p of a.prospects ?? []) await ctx.db.insert(prospects, { ...(p as any), owner: run.owner, runId: run.id });
    for (const r of a.ranks ?? []) {
      const p = await ctx.db.get(prospects, r.id);
      if (p && p.runId === run.id) await ctx.db.patch(prospects, r.id, { rank: r.rank });
    }
    const patch: Record<string, unknown> = { ...a.patch };
    if (a.pagesFor && Array.isArray(patch.candidates)) {
      patch.candidates = (patch.candidates as any[]).map((c) => (c.domain === a.pagesFor ? { ...c, pageIds: [...(c.pageIds ?? []), ...sourceIds] } : c));
    }
    const usage = { ...ZERO_USAGE, ...(run.usage ?? {}) } as Record<string, number>;
    for (const [k, v] of Object.entries(a.usage ?? {})) usage[k] = (usage[k] ?? 0) + v;
    const steps = [...(run.steps ?? []), { at: now, ...a.step }].slice(-200);
    // A run that has finished gives back the budget it did not charge (a blocked run keeps it, to resume).
    const ended = ["completed", "partial", "failed"].includes(String(patch.status ?? ""));
    const budget = ended ? await releaseBudget(ctx, run) : undefined;
    await ctx.db.patch(researchRuns, run.id, { ...patch, usage, steps, ...(budget ? { budget } : {}), updatedAt: now } as any);
    if (a.reply && run.conversationId) await appendMessage(ctx, run.conversationId, { role: "assistant", text: a.reply });
    // A run an invocation started: the invocation follows it when it ends (or stops short).
    const status = (patch.status as string | undefined) ?? run.status;
    if (status !== "running") await followResearch(ctx, run as any, status, a.reply ?? a.step.outcome);
    if (a.next) enqueueStep(ctx, run.id, a.delayMs ?? 0);
    return { applied: true, sourceIds };
  },
});

// ── Research an agent runs for the owner (research.start, under FeltKit's verified delegation) ──────

/** Reserve `calls` from what the owner lets `agent` spend on research. Fails closed: no budget, or not enough left. */
async function reserve(ctx: MutationCtx, owner: string, agent: string, calls: number) {
  const record = (await ctx.db.find(researchBudgets, { owner, agent }))[0];
  if (!record) fail("FORBIDDEN", `No research budget is set for ${agent}: the owner sets one (delegation.setResearchBudget) before it can start research.`);
  const left = record.calls - record.reserved;
  if (calls > left) fail("FORBIDDEN", `The research budget for ${agent} has ${Math.max(0, left)} call(s) left; ${calls} asked for.`);
  await ctx.db.patch(researchBudgets, record.id, { reserved: record.reserved + calls, updatedAt: Date.now() });
}

/** Give back what a run that has stopped did not charge (once). What it charged stays spent. */
export async function releaseBudget(ctx: MutationCtx, run: any) {
  const b = run.budget;
  if (!b || b.released) return undefined;
  const record = (await ctx.db.find(researchBudgets, { owner: run.owner, agent: b.agent }))[0];
  if (record) await ctx.db.patch(researchBudgets, record.id, { reserved: Math.max(0, record.reserved - (b.allocation - b.charged)), updatedAt: Date.now() });
  return { ...b, released: true };
}

const Started = s.object({ runId: s.string(), conversationId: s.string(), status: s.string(), budget: s.nullable(s.object({ agent: s.string(), allocation: s.number(), charged: s.number(), released: s.boolean() })) });

/**
 * Start research for an outcome stated in words, as a transaction: the run is recorded (and, for an agent
 * acting for the owner, its budget reserved) here; the first step discovers what the platform offers and
 * plans. An agent must name a budget (billable calls), within what the owner lets it spend.
 */
export const start = app.mutation({
  access: "research.run",
  args: { text: s.string({ minLength: 1, maxLength: 4000 }), budget: s.optional(s.integer({ minimum: 1, maximum: 1000 })) },
  returns: Started,
  capability: { name: "research.start", description: "Start research for an outcome (for example: find new customers for <product>). An agent acting for the owner must give a budget: the most billable calls (model generations and web searches) the run may make." },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { text, budget }) => {
    const owner = ops.me(ctx);
    const delegated = ops.delegationOf(ctx);
    if (delegated && budget === undefined) fail("INVALID_ARGUMENT", "Research started for the owner needs a budget: the most billable calls it may make.");
    if (delegated) await reserve(ctx, owner, delegated.agentAuthority, budget!);
    const allocation = delegated ? { agent: delegated.agentAuthority, allocation: budget!, charged: 0, released: false } : null;
    const outcome = outcomeOf(text);
    const now = Date.now();
    const conversationId = await ctx.db.insert(conversations, { owner, title: titleOf(text), createdAt: now, updatedAt: now, messageCount: 0 });
    await appendMessage(ctx, conversationId, { role: "user", text });
    const runId = await ctx.db.insert(researchRuns, {
      owner, kind: "prospects", request: text, product: outcome?.product ?? "(planning)", objective: outcome?.objective ?? text.slice(0, 1000),
      status: "running", phase: "discovering", discovery: {}, profile: { statements: [], keywords: [] }, queries: [],
      ...(allocation ? { budget: allocation } : {}), conversationId, createdAt: now, updatedAt: now,
    });
    const stored = (await ctx.db.get(researchRuns, runId))!;
    await ops.record(ctx, { kind: "research.start", summary: `Research started: ${text}`, status: "succeeded", input: { text, ...(budget !== undefined ? { budget } : {}) }, evidence: { collection: "researchRuns", id: runId, version: Number(stored.__version), verified: stored.status === "running" } }, { via: "ui", conversationId });
    enqueueStep(ctx, runId);
    return { runId, conversationId, status: "running", budget: allocation };
  },
});

/** A started run's first step: what discovery found, and the plan (as `create` makes it when research begins in the app). */
export const prepare = app.mutation({
  access: "research.work",
  args: { runId: s.string(), expectUpdatedAt: s.number(), discovery: s.record(s.unknown()), planning: s.enum(["rules", "model"] as const) },
  returns: s.object({ applied: s.boolean() }),
  handler: async (ctx, a) => {
    const run = await ctx.db.get(researchRuns, a.runId);
    if (!run || run.owner !== ops.me(ctx)) fail("NOT_FOUND", "research run not found");
    if (run.status !== "running" || run.cancelRequested || run.updatedAt !== a.expectUpdatedAt || run.phase !== "discovering") return { applied: false };
    const d = a.discovery as unknown as Discovery;
    const product = run.product === "(planning)" ? "" : run.product;
    const known = (await ctx.db.find(memories, { owner: run.owner })).map((m: any) => ({ id: m.id, content: String(m.content), status: m.status }));
    const knowledge = productKnowledge(product || "\u0000", known);
    const now = Date.now();
    if (a.planning === "rules" && !product) {
      const blocker = { need: "a research outcome", state: "failed", detail: "Without a model, research needs an outcome it recognizes, such as: find new customers for <product>." };
      const budget = await releaseBudget(ctx, run);
      await ctx.db.patch(researchRuns, run.id, { status: "failed", phase: "done", discovery: a.discovery, profile: knowledge, blocker, ...(budget ? { budget } : {}), completedAt: now, updatedAt: now });
      if (run.conversationId) await appendMessage(ctx, run.conversationId, { role: "assistant", text: `I can't pursue that without a model: ${blocker.detail} Nothing was searched.` });
      return { applied: true };
    }
    const queries = a.planning === "rules" ? planQueries(product, knowledge) : [];
    const blocker = blockerOf(d);
    await ctx.db.patch(researchRuns, run.id, {
      discovery: a.discovery, profile: knowledge, phase: a.planning === "model" ? "planning" : "searching",
      ...(a.planning === "rules" ? { plan: { basis: "rules" as const, criteria: knowledge.keywords.map((k) => `mentions "${k}"`) } } : {}),
      queries: queries.map((text) => ({ text, state: "pending" as const, attempts: 0, origin: "plan" as const })),
      status: blocker ? "blocked" : "running", ...(blocker ? { blocker } : {}), updatedAt: now,
    });
    const reply = blocker ? blockedReply(product || "this request", d, blocker) : a.planning === "model" ? planningReply(d) : startReply(product, queries, d, knowledge);
    if (run.conversationId) await appendMessage(ctx, run.conversationId, { role: "assistant", text: reply });
    if (!blocker) enqueueStep(ctx, run.id);
    return { applied: true };
  },
});

/**
 * Charge one billable call (a model generation or a web search) to a run an agent started, before the call
 * is made. Refused if the run has stopped, moved on, or used its allocation (then it stops, saying why).
 */
export const charge = app.mutation({
  access: "research.work",
  args: { runId: s.string(), expectUpdatedAt: s.number(), call: s.enum(["model", "search"] as const) },
  returns: s.object({ ok: s.boolean(), updatedAt: s.number(), reason: s.optional(s.string()) }),
  handler: async (ctx, a) => {
    const run = await ctx.db.get(researchRuns, a.runId);
    if (!run || run.owner !== ops.me(ctx)) fail("NOT_FOUND", "research run not found");
    if (!run.budget) return { ok: true, updatedAt: run.updatedAt };
    if (run.status !== "running" || run.cancelRequested || run.updatedAt !== a.expectUpdatedAt) return { ok: false, updatedAt: run.updatedAt, reason: "stopped" };
    const now = Date.now();
    if (run.budget.charged >= run.budget.allocation) {
      const blocker = { need: "research budget", state: "exhausted", detail: `This research used all ${run.budget.allocation} billable calls it was given.`, howToEnable: "Retry it with more budget, within what you allow the agent." };
      await ctx.db.patch(researchRuns, run.id, { status: "blocked", blocker, updatedAt: now, steps: [...(run.steps ?? []), { at: now, phase: run.phase ?? "", ms: 0, outcome: `stopped before a ${a.call} call: budget used` }].slice(-200) });
      if (run.conversationId) await appendMessage(ctx, run.conversationId, { role: "assistant", text: `I stopped the research for ${run.product}: it used all ${run.budget.allocation} calls it was given. What I found is kept.` });
      return { ok: false, updatedAt: now, reason: "exhausted" };
    }
    await ctx.db.patch(researchRuns, run.id, { budget: { ...run.budget, charged: run.budget.charged + 1 }, updatedAt: now });
    return { ok: true, updatedAt: now };
  },
});

/**
 * Retry a stopped run (failed, partial, blocked, or cancelled by the agent). Never a completed run. An agent
 * retries only runs it started, never one the owner stopped, and within budget (`budget`: calls to add).
 */
export const retryRun = app.mutation({
  access: "research.run",
  args: { runId: s.string(), budget: s.optional(s.integer({ minimum: 1, maximum: 1000 })) },
  returns: RunView,
  capability: { name: "research.retry", description: "Continue a stopped research run where it left off (never a completed one), within its budget; `budget` adds calls from what the owner allows." },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { runId, budget }) => {
    const run = await ops.own<any>(ctx, researchRuns, runId, "research run");
    const delegated = ops.delegationOf(ctx);
    if (delegated && run.budget?.agent !== delegated.agentAuthority) fail("FORBIDDEN", "An agent retries only research it started.");
    if (delegated && run.cancelledBy === "owner") fail("FORBIDDEN", "The owner stopped this research; only they can resume it.");
    const result = await resumeRun(ctx, run, run.discovery as unknown as Discovery, budget ?? 0);
    if (result.status !== run.status) await ops.record(ctx, { kind: "research.retry", summary: `Research resumed: ${run.request}`.slice(0, 500), status: "succeeded", input: { runId, ...(budget ? { budget } : {}) } }, { via: "ui", ...(run.conversationId ? { conversationId: run.conversationId } : {}) });
    return result;
  },
});
