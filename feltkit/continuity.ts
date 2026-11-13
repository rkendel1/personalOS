/**
 * Continuity: one conversation, whatever surface each part of it came through. This gathers what is
 * already recorded about a conversation (no second store): every Multiplayer interaction
 * (`interactions`), every invocation from the browser or iOS (`invocations`), the research and tasks
 * they started, and keeps each one's own provenance apart:
 *
 *   surface     where that part came from (Multiplayer, your browser, iOS), not where you are now
 *   asked       what the person asked there, in their words
 *   shared      what they shared there (each share is its own evidence; nothing replaces it)
 *   inferred    how PersonalOS read it (rules or a model)
 *   authority   AuthBoundry's decision at the time it ran (never reused: each continuation asks again)
 *   did         what PersonalOS did, and the state it is in now
 *
 * Read by PersonalOS's chat (`continuity:of`) and by a continued Multiplayer thread ("status").
 */
import { fail, s } from "@feltdb/feltkit";
import { app, conversations, interactions, invocations, researchRuns, tasks } from "./app.js";
import { surfaceLabel } from "./_invocation.js";
import * as ops from "./_ops.js";

export interface WorkEntry {
  at: number;
  kind: "interaction" | "invocation" | "research" | "task";
  surface: string;
  asked: string | null;
  shared: string[];
  inferred: string | null;
  authority: { capability: string; outcome: string; delegationId?: string; decisionId?: string; reason?: string } | null;
  did: string;
  state: string;
  ref: string;
  /** An invocation waiting for its owner to run it from PersonalOS (asked from X): its id. */
  run?: string;
  /** Asked from X: the post, which the owner may explicitly reply to (xsurface:publish). */
  xPostId?: string;
}

type Db = { find(c: unknown, f: Record<string, unknown>): Promise<any[]> };

const ADAPTERS: Record<string, string> = { multiplayer: "Multiplayer", x: "X" };
const authorityOf = (a: any) => (a ? { capability: a.capability, outcome: a.outcome, ...(a.delegationId ? { delegationId: a.delegationId } : {}), ...(a.decisionId ? { decisionId: a.decisionId } : {}), ...(a.reason ? { reason: String(a.reason) } : {}) } : null);

