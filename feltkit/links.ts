/**
 * Connected surfaces: binding a sender on another surface (a Multiplayer account) to this
 * PersonalOS account. Both sides authenticate:
 *
 *   1. Here, signed in to PersonalOS, the owner asks for a code (links:start). Only a digest is kept;
 *      the code is shown once and expires in 10 minutes.
 *   2. On the surface, signed in there, the owner sends `link XXXX-XXXX` to PersonalOS in a direct
 *      message. The surface's bridge delivers it with the sender's authenticated source identity, and
 *      interactions:receive binds that identity to the account that issued the code (one use).
 *
 * A code is accepted only in a direct conversation with PersonalOS, so nobody else can read and
 * redeem it first. A source identity links to one account at a time. Revoking takes effect on the
 * surface's next request, including requests already in progress (interactions:status).
 */
import { fail, s } from "@feltdb/feltkit";
import { app, identityLinks } from "./app.js";
import { digest, linkCodeFrom } from "./_interaction.js";
import { me, own } from "./_ops.js";

export const CODE_TTL_MS = 10 * 60_000;
const ADAPTER = s.string({ minLength: 1, maxLength: 100, pattern: "^[a-z0-9][a-z0-9-]*$" });

const Link = s.object({
  id: s.string(),
  adapter: s.string(),
  status: s.string(),
  sourcePrincipalId: s.nullable(s.string()),
  sourceDisplayName: s.nullable(s.string()),
  createdAt: s.number(),
  linkedAt: s.nullable(s.number()),
  lastUsedAt: s.nullable(s.number()),
  codeExpiresAt: s.nullable(s.number()),
});

const view = (l: any) => ({
  id: l.id, adapter: l.adapter, status: l.status, sourcePrincipalId: l.sourcePrincipalId ?? null, sourceDisplayName: l.sourceDisplayName ?? null,
  createdAt: l.createdAt, linkedAt: l.linkedAt ?? null, lastUsedAt: l.lastUsedAt ?? null, codeExpiresAt: l.status === "pending" ? (l.codeExpiresAt ?? null) : null,
});

/** Issue a one-time code to link this account on a surface. Replaces any earlier pending code for it. */
export const start = app.mutation({
  access: "links.write",
  args: { adapter: s.optional(ADAPTER) },
  returns: s.object({ id: s.string(), adapter: s.string(), code: s.string(), expiresAt: s.number() }),
  handler: async (ctx, args) => {
    const owner = me(ctx);
    const adapter = args.adapter ?? "multiplayer";
    for (const l of await ctx.db.find(identityLinks, { owner })) {
      if (l.adapter === adapter && l.status === "pending") await ctx.db.delete(identityLinks, l.id);
    }
    const code = linkCodeFrom(await ctx.crypto.token(16));
    const expiresAt = Date.now() + CODE_TTL_MS;
    const id = await ctx.db.insert(identityLinks, { owner, adapter, status: "pending", codeDigest: await digest(code), codeExpiresAt: expiresAt, createdAt: Date.now() });
    return { id, adapter, code, expiresAt };
  },
});

export const list = app.query({
  access: "links.read",
  returns: s.array(Link),
  handler: async (ctx) => (await ctx.db.find(identityLinks, { owner: me(ctx) }, { orderBy: [{ field: "createdAt", direction: "desc" }] })).filter((l) => l.status !== "revoked").map(view),
});

/** Disconnect a surface (or cancel a pending code). Its next request is refused. */
export const revoke = app.mutation({
  access: "links.write",
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    const link = await own<any>(ctx, identityLinks, id, "link");
    if (link.status === "revoked") fail("FAILED_PRECONDITION", "Already disconnected.");
    await ctx.db.patch(identityLinks, id, { status: "revoked", revokedAt: Date.now(), codeDigest: undefined });
  },
});
