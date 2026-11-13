/**
 * Summoning PersonalOS from outside its own interface (`personalos.invocation/1`, feltkit/_invocation.ts).
 * The iOS share extension is the first surface; any other fills the same envelope.
 *
 *   submit (mutation)   the person's own session. Who is asking is that session, never the envelope.
 *                       Validated and limited, idempotent per (person, invocationId), persisted with
 *                       its provenance, and a job queued. It answers with a receipt and returns: the
 *                       surface does not wait, and executes nothing.
 *   process (job)       runs later as the person, so it survives the surface closing and the server
 *                       restarting (AppPort Services jobs: leased, retried). It:
 *                         1 infers what was asked (rules; a model when the rules can't tell), recorded
 *                           apart from what was asked and what was shared
 *                         2 asks AuthBoundry, now, whether PersonalOS's executor (agent:personalos) may
 *                           do that on the person's behalf (their delegation, as for every surface)
 *                         3 hands the work to what already does it: research (seeded with the shared
 *                           page), the assistant (tasks, reminders, notes), or saving it
 *   get / list          what the surface shows: accepted, processing, needs approval, completed, failed
 *
 * Shared content is data. It is never read for instructions, and nothing in it changes who is asking
 * or what they may do.
 */
import { fail, FeltKitError, s, type ActionCtx } from "@feltdb/feltkit";
import { api } from "./_generated/api.js";
import { app, conversations, invocations } from "./app.js";
import { acceptIntent, describeContext, intentByRules, intentPrompt, INVOCATION_CONTRACT, INVOCATION_TERMINAL, InvocationEnvelope, InvocationRefusal, normalizeInvocation, subjectOf } from "./_invocation.js";
import { authorityPrincipal, capabilityFor } from "./_authority.js";
import { declaredCapabilities, discover, PROSPECT_NEEDS } from "./_capabilities.js";
import { interpret } from "./_interpret.js";
import { clockFor } from "./_clock.js";
import { jsonOf } from "./_researchmodel.js";
import { modelUsable } from "./research.js";
import { ownInvocation, Receipt, receiptOf } from "./invocationstate.js";
import * as ops from "./_ops.js";

/** How many times processing waits for an unreachable authority before the invocation fails and says so. */
const AUTHORITY_TRIES = 4;
/** Research started from outside PersonalOS needs this capability in the person's delegation. */
export const RESEARCH_CAPABILITY = "personalos.research.run";

const titleOf = (inv: { context: Array<{ title?: string; url?: string; name?: string; text?: string }> }) => {
  const c = inv.context[0]!;
  const what = c.title ?? c.name ?? (c.url ? new URL(c.url).hostname.replace(/^www\./, "") : (c.text ?? "").slice(0, 40));
  return `Shared: ${what}`.slice(0, 60);
};

/** Submit an invocation. The receipt says it was accepted; the work happens afterwards. */
export const submit = app.mutation({
  access: "invocations.submit",
  args: { envelope: InvocationEnvelope },
  returns: Receipt,
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { envelope }) => {
    const owner = ops.me(ctx);
    let n;
    try { n = normalizeInvocation(envelope); } catch (error) {
      if (error instanceof InvocationRefusal) fail("INVALID_ARGUMENT", error.message, { reason: error.code });
      throw error;
    }
    // The same share sent again (a retry after a lost answer) is the same invocation.
    const existing = await ownInvocation(ctx, n.invocationId);
    if (existing) {
      if (existing.digest !== n.digest) fail("CONFLICT", "This invocation id was already used for something else. A new share needs a new id.");
      return receiptOf(existing, true);
    }
    const now = Date.now();
    let conversationId = n.conversationId;
    if (conversationId) await ops.own(ctx, conversations, conversationId, "conversation");
    else conversationId = await ctx.db.insert(conversations, { owner, title: titleOf(n), createdAt: now, updatedAt: now, messageCount: 0 });
    const id = await ctx.db.insert(invocations, {
      owner, invocationId: n.invocationId, contract: INVOCATION_CONTRACT, surface: n.surface, instruction: n.instruction, context: n.context,
      ...(n.sourceUrl ? { sourceUrl: n.sourceUrl } : {}), submittedAt: n.submittedAt, receivedAt: now, ...(n.timeZone ? { timeZone: n.timeZone } : {}),
      digest: n.digest, conversationId, returnTo: "personalos", state: "accepted",
      updates: [{ seq: 1, state: "accepted", text: `PersonalOS has it: ${describeContext(n.context)}${n.instruction ? `, "${n.instruction.slice(0, 200)}"` : ""}. You can close this; the result will be in PersonalOS.`, at: now }],
      createdAt: now, updatedAt: now,
    });
    ctx.afterCommit.jobs.enqueue("invocation.process", { invocationId: n.invocationId }, { maxAttempts: 6 });
    return receiptOf((await ctx.db.get(invocations, id))!, false);
  },
});