/** Everything recorded about this conversation's work, oldest first. The owner must already be checked. */
export async function workIn(db: Db, owner: string, conversationId: string): Promise<WorkEntry[]> {
  const entries: WorkEntry[] = [];
  for (const i of (await db.find(interactions, { owner })).filter((x) => x.conversationId === conversationId)) {
    const e = i.envelope as { message?: { text?: string }; conversation?: { kind?: string; name?: string } };
    entries.push({
      at: i.createdAt, kind: "interaction", surface: `${ADAPTERS[i.adapter] ?? i.adapter}${e.conversation?.kind === "dm" ? " (direct message)" : e.conversation?.name ? ` (#${e.conversation.name})` : ""}`,
      asked: e.message?.text ?? null, shared: [], inferred: i.intent ?? null, authority: authorityOf(i.authority),
      did: i.continuation ? `continued this conversation from ${ADAPTERS[i.adapter] ?? i.adapter}` : (i.updates?.at(-1)?.text ?? "").slice(0, 300),
      state: i.state, ref: `interaction ${i.id}`,
    });
  }
  for (const v of (await db.find(invocations, { owner })).filter((x) => x.conversationId === conversationId)) {
    entries.push({
      at: v.receivedAt, kind: "invocation", surface: surfaceLabel(v.surface.adapter) === "your browser" ? "Chrome (your browser)" : v.surface.adapter === "x" ? `X${v.surface.device ? ` (${v.surface.device})` : ""}` : surfaceLabel(v.surface.adapter),
      asked: v.instruction || null,
      shared: v.context.map((c: any) => (c.kind === "url" ? `${c.title ? `${c.title} ` : ""}${c.url}` : c.kind === "selection" ? `selected text from ${c.url ?? "a page"} (${(c.text ?? "").length} chars)` : c.kind === "page" ? `the text of ${c.url} (${(c.text ?? "").length} chars)` : c.kind === "document" ? `${c.name ?? "a document"}` : `text (${(c.text ?? "").length} chars)`)),
      inferred: v.interpretation ? `${v.interpretation.intent} (${v.interpretation.basis === "model" ? "a model's reading" : "rules"})` : null,
      authority: authorityOf(v.authority),
      did: (v.updates?.at(-1)?.text ?? "").slice(0, 400), state: v.state, ref: `invocation ${v.invocationId}`,
      ...(v.state === "needs_approval" && v.work?.waitingFor === "owner" ? { run: v.invocationId } : {}),
      ...(v.surface.adapter === "x" && /^x-[0-9]{1,19}$/.test(v.invocationId) ? { xPostId: v.invocationId.slice(2) } : {}),
    });
  }
  for (const r of (await db.find(researchRuns, { owner })).filter((x) => x.conversationId === conversationId)) {
    entries.push({
      at: r.createdAt, kind: "research", surface: r.invocationId ? "started by an invocation" : "PersonalOS",
      asked: null, shared: r.seed ? [r.seed.url] : [], inferred: r.plan ? `${r.kind} of ${r.product} (${r.plan.basis === "model" ? "a model's plan" : "rules"}${r.plan.scope === "this" ? ", the shared organization" : ""})` : null,
      authority: null,
      did: `${r.prospectCount ?? 0} result(s); ${r.blocker ? `stopped: ${r.blocker.detail}` : (r.steps?.at(-1)?.outcome ?? "started")}`.slice(0, 400),
      state: r.status, ref: `research ${r.id}`,
    });
  }
  for (const t of (await db.find(tasks, { owner })).filter((x) => x.source?.conversationId === conversationId)) {
    entries.push({ at: t.createdAt, kind: "task", surface: "PersonalOS", asked: null, shared: [], inferred: null, authority: null, did: `task "${t.title}"${t.remindAt ? `, reminder ${new Date(t.remindAt).toISOString()}` : ""}`, state: t.status, ref: `task ${t.id}` });
  }
  return entries.sort((a, b) => a.at - b.at);
}

/** The work as text: each line its surface, what was asked and shared, the decision, and where it stands. */
export function describeWork(entries: WorkEntry[]): string {
  if (!entries.length) return "Nothing has been done in this conversation yet.";
  return entries.map((w) => {
    const parts = [`• ${w.surface}${w.kind === "research" || w.kind === "task" ? ` — ${w.kind}` : ""}: ${w.state}`];
    if (w.asked) parts.push(`asked "${w.asked.slice(0, 160)}"`);
    if (w.shared.length) parts.push(`shared ${w.shared.join("; ").slice(0, 300)}`);
    if (w.authority) parts.push(`authority ${w.authority.capability}: ${w.authority.outcome}${w.authority.delegationId ? ` (delegation ${w.authority.delegationId})` : ""}${w.authority.reason ? ` (${w.authority.reason})` : ""}`);
    if (w.did) parts.push(w.did.replace(/\s+/g, " ").slice(0, 300));
    return parts.join(" · ");
  }).join("\n");
}

/** One conversation's work, with where each part came from: for the chat's "Where this came from". */
export const of = app.query({
  access: "conversations.read",
  args: { conversationId: s.string() },
  handler: async (ctx, { conversationId }) => {
    const owner = ops.me(ctx);
    const conversation = await ctx.db.get(conversations, conversationId);
    if (!conversation || conversation.owner !== owner) fail("NOT_FOUND", `No conversation ${conversationId}.`);
    return { conversationId, title: conversation.title, entries: await workIn(ctx.db, owner, conversationId), continueWith: `continue ${conversationId}` };
  },
});
