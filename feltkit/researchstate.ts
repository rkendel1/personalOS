/**
 * The writes behind research.begin and research.retry (feltkit/research.ts): recording a run, its plan
 * and its discovery, and replying in the conversation. Separate from research.ts so those actions can
 * name them through the generated API.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, conversations, memories, messages, prospects, researchRuns, researchSources } from "./app.js";
import { describeDiscovery, type Discovery } from "./_capabilities.js";
import { companyName, domainOf, planQueries, productKnowledge } from "./_research.js";
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
  const lines = [`On it: finding qualified prospects for ${product}. I checked what this PersonalOS can do for that (${d.capabilitiesSeen} capabilities):`, describeDiscovery(d), ""];
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
    `On it. I checked what this PersonalOS can use for research (${d.capabilitiesSeen} capabilities):`,
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
     * Started by an invocation from outside PersonalOS (feltkit/invocations.ts): its id (each step then
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
  handler: async (ctx, { runId, discovery }) => {
    const run = await ops.own<any>(ctx, researchRuns, runId, "research run");
    if (run.status === "running") return { runId, conversationId: run.conversationId, status: run.status, reply: "Still running.", messageId: "", replyId: "" };
    if (run.status === "completed") fail("FAILED_PRECONDITION", "This research is complete. Ask again to start a new one.");
    const d = discovery as unknown as Discovery;
    const blocker = blockerOf(d);
    const queries = run.queries.map((q: any) => (q.state === "failed" ? { ...q, state: "pending", attempts: 0, error: undefined } : q));
    const candidates = run.candidates?.map((c: any) => (c.state === "failed" ? { ...c, state: c.pageIds?.length ? "read" : "pending", attempts: 0 } : c));
    // Failed searches run again; so does the step after them (selection) if it already ran without them.
    const rerun = queries.some((q: any, i: number) => q.state === "pending" && run.queries[i].state === "failed");
    const phase = rerun && run.phase && run.phase !== "planning" ? "searching" : run.phase === "done" ? "finishing" : run.phase;
    const status = blocker ? "blocked" : "running";
    await ctx.db.patch(researchRuns, runId, { status, discovery, queries, ...(candidates ? { candidates } : {}), ...(phase ? { phase } : {}), cancelRequested: false, blocker: blocker ?? undefined, completedAt: undefined, updatedAt: Date.now() });
    const left = queries.filter((q: any) => q.state === "pending").length;
    const reply = blocker ? blockedReply(run.product, d, blocker) : `Resuming the research for ${run.product}${left ? `: ${left} search(es) to go` : ""}.`;
    const replyId = run.conversationId ? await appendMessage(ctx, run.conversationId, { role: "assistant", text: reply }) : "";
    if (!blocker) enqueueStep(ctx, runId);
    await followResearch(ctx, run, status, reply);
    return { runId, conversationId: run.conversationId, status, reply, messageId: replyId, replyId };
  },
});


/** Record a question about what PersonalOS can do, and the answer discovery gave (no model involved). */
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
    await ctx.db.patch(researchRuns, run.id, { ...patch, usage, steps, updatedAt: now } as any);
    if (a.reply && run.conversationId) await appendMessage(ctx, run.conversationId, { role: "assistant", text: a.reply });
    // A run an invocation started: the invocation follows it when it ends (or stops short).
    const status = (patch.status as string | undefined) ?? run.status;
    if (status !== "running") await followResearch(ctx, run as any, status, a.reply ?? a.step.outcome);
    if (a.next) enqueueStep(ctx, run.id, a.delayMs ?? 0);
    return { applied: true, sourceIds };
  },
});
