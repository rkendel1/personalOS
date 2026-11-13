/**
 * The durable record behind `personalos.invocation/1` (feltkit/invocations.ts): receipts, what the
 * person sees as the work moves, and the hand-off to the work itself. Separate from invocations.ts so
 * its action can name these through the generated API.
 */
import { fail, s, type MutationCtx } from "@feltdb/feltkit";
import { actions, app, invocations, messages } from "./app.js";
import { describeContext, INVOCATION_CONTRACT, INVOCATION_TERMINAL, type InvocationState } from "./_invocation.js";
import { appendMessage } from "./assistant.js";
import * as ops from "./_ops.js";

/** What a surface gets back: enough to confirm, follow and open the result. Never another person's data. */
export const Receipt = s.object({
  contract: s.string(),
  invocationId: s.string(),
  state: s.string(),
  replayed: s.boolean(),
  receivedAt: s.number(),
  conversationId: s.string(),
  /** Where to look in PersonalOS: a path below the app's address (#/chat/<id>, #/research). */
  open: s.string(),
  message: s.string(),
  updates: s.array(s.object({ seq: s.number(), state: s.string(), text: s.string(), at: s.number() })),
  error: s.optional(s.object({ code: s.string(), message: s.string() })),
});

export function receiptOf(inv: any, replayed: boolean) {
  const last = inv.updates.at(-1);
  return {
    contract: INVOCATION_CONTRACT,
    invocationId: inv.invocationId,
    state: inv.state,
    replayed,
    receivedAt: inv.receivedAt,
    conversationId: inv.conversationId,
    open: inv.work?.researchRunId ? `#/research` : `#/chat/${inv.conversationId}`,
    message: last?.text ?? "",
    updates: inv.updates.map((u: any) => ({ seq: u.seq, state: u.state, text: u.text, at: u.at })),
    ...(inv.error ? { error: inv.error } : {}),
  };
}

/** The caller's invocation by its id, or null: another person's does not exist for them. */
export async function ownInvocation(ctx: { db: { find(c: any, f: any): Promise<any[]> }; auth: any }, invocationId: string) {
  return (await ctx.db.find(invocations, { owner: ops.me(ctx as any), invocationId }))[0] ?? null;
}

/**
 * Move an invocation to a state, with the line the person sees. A terminal invocation does not move
 * again. A notification goes to the person's inbox when the outcome is theirs to look at.
 */
export async function moveInvocation(ctx: MutationCtx, inv: any, state: InvocationState, text: string, patch: Record<string, unknown> = {}) {
  if (INVOCATION_TERMINAL.has(inv.state)) return false;
  const now = Date.now();
  const seq = (inv.updates.at(-1)?.seq ?? 0) + 1;
  const same = inv.updates.at(-1)?.state === state && inv.updates.at(-1)?.text === text;
  await ctx.db.patch(invocations, inv.id, { ...patch, state, updatedAt: now, ...(same ? {} : { updates: [...inv.updates, { seq, state, text: text.slice(0, 2000), at: now }] }) });
  if (!same && (state === "completed" || state === "failed" || state === "needs_approval")) {
    ctx.afterCommit.notifications.send({
      recipient: inv.owner,
      type: "invocation.updated",
      title: state === "completed" ? "Shared item: done" : state === "needs_approval" ? "Shared item: needs your approval" : "Shared item: couldn't finish",
      body: text.slice(0, 500),
      data: { invocationId: inv.invocationId, conversationId: inv.conversationId, state },
      idempotencyKey: `invocation:${inv.id}:${seq}`,
    });
  }
  return true;
}

/**
 * Called by research when a run an invocation started ends, stops or is resumed: the invocation follows
 * the run. Runs as the run's owner (the step's job, or the person).
 */
