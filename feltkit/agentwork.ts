/**
 * Work a person hands to their agent from a Anywhere Aide conversation, and what they do with it after.
 *
 *   start    one piece of work per message: by Anywhere Aide's routing rules (feltkit/_route.ts, from the turn)
 *            or by the person's "Work on this". Recorded here first; the `anywhere` agent submits it to the
 *            connected agent and follows it (feltkit/anywhere.ts), so it continues after the person leaves.
 *   answer   the person answers what the agent asks; delivered to the same work, which resumes where it asked.
 *   cancel   the person stops it; delivered to the agent, which stops once nothing it started is uncertain.
 *
 * Delegation is not authorization: the agent acts only under the person's own grants to it, decided by
 * AuthBoundry at every call on Anywhere Aide's delegated /appport. Without a connected agent nothing is sent:
 * the request stays in the conversation, marked so, and Anywhere Aide works as before.
 */
import { fail, s, type MutationCtx } from "@feltdb/feltkit";
import { agentwork, app, messages } from "./app.js";
import { agentConnected, handOff } from "./anywhere.js";
import { appendMessage } from "./assistant.js";
import * as ops from "./_ops.js";

const FINISHED = new Set(["completed", "cancelled", "refused", "expired"]);
const MAX_ANSWER = 2000;

/** Hand the person's message to their agent: once per message. Used by the turn and by "Work on this". */
export async function startWork(ctx: MutationCtx, messageId: string, routedBy: "explicit" | "rules", reason: string) {
  const owner = ops.me(ctx);
  const message = await ops.own<{ owner: string; conversationId: string; role: string; text: string }>(ctx, messages, messageId, "message");
  if (message.role !== "user") fail("INVALID_ARGUMENT", "Only your own request can be handed to your agent.");
  const existing = (await ctx.db.find(agentwork, { owner, messageId }))[0];
  const connected = agentConnected();
  if (existing && !(existing.agent.state === "unavailable" && connected)) return { work: existing, started: false };

  const now = Date.now();
  const agent = connected
    ? { key: `chat:${messageId}`, state: "submitting" as const, objective: message.text.slice(0, 4000), surface: { surface: "personalos", conversationId: message.conversationId, messageId }, attempts: 0 }
    : { key: `chat:${messageId}`, state: "unavailable" as const, objective: message.text.slice(0, 4000), surface: { surface: "personalos", conversationId: message.conversationId, messageId }, attempts: 0 };
  let id = existing?.id;
  if (id) await ctx.db.patch(agentwork, id, { agent: agent as any, routedBy, reason: reason.slice(0, 300), updatedAt: now });
  else id = await ctx.db.insert(agentwork, { owner, conversationId: message.conversationId, messageId, routedBy, reason: reason.slice(0, 300), agent: agent as any, createdAt: now, updatedAt: now });

  if (!connected) {
    await appendMessage(ctx, message.conversationId, {
      role: "assistant",
      text: "No agent is connected to this Anywhere Aide, so nothing was started. Your request is kept here; choose Work on this once one is connected.",
    });
  } else {
    await appendMessage(ctx, message.conversationId, {
      role: "assistant",
      text: `Handed to your agent (${reason}). It keeps working if you close Anywhere Aide; its progress, any questions for you, and what it did will appear here.`,
    });
    handOff(ctx, "work", id);
  }
  return { work: (await ctx.db.get(agentwork, id))!, started: connected };
}

const Work = s.doc(agentwork);

/** The turn's handover (feltkit/turn.ts): the routing rules sent this message to the agent. */
export const handOver = app.mutation({
  access: "agentwork.write",
  args: { messageId: s.string({ maxLength: 100 }), reason: s.string({ maxLength: 300 }) },
  returns: s.object({ workId: s.string(), replyId: s.optional(s.string()) }),
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { messageId, reason }) => {
    const { work } = await startWork(ctx, messageId, "rules", reason);
    const reply = (await ctx.db.find(messages, { conversationId: work.conversationId }, { orderBy: [{ field: "seq", direction: "desc" }], limit: 1 }))[0];
    return { workId: work.id, ...(reply && reply.role === "assistant" ? { replyId: reply.id } : {}) };
  },
});

