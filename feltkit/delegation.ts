/**
 * What PersonalOS may do for you: your grants to its executor (`agent:personalos`), which AuthBoundry
 * decides every request from a connected surface by (Multiplayer, X, the browser, the share sheet;
 * feltkit/interactions.ts, invocations.ts, xsurface.ts). Work you do in the app yourself needs no grant.
 *
 * The grants live in AuthBoundry: with the private one FeltKit runs (`authority.local`), through
 * `ctx.authority.grants`, which only ever acts for the signed-in person. Nothing here is a copy of them.
 * With a hosted AuthBoundry (AUTHBOUNDRY_URL), people grant there and this says so.
 */
import { fail, s } from "@feltdb/feltkit";
import { app } from "./app.js";
import { AGENT_CAPABILITIES, AGENT_CAPABILITY_LABELS, CAPABILITIES, CAPABILITY_LABELS } from "./_authority.js";
import { agentPrincipal, setGrants } from "./_delegation.js";

const KNOWN = new Set<string>(CAPABILITIES);
const AGENT_KNOWN = new Set<string>(AGENT_CAPABILITIES);

/** Why grants can't be managed here (a hosted AuthBoundry, or the local one isn't running), else null. */
function unavailable(error: unknown): string | null {
  const code = (error as { code?: string })?.code;
  return code === "UNAVAILABLE" || code === "FAILED_PRECONDITION" ? (error as Error).message : null;
}

async function current(ctx: { authority: { grants: { list(): Promise<Array<{ id: string; agent?: string | null; capabilities: string[]; expiresAt: number | null }>> } } }, agent: string | null) {
  const target = agent === null ? null : agentPrincipal(agent);
  return (await ctx.authority.grants.list()).filter((g) => (g.agent ?? null) === target);
}

/**
 * Without `agent`: what PersonalOS may do for you (grants to its executor). With `agent`: what that agent,
 * registered by an operator (`registerAgent`), may do for you over /appport, one capability at a time.
 */
export const list = app.action({
  access: "delegation.read",
  args: { agent: s.optional(s.string({ maxLength: 100 })) },
  handler: async (ctx, { agent }) => {
    const offered: ReadonlyArray<{ id: string; label: string }> = agent === undefined
      ? CAPABILITIES.map((id) => ({ id, label: CAPABILITY_LABELS[id] }))
      : AGENT_CAPABILITIES.map((id) => ({ id, label: AGENT_CAPABILITY_LABELS[id] }));
    try {
      const grants = await current(ctx, agent ?? null);
      const by = new Map<string, { id: string; expiresAt: number | null }>();
      for (const g of grants) for (const c of g.capabilities) by.set(c, { id: g.id, expiresAt: g.expiresAt });
      return {
        available: true as const,
        reason: null,
        capabilities: offered.map(({ id, label }) => ({ id, label, granted: by.has(id), expiresAt: by.get(id)?.expiresAt ?? null })),
      };
    } catch (error) {
      const reason = unavailable(error);
      if (reason === null) throw error;
      return { available: false as const, reason, capabilities: offered.map(({ id, label }) => ({ id, label, granted: false, expiresAt: null })) };
    }
  },
});

/**
 * Make what PersonalOS (or, with `agent`, that agent) may do for you exactly `capabilities` (until
 * `expiresAt`, or until you change it): one new grant of them, then your earlier grants to the same one
 * revoked. In between, the two overlap; nothing outside either is ever allowed. Grants to the executor
 * and to each agent are separate: changing one never revokes another.
 */
export const set = app.action({
  access: "delegation.write",
  args: { capabilities: s.array(s.string({ maxLength: 100 }), { maxItems: 50 }), expiresAt: s.optional(s.nullable(s.number())), agent: s.optional(s.string({ maxLength: 100 })) },
  handler: async (ctx, { capabilities, expiresAt, agent }) => {
    const want = [...new Set(capabilities)];
    const known = agent === undefined ? KNOWN : AGENT_KNOWN;
    const unknown = want.filter((c) => !known.has(c));
    if (unknown.length) throw new Error(agent === undefined ? `Not something PersonalOS asks for: ${unknown.join(", ")}` : `Not something an agent can be given: ${unknown.join(", ")}`);
    // Retry-safe: the grant now in force is never revoked (feltkit/_delegation.ts).
    const { granted, changed } = await setGrants(ctx.authority.grants, want, expiresAt ?? null, agent ?? null);
    return { granted, changed };
  },
});

/** An operator registers an agent outside PersonalOS with its authority. It may do nothing until a person grants it. */
export const registerAgent = app.action({
  access: "feltkit.authority.agents",
  args: { id: s.string({ minLength: 1, maxLength: 100 }), name: s.optional(s.string({ maxLength: 100 })) },
  handler: async (ctx, input) => {
    // ctx.authority.agents arrived after FeltKit 0.3.30; without it, agents are registered nowhere here.
    const agents = (ctx.authority as { agents?: { register(input: { id: string; name?: string }): Promise<{ id: string; status: string }> } }).agents;
    if (!agents) fail("FAILED_PRECONDITION", "This FeltKit cannot register agents (needs a release with ctx.authority.agents).");
    return agents.register(input);
  },
});