export async function followResearch(ctx: MutationCtx, run: { invocationId?: string; owner: string; product: string }, status: string, summary: string) {
  if (!run.invocationId) return;
  const inv = (await ctx.db.find(invocations, { owner: run.owner, invocationId: run.invocationId }))[0];
  if (!inv) return;
  if (status === "running") {
    if (inv.state !== "processing") await ctx.db.patch(invocations, inv.id, { state: "processing", updatedAt: Date.now(), updates: [...inv.updates, { seq: (inv.updates.at(-1)?.seq ?? 0) + 1, state: "processing", text: summary.slice(0, 2000), at: Date.now() }] });
    return;
  }
  const state: InvocationState = status === "completed" || status === "partial" ? "completed" : "failed";
  // A run that was stopped or blocked can be retried, so the invocation is not final until the run is.
  if (state === "failed" && (status === "blocked" || status === "cancelled")) {
    await ctx.db.patch(invocations, inv.id, { state: "failed", updatedAt: Date.now(), error: { code: status === "blocked" ? "BLOCKED" : "CANCELLED", message: summary.slice(0, 1000) }, updates: [...inv.updates, { seq: (inv.updates.at(-1)?.seq ?? 0) + 1, state: "failed", text: summary.slice(0, 2000), at: Date.now() }] });
    ctx.afterCommit.notifications.send({ recipient: inv.owner, type: "invocation.updated", title: "Shared item: couldn't finish", body: summary.slice(0, 500), data: { invocationId: inv.invocationId, conversationId: inv.conversationId, state: "failed" }, idempotencyKey: `invocation:${inv.id}:${status}:${inv.updates.length}` });
    return;
  }
  await moveInvocation(ctx, inv, state, summary, state === "failed" ? { error: { code: "FAILED", message: summary.slice(0, 1000) } } : {});
}

/** One invocation with its record (what was asked, shared, inferred, decided and done), for the surface or the app. */
export const get = app.query({
  access: "invocations.read",
  args: { invocationId: s.string({ maxLength: 100 }) },
  handler: async (ctx, { invocationId }) => {
    const inv = await ownInvocation(ctx, invocationId);
    if (!inv) fail("NOT_FOUND", `No invocation ${invocationId}.`);
    return { receipt: receiptOf(inv, false), invocation: inv };
  },
});

/** The caller's recent invocations, newest first: what the surface's own screen lists. */
export const list = app.query({
  access: "invocations.read",
  args: { limit: s.optional(s.integer({ minimum: 1, maximum: 50 })) },
  handler: async (ctx, { limit }) =>
    (await ctx.db.find(invocations, { owner: ops.me(ctx) }, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: limit ?? 20 })).map((inv: any) => ({
      ...receiptOf(inv, false),
      adapter: inv.surface.adapter,
      instruction: inv.instruction,
      shared: inv.context.map((c: any) => ({ kind: c.kind, url: c.url ?? null, title: c.title ?? c.name ?? null })),
      createdAt: inv.createdAt,
    })),
});

/** What processing needs: the invocation, if it is still the caller's to process. */
export const forProcess = app.query({
  access: "invocations.process",
  args: { invocationId: s.string() },
  handler: async (ctx, { invocationId }) => ownInvocation(ctx, invocationId),
});

/** Processing began (once): the person sees it is being worked on. */
export const begin = app.mutation({
  access: "invocations.process",
  args: { invocationId: s.string(), interpretation: s.record(s.unknown()) },
  handler: async (ctx, { invocationId, interpretation }) => {
    const inv = await ownInvocation(ctx, invocationId);
    if (!inv || inv.state !== "accepted") return { began: false };
    await moveInvocation(ctx, inv, "processing", `Working on it: ${String(interpretation.detail)}`, { interpretation });
    return { began: true };
  },
});

/**
 * The authority could not be asked (AuthBoundry unreachable or unverifiable). Counted; after `max`
 * tries the invocation fails and says so, else the job tries again.
 */
