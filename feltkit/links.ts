/**
 * Connected surfaces: binding a sender on another surface (a Multiplayer account) to this
 * PersonalOS account. Both sides authenticate:
 *
 *   1. Here, signed in to PersonalOS, the owner asks for a code (links:start). Only a digest is kept;
 *      the code is shown once and expires in 10 minutes.
 *   2. On the surface, signed in there, the owner sends `link XXXX-XXXX` to PersonalOS in a direct
 *      message. The surface's bridge delivers it with the sender's authenticated source identity;
 *      interactions:receive uses the code up and records which surface account presented it.
 *   3. Here again, the owner sees that account and confirms it is theirs (links:confirm). A code
 *      someone else saw and sent first shows *their* account, which the owner does not confirm.
 *
 * Resolver is written only by the `identity` agent below, which FeltKit runs after the owner's
 * decision commits, as its own principal, with the only role that holds identity.link. It writes
 * exactly what this record says the owner decided, and nothing a request asks for. No person's or
 * bridge's session can call the Resolver integrations' capabilities (which FeltKit also serves on
 * /appport), because none holds that permission.
 *
 * A code is accepted only in a direct conversation with PersonalOS, so nobody else can read and
 * redeem it first. The verified link is recorded in Resolver (feltkit/_resolver.ts), which is what
 * every request resolves through; a source identity resolves to one account at a time, and several
 * source identities may resolve to the same account. Revoking revokes the Resolver reference, so the
 * surface's next request, and requests already in progress (interactions:status), stop resolving.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, identityLinks } from "./app.js";
import { digest, linkCodeFrom } from "./_interaction.js";
import { me, own } from "./_ops.js";
import { linkExternal, resolveExternal, revokeLink } from "./_resolver.js";

export const CODE_TTL_MS = 10 * 60_000;
/** How long a presented code waits for the owner's confirmation. */
export const PRESENTED_TTL_MS = 30 * 60_000;
const ADAPTER = s.string({ minLength: 1, maxLength: 100, pattern: "^[a-z0-9][a-z0-9-]*$" });

const Link = s.object({
  id: s.string(),
  adapter: s.string(),
  status: s.string(),
  error: s.nullable(s.string()),
  sourcePrincipalId: s.nullable(s.string()),
  sourceDisplayName: s.nullable(s.string()),
  createdAt: s.number(),
  linkedAt: s.nullable(s.number()),
  lastUsedAt: s.nullable(s.number()),
  codeExpiresAt: s.nullable(s.number()),
});

const view = (l: any) => ({
  id: l.id, adapter: l.adapter, status: l.status, error: l.error ?? null, sourcePrincipalId: l.sourcePrincipalId ?? null, sourceDisplayName: l.sourceDisplayName ?? null,
  createdAt: l.createdAt, linkedAt: l.linkedAt ?? null, lastUsedAt: l.lastUsedAt ?? null, codeExpiresAt: l.status === "pending" || l.status === "presented" ? (l.codeExpiresAt ?? null) : null,
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
    if (link.status === "revoking") return;
    // Nothing in Resolver yet (a code, a presentation, a confirmation not recorded): done here.
    if (!link.resolverRef && link.status !== "confirming") {
      await ctx.db.patch(identityLinks, id, { status: "revoked", revokedAt: Date.now(), codeDigest: undefined, codeExpiresAt: undefined });
      return;
    }
    // In Resolver: revoking until the identity agent has revoked it there. Requests are refused from
    // now on (interactions:receive treats "revoking" as disconnected), whatever Resolver still says.
    await ctx.db.patch(identityLinks, id, { status: "revoking", codeDigest: undefined, error: undefined });
    ctx.afterCommit.agent("identity", { linkId: id });
  },
});

/**
 * The owner confirms that the surface account which presented their code is theirs. The identity
 * agent then records it in Resolver.
 */
export const confirm = app.mutation({
  access: "links.write",
  args: { id: s.string() },
  returns: Link,
  handler: async (ctx, { id }) => {
    const link = await own<any>(ctx, identityLinks, id, "link");
    if (link.status !== "presented" || !link.sourcePrincipalId || !link.sourceInstance) fail("FAILED_PRECONDITION", "There is nothing to confirm: no surface account has presented this code.");
    if ((link.codeExpiresAt ?? 0) < Date.now()) fail("FAILED_PRECONDITION", "This confirmation expired. Start again to get a new code.");
    await ctx.db.patch(identityLinks, id, { status: "confirming", confirmedAt: Date.now(), error: undefined });
    ctx.afterCommit.agent("identity", { linkId: id });
    return view((await ctx.db.get(identityLinks, id))!);
  },
});

/**
 * Records in Resolver what the owner decided: a confirmed link (create) or a disconnection (revoke).
 * Deterministic, idempotent per link record, retried by FeltKit on failure. It acts only on the
 * record's state, which only the owner's own mutations set.
 */
export const identityAgent = app.agent("identity", {
  principal: { id: "personalos-identity", displayName: "PersonalOS identity links" },
  roles: ["identitylinker"],
  access: "identity.link",
  description: "Records the owner's identity-link decisions in Resolver.",
  handler: async (ctx, input: { linkId: string }) => {
    const link = await ctx.db.get(identityLinks, String(input.linkId));
    if (!link) return;
    if (link.status === "confirming") {
      const external = { adapter: link.adapter, instance: link.sourceInstance!, principalId: link.sourcePrincipalId! };
      const current = await resolveExternal(ctx, external);
      const problem = current.status === "ambiguous" ? "That account resolves to more than one PersonalOS link. Disconnect the others first."
        : current.status === "resolved" && current.owner !== link.owner ? "That account is already connected to a different PersonalOS account."
        : null;
      if (problem) { await ctx.db.patch(identityLinks, link.id, { status: "presented", error: problem }); return; }
      const now = Date.now();
      const linked = current.status === "resolved" ? { ref: current.ref } : await linkExternal(ctx, external, link.owner, link.id, link.confirmedAt ?? now);
      await ctx.db.patch(identityLinks, link.id, { status: "active", resolverRef: linked.ref, linkedAt: now, codeExpiresAt: undefined, error: undefined });
    } else if (link.status === "revoking") {
      if (link.resolverRef) await revokeLink(ctx, link.resolverRef, `disconnected by ${link.owner}`);
      await ctx.db.patch(identityLinks, link.id, { status: "revoked", revokedAt: Date.now(), error: undefined });
    }
  },
});
