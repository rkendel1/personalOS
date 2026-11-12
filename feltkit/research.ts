/**
 * Research outcomes: the person asks for an outcome ("find me some new customers for FeltKit"), and
 * PersonalOS pursues it with whatever the platform can actually do, instead of the tools a model
 * turn was handed.
 *
 *   begin (action)   discover the capability landscape for the outcome's needs (ctx.agent.catalog:
 *                    what exists, what this person may use, what is configured), then create the run
 *   create           record the run, its plan and its discovery; reply in the conversation with the
 *                    plan, or with the exact blocker and how to clear it; start the agent if it can run
 *   research agent   one step per run of the agent (durable progress; cancel and retry between steps):
 *                    a search through the `websearch` integration, its results stored as sources;
 *                    when the searches are done, prospects built from those sources (_research.ts)
 *   cancel / retry   stop between steps (what was found is kept); re-discover and resume failed steps
 *
 * Finding prospects is reading. Nothing here contacts anyone: outreach is a recommended next action,
 * and would be a consequential capability that waits for the person's approval.
 */
import { fail, s, type ActionCtx } from "@feltdb/feltkit";
import { api } from "./_generated/api.js";
import { app, prospects, researchRuns, researchSources } from "./app.js";
import { declaredCapabilities, PROSPECT_NEEDS, discover } from "./_capabilities.js";
import { outcomeOf, prospectsFrom, searchResults } from "./_research.js";
import { appendMessage } from "./assistant.js";
import * as ops from "./_ops.js";

const MAX_ATTEMPTS = 3;
const RESULTS_PER_QUERY = 10;

export const RunView = s.object({
  runId: s.string(),
  conversationId: s.string(),
  status: s.string(),
  reply: s.string(),
  messageId: s.string(),
  replyId: s.string(),
});


/**
 * Start research for an outcome stated in words. Discovery runs here (an action reads the platform's
 * catalog); the run itself is recorded by `create`. Refused when the words are not a research outcome.
 */
export const begin = app.action({
  access: "research.run",
  args: { text: s.string({ minLength: 1, maxLength: 4000 }), conversationId: s.optional(s.string()) },
  returns: RunView,
  handler: (ctx, { text, conversationId }) => startResearch(ctx, text, conversationId),
});

/** begin's work, for any action (a conversation turn calls it directly). */
export async function startResearch(ctx: ActionCtx, text: string, conversationId?: string) {
  const outcome = outcomeOf(text);
  if (!outcome) fail("INVALID_ARGUMENT", "That isn't a research outcome I can pursue yet (for example: \"find me new customers for <product>\").");
  const discovery = await discover(ctx.agent, PROSPECT_NEEDS, { declared: declaredCapabilities() });
  return ctx.runMutation(api.researchstate.create, { text, product: outcome.product, objective: outcome.objective, discovery: discovery as unknown as Record<string, unknown>, ...(conversationId ? { conversationId } : {}) });
}

/** retry's work, for any action. */
export async function retryResearch(ctx: ActionCtx, runId: string) {
  const discovery = await discover(ctx.agent, PROSPECT_NEEDS, { declared: declaredCapabilities() });
  return ctx.runMutation(api.researchstate.resume, { runId, discovery: discovery as unknown as Record<string, unknown> });
}

/** Re-discover and resume a blocked or failed run (after configuring a provider, or a transient failure). */
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
    const replyId = run.conversationId ? await appendMessage(ctx, run.conversationId, { role: "assistant", text: `Stopped the research for ${run.product}. What I found so far is kept; say "retry research" to continue.` }) : null;
    return { status: "cancelled", conversationId: run.conversationId ?? null, messageId: replyId, replyId };
  },
});

export const list = app.query({
  access: "research.read",
  handler: async (ctx) => (await ctx.db.find(researchRuns, { owner: ops.me(ctx) }, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: 50 })).map((r: any) => ({
    id: r.id, product: r.product, request: r.request, status: r.status, conversationId: r.conversationId ?? null, createdAt: r.createdAt, completedAt: r.completedAt ?? null, prospectCount: r.prospectCount ?? 0, blocker: r.blocker ?? null,
    queries: r.queries.map((q: any) => ({ text: q.text, state: q.state, attempts: q.attempts, results: q.results ?? null })),
  })),
});

/** One run with its evidence: sources (what was found) and prospects (facts citing them, assessments apart). */
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

/**
 * The research agent: one step per run. A search (stored as sources) while searches remain; then the
 * prospects. It re-reads the run each step, so a cancel takes effect before the next search.
 */