export const authorityUnavailable = app.mutation({
  access: "invocations.process",
  args: { invocationId: s.string(), reason: s.string({ maxLength: 500 }), max: s.integer({ minimum: 1, maximum: 20 }) },
  returns: s.object({ gaveUp: s.boolean() }),
  handler: async (ctx, { invocationId, reason, max }) => {
    const inv = await ownInvocation(ctx, invocationId);
    if (!inv) return { gaveUp: true };
    const attempts = (inv.attempts ?? 0) + 1;
    if (attempts >= max) {
      await moveInvocation(ctx, inv, "failed", `I couldn't confirm I'm allowed to do this for you (${reason}). Nothing was done; share it again to retry.`, { attempts, error: { code: "UNAVAILABLE", message: reason } });
      return { gaveUp: true };
    }
    await ctx.db.patch(invocations, inv.id, { attempts, updatedAt: Date.now() });
    return { gaveUp: false };
  },
});

/** "Keep this": saved as a note in the person's memory, and said so in the conversation. */
export const save = app.mutation({
  access: "invocations.process",
  args: { invocationId: s.string() },
  returns: s.object({ text: s.string(), replyId: s.string() }),
  handler: async (ctx, { invocationId }) => {
    const inv = await ownInvocation(ctx, invocationId);
    if (!inv) fail("NOT_FOUND", `No invocation ${invocationId}.`);
    const c = inv.context[0]!;
    const what = c.kind === "url" ? `${c.title ? `${c.title}: ` : ""}${c.url}` : c.kind === "document" ? `${c.name ?? "a document"}: ${c.text!.slice(0, 300)}` : `${c.text!.slice(0, 400)}${c.url ? ` (from ${c.url})` : ""}`;
    const content = `Saved from ${inv.surface.adapter === "ios-share" ? "iOS" : inv.surface.adapter}: ${what}`.slice(0, 1000);
    const meta = { via: "job" as const, conversationId: inv.conversationId };
    const messageId = await appendMessage(ctx, inv.conversationId, { role: "user", text: `${inv.instruction || "Keep this"}\n\n${describeContext(inv.context)}`.slice(0, 4000) });
    await ops.remember(ctx, { kind: "fact", subject: (c.title ?? c.name ?? "shared").slice(0, 100), content, status: "confirmed" }, { ...meta, messageId });
    const text = `Saved it to your notes: ${what.slice(0, 300)}. Ask me about it any time.`;
    const replyId = await appendMessage(ctx, inv.conversationId, { role: "assistant", text });
    return { text, replyId };
  },
});

/** The assistant's reply to an invocation, and the actions in that conversation still waiting for the person. */
export const replyOf = app.query({
  access: "invocations.process",
  args: { conversationId: s.string(), replyId: s.string() },
  handler: async (ctx, { conversationId, replyId }) => {
    const owner = ops.me(ctx);
    const reply = await ctx.db.get(messages, replyId);
    if (!reply || reply.owner !== owner || reply.conversationId !== conversationId) fail("NOT_FOUND", "No reply.");
    const pending = (await ctx.db.find(actions, { owner, conversationId })).filter((a: any) => a.status === "proposed").map((a: any) => a.id);
    return { text: reply.text, pending };
  },
});

/** The work was refused, failed, finished, or handed over (to research, or the assistant's reply). */
export const settle = app.mutation({
  access: "invocations.process",
  args: {
    invocationId: s.string(),
    state: s.enum(["processing", "needs_approval", "completed", "failed"] as const),
    text: s.string({ maxLength: 2000 }),
    authority: s.optional(s.record(s.unknown())),
    work: s.optional(s.object({ researchRunId: s.optional(s.string()), replyId: s.optional(s.string()), actionIds: s.optional(s.array(s.string())) })),
    error: s.optional(s.object({ code: s.string(), message: s.string({ maxLength: 1000 }) })),
  },
  handler: async (ctx, a) => {
    const inv = await ownInvocation(ctx, a.invocationId);
    if (!inv) fail("NOT_FOUND", `No invocation ${a.invocationId}.`);
    const moved = await moveInvocation(ctx, inv, a.state, a.text, { ...(a.authority ? { authority: a.authority } : {}), ...(a.work ? { work: { ...(inv.work ?? {}), ...a.work } } : {}), ...(a.error ? { error: a.error } : {}) });
    return { moved };
  },
});
