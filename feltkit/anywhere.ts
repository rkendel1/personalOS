/**
 * Connected surfaces → the connected agent (an eve AppPort agent), for people who linked a surface.
 *
 * The surfaces stay what they are: Multiplayer's bridge and the X adapter deliver a message with the
 * sender's authenticated identity, and PersonalOS resolves that identity through Resolver to the
 * person a verified link names (interactions.ts, xsurface.ts). When PERSONALOS_AGENT_URL is set, the
 * request is not answered by PersonalOS's own assistant: after AuthBoundry allows
 * personalos.assistant.converse for that person, it is recorded on the surface's own record
 * (`agent`, below) and handed to the agent here.
 *
 *   who         PersonalOS asserts the resolved person to the agent with its own identity token
 *               (integration `agent`, credential `agent-identity`). The agent accepts a person only
 *               from that token, and then acts only under that person's own grants to it, which
 *               AuthBoundry decides at every AppPort call on PersonalOS's delegated /appport. Resolver,
 *               its keys and the sender's surface identity never leave PersonalOS (the agent receives
 *               them as provenance only, never as authority).
 *   once        The agent's idempotency key is derived from the surface's own event id (the
 *               interaction key, the X post id): a redelivered or retried event is the same work.
 *   where to    The reply goes where the request came from, because it is written to the surface's own
 *               record: an interaction update the bridge posts to that conversation, or (X) the
 *               person's PersonalOS conversation, with only the generic public acknowledgement on X.
 *               Nothing the agent returns names a recipient.
 *   outcome     Execution (the agent's record: completed, blocked as stalled, indeterminate, …) is kept
 *               here verbatim; delivery is the surface's (interaction updates and their events, X
 *               reply states). A failed delivery never resubmits work.
 *
 * Runs only as the `anywhere` agent (its own principal; no session holds anywhere.agent) and the
 * follow-up job it queues, so neither a bridge nor a person can submit or redirect agent work.
 */
import { s, type MutationCtx } from "@feltdb/feltkit";
import { app, interactions, invocations } from "./app.js";
import { appendMessage } from "./assistant.js";
import { moveInvocation } from "./invocationstate.js";
import { announce } from "./interactions.js";
import * as ops from "./_ops.js";

/** The AuthBoundry capability a person grants PersonalOS for taking their requests from a surface. */
export const HANDOFF_CAPABILITY = "personalos.assistant.converse";
/** How long agent work is followed before PersonalOS stops and says so. */
export const FOLLOW_FOR_MS = 24 * 60 * 60_000;
const MAX_DELAY_MS = 60_000;

export const agentConnected = (): boolean => Boolean(process.env.PERSONALOS_AGENT_URL);
const pollMs = () => {
  const configured = Number(process.env.PERSONALOS_AGENT_POLL_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 2000;
};

type Kind = "interaction" | "invocation";
type AgentRecord = {
  key: string; state: "submitting" | "accepted" | "completed" | "blocked" | "refused" | "expired";
  objective: string; surface: Record<string, string>; workId?: string; status?: string; decision?: string; summary?: string;
  operations?: Array<{ capability: string; operationId: string; state: string; requestIds: string[] }>;
  reported?: string; next?: string; attempts: number; error?: string; submittedAt?: number; checkedAt?: number;
};

/** The agent work a surface record starts with. */
export function agentWork(key: string, objective: string, surface: Record<string, string | number | null | undefined>): AgentRecord {
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(surface)) if (value !== undefined && value !== null) flat[name] = String(value).slice(0, 500);
  return { key: `surface:${key}`.slice(0, 300), state: "submitting", objective: objective.slice(0, 4000), surface: flat, attempts: 0 };
}

/** Start handing a recorded surface request to the agent (after the recording commits). */
export function handOff(ctx: MutationCtx, kind: Kind, id: string): void {
  ctx.afterCommit.agent("anywhere", { kind, id });
}

/** What the agent's latest decision says about blocked work, in words for the person. */
function why(decision: string | undefined): string {
  const d = decision ?? "";
  if (d.startsWith("stalled:")) return "it stalled (no progress, nothing in flight), and nothing was retried";
  if (d.startsWith("indeterminate:")) return "an operation's outcome is uncertain, so nothing is retried until it is settled";
  if (d.startsWith("waiting: every AppPort invocation was rejected")) return "every operation it tried was refused (not granted to the agent, or not allowed)";
  if (d.startsWith("waiting:")) return "it is waiting for an approval";
  if (d.startsWith("blocked: not completed:")) return `it could not show that it finished (${d.slice("blocked: not completed:".length).trim()})`;
  if (d.startsWith("failed:")) return "the agent's turn failed";
  return d ? `it is blocked (${d.slice(0, 200)})` : "it is blocked";
}

