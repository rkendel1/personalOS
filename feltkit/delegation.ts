/**
 * What Anywhere Aide may do for you: your grants to its executor (`agent:personalos`), which AuthBoundry
 * decides every request from a connected surface by (Multiplayer, X, the browser, the share sheet;
 * feltkit/interactions.ts, invocations.ts, xsurface.ts). Work you do in the app yourself needs no grant.
 *
 * The grants live in AuthBoundry: with the private one FeltKit runs (`authority.local`), through
 * `ctx.authority.grants`, which only ever acts for the signed-in person. Nothing here is a copy of them.
 * With a hosted AuthBoundry (AUTHBOUNDRY_URL), people grant there and this says so.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, researchBudgets } from "./app.js";
import { AGENT_CAPABILITIES, AGENT_CAPABILITY_LABELS, CAPABILITIES, CAPABILITY_LABELS } from "./_authority.js";
import { agentPrincipal, setGrants } from "./_delegation.js";
import { delegationOf } from "./_ops.js";
import { CONNECTION_CAPABILITIES } from "./connections.js";

const KNOWN = new Set<string>(CAPABILITIES);
const AGENT_KNOWN = new Set<string>(AGENT_CAPABILITIES);

/**
 * Why grants can't be managed here, else null: a hosted AuthBoundry, the local one isn't running, or it
 * refused this deployment's own administrator (SETUP_FAILED, e.g. "delegations: 403 authorization_denied":
 * the local authority's saved state no longer accepts the administrator FeltKit signs in as). Settings then
 * says so and what to do, instead of failing the whole page.
 */
function unavailable(error: unknown): string | null {
  const code = (error as { code?: string })?.code;
  if (code === "UNAVAILABLE" || code === "FAILED_PRECONDITION") return (error as Error).message;
  if (code === "SETUP_FAILED" || /\b40[13]\b.*(authoriz|denied|unauthor)/i.test(String((error as Error)?.message ?? "")))
    return `This server's permission service refused to list your grants (${String((error as Error).message).slice(0, 200)}). Nothing was changed. An operator can check the local AuthBoundry's state (npx feltkit readiness), or restart it with fresh state.`;
  return null;
}

async function current(ctx: { authority: { grants: { list(): Promise<Array<{ id: string; agent?: string | null; capabilities: string[]; expiresAt: number | null }>> } } }, agent: string | null) {
  const target = agent === null ? null : agentPrincipal(agent);
  return (await ctx.authority.grants.list()).filter((g) => (g.agent ?? null) === target);
}

/**
 * Without `agent`: what Anywhere Aide may do for you (grants to its executor). With `agent`: what that agent,
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
 * Make what Anywhere Aide (or, with `agent`, that agent) may do for you exactly `capabilities` (until
 * `expiresAt`, or until you change it): one new grant of them, then your earlier grants to the same one
 * revoked. In between, the two overlap; nothing outside either is ever allowed. Grants to the executor
 * and to each agent are separate: changing one never revokes another.
 */
export const set = app.action({
  access: "delegation.write",
  args: { capabilities: s.array(s.string({ maxLength: 100 }), { maxItems: 50 }), expiresAt: s.optional(s.nullable(s.number())), agent: s.optional(s.string({ maxLength: 100 })) },
  handler: async (ctx, { capabilities, expiresAt, agent }) => {
    let want = [...new Set(capabilities)];
    const known = agent === undefined ? KNOWN : AGENT_KNOWN;
    const unknown = want.filter((c) => !known.has(c));
    if (unknown.length) throw new Error(agent === undefined ? `Not something Anywhere Aide asks for: ${unknown.join(", ")}` : `Not something an agent can be given: ${unknown.join(", ")}`);
    // What the person allowed for their connected accounts (Settings → Connections) is kept as it is:
    // this list is only what connected surfaces may ask for (feltkit/connections.ts changes the rest).
    if (agent === undefined) {
      const kept = (await current(ctx, null)).flatMap((g) => g.capabilities).filter((c) => CONNECTION_CAPABILITIES.includes(c));
      want = [...new Set([...want, ...kept])];
    }
    // Retry-safe: the grant now in force is never revoked (feltkit/_delegation.ts).
    const { granted, changed } = await setGrants(ctx.authority.grants, want, expiresAt ?? null, agent ?? null);
    return { granted, changed };
  },
});

/** An operator registers an agent outside Anywhere Aide with its authority. It may do nothing until a person grants it. */
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

/**
 * What the owner lets an agent spend on research for them, in billable calls (a model generation or a web
 * search). Only the owner sets it: never an agent, whatever it was granted. Lowering it below what running
 * research holds stops new runs; it does not take back what is already reserved.
 */
export const setResearchBudget = app.mutation({
  access: "delegation.write",
  args: { agent: s.string({ minLength: 1, maxLength: 100 }), calls: s.integer({ minimum: 0, maximum: 100000 }) },
  returns: s.object({ agent: s.string(), calls: s.number(), reserved: s.number(), left: s.number() }),
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { agent, calls }) => {
    if (delegationOf(ctx)) fail("FORBIDDEN", "Only the owner sets a research budget; an agent acting for them cannot.");
    const owner = ctx.auth.requirePrincipal().id;
    const target = agentPrincipal(agent);
    const record = (await ctx.db.find(researchBudgets, { owner, agent: target }))[0];
    if (record) await ctx.db.patch(researchBudgets, record.id, { calls, updatedAt: Date.now() });
    else await ctx.db.insert(researchBudgets, { owner, agent: target, calls, reserved: 0, updatedAt: Date.now() });
    const reserved = record?.reserved ?? 0;
    return { agent: target, calls, reserved, left: Math.max(0, calls - reserved) };
  },
});

/** The research budget the owner set for an agent, what is reserved or spent, and what is left. */
export const researchBudget = app.query({
  access: "delegation.read",
  args: { agent: s.string({ minLength: 1, maxLength: 100 }) },
  returns: s.nullable(s.object({ agent: s.string(), calls: s.number(), reserved: s.number(), left: s.number() })),
  handler: async (ctx, { agent }) => {
    const owner = ctx.auth.requirePrincipal().id;
    const record = (await ctx.db.find(researchBudgets, { owner, agent: agentPrincipal(agent) }))[0];
    return record ? { agent: record.agent, calls: record.calls, reserved: record.reserved, left: Math.max(0, record.calls - record.reserved) } : null;
  },
});
