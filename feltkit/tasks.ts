import { s } from "@feltdb/feltkit";
import { app, RECURRENCE, tasks } from "./app.js";
import * as ops from "./_ops.js";

const ui = { via: "ui" as const };
const When = { due: s.optional(s.string()), time: s.optional(s.string()), tzOffset: s.optional(s.number()), reminder: s.optional(s.boolean()) };

export const list = app.query({
  access: "tasks.read",
  args: { status: s.optional(s.enum(["open", "done"] as const)) },
  returns: s.array(s.doc(tasks)),
  capability: { name: "tasks.list", description: "Your tasks (open or done), newest first." },
  handler: (ctx, { status }) => ctx.db.find(tasks, { owner: ops.me(ctx), ...(status ? { status } : {}) }, { orderBy: [{ field: "createdAt", direction: "desc" }] }),
});

export const create = app.mutation({
  access: "tasks.write",
  args: { title: s.string({ minLength: 1, maxLength: 200 }), notes: s.optional(s.string({ maxLength: 4000 })), priority: s.optional(s.enum(["low", "normal", "high"] as const)), recurrence: s.optional(s.enum(RECURRENCE)), projectId: s.optional(s.string()), ...When },
  returns: s.doc(tasks),
  capability: { name: "tasks.create", description: "Create a task, optionally with a due date and a reminder." },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, args) => (await ops.createTask(ctx, args, ui)).task,
});

export const update = app.mutation({
  access: "tasks.write",
  args: { id: s.string(), title: s.optional(s.string({ minLength: 1, maxLength: 200 })), notes: s.optional(s.string({ maxLength: 4000 })), priority: s.optional(s.enum(["low", "normal", "high"] as const)), recurrence: s.optional(s.enum(RECURRENCE)), projectId: s.optional(s.string()), clearDue: s.optional(s.boolean()), ...When },
  returns: s.doc(tasks),
  capability: { name: "tasks.update", description: "Change a task: title, notes, priority, date, reminder, project." },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { id, ...change }) => (await ops.updateTask(ctx, id, change, ui)).task,
});

export const complete = app.mutation({
  access: "tasks.write",
  args: { id: s.string() },
  returns: s.doc(tasks),
  capability: { name: "tasks.complete", description: "Mark a task done. A recurring task schedules its next occurrence." },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { id }) => (await ops.completeTask(ctx, id, ui)).task,
});

export const reopen = app.mutation({
  access: "tasks.write",
  args: { id: s.string() },
  returns: s.doc(tasks),
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { id }) => (await ops.reopenTask(ctx, id, ui)).task,
});

/** Deleting from the Tasks screen is the person's own direct act; the assistant can only propose it. */
export const remove = app.mutation({
  access: "tasks.write",
  args: { id: s.string() },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { id }) => {
    await ops.deleteTask(ctx, id, ui);
  },
});