/** "Work on this": the person hands one of their own messages to their agent. */
export const start = app.mutation({
  access: "agentwork.write",
  args: { messageId: s.string({ maxLength: 100 }) },
  returns: s.object({ work: Work, started: s.boolean() }),
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { messageId }) => startWork(ctx, messageId, "explicit", "you chose Work on this"),
});

/** The person answers a question their agent asks: recorded here, delivered by the follow job. */
export const answer = app.mutation({
  access: "agentwork.write",
  args: { id: s.string({ maxLength: 100 }), interactionId: s.string({ maxLength: 200 }), optionId: s.optional(s.string({ maxLength: 200 })), text: s.optional(s.string({ maxLength: MAX_ANSWER })) },
  returns: Work,
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { id, interactionId, optionId, text }) => {
    const work = await ops.own<any>(ctx, agentwork, id, "agent work");
    const agent = work.agent;
    if (FINISHED.has(agent.state)) fail("FAILED_PRECONDITION", `This work is ${agent.state}; there is nothing to answer.`);
    const question = (agent.questions ?? []).find((q: any) => q.interactionId === interactionId);
    if (!question) fail("NOT_FOUND", "Your agent is not asking that.");
    if ((agent.answers ?? []).some((a: any) => a.interactionId === interactionId)) fail("FAILED_PRECONDITION", "You already answered that.");
    if (optionId === undefined && !text?.trim()) fail("INVALID_ARGUMENT", "Choose an option or write an answer.");
    if (optionId !== undefined && !question.options.some((o: any) => o.id === optionId)) fail("INVALID_ARGUMENT", "That is not one of the choices.");
    if (optionId === undefined && !question.allowFreeform) fail("INVALID_ARGUMENT", "Choose one of the options.");
    const label = optionId === undefined ? text!.trim() : question.options.find((o: any) => o.id === optionId)!.label;
    const now = Date.now();
    const answers = [...(agent.answers ?? []), { interactionId, ...(optionId !== undefined ? { optionId } : {}), ...(optionId === undefined ? { text: text!.trim() } : {}), at: now }];
    await ctx.db.patch(agentwork, id, { agent: { ...agent, answers }, updatedAt: now });
    await appendMessage(ctx, work.conversationId, { role: "user", text: `${question.prompt}\n→ ${label}`.slice(0, 4000) });
    handOff(ctx, "work", id);
    return (await ctx.db.get(agentwork, id))!;
  },
});

/** The person stops the work: recorded here, delivered to the agent by the follow job. */
export const cancel = app.mutation({
  access: "agentwork.write",
  args: { id: s.string({ maxLength: 100 }) },
  returns: Work,
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { id }) => {
    const work = await ops.own<any>(ctx, agentwork, id, "agent work");
    const agent = work.agent;
    if (FINISHED.has(agent.state)) fail("FAILED_PRECONDITION", `This work is already ${agent.state}.`);
    const now = Date.now();
    if (agent.state === "unavailable") {
      await ctx.db.patch(agentwork, id, { agent: { ...agent, state: "cancelled" }, updatedAt: now });
      return (await ctx.db.get(agentwork, id))!;
    }
    if (!agent.cancel) {
      await ctx.db.patch(agentwork, id, { agent: { ...agent, state: "cancelling", cancel: { requestedAt: now } }, updatedAt: now });
      await appendMessage(ctx, work.conversationId, { role: "assistant", text: "Stopping your agent's work. Anything it already did stays recorded below." });
      handOff(ctx, "work", id);
    }
    return (await ctx.db.get(agentwork, id))!;
  },
});

/** The person's agent work, newest first; in one conversation when given. */
export const list = app.query({
  access: "agentwork.read",
  args: { conversationId: s.optional(s.string({ maxLength: 100 })) },
  returns: s.array(Work),
  handler: async (ctx, { conversationId }) => {
    const owner = ops.me(ctx);
    const all = await ctx.db.find(agentwork, { owner, ...(conversationId ? { conversationId } : {}) });
    return all.sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
  },
});
