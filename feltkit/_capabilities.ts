/**
 * What an outcome needs, and whether this installation can do it: decided from the platform's own
 * capability catalog (`ctx.agent.catalog()`: every capability the application and its services
 * offer, with the caller's authorization and whether it is configured here), never from the tools a
 * model turn happens to be given, and never by a model.
 *
 * Each need is one of:
 *   available            in the catalog, allowed for this person, configured here
 *   needs-configuration  declared, but its endpoint or credential is not set (readiness says what)
 *   needs-authorization  declared and configured, but this person may not use it
 *   connectable          not declared here; a provider can be connected (Studio → Integrations), and
 *                        then declared as the capability named below
 *   missing              nothing provides it and nothing can be connected for it
 *
 * The capability names are PersonalOS's declared integrations (feltkit/app.ts): the boundary where a
 * provider is chosen by configuration (base URL, credential), not by code.
 */

import { app } from "./app.js";

export type NeedState = "available" | "needs-configuration" | "needs-authorization" | "connectable" | "missing";

export interface Need {
  need: string;
  purpose: string;
  required: boolean;
  /** The capability that provides it here, if PersonalOS declares one. */
  capability: string | null;
}

export interface NeedReport extends Need {
  state: NeedState;
  /** What to do so it becomes available (configuration, authorization, a provider to connect). */
  howToEnable: string | null;
  problems: string[];
}

export interface Discovery {
  /** Where the inventory came from, and how much of it there was. */
  source: "ctx.agent.catalog" | "ctx.agent.tools";
  searchedAt: number;
  capabilitiesSeen: number;
  needs: NeedReport[];
  /** Every required need is available. */
  executable: boolean;
  /** Every need, required or not, is available (otherwise the result is partial by design). */
  complete: boolean;
}

/** What finding prospects needs. Storage is PersonalOS's own (research runs, sources, prospects). */
export const PROSPECT_NEEDS: Need[] = [
  { need: "web search", purpose: "find companies in the product's space, with the pages that say so", required: true, capability: "websearch.search" },
  { need: "page retrieval", purpose: "read a company's own pages to verify what search results say", required: false, capability: null },
  { need: "contact research", purpose: "identify who decides; not needed to find prospects, and outreach always waits for your approval", required: false, capability: null },
];

interface CatalogEntry {
  name: string;
  allowed?: boolean;
  integration?: string;
  readiness?: { ready: boolean; problems: Array<{ message: string; fix: string }> };
}

type AgentLike = { catalog?: () => Promise<CatalogEntry[]>; tools: () => Promise<Array<{ name: string }>> };

/**
 * Discover what this installation can do for these needs, for the caller. Uses the full catalog when
 * the platform provides it (FeltKit with ctx.agent.catalog); otherwise the caller's usable tools,
 * where a capability absent from them is either not permitted or not declared, and readiness is
 * established by the first call.
 */
export async function discover(agent: AgentLike, needs: Need[], options: { declared?: string[]; now?: number } = {}): Promise<Discovery> {
  const now = options.now ?? Date.now();
  const full = typeof agent.catalog === "function";
  // Without the full catalog, the caller's model tools are a subset (older FeltKit leaves integration
  // operations out of it): this application's own declarations fill in what exists, unverified until
  // the first call, which establishes configuration and permission.
  const tools = full ? [] : (await agent.tools()).map((t) => ({ name: t.name, allowed: true }));
  const declared = full ? [] : (options.declared ?? []).filter((name) => !tools.some((t) => t.name === name)).map((name) => ({ name, allowed: true, declaredOnly: true }));
  const catalog: Array<CatalogEntry & { declaredOnly?: boolean }> = full ? await agent.catalog!() : [...tools, ...declared];
  const byName = new Map(catalog.map((c) => [c.name, c]));
  const reports = needs.map((n): NeedReport => {
    const entry = n.capability ? byName.get(n.capability) : undefined;
    if (!n.capability) {
      return { ...n, state: "connectable", problems: [], howToEnable: `No ${n.need} provider is declared in this PersonalOS. An HTTP API that provides it can be connected (Studio → Integrations → Connect an API) and declared as a capability.` };
    }
    if (!entry) {
      return full
        ? { ...n, state: "connectable", problems: [], howToEnable: `${n.capability} is not declared in this deployment. Connect a ${n.need} API (Studio → Integrations) as "${n.capability.split(".")[0]}".` }
        : { ...n, state: "needs-authorization", problems: [`${n.capability} is not among the capabilities you may use (it may not be permitted for your account, or not declared).`], howToEnable: "Ask an administrator to grant your role the research permission." };
    }
    if (entry.allowed === false) {
      return { ...n, state: "needs-authorization", problems: [`Your account may not use ${n.capability}.`], howToEnable: "Ask an administrator to grant your role the research permission (research.search)." };
    }
    if (entry.readiness && !entry.readiness.ready) {
      return { ...n, state: "needs-configuration", problems: entry.readiness.problems.map((p) => p.message), howToEnable: entry.readiness.problems.map((p) => p.fix).join(" ") };
    }
    if ((entry as { declaredOnly?: boolean }).declaredOnly) {
      return { ...n, state: "available", problems: [`Declared by this PersonalOS; this FeltKit does not report whether it is configured or permitted, so the first call will tell.`], howToEnable: null };
    }
    return { ...n, state: "available", problems: [], howToEnable: null };
  });
  return {
    source: full ? "ctx.agent.catalog" : "ctx.agent.tools",
    searchedAt: now,
    capabilitiesSeen: catalog.length,
    needs: reports,
    executable: reports.every((r) => !r.required || r.state === "available"),
    complete: reports.every((r) => r.state === "available"),
  };
}

/** One line per need, for a reply or a model's context: what is there, and what is not, and why. */
export function describeDiscovery(d: Discovery): string {
  const label: Record<NeedState, string> = {
    available: "available",
    "needs-configuration": "declared, not configured",
    "needs-authorization": "not permitted for you",
    connectable: "no provider connected",
    missing: "not available",
  };
  return d.needs
    .map((n) => {
      const unverified = n.state === "available" && n.problems.length > 0;
      const state = unverified ? "declared; whether it is configured is checked on first use" : label[n.state];
      return `- ${n.need}: ${state}${n.capability ? ` (${n.capability})` : ""}${n.state === "available" ? "" : n.problems.length ? `: ${n.problems.join(" ")}` : ""}`;
    })
    .join("\n");
}

/** The integration capabilities this PersonalOS declares (feltkit/app.ts): what exists, by declaration. */
export function declaredCapabilities(): string[] {
  return [...app.integrations.values()].flatMap((i) => Object.values(i.operations).map((op) => op.capability));
}