/**
 * For the assistant: "this" in what they asked means what they shared ("remind me to read this" →
 * "remind me to read <title> (<url>)"), so the task it creates says what to read. Else it is appended.
 */
function assistantText(inv: any): string {
  const c = inv.context[0];
  const label = c.kind === "url" ? `${c.title ? `${c.title.slice(0, 120)} ` : ""}(${c.url})` : c.kind === "document" ? `"${c.name ?? "the document"}"` : c.url ? `the text from ${c.url}` : `"${c.text.slice(0, 120)}"`;
  const replaced = inv.instruction.replace(/\b(this|that|it)\b(?!\s+(?:is|was|week|month|morning|afternoon|evening|year)\b)/i, label);
  return (replaced === inv.instruction ? `${inv.instruction}: ${label}` : replaced).slice(0, 4000);
}

/** The words the existing machinery is given: what was asked, then what was shared, labelled as such. */
function requestText(inv: any): string {
  const shared = describeContext(inv.context);
  return `${inv.instruction || "Keep this"}\n\n(Shared from ${inv.surface.adapter === "ios-share" ? "iOS" : inv.surface.adapter}: ${shared})`.slice(0, 4000);
}

/** Process one invocation (the `invocation.process` job, as the person who submitted it). */
export const process = app.action({
  access: "invocations.process",
  args: { invocationId: s.string() },
  handler: async (ctx, { invocationId }) => {
    const inv = (await ctx.runQuery(api.invocationstate.forProcess, { invocationId })) as any;
    if (!inv || INVOCATION_TERMINAL.has(inv.state) || inv.state === "needs_approval" || inv.work?.researchRunId || inv.work?.replyId) return { state: inv?.state ?? null };
    const owner = inv.owner as string;

    // 1. What was asked: recorded once (a retried job reuses it, and asks no model twice).
    let interpretation = inv.interpretation;
    if (!interpretation) {
      const rules = intentByRules(inv.instruction);
      interpretation = rules ? { ...rules, basis: "rules" } : await byModel(ctx, inv);
      await ctx.runMutation(api.invocationstate.begin, { invocationId, interpretation });
    }
    const intent = interpretation.intent as "research" | "assistant" | "save";
    const text = requestText(inv);
    const clock = clockFor(inv.timeZone);
    const understood = intent === "assistant" ? interpret(assistantText(inv), clock.today).intent : null;
    const capability = intent === "research" ? RESEARCH_CAPABILITY : intent === "save" ? "personalos.memory.write" : capabilityFor(understood!.kind, { reminder: understood!.kind === "task.create" ? understood!.reminder : false });

    // 2. Whether PersonalOS may do it for this person: asked now, at execution, from their delegation.
    const decision = await ctx.authority.decide({ capability, onBehalfOf: authorityPrincipal(owner), context: { surface: inv.surface.adapter, invocation: invocationId.slice(0, 100) } });
    const authority = {
      capability, outcome: decision.outcome, principal: decision.executor, at: Date.now(),
      ...(decision.onBehalfOf ? { onBehalfOf: decision.onBehalfOf } : {}),
      ...(decision.delegationId ? { delegationId: decision.delegationId } : {}),
      ...(decision.decisionId ? { decisionId: decision.decisionId } : {}),
      ...(decision.reason ? { reason: String(decision.reason).slice(0, 500) } : {}),
    };
    if (decision.outcome === "unavailable" || decision.outcome === "invalid") {
      const { gaveUp } = (await ctx.runMutation(api.invocationstate.authorityUnavailable, { invocationId, reason: String(decision.reason ?? decision.outcome).slice(0, 500), max: AUTHORITY_TRIES })) as { gaveUp: boolean };
      if (gaveUp) return { state: "failed" };
      throw new FeltKitError("UNAVAILABLE", "The authority could not decide; the job will try again.");
    }
    if (!decision.allowed) {
      await ctx.runMutation(api.invocationstate.settle, { invocationId, state: "failed", authority, text: `You haven't allowed PersonalOS to do this for you (${capability}${decision.reason ? `: ${decision.reason}` : ""}). Nothing was done.`, error: { code: "FORBIDDEN", message: `${capability} was not allowed${decision.reason ? `: ${decision.reason}` : ""}` } });
      return { state: "failed" };
    }

    // 3. The work, done by what already does it.
    if (intent === "research") {
      const seed = inv.sourceUrl ? { seedUrl: inv.sourceUrl, ...(inv.context.find((c: any) => c.url === inv.sourceUrl && c.title)?.title ? { seedTitle: inv.context.find((c: any) => c.url === inv.sourceUrl).title } : {}) } : {};
      const shared = inv.context.filter((c: any) => c.kind !== "url" && c.text).map((c: any) => c.text).join("\n\n").slice(0, 20_000);
      const model = await modelUsable(ctx);
      const product = subjectOf(inv.instruction) ?? "";
      if (!model && !product) {
        await ctx.runMutation(api.invocationstate.settle, { invocationId, state: "failed", authority, text: "I couldn't work out what to research this for without a model. Say who it's for (for example: \"could this be a customer for FeltKit?\"), or turn the model on in Settings, and share it again.", error: { code: "NOT_UNDERSTOOD", message: "research needs a subject or a model" } });
        return { state: "failed" };
      }
      const discovery = await discover(ctx.agent, PROSPECT_NEEDS, { declared: declaredCapabilities() });
      const r = (await ctx.runMutation(api.researchstate.create, {
        text, product, objective: inv.instruction || "Research what was shared.", discovery: discovery as unknown as Record<string, unknown>,
        planning: model ? "model" : "rules", conversationId: inv.conversationId,
        fromInvocation: { invocationId, ...seed, ...(shared ? { sharedText: shared } : {}), adapter: inv.surface.adapter },
      })) as { runId: string; status: string; reply: string };
      const blocked = r.status === "blocked";
      await ctx.runMutation(api.invocationstate.settle, {
        invocationId, state: blocked ? "failed" : "processing", authority, work: { researchRunId: r.runId },
        text: blocked ? `Research can't run yet: ${r.reply.split("\n")[0]}` : "Researching it now. The plan is in the conversation; the result will be too.",
        ...(blocked ? { error: { code: "BLOCKED", message: r.reply.slice(0, 1000) } } : {}),
      });
      return { state: blocked ? "failed" : "processing", researchRunId: r.runId };
    }
    if (intent === "save") {
      const r = (await ctx.runMutation(api.invocationstate.save, { invocationId })) as { text: string; replyId: string };
      await ctx.runMutation(api.invocationstate.settle, { invocationId, state: "completed", authority, text: r.text, work: { replyId: r.replyId } });
      return { state: "completed" };
    }
    const sent = await ctx.runMutation(api.assistant.send, { conversationId: inv.conversationId, text: assistantText(inv), today: clock.today, tzOffset: clock.tzOffset });
    const outcome = (await ctx.runQuery(api.invocationstate.replyOf, { conversationId: inv.conversationId, replyId: sent.replyId })) as { text: string; pending: string[] };
    await ctx.runMutation(api.invocationstate.settle, {
      invocationId, state: outcome.pending.length ? "needs_approval" : "completed", authority,
      text: outcome.pending.length ? `${outcome.text.slice(0, 1500)}\n\nIt needs your approval in PersonalOS.` : outcome.text.slice(0, 2000),
      work: { replyId: sent.replyId, ...(outcome.pending.length ? { actionIds: outcome.pending } : {}) },
    });
    return { state: outcome.pending.length ? "needs_approval" : "completed" };
  },
});

/** When the rules can't tell: a model proposes one of three intents, recorded with its generation. Else the assistant. */
async function byModel(ctx: ActionCtx, inv: any) {
  if (await modelUsable(ctx)) {
    try {
      const { taskId } = await ctx.agent.openTask({ key: `invocation:${inv.id}`, objective: (inv.instruction || "shared item").slice(0, 500) });
      const prompt = intentPrompt(inv.instruction, inv.context);
      const g = await ctx.model.generate({ taskId, messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }], maxTokens: 120, temperature: 0 });
      const accepted = acceptIntent(jsonOf(g.text));
      if (accepted) return { ...accepted, basis: "model", generation: { generationId: g.generationId, memoryId: g.memoryId, model: `${g.receipt.provider}/${g.receipt.model}` } };
    } catch { /* the rules' default below, and the record says so */ }
  }
  return { intent: "assistant", basis: "rules", detail: "the assistant handles it (no rule or model decided otherwise)" };
}

void ownInvocation;
