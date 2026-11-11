import { fail, s } from "@feltdb/feltkit";
import { actions, app } from "./app.js";
import * as ops from "./_ops.js";
import { appendMessage } from "./assistant.js";

export const list = app.query({
  access: "actions.read",
  args: { status: s.optional(s.enum(["proposed", "succeeded", "failed", "rejected"] as const)), limit: s.optional(s.number()) },
  returns: s.array(s.doc(actions)),
  capability: { name: "actions.list", description: "The action log: what the assistant did or proposed, with outcome and evidence." },
  handler: (ctx, { status, limit }) => ctx.db.find(actions, { owner: ops.me(ctx), ...(status ? { status } : {}) }, { orderBy: [{ field: "seq", direction: "desc" }], limit: Math.min(limit ?? 200, 500) }),
});

/** Only a person approves: agents, services and API keys holding the permission can only propose this. */
export const approve = app.mutation({
  access: "actions.decide",
  approval: "required",
  args: { id: s.string() },
  returns: s.doc(actions),
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { id }) => {
    const proposal = await ops.own<any>(ctx, actions, id, "action");
    if (proposal.status !== "proposed") fail("FAILED_PRECONDITION", `This action is already ${proposal.status}.`);
    const meta = { via: proposal.via, ...(proposal.conversationId ? { conversationId: proposal.conversationId } : {}), ...(proposal.messageId ? { messageId: proposal.messageId } : {}), proposalId: id } as ops.Meta;
    try {
      const result = await ops.execute(ctx, proposal.kind, proposal.input, meta);
      await ctx.db.patch(actions, id, { status: "succeeded", decidedAt: Date.now(), ...(result.evidence ? { evidence: result.evidence } : {}) });
      if (proposal.conversationId) await appendMessage(ctx, proposal.conversationId, { role: "assistant", text: `Approved and done: ${result.summary}.`, actionIds: [id] });
    } catch (error) {
      // A proposal whose target vanished is recorded as failed, visibly, rather than retried or hidden.
      const e = error as { code?: string; message?: string };
      if (e.code !== "NOT_FOUND") throw error;
      await ctx.db.patch(actions, id, { status: "failed", decidedAt: Date.now(), error: { code: e.code, message: e.message ?? "Not found" } });
    }
    return (await ctx.db.get(actions, id))!;
  },
});

export const reject = app.mutation({
  access: "actions.decide",
  args: { id: s.string() },
  returns: s.doc(actions),
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { id }) => {
    const proposal = await ops.own<any>(ctx, actions, id, "action");
    if (proposal.status !== "proposed") fail("FAILED_PRECONDITION", `This action is already ${proposal.status}.`);
    await ctx.db.patch(actions, id, { status: "rejected", decidedAt: Date.now() });
    if (proposal.conversationId) await appendMessage(ctx, proposal.conversationId, { role: "assistant", text: `Okay, not doing it: ${proposal.summary.replace(/^\w/, (c: string) => c.toLowerCase())}. Nothing changed.`, actionIds: [id] });
    return (await ctx.db.get(actions, id))!;
  },
});
