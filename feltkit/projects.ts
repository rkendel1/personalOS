import { s } from "@feltdb/feltkit";
import { app, projects, tasks } from "./app.js";
import * as ops from "./_ops.js";

export const list = app.query({
  access: "projects.read",
  returns: s.array(s.doc(projects).extend({ open: s.number(), done: s.number() })),
  capability: { name: "projects.list", description: "Projects with their open and done task counts." },
  handler: async (ctx) => {
    const owner = ops.me(ctx);
    const [all, ts] = await Promise.all([ctx.db.find(projects, { owner }, { orderBy: [{ field: "updatedAt", direction: "desc" }] }), ctx.db.find(tasks, { owner })]);
    return all.map((p) => ({ ...p, open: ts.filter((t) => t.projectId === p.id && t.status === "open").length, done: ts.filter((t) => t.projectId === p.id && t.status === "done").length }));
  },
});

export const create = app.mutation({
  access: "projects.write",
  args: { name: s.string({ minLength: 1, maxLength: 120 }), description: s.optional(s.string({ maxLength: 2000 })) },
  returns: s.doc(projects),
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, args) => (await ops.createProject(ctx, args, { via: "ui" })).project,
});

export const update = app.mutation({
  access: "projects.write",
  args: { id: s.string(), name: s.optional(s.string({ minLength: 1, maxLength: 120 })), description: s.optional(s.string({ maxLength: 2000 })), status: s.optional(s.enum(["active", "paused", "done"] as const)) },
  handler: async (ctx, { id, ...change }) => {
    await ops.own(ctx, projects, id, "project");
    await ctx.db.patch(projects, id, { ...change, updatedAt: Date.now() });
  },
});