async function record(ctx: MutationCtx, kind: Kind, id: string): Promise<any> {
  return kind === "interaction" ? ctx.db.get(interactions, id) : ctx.db.get(invocations, id);
}

async function save(ctx: MutationCtx, kind: Kind, id: string, agent: AgentRecord): Promise<void> {
  if (kind === "interaction") await ctx.db.patch(interactions, id, { agent: agent as any, updatedAt: Date.now() });
  else await ctx.db.patch(invocations, id, { agent: agent as any, updatedAt: Date.now() });
}

/** Follow up later. The token makes a retried job that already scheduled its successor a no-op. */
async function later(ctx: MutationCtx, kind: Kind, id: string, agent: AgentRecord): Promise<void> {
  const next = `${agent.attempts}`;
  await save(ctx, kind, id, { ...agent, next });
  const delay = Math.min(pollMs() * 2 ** Math.min(Math.max(agent.attempts - 1, 0), 5), MAX_DELAY_MS);
  ctx.afterCommit.jobs.enqueue("anywhere.follow", { kind, id, next }, { runAt: new Date(Date.now() + delay).toISOString(), maxAttempts: 3 });
}

/**
 * Tell the surface record what became of the request. Multiplayer: an interaction update (the bridge
 * posts it to the conversation it came from; in a shared conversation only that it is done or not,
 * never the content). X: the invocation's state, and the reply in the person's own PersonalOS
 * conversation; X itself only ever got the generic acknowledgement.
 */
async function report(ctx: MutationCtx, kind: Kind, rec: any, state: "working" | "completed" | "failed", full: string): Promise<void> {
  const owner = rec.owner as string;
  const octx = ops.actingFor(ctx, owner);
  if (rec.conversationId) await appendMessage(octx, rec.conversationId, { role: "assistant", text: full.slice(0, 8000) });
  if (kind === "invocation") {
    await moveInvocation(ctx, rec, state === "working" ? "processing" : state, full.slice(0, 2000));
    return;
  }
  const shared = rec.audience !== "private";
  const text = !shared
    ? full
    : state === "completed" ? "Done. The details are in your PersonalOS, since this conversation is shared."
      : state === "failed" ? "It couldn't be finished. The details are in your PersonalOS, since this conversation is shared."
        : "Not finished yet. The details are in your PersonalOS, since this conversation is shared.";
  const fresh = (await ctx.db.get(interactions, rec.id))!;
  const update = { seq: (fresh.updates.at(-1)?.seq ?? 0) + 1, state, text: text.slice(0, 8000), at: Date.now() };
  await ctx.db.patch(interactions, rec.id, { state, updates: [...fresh.updates, update], updatedAt: Date.now() });
  announce(ctx, fresh as any, update);
}

const errorText = (e: unknown) => {
  const err = e as { code?: string; message?: string; details?: { status?: number | null } };
  return `${err.code ?? "ERROR"}${err.details?.status ? ` ${err.details.status}` : ""}: ${String(err.message ?? e).slice(0, 300)}`;
};
/** The agent answered and refused (a 4xx other than rate limiting): nothing ran, and asking again won't change it. */
const refusedBy = (e: unknown) => {
  const err = e as { code?: string; details?: { status?: number | null } };
  const status = err.details?.status ?? 0;
  return err.code === "UPSTREAM_REJECTED" && status >= 400 && status < 500 && status !== 429;
};

/** The work the agent accepted under `key` for `owner`, or null (not found, or the agent unreachable). */
async function lookup(ctx: MutationCtx, owner: string, key: string): Promise<string | null> {
  try {
    const out = (await ctx.integrations.invoke("agent.lookup", { onBehalfOf: owner, key })) as { workId?: unknown };
    return typeof out?.workId === "string" ? out.workId : null;
  } catch {
    return null;
  }
}

