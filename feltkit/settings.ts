import { s } from "@feltdb/feltkit";
import { app, settings } from "./app.js";
import { me } from "./_ops.js";

export const get = app.query({
  access: "settings.read",
  handler: async (ctx) => {
    const row = (await ctx.db.find(settings, { owner: me(ctx) }))[0];
    return { name: row?.name ?? null, modelAssist: row?.modelAssist ?? false, canUseModel: ctx.auth.has("feltkit.agent.write") };
  },
});

export const set = app.mutation({
  access: "settings.write",
  args: { name: s.optional(s.nullable(s.string({ maxLength: 80 }))), modelAssist: s.optional(s.boolean()) },
  handler: async (ctx, { name, modelAssist }) => {
    const owner = me(ctx);
    const row = (await ctx.db.find(settings, { owner }))[0];
    const change = { ...(name !== undefined ? { name: name?.trim() || undefined } : {}), ...(modelAssist !== undefined ? { modelAssist } : {}), updatedAt: Date.now() };
    if (row) await ctx.db.patch(settings, row.id, change);
    else await ctx.db.insert(settings, { owner, modelAssist: false, ...change });
  },
});