export const researchAgent = app.agent("research", {
  principal: { id: "personalos-research", displayName: "PersonalOS research" },
  roles: ["researcher"],
  access: "research.work",
  description: "Runs research steps (web searches, then prospects) for the run's owner. Reads only; contacts no one.",
  handler: async (ctx, input: { runId: string }) => {
    const run = await ctx.db.get(researchRuns, String(input.runId));
    if (!run || run.status !== "running" || run.cancelRequested) return;
    const octx = ops.actingFor(ctx, run.owner);
    const queries = [...run.queries];
    const index = queries.findIndex((q) => q.state === "pending");
    if (index >= 0) {
      const q = queries[index]!;
      try {
        const output = await ctx.integrations.invoke("websearch.search", { q: q.text, count: RESULTS_PER_QUERY });
        const results = searchResults(output);
        const at = Date.now();
        for (const r of results) {
          await ctx.db.insert(researchSources, { owner: run.owner, runId: run.id, url: r.url, title: r.title, text: [r.description, ...(r.extra ?? [])].filter(Boolean).join(" … ").slice(0, 4000), query: q.text, provider: "websearch", retrievedAt: at });
        }
        queries[index] = { ...q, state: "done", attempts: q.attempts + 1, results: results.length, at };
      } catch (error) {
        const f = failureOf(error);
        const attempts = q.attempts + 1;
        if (!f.transient) {
          // Not something a retry fixes: stop, say exactly what is missing, keep what was found.
          queries[index] = { ...q, state: "failed", attempts, error: f.detail, at: Date.now() };
          const blocker = { need: "web search", state: f.state, detail: f.detail, ...(f.state === "needs-configuration" ? { howToEnable: "Check WEBSEARCH_URL and the websearch credential (Studio → Integrations), then retry the research." } : f.state === "needs-authorization" ? { howToEnable: "Ask an administrator to grant the research permission, then retry." } : {}) };
          await ctx.db.patch(researchRuns, run.id, { queries, status: "blocked", blocker, updatedAt: Date.now() });
          if (run.conversationId) await appendMessage(octx, run.conversationId, { role: "assistant", text: `The research for ${run.product} stopped: ${f.detail.replace(/\.+$/, "")}. ${blocker.howToEnable ?? ""} What I found before this is kept.`.replace(/\s+/g, " ").trim() });
          return;
        }
        queries[index] = attempts >= MAX_ATTEMPTS ? { ...q, state: "failed", attempts, error: f.detail, at: Date.now() } : { ...q, attempts, error: f.detail };
      }
      await ctx.db.patch(researchRuns, run.id, { queries, updatedAt: Date.now() });
      ctx.afterCommit.agent("research", { runId: run.id });
      return;
    }

    // Every search ran (or gave up): build the prospects from the stored sources.
    const sources = (await ctx.db.find(researchSources, { runId: run.id })).map((x: any) => ({ id: x.id, url: x.url, title: x.title, text: x.text, query: x.query }));
    const pagesRead = ((run.discovery as any)?.needs ?? []).some((n: any) => n.need === "page retrieval" && n.state === "available");
    const drafts = prospectsFrom(run.product, run.profile, sources, { pagesRead });
    const researchedAt = Date.now();
    for (const [rank, d] of drafts.entries()) await ctx.db.insert(prospects, { owner: run.owner, runId: run.id, rank: rank + 1, ...d, researchedAt });
    const failed = queries.filter((q) => q.state === "failed");
    const status = sources.length === 0 ? "failed" : failed.length ? "partial" : "completed";
    await ctx.db.patch(researchRuns, run.id, { status, prospectCount: drafts.length, updatedAt: researchedAt, completedAt: researchedAt });
    if (run.conversationId) {
      const top = drafts.slice(0, 5).map((d, i) => `${i + 1}. ${d.company} (${d.website}): ${d.assessment.fit} fit, ${d.assessment.confidence} confidence. ${d.assessment.whyFeltKit} [${d.facts.length} source${d.facts.length === 1 ? "" : "s"}]`);
      const text = status === "failed"
        ? `I couldn't find anything for ${run.product}: ${failed.length} of ${queries.length} searches failed${failed[0]?.error ? ` (${failed[0].error})` : ""}, and the rest returned nothing. Say "retry research" to try again.`
        : [
            `Research for ${run.product} is ${status === "partial" ? "partly done" : "done"}: ${drafts.length} prospect${drafts.length === 1 ? "" : "s"} from ${sources.length} sources (${queries.length - failed.length} of ${queries.length} searches).`,
            ...top,
            "",
            "Each one lists what its sources said (verified: those pages returned it) apart from my assessment (keyword match, not a judgment of the company). Open Research to review the evidence.",
            ...(failed.length ? [`${failed.length} search(es) failed (${failed.map((q) => `"${q.text}"`).join(", ")}); say "retry research" to run them again.`] : []),
            "Nothing was sent to anyone. If one fits, ask me to draft an introduction: it will wait for your approval.",
          ].join("\n");
      await appendMessage(octx, run.conversationId, { role: "assistant", text });
    }
  },
});
