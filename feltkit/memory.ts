import { s } from "@feltdb/feltkit";
import { app, memories, MEMORY_KINDS } from "./app.js";
import * as ops from "./_ops.js";

const ui = { via: "ui" as const };

export const list = app.query({
  access: "memory.read",
  returns: s.array(s.doc(memories)),
  capability: { name: "memory.list", description: "Everything the assistant remembers, with status (confirmed or inferred) and provenance." },
  handler: (ctx) => ctx.db.find(memories, { owner: ops.me(ctx) }, { orderBy: [{ field: "updatedAt", direction: "desc" }] }),
});

export const add = app.mutation({
  access: "memory.write",
  args: { kind: s.enum(MEMORY_KINDS), subject: s.string({ maxLength: 200 }), content: s.string({ minLength: 1, maxLength: 2000 }), date: s.optional(s.string()) },
  returns: s.doc(memories),
  capability: { name: "memory.add", description: "Record something the user states (stored as confirmed)." },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, args) => (await ops.remember(ctx, { ...args, status: "confirmed" }, ui)).memory,
});

export const confirm = app.mutation({
  access: "memory.write",
  args: { id: s.string() },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { id }) => {
    await ops.confirmMemory(ctx, id, ui);
  },
});

export const update = app.mutation({
  access: "memory.write",
  args: { id: s.string(), content: s.optional(s.string({ minLength: 1, maxLength: 2000 })), kind: s.optional(s.enum(MEMORY_KINDS)), subject: s.optional(s.string({ maxLength: 200 })), date: s.optional(s.nullable(s.string())) },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { id, ...change }) => {
    await ops.updateMemory(ctx, id, change as any, ui);
  },
});

export const remove = app.mutation({
  access: "memory.write",
  args: { id: s.string() },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { id }) => {
    await ops.forgetMemory(ctx, id, ui);
  },
});
