/**
 * Make a person's grants to PersonalOS exactly one set of capabilities (feltkit/delegation.ts `set`).
 *
 * Not atomic: one grant of the wanted capabilities, then the earlier grants revoked. A run can stop
 * part-way (a revoke fails) and the caller retries. The retry must keep the grant now in force: the
 * authority returns an identical grant that is still in force instead of making a new one, so after a
 * partial run that grant is already among the grants listed before, and revoking "everything listed
 * before" would revoke it too, leaving the person with nothing while reporting success. The grant the
 * authority returns is therefore never revoked here.
 */
export interface Grant {
  id: string;
  /** The agent the grant is for (`agent:<id>`), or null: PersonalOS's executor. */
  agent?: string | null;
  capabilities: string[];
  expiresAt: number | null;
}

export interface Grants {
  list(): Promise<Grant[]>;
  grant(input: { capabilities: string[]; expiresAt?: number; agent?: string }): Promise<Grant>;
  revoke(id: string): Promise<void>;
}

/** An agent's AuthBoundry principal, as grants name it. */
export const agentPrincipal = (agent: string) => (agent.includes(":") ? agent : `agent:${agent}`);

/** `agent` null: the grants to PersonalOS's executor; otherwise the grants to that agent only. Neither touches the other's. */
export async function setGrants(grants: Grants, want: string[], expiresAt: number | null, agent: string | null = null): Promise<{ granted: string[]; changed: boolean }> {
  const target = agent === null ? null : agentPrincipal(agent);
  const before = (await grants.list()).filter((g) => (g.agent ?? null) === target);
  const same = (g: Grant) => g.capabilities.length === want.length && want.every((c) => g.capabilities.includes(c)) && g.expiresAt === expiresAt;
  if (before.length === 1 && same(before[0]!)) return { granted: want, changed: false };
  if (!want.length && !before.length) return { granted: want, changed: false };
  const inForce = want.length ? (await grants.grant({ capabilities: want, ...(expiresAt ? { expiresAt } : {}), ...(target ? { agent: target } : {}) })).id : null;
  for (const g of before) if (g.id !== inForce) await grants.revoke(g.id);
  return { granted: want, changed: true };
}