/** One step: submit if not yet accepted, read the agent's record, report what changed, follow up if not done. */
export async function step(ctx: MutationCtx, kind: Kind, id: string, next?: string): Promise<void> {
  const rec = await record(ctx, kind, id);
  const current = rec?.agent as AgentRecord | undefined;
  if (!rec?.owner || !current || ["completed", "refused", "expired"].includes(current.state)) return;
  if (next !== undefined && current.next !== next) return;
  const now = Date.now();
  let agent: AgentRecord = { ...current, attempts: current.attempts + 1, checkedAt: now };

  if (now - rec.createdAt > FOLLOW_FOR_MS) {
    await save(ctx, kind, id, { ...agent, state: "expired" });
    await report(ctx, kind, rec, "failed", `The connected agent's work${agent.workId ? ` ${agent.workId}` : ""} did not finish within a day${agent.decision ? `: ${why(agent.decision)}` : ""}. PersonalOS stopped following it; its own record is authoritative.`);
    return;
  }

  if (!agent.workId) {
    try {
      const out = (await ctx.integrations.invoke("agent.submit", { objective: agent.objective, onBehalfOf: rec.owner, readOnly: false, surface: agent.surface, key: agent.key }, { idempotencyKey: agent.key })) as { workId?: unknown };
      if (typeof out?.workId !== "string") throw Object.assign(new Error("The agent answered without a work id."), { code: "UNAVAILABLE" });
      agent = { ...agent, workId: out.workId, state: "accepted", submittedAt: now, error: undefined };
    } catch (e) {
      if (refusedBy(e)) {
        await save(ctx, kind, id, { ...agent, state: "refused", error: errorText(e) });
        await report(ctx, kind, rec, "failed", `The connected agent refused this request (${errorText(e)}). Nothing was done.`);
        return;
      }
      // No definite answer (FeltKit then refuses to send the same key again until it is settled):
      // the agent's own record says whether it has the work. Found: carry on with it. Not (yet): ask again later.
      const found = await lookup(ctx, rec.owner, agent.key);
      if (found === null) return later(ctx, kind, id, { ...agent, error: errorText(e) });
      agent = { ...agent, workId: found, state: "accepted", submittedAt: now, error: undefined };
    }
  }

  let work: any;
  try {
    work = await ctx.integrations.invoke("agent.read", { workId: agent.workId! });
  } catch (e) {
    return later(ctx, kind, id, { ...agent, error: errorText(e) });
  }
  const decision = Array.isArray(work?.decisions) ? String(work.decisions.at(-1) ?? "") : "";
  agent = {
    ...agent, status: String(work?.status ?? ""), decision: decision.slice(0, 1000) || undefined, summary: String(work?.summary ?? "").slice(0, 4000), error: undefined,
    operations: (Array.isArray(work?.ledger) ? work.ledger : []).slice(0, 50).map((o: any) => ({ capability: String(o.capability), operationId: String(o.operationId), state: String(o.state), requestIds: (o.requestIds ?? []).map(String) })),
  };
  const ref = `(work ${agent.workId}${agent.operations?.length ? `; ${agent.operations.map((o) => `${o.capability} ${o.state}`).join(", ")}` : ""})`;

  if (agent.status === "completed") {
    await save(ctx, kind, id, { ...agent, state: "completed", reported: "completed" });
    await report(ctx, kind, rec, "completed", `${agent.summary} ${ref}`);
    return;
  }
  if (agent.status === "blocked") {
    agent = { ...agent, state: "blocked" };
    if (agent.reported !== agent.decision) {
      agent = { ...agent, reported: agent.decision };
      await save(ctx, kind, id, agent);
      await report(ctx, kind, (await record(ctx, kind, id))!, "working", `Not finished: ${why(agent.decision)}. ${ref}`);
    }
  }
  return later(ctx, kind, id, agent);
}

export const anywhereAgent = app.agent("anywhere", {
  principal: { id: "personalos-anywhere", displayName: "PersonalOS connected agent" },
  roles: ["anywhere"],
  access: "anywhere.agent",
  description: "Hands a linked person's surface request to the connected agent and follows it to its outcome.",
  handler: async (ctx, input: { kind: Kind; id: string }) => step(ctx, input.kind, String(input.id)),
});

/** The `anywhere.follow` job: the next step of one request, queued by the agent (runs as it). */
export const follow = app.mutation({
  access: "anywhere.agent",
  args: { kind: s.enum(["interaction", "invocation"] as const), id: s.string({ maxLength: 100 }), next: s.string({ maxLength: 20 }) },
  handler: async (ctx, { kind, id, next }) => step(ctx, kind, id, next),
});
