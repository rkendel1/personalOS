/**
 * What PersonalOS may do for you: your grants to its executor (`agent:personalos`), which AuthBoundry
 * decides every request from a connected surface by (Multiplayer, X, the browser, the share sheet;
 * feltkit/interactions.ts, invocations.ts, xsurface.ts). Work you do in the app yourself needs no grant.
 *
 * The grants live in AuthBoundry: with the private one FeltKit runs (`authority.local`), through
 * `ctx.authority.grants`, which only ever acts for the signed-in person. Nothing here is a copy of them.
 * With a hosted AuthBoundry (AUTHBOUNDRY_URL), people grant there and this says so.
 */
import { s } from "@feltdb/feltkit";
import { app } from "./app.js";
import { CAPABILITIES, CAPABILITY_LABELS } from "./_authority.js";

type Capability = (typeof CAPABILITIES)[number];
const KNOWN = new Set<string>(CAPABILITIES);

/** Why grants can't be managed here (a hosted AuthBoundry, or the local one isn't running), else null. */
function unavailable(error: unknown): string | null {
  const code = (error as { code?: string })?.code;
  return code === "UNAVAILABLE" || code === "FAILED_PRECONDITION" ? (error as Error).message : null;
}

async function current(ctx: { authority: { grants: { list(): Promise<Array<{ id: string; capabilities: string[]; expiresAt: number | null }>> } } }) {
  return ctx.authority.grants.list();
}

export const list = app.action({
  access: "delegation.read",
  handler: async (ctx) => {
    try {
      const grants = await current(ctx);
      const by = new Map<string, { id: string; expiresAt: number | null }>();
      for (const g of grants) for (const c of g.capabilities) by.set(c, { id: g.id, expiresAt: g.expiresAt });
      return {
        available: true as const,
        reason: null,
        capabilities: CAPABILITIES.map((id) => ({ id, label: CAPABILITY_LABELS[id], granted: by.has(id), expiresAt: by.get(id)?.expiresAt ?? null })),
      };
    } catch (error) {
      const reason = unavailable(error);
      if (reason === null) throw error;
      return { available: false as const, reason, capabilities: CAPABILITIES.map((id) => ({ id, label: CAPABILITY_LABELS[id], granted: false, expiresAt: null })) };
    }
  },
});

/**
 * Make what PersonalOS may do for you exactly `capabilities` (until `expiresAt`, or until you change it):
 * one new grant of them, then your earlier grants revoked. In between, the two overlap; nothing outside
 * either is ever allowed.
 */
export const set = app.action({
  access: "delegation.write",
  args: { capabilities: s.array(s.string({ maxLength: 100 }), { maxItems: 50 }), expiresAt: s.optional(s.nullable(s.number())) },
  handler: async (ctx, { capabilities, expiresAt }) => {
    const want = [...new Set(capabilities)];
    const unknown = want.filter((c) => !KNOWN.has(c));
    if (unknown.length) throw new Error(`Not something PersonalOS asks for: ${unknown.join(", ")}`);
    const before = await current(ctx);
    const same = (g: { capabilities: string[]; expiresAt: number | null }) => g.capabilities.length === want.length && want.every((c) => g.capabilities.includes(c)) && g.expiresAt === (expiresAt ?? null);
    if (before.length === 1 && same(before[0]!)) return { granted: want as Capability[], changed: false };
    if (want.length) await ctx.authority.grants.grant({ capabilities: want, ...(expiresAt ? { expiresAt } : {}) });
    for (const g of before) await ctx.authority.grants.revoke(g.id);
    return { granted: want as Capability[], changed: true };
  },
});
