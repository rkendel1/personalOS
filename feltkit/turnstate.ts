/** A model turn's durable state: the user's message, the context the model reads, and the reply (see turn.ts). */
import { s } from "@feltdb/feltkit";
import { app, conversations, memories, messages, settings, tasks } from "./app.js";
import { appendMessage } from "./assistant.js";
import { relevance } from "./_interpret.js";
import * as ops from "./_ops.js";

/** Record the user's message (once per client id) in a conversation, creating the conversation if needed. */
export const recordUser = app.mutation({
  access: "assistant.send",
  args: { conversationId: s.optional(s.string()), clientId: s.string({ minLength: 8, maxLength: 100 }), text: s.string({ minLength: 1, maxLength: 4000 }) },
  returns: s.object({ conversationId: s.string(), messageId: s.string(), replyId: s.nullable(s.string()) }),
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { conversationId, clientId, text }) => {
    const owner = ops.me(ctx);
    const existing = (await ctx.db.find(messages, { owner, clientId }))[0];
    if (existing) {
      const reply = (await ctx.db.find(messages, { conversationId: existing.conversationId })).find((m) => m.agent?.replyTo === existing.id);
      return { conversationId: existing.conversationId, messageId: existing.id, replyId: reply?.id ?? null };
    }
    let id = conversationId;
    if (id) await ops.own(ctx, conversations, id, "conversation");
    else id = await ctx.db.insert(conversations, { owner, title: text.length > 60 ? `${text.slice(0, 57)}…` : text, createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 });
    const messageId = await appendMessage(ctx, id, { role: "user", text, interpretation: { intent: "conversation", source: "model" } });
    await ctx.db.patch(messages, messageId, { clientId });
    return { conversationId: id, messageId, replyId: null };
  },
});

const Proposal = s.object({ taskId: s.string(), actionId: s.string(), capability: s.string(), effect: s.string(), state: s.string(), input: s.record(s.unknown()) });

/** Record a model turn's reply, once per user message. */
export const recordReply = app.mutation({
  access: "assistant.send",
  args: { conversationId: s.string(), replyTo: s.string(), text: s.string({ maxLength: 8000 }), taskId: s.string(), model: s.string(), reference: s.optional(s.string()), generations: s.array(s.string()), proposals: s.array(Proposal), cancelled: s.optional(s.boolean()) },
  returns: s.string(),
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, args) => {
    await ops.own(ctx, conversations, args.conversationId, "conversation");
    const prior = (await ctx.db.find(messages, { conversationId: args.conversationId })).find((m) => m.agent?.replyTo === args.replyTo);
    if (prior) return prior.id;
    const id = await appendMessage(ctx, args.conversationId, { role: "assistant", text: args.text || (args.proposals.length ? "" : "…"), interpretation: { intent: "conversation", source: "model", agentTaskId: args.taskId } });
    await ctx.db.patch(messages, id, { agent: { taskId: args.taskId, replyTo: args.replyTo, model: args.model, ...(args.reference ? { reference: args.reference } : {}), generations: args.generations, proposals: args.proposals, ...(args.cancelled ? { cancelled: true } : {}) } });
    return id;
  },
});

/** What the model is told about the user: recent conversation, open work, confirmed memories. Read as the caller. */
export const context = app.query({
  access: "assistant.send",
  args: { conversationId: s.string(), before: s.string(), query: s.string() },
  handler: async (ctx, { conversationId, before, query }) => {
    const owner = ops.me(ctx);
    await ops.own(ctx, conversations, conversationId, "conversation");
    const all = await ctx.db.find(messages, { conversationId }, { orderBy: [{ field: "seq", direction: "asc" }] });
    const cut = all.findIndex((m) => m.id === before);
    const history = (cut >= 0 ? all.slice(0, cut) : all).filter((m) => !m.supersededBy && m.text).slice(-16).map((m) => ({ role: m.role, text: m.text }));
    const open = (await ctx.db.find(tasks, { owner, status: "open" })).sort((a, b) => (a.due ?? "9999").localeCompare(b.due ?? "9999") || (a.priority === "high" ? -1 : 0) - (b.priority === "high" ? -1 : 0));
    const mems = await ctx.db.find(memories, { owner });
    const ranked = mems.map((m) => ({ m, score: relevance(query, `${m.subject} ${m.content}`) })).sort((a, b) => b.score - a.score || b.m.updatedAt - a.m.updatedAt);
    const name = (await ctx.db.find(settings, { owner }))[0]?.name ?? null;
    return {
      name,
      history,
      tasks: open.slice(0, 25).map((t) => ({ id: t.id, title: t.title, due: t.due ?? null, time: t.remindTime ?? null, priority: t.priority, recurrence: t.recurrence })),
      openTaskCount: open.length,
      memories: ranked.slice(0, 25).map(({ m }) => ({ content: m.content, kind: m.kind, status: m.status, ...(m.date ? { date: m.date } : {}) })),
    };
  },
});
