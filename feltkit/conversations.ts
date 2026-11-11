import { s } from "@feltdb/feltkit";
import { app, conversations, messages } from "./app.js";
import { me, own } from "./_ops.js";

export const list = app.query({
  access: "conversations.read",
  returns: s.array(s.doc(conversations)),
  capability: { name: "conversations.list", description: "Your conversations, most recent first." },
  handler: (ctx) => ctx.db.find(conversations, { owner: me(ctx) }, { orderBy: [{ field: "updatedAt", direction: "desc" }] }),
});

export const messagesOf = app.query({
  access: "conversations.read",
  args: { conversationId: s.string() },
  returns: s.array(s.doc(messages)),
  capability: { name: "conversations.messages", description: "The messages of one conversation, in order." },
  handler: async (ctx, { conversationId }) => {
    await own(ctx, conversations, conversationId, "conversation");
    return ctx.db.find(messages, { conversationId }, { orderBy: [{ field: "seq", direction: "asc" }] });
  },
});

export const rename = app.mutation({
  access: "conversations.write",
  args: { id: s.string(), title: s.string({ minLength: 1, maxLength: 120 }) },
  handler: async (ctx, { id, title }) => {
    await own(ctx, conversations, id, "conversation");
    await ctx.db.patch(conversations, id, { title: title.trim(), updatedAt: Date.now() });
  },
});

/** Delete a conversation and its messages. Tasks, memories and the action log it produced are kept. */
export const remove = app.mutation({
  access: "conversations.write",
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    await own(ctx, conversations, id, "conversation");
    for (const m of await ctx.db.find(messages, { conversationId: id })) await ctx.db.delete(messages, m.id);
    await ctx.db.delete(conversations, id);
  },
});
