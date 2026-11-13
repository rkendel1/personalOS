/**
 * PersonalOS Anywhere: interactions from connected surfaces (contract: feltkit/_interaction.ts,
 * docs/INTERACTION-CONTRACT.md). A surface's bridge delivers an envelope; PersonalOS decides
 * everything else, in one transaction:
 *
 *   1. authenticate   the bridge's session (FeltKit) holds `interactions.receive`; the envelope
 *                     must name that same adapter
 *   2. idempotency    one interaction per (adapter, key): a repeated delivery returns the stored
 *                     outcome and executes nothing
 *   3. identity       the sender's source identity → the PersonalOS account of an *active* link
 *                     (links.ts), or a refusal. Names, handles and claims are never identity
 *   4. audience       a direct conversation with PersonalOS is private; anything else is shared, and
 *                     a shared reply never carries the owner's private data
 *   5. understand     a request about the conversation itself (summary, decisions, action items)
 *                     reads only the envelope's context; anything else is the deterministic assistant
 *                     (assistant.ts), unchanged, working for the linked owner
 *   6. execute        through the same operations as the chat (_ops.ts): verified, with evidence in
 *                     the action log; destructive changes become proposals the owner approves here
 *   7. record         the interaction, its PersonalOS conversation (the same thread on both
 *                     surfaces), its actions, and the updates the surface posts back
 *
 * The surface never executes anything and never decides what PersonalOS may do. Approvals stay in
 * PersonalOS (actions:approve, a person's act); their outcome is appended here as an update.
 */
import { fail, s } from "@feltdb/feltkit";
import type { MutationCtx } from "@feltdb/feltkit";
import { actions, app, conversations, identityLinks, interactions } from "./app.js";
import { audienceOf, conversationTitle, digest, Envelope, LINK_CODE, TERMINAL, threadKey, type EnvelopeT, type InteractionState } from "./_interaction.js";
import { actionItems, conversationIntent, decisions, summarize, type ConversationIntent } from "./_conversation.js";
import { appendMessage, respond } from "./assistant.js";
import { interpret } from "./_interpret.js";
import { clockFor } from "./_clock.js";
import * as ops from "./_ops.js";
import { linkActive, resolveExternal } from "./_resolver.js";
import { PRESENTED_TTL_MS } from "./links.js";
import { authorityPrincipal, capabilityFor } from "./_authority.js";
import { describeWork, workIn } from "./continuity.js";

/** How a surface's adapter id reads to people. */
const LABELS: Record<string, string> = { multiplayer: "Multiplayer" };
const label = (adapter: string) => LABELS[adapter] ?? adapter;

/** Intents whose reply only repeats what the requester just said, or nothing private: safe in a shared conversation. */
const SHAREABLE = new Set(["greet", "thanks", "help", "task.create", "remember", "project.create", "conversation.summary", "conversation.decisions", "conversation.actionItems", "unknown"]);
/** Intents that read the owner's private PersonalOS data. */
const PRIVATE_READS = new Set(["recall", "task.list", "briefing", "forgetting", "plan.week", "project.status", "task.complete", "task.reschedule", "task.delete", "forget", "confirm"]);

const Update = s.object({ seq: s.number(), state: s.string(), text: s.string(), at: s.number(), actionId: s.optional(s.string()) });

const Outcome = s.object({
  interactionId: s.string(),
  state: s.string(),
  replayed: s.boolean(),
  audience: s.string(),
  /** What the surface may post in the originating conversation (already limited to its audience). */
  reply: s.string(),
  updateSeq: s.number(),
  approval: s.nullable(s.object({ actionId: s.string(), summary: s.string(), reason: s.string() })),
  refusal: s.nullable(s.object({ code: s.string(), message: s.string() })),
  /** The PersonalOS conversation holding this interaction, for an "open in PersonalOS" link. */
  conversationId: s.nullable(s.string()),
});

type Doc = any;

function outcome(i: Doc, replayed: boolean) {
  const last = i.updates.at(-1);
  return {
    interactionId: i.id,
    state: i.state,
    replayed,
    audience: i.audience,
    reply: i.updates[0]?.text ?? "",
    updateSeq: last?.seq ?? 0,
    approval: i.approval ?? null,
    refusal: i.state === "refused" ? { code: i.error?.code ?? "REFUSED", message: i.error?.message ?? "" } : null,
    conversationId: i.conversationId ?? null,
  };
}

const clean = (text: string) => text.replace(/(^|\s)@personalos\b[:,]?/gi, " ").replace(/\s+/g, " ").trim();

export const receive = app.mutation({
  access: "interactions.receive",
  description: "A connected surface hands PersonalOS a request (personalos.interaction/1).",
  args: { envelope: Envelope },
  returns: Outcome,
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { envelope }) => {
    const e = envelope as EnvelopeT;
    const adapter = ctx.auth.requirePrincipal().id;
    // The adapter is the authenticated session, never what the envelope says about itself.
    if (e.source.adapter !== adapter) fail("FORBIDDEN", "This envelope names a different adapter than the session delivering it.");
    const key = `${adapter}:${e.idempotencyKey}`;
    const prior = (await ctx.db.find(interactions, { key }))[0];
    if (prior) return outcome(prior, true);

    const now = Date.now();
    const audience = audienceOf(e);
    const base = {
      adapter, key, envelope: e as unknown as Record<string, unknown>, audience, threadKey: threadKey(adapter, e),
      ...(e.source.sequence !== undefined ? { sourceSequence: e.source.sequence } : {}),
      actionIds: [] as string[], createdAt: now, updatedAt: now,
      provenance: { messageIds: [e.message.id], attachmentIds: e.message.attachments.map((a) => a.id), privateDataUsed: false },
    };
    const who = { sourcePrincipalId: e.sender.sourcePrincipalId, displayName: e.sender.displayName };
    const refuse = async (code: string, message: string) => {
      const id = await ctx.db.insert(interactions, { ...base, identity: { ...who, resolution: "unlinked" as const }, state: "refused", error: { code, message }, updates: [{ seq: 1, state: "refused", text: message, at: now }] });
      return outcome((await ctx.db.get(interactions, id))!, false);
    };

    // ── Linking: `link XXXX-XXXX`, only where nobody else can read it ──────────
    const code = LINK_CODE.exec(e.message.text);
    if (code) {
      if (audience !== "private") {
        // Others may have read it: burn it, so nobody can redeem it first.
        const [exposed] = await ctx.db.find(identityLinks, { codeDigest: await digest(`${code[1]}${code[2]}`) });
        if (exposed?.status === "pending") await ctx.db.delete(identityLinks, exposed.id);
      }
      if (audience !== "private") return refuse("LINK_NOT_PRIVATE", "Send link codes to me in a direct message, never in a shared conversation. That code is now unsafe: get a new one in PersonalOS → Settings → Connected surfaces.");
      const digested = await digest(`${code[1]}${code[2]}`);
      const [pending] = await ctx.db.find(identityLinks, { codeDigest: digested });
      if (!pending || pending.status !== "pending" || pending.adapter !== adapter || (pending.codeExpiresAt ?? 0) < now) return refuse("LINK_CODE_INVALID", "That code isn't valid (it may have expired or been used). Get a new one in PersonalOS → Settings → Connected surfaces.");
      const external = { adapter, instance: e.source.instance, principalId: e.sender.sourcePrincipalId };
      const current = await resolveExternal(ctx, external);
      if (current.status === "resolved" && current.owner !== pending.owner) return refuse("ALREADY_LINKED", "This account is already connected to a different PersonalOS account. Disconnect it there first.");
      if (current.status === "ambiguous") return refuse("AMBIGUOUS_IDENTITY", "This account resolves to more than one PersonalOS link, so I won't act until that is fixed. Disconnect it in PersonalOS → Settings → Connected surfaces.");
      // The code is used up here (one presentation per code), and nothing is linked yet: this records
      // which surface account presented it. The owner, signed in to PersonalOS, sees that account and
      // confirms it (links:confirm), which is what writes the link to Resolver. So a code someone else
      // saw cannot link their account, and a surface's bridge never writes an identity binding.
      await ctx.db.patch(identityLinks, pending.id, { status: "presented", sourcePrincipalId: e.sender.sourcePrincipalId, sourceDisplayName: e.sender.displayName, sourceInstance: e.source.instance, presentedAt: now, codeDigest: undefined, codeExpiresAt: now + PRESENTED_TTL_MS });
      const text = `Almost connected. Open PersonalOS → Settings → Connected surfaces and confirm that ${e.sender.displayName} on ${label(adapter)} is you. Until you do, I won't act for this account.`;
      const id = await ctx.db.insert(interactions, { ...base, owner: pending.owner, identity: { ...who, resolution: "link_presented", linkId: pending.id }, state: "completed", intent: "link", updates: [{ seq: 1, state: "completed", text, at: now }] });
      return outcome((await ctx.db.get(interactions, id))!, false);
    }

    // ── Identity: Resolver maps the authenticated source identity to a canonical account ──
    const resolved = await resolveExternal(ctx, { adapter, instance: e.source.instance, principalId: e.sender.sourcePrincipalId });
    if (resolved.status === "ambiguous") return refuse("AMBIGUOUS_IDENTITY", "Your account here resolves to more than one PersonalOS link, so I won't act for anyone until that is fixed in PersonalOS → Settings → Connected surfaces.");
    if (resolved.status !== "resolved") {
      return refuse("NOT_LINKED", `I don't know which PersonalOS account is yours yet, so I can't act for you. To connect: in PersonalOS open Settings → Connected surfaces → Connect ${label(adapter)}, then send me the code in a direct message ("link XXXX-XXXX").`);
    }
    const owner = resolved.owner;
    const [index] = (await ctx.db.find(identityLinks, { owner })).filter((l) => l.resolverRef === resolved.ref);
    // The owner disconnected it here and the identity agent is revoking it in Resolver: already refused.
    if (index && (index.status === "revoking" || index.status === "revoked")) return refuse("NOT_LINKED", `This account was disconnected from PersonalOS. To connect again: in PersonalOS open Settings → Connected surfaces → Connect ${label(adapter)}.`);
    if (index) await ctx.db.patch(identityLinks, index.id, { lastUsedAt: now });
    const octx = ops.actingFor(ctx, owner);
    const identity = { ...who, resolution: "linked" as const, ...(index ? { linkId: index.id } : {}), resolverRef: resolved.ref, resolverRevision: resolved.revision, canonical: resolved.canonical };

    const tk = base.threadKey;
    const clock = clockFor(e.sender.timeZone ?? null);
    const text = clean(e.message.text) || e.message.text;

    // ── Continuity: carry on one of your PersonalOS conversations here, or see its work ──
    const continuing = continuityIntent(text);
    if (continuing) {
      // The conversation this thread is on now (never a refused attempt's).
      const current = await threadConversation(ctx, tk, owner);
      const target = continuing.kind === "conversation.continue" ? continuing.conversationId : current;
      const record = async (state: InteractionState, reply: string, extra: Record<string, unknown> = {}) => {
        const id = await ctx.db.insert(interactions, { ...base, owner, identity, state, intent: continuing.kind, updates: [{ seq: 1, state, text: reply, at: now }], ...extra });
        return outcome((await ctx.db.get(interactions, id))!, false);
      };
      // Another person's work never crosses into a shared conversation: only a direct message with me.
      if (audience !== "private") return record("refused", "I only continue a conversation, or show its work, in a direct message with me, so nothing private lands in a shared conversation.", { error: { code: "CONTINUE_NOT_PRIVATE", message: "continuation needs a direct message" } });
      if (!target) return record("completed", "This conversation isn't connected to a PersonalOS conversation yet. To carry one on here, send “continue <conversation id>” (PersonalOS shows it under “Where this came from” in that conversation).");
      // Yours, or as good as nonexistent: another person's id says nothing about whether it exists.
      const conversation = await ctx.db.get(conversations, target);
      if (!conversation || conversation.owner !== owner) return record("refused", `There's no conversation ${target.slice(0, 40)} in your PersonalOS.`, { error: { code: "NOT_FOUND", message: "no such conversation for this account" } });
      // Continuing is not permission to reuse what was allowed before: AuthBoundry decides now.
      const capability = capabilityFor(continuing.kind);
      const decision = await ctx.authority.decide({ capability, onBehalfOf: authorityPrincipal(owner), context: { surface: adapter, audience, conversation: e.conversation.kind, interaction: key.slice(0, 200) } });
      const authority = {
        capability, outcome: decision.outcome, principal: decision.executor,
        ...(decision.onBehalfOf ? { onBehalfOf: decision.onBehalfOf } : {}), ...(decision.delegationId ? { delegationId: decision.delegationId } : {}),
        ...(decision.decisionId ? { decisionId: decision.decisionId } : {}), ...(decision.reason ? { reason: decision.reason } : {}),
      };
      if (decision.outcome === "unavailable" || decision.outcome === "invalid") fail("UNAVAILABLE", `The authority could not decide (${decision.reason ?? decision.outcome}); nothing was done.`);
      if (!decision.allowed) {
        // The denial is evidence of that conversation's history; the thread is not moved by it.
        return record("refused", `You aren't allowed to continue PersonalOS conversations through ${label(adapter)} (${capability}${decision.reason ? `: ${decision.reason}` : ""}). Nothing was shown or changed.`, { authority, conversationId: target, error: { code: "FORBIDDEN", message: `${capability} was not allowed${decision.reason ? `: ${decision.reason}` : ""}` } });
      }
      const work = describeWork(await workIn(ctx.db, owner, target));
      const lead = continuing.kind === "conversation.continue"
        ? `Continuing “${conversation.title}” here from ${label(adapter)}. What has happened in it, and where each part came from:`
        : `Where “${conversation.title}” stands, and where each part came from:`;
      const reply = `${lead}\n${work}`;
      const messageId = await appendMessage(octx, target, { role: "user", text: `${text}\n\n(from ${label(adapter)}, ${e.conversation.kind === "dm" ? "a direct message" : "a conversation"})`, interpretation: { intent: continuing.kind, source: "rules" } });
      const replyId = await appendMessage(octx, target, { role: "assistant", text: reply, interpretation: { intent: continuing.kind, source: "rules" } });
      return record("completed", reply, {
        authority, conversationId: target, messageId, replyId,
        ...(continuing.kind === "conversation.continue" ? { continuation: { conversationId: target, at: now } } : {}),
        provenance: { ...base.provenance, privateDataUsed: true },
      });
    }

    const about = e.context.messages.length ? conversationIntent(text) : null;
    const said: { text: string; completes?: string } = about ? { text } : await answerTo(ctx, tk, owner, e, text, clock.today);
    const understood = about ? null : interpret(said.text, clock.today as any).intent;

    // ── Authority: AuthBoundry decides on the exact capability, before anything runs ──
    const capability = capabilityFor(about?.kind ?? understood!.kind, { reminder: understood?.kind === "task.create" ? understood.reminder : false });
    // PersonalOS's executor asks to act on behalf of the resolved account: AuthBoundry decides from
    // that person's delegation to PersonalOS for exactly this capability, or denies.
    const decision = await ctx.authority.decide({ capability, onBehalfOf: authorityPrincipal(owner), context: { surface: adapter, audience, conversation: e.conversation.kind, interaction: key.slice(0, 200) } });
    const authority = {
      capability, outcome: decision.outcome, principal: decision.executor,
      ...(decision.onBehalfOf ? { onBehalfOf: decision.onBehalfOf } : {}),
      ...(decision.delegationId ? { delegationId: decision.delegationId } : {}),
      ...(decision.decisionId ? { decisionId: decision.decisionId } : {}),
      ...(decision.reason ? { reason: decision.reason } : {}),
    };
    if (decision.outcome === "unavailable" || decision.outcome === "invalid") fail("UNAVAILABLE", `The authority could not decide (${decision.reason ?? decision.outcome}); nothing was done.`);
    if (!decision.allowed) {
      const message = `You aren't allowed to do that through ${label(adapter)} (${capability}${decision.reason ? `: ${decision.reason}` : ""}). Nothing was done.`;
      const id = await ctx.db.insert(interactions, { ...base, owner, identity, authority, state: "refused", intent: about?.kind ?? understood!.kind, error: { code: "FORBIDDEN", message }, updates: [{ seq: 1, state: "refused", text: message, at: now }] });
      return outcome((await ctx.db.get(interactions, id))!, false);
    }

    // ── The PersonalOS conversation for this source thread (one history across surfaces) ──
    let conversationId = await threadConversation(ctx, tk, owner);
    conversationId ??= await ctx.db.insert(conversations, { owner, title: conversationTitle(label(adapter), e), createdAt: now, updatedAt: now, messageCount: 0 });
    if (!about && said.completes) await ctx.db.patch(interactions, said.completes, { state: "completed", updatedAt: now });

    let result: Result;
    try {
      result = about
        ? await aboutConversation(octx, about, e, conversationId, text)
        : await personal(octx, ctx, e, conversationId, said.text, clock.today, clock.tzOffset, audience);
    } catch (error) {
      const err = error as { code?: string; message?: string };
      if (!["NOT_FOUND", "FAILED_PRECONDITION", "INVALID_ARGUMENT"].includes(err.code ?? "")) throw error;
      const note = `I couldn't do that: ${String(err.message ?? err.code).replace(/[.!]+$/, "")}. Nothing was changed.`;
      await appendMessage(octx, conversationId, { role: "assistant", text: note });
      result = { state: "failed", intent: "error", reply: note, surface: note, actionIds: [], sources: [], privateDataUsed: false, error: { code: err.code!, message: String(err.message ?? "") } };
    }
    const approval = result.approval ?? null;
    const id = await ctx.db.insert(interactions, {
      ...base, owner, identity, authority, state: result.state, intent: result.intent, conversationId,
      ...(result.messageId ? { messageId: result.messageId } : {}), ...(result.replyId ? { replyId: result.replyId } : {}),
      actionIds: result.actionIds,
      ...(approval ? { approval } : {}),
      provenance: { messageIds: [...new Set([e.message.id, ...result.sources])], attachmentIds: base.provenance.attachmentIds, privateDataUsed: result.privateDataUsed },
      updates: [{ seq: 1, state: result.state, text: result.surface, at: now, ...(approval ? { actionId: approval.actionId } : {}) }],
      ...(result.error ? { error: result.error } : {}),
    });
    return outcome((await ctx.db.get(interactions, id))!, false);
  },
});

/**
 * The PersonalOS conversation a source thread is on: its latest interaction's, if that conversation is
 * still the owner's. A refused interaction never moves a thread (a denied "continue" leaves it where it was).
 */
async function threadConversation(ctx: MutationCtx, tk: string, owner: string): Promise<string | undefined> {
  for (const p of (await ctx.db.find(interactions, { threadKey: tk })).sort((a, b) => b.createdAt - a.createdAt)) {
    if (p.state === "refused") continue;
    if (p.owner === owner && p.conversationId && (await ctx.db.get(conversations, p.conversationId))?.owner === owner) return p.conversationId;
  }
  return undefined;
}

/** "continue <conversation id>", or a question about where this conversation's work stands. */
export function continuityIntent(text: string): { kind: "conversation.continue"; conversationId: string } | { kind: "conversation.work" } | null {
  const t = text.trim();
  const m = /^continue\s+(?:(?:the\s+)?conversation\s+)?([A-Za-z0-9_-]{8,64})\s*[.!]?$/i.exec(t);
  // A conversation id (FeltDB: letters and digits, 12+), never a word ("continue research").
  if (m && m[1]!.length >= 12 && /\d/.test(m[1]!) && /[a-z]/i.test(m[1]!)) return { kind: "conversation.continue", conversationId: m[1]! };
  if (/^(status|what'?s the status|what is the status|what did you find|what happened|where are we|where does it stand|any (news|updates?)|show (me )?(the )?(work|results?|evidence))\s*[?.!]*$/i.test(t)) return { kind: "conversation.work" };
  return null;
}

interface Result {
  state: InteractionState;
  intent: string;
  /** The full reply, in PersonalOS. */
  reply: string;
  /** What the surface may post (the reply, or less in a shared conversation). */
  surface: string;
  actionIds: string[];
  sources: string[];
  privateDataUsed: boolean;
  messageId?: string;
  replyId?: string;
  approval?: { actionId: string; summary: string; reason: string };
  error?: { code: string; message: string };
}

/** A request about the conversation itself: read only the envelope's context. */
async function aboutConversation(ctx: MutationCtx, intent: ConversationIntent, e: EnvelopeT, conversationId: string, text: string): Promise<Result> {
  const messageId = await appendMessage(ctx, conversationId, { role: "user", text, interpretation: { intent: intent.kind, source: "rules" } });
  const meta = { via: "chat" as const, conversationId, messageId };
  let reply: string;
  let sources: string[];
  const actionIds: string[] = [];
  if (intent.kind === "conversation.summary") ({ text: reply, sources } = summarize(e));
  else if (intent.kind === "conversation.decisions") ({ text: reply, sources } = decisions(e, intent.topic));
  else {
    const found = actionItems(e);
    sources = found.sources;
    const items = found.items ?? [];
    for (const item of items) {
      const notes = [`From ${conversationTitle(label(e.source.adapter), e)}${item.owner ? `; owner: ${item.owner}` : ""}${item.due ? `; ${item.due}` : ""}.`, `Source message: ${item.sourceMessageId}`].join("\n");
      const { actionId } = await ops.createTask(ctx, { title: item.owner && !/^I\b/.test(item.title) ? `${item.title} (${item.owner})`.slice(0, 200) : item.title.slice(0, 200), notes }, meta);
      actionIds.push(actionId);
    }
    reply = items.length
      ? [`Added ${items.length} task${items.length === 1 ? "" : "s"} to your PersonalOS from this conversation:`, ...items.map((i) => `• ${i.title}${i.owner ? ` — ${i.owner}` : ""}${i.due ? ` (${i.due})` : ""}`)].join("\n")
      : "I didn't find any action items here (nobody wrote \"I'll…\", \"we need to…\", \"can you…\"). Nothing was added.";
  }
  const replyId = await appendMessage(ctx, conversationId, { role: "assistant", text: reply, interpretation: { intent: intent.kind, source: "rules" }, actionIds });
  // Conversation answers use only what everyone in the conversation can read: shareable as they are.
  return { state: "completed", intent: intent.kind, reply, surface: reply, actionIds, sources, privateDataUsed: false, messageId, replyId };
}

/**
 * A short answer to an earlier clarifying question in the same thread completes that request
 * ("remind me to call Sarah" … "tomorrow at 10"). Only an earlier event: out-of-order delivery never
 * merges backwards. Returns the text to act on, and the interaction it completes.
 */
async function answerTo(ctx: MutationCtx, tk: string, owner: string, e: EnvelopeT, text: string, today: string): Promise<{ text: string; completes?: string }> {
  const asked = (await ctx.db.find(interactions, { threadKey: tk }))
    .filter((p) => p.owner === owner && p.state === "needs_clarification" && p.intent === "task.create" && (p.sourceSequence ?? 0) < (e.source.sequence ?? Number.MAX_SAFE_INTEGER))
    .sort((a, b) => (b.sourceSequence ?? 0) - (a.sourceSequence ?? 0))[0];
  if (!asked || interpret(text, today as any).intent.kind !== "unknown") return { text };
  const combined = `${clean(String((asked.envelope as any).message.text))} ${text}`;
  return interpret(combined, today as any).missing.length ? { text } : { text: combined, completes: asked.id };
}

/** A personal request: the deterministic assistant, working for the owner, then limited to the audience. */
async function personal(octx: MutationCtx, ctx: MutationCtx, e: EnvelopeT, conversationId: string, said: string, today: string, tzOffset: number, audience: "private" | "shared"): Promise<Result> {
  const r = await respond(octx, conversationId, said, today as any, tzOffset);
  const kind = r.intent.kind;
  const logged = await Promise.all((r.reply.actionIds ?? []).map((id) => ctx.db.get(actions, id)));
  const proposed = logged.find((a) => a?.status === "proposed");
  const unresolved = ["task.complete", "task.reschedule", "task.delete"].includes(kind) && !(r.reply.actionIds ?? []).length;
  const state: InteractionState = proposed ? "awaiting_approval" : r.missing.length || unresolved ? "needs_clarification" : "completed";
  const privateDataUsed = PRIVATE_READS.has(kind);
  const where = label(e.source.adapter);
  let surface = r.reply.text;
  let approval: Result["approval"];
  if (proposed) {
    const reason = proposed.kind === "task.delete" ? "Deleting a task is permanent." : proposed.kind === "memory.forget" ? "Forgetting a memory is permanent." : "It changes something that can't be undone.";
    approval = { actionId: proposed.id, summary: audience === "private" ? proposed.summary : `${proposed.kind === "task.delete" ? "Delete a task" : proposed.kind === "memory.forget" ? "Forget a memory" : "A change"} in your PersonalOS`, reason };
    surface = audience === "private"
      ? `${r.reply.text}\n\nApprove or decline it in PersonalOS (Activity, or this conversation there). Nothing changes until you do.`
      : `That needs your approval: ${approval.summary.charAt(0).toLowerCase()}${approval.summary.slice(1)}. ${reason} Approve or decline it in PersonalOS; nothing changes until you do, and I'll post the result here.`;
  } else if (audience === "shared" && kind === "unknown") {
    surface = `I can't do that from here: I have no integration or model for it, and I won't pretend otherwise. In a conversation I can summarize it, say what was decided, turn its action items into tasks in your PersonalOS, set reminders, and remember things for you.`;
  } else if (audience === "shared" && !SHAREABLE.has(kind)) {
    surface = state === "needs_clarification"
      ? `I need a detail to do that, and the question involves your private PersonalOS data, so I asked you in PersonalOS (or ask me in a direct message here).`
      : (r.reply.actionIds ?? []).length
        ? `Done in your PersonalOS. The details are there, since this conversation is shared.`
        : `That's about your private PersonalOS data, so I answered in PersonalOS instead of here. Ask me in a direct message to see it in ${where}.`;
  }
  return { state, intent: kind, reply: r.reply.text, surface, actionIds: r.reply.actionIds ?? [], sources: [], privateDataUsed, messageId: r.messageId, replyId: r.replyId, ...(approval ? { approval } : {}) };
}

/** What changed since `afterSeq`, for the surface to post. Refused once the owner disconnected the surface. */
/**
 * An interaction's state and its updates after `afterSeq`, for the surface's bridge. A mutation, not a
 * query: whether the link still holds is Resolver's answer (an integration call), which a query
 * cannot make. It changes nothing.
 */
export const status = app.mutation({
  access: "interactions.receive",
  args: { key: s.string({ minLength: 8, maxLength: 300 }), afterSeq: s.number() },
  returns: s.object({ state: s.string(), updates: s.array(Update), revoked: s.boolean() }),
  handler: async (ctx, { key, afterSeq }) => {
    const adapter = ctx.auth.requirePrincipal().id;
    const i = (await ctx.db.find(interactions, { key: `${adapter}:${key}` }))[0] ?? fail("NOT_FOUND", "No such interaction.");
    // Revoked in Resolver (the owner disconnected the surface): no more content for this surface.
    if (i.owner && i.identity.resolverRef && !(await linkActive(ctx, i.identity.resolverRef, i.owner))) return { state: i.state, updates: [], revoked: true };
    return { state: i.state, updates: i.updates.filter((u: any) => u.seq > afterSeq), revoked: false };
  },
});

/** The requester cancels from the surface: pending proposals are declined; nothing that already ran is undone. */
export const cancel = app.mutation({
  access: "interactions.receive",
  args: { key: s.string({ minLength: 8, maxLength: 300 }), sourcePrincipalId: s.string() },
  returns: s.object({ state: s.string(), updates: s.array(Update), revoked: s.boolean() }),
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { key, sourcePrincipalId }) => {
    const adapter = ctx.auth.requirePrincipal().id;
    const i = (await ctx.db.find(interactions, { key: `${adapter}:${key}` }))[0] ?? fail("NOT_FOUND", "No such interaction.");
    if (i.identity.sourcePrincipalId !== sourcePrincipalId) fail("FORBIDDEN", "Only the person who asked can cancel it.");
    if (!i.owner || !i.identity.resolverRef || !(await linkActive(ctx, i.identity.resolverRef, i.owner))) return { state: i.state, updates: [], revoked: !!i.owner };
    if (TERMINAL.has(i.state as InteractionState)) return { state: i.state, updates: [], revoked: false };
    const octx = ops.actingFor(ctx, i.owner);
    for (const id of i.actionIds) {
      const a = await ctx.db.get(actions, id);
      if (a?.owner === i.owner && a.status === "proposed") await ctx.db.patch(actions, id, { status: "rejected", decidedAt: Date.now() });
    }
    const text = `Cancelled from ${label(adapter)} by ${i.identity.displayName}. Nothing was changed.`;
    if (i.conversationId) await appendMessage(octx, i.conversationId, { role: "assistant", text, actionIds: i.actionIds });
    const update = { seq: (i.updates.at(-1)?.seq ?? 0) + 1, state: "cancelled", text: "Cancelled. Nothing was changed.", at: Date.now() };
    await ctx.db.patch(interactions, i.id, { state: "cancelled", updates: [...i.updates, update], updatedAt: Date.now() });
    announce(ctx, i, update);
    return { state: "cancelled", updates: [update], revoked: false };
  },
});

/**
 * The durable event a surface receives when one of its interactions changes (Studio → Webhooks: the
 * surface's inbound endpoint). It is emitted in the transaction that records the update, so it exists
 * exactly when the update does; AppPort Services signs, retries and records each delivery. It names
 * the interaction only (the surface's own idempotency key, workspace, seq, state): the surface fetches
 * the content with its bridge session (interactions:status), which refuses once the person
 * disconnected that surface, so no private result travels in an event.
 */
function announce(ctx: MutationCtx, i: { adapter: string; key: string; envelope: unknown }, update: { seq: number; state: string }) {
  const e = i.envelope as EnvelopeT;
  ctx.afterCommit.webhooks.emit("interaction.updated", {
    adapter: i.adapter,
    key: i.key.slice(i.adapter.length + 1),
    instance: e.source.instance,
    workspaceId: e.conversation.workspaceId,
    seq: update.seq,
    state: update.state,
  });
}

/**
 * Called by actions:approve / actions:reject (as the owner): the decision on a proposal an
 * interaction made becomes that interaction's next update, which its surface posts back.
 */
export async function settle(ctx: MutationCtx, proposal: { id: string; messageId?: string; summary: string }, decision: "approved" | "rejected" | "failed", detail: string) {
  if (!proposal.messageId) return;
  const owner = ops.me(ctx);
  const i = (await ctx.db.find(interactions, { owner, messageId: proposal.messageId }))[0];
  if (!i || !i.actionIds.includes(proposal.id) || TERMINAL.has(i.state as InteractionState)) return;
  const stillWaiting = (await Promise.all(i.actionIds.filter((id: string) => id !== proposal.id).map((id: string) => ctx.db.get(actions, id)))).some((a) => a?.status === "proposed");
  const state: InteractionState = stillWaiting ? "awaiting_approval" : decision === "approved" ? "completed" : decision === "rejected" ? "cancelled" : "failed";
  const shared = i.audience === "shared";
  const text = decision === "approved"
    ? shared ? "Approved in PersonalOS and done." : `Approved in PersonalOS and done: ${detail}.`
    : decision === "rejected"
      ? shared ? "Declined in PersonalOS. Nothing was changed." : `Declined in PersonalOS: ${proposal.summary}. Nothing was changed.`
      : shared ? "Approved, but it couldn't be done (what it referred to no longer exists). Nothing was changed." : `Approved, but it couldn't be done: ${detail}. Nothing was changed.`;
  const update = { seq: (i.updates.at(-1)?.seq ?? 0) + 1, state, text, at: Date.now(), actionId: proposal.id };
  await ctx.db.patch(interactions, i.id, { state, updates: [...i.updates, update], updatedAt: Date.now() });
  announce(ctx, i, update);
}

/** What connected surfaces asked of you, newest first, with where it came from and what informed it. */
export const list = app.query({
  access: "interactions.read",
  args: { limit: s.optional(s.number()) },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db.find(interactions, { owner: ops.me(ctx) }, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: Math.min(limit ?? 50, 200) });
    return rows.map((i) => {
      const e = i.envelope as unknown as EnvelopeT;
      return {
        id: i.id, adapter: i.adapter, surface: label(i.adapter), state: i.state, intent: i.intent ?? null, audience: i.audience,
        where: conversationTitle(label(i.adapter), e), workspace: e.conversation.workspaceName ?? null, from: i.identity.displayName,
        text: e.message.text, conversationId: i.conversationId ?? null, actionIds: i.actionIds, provenance: i.provenance,
        context: { scope: e.context.scope, messages: e.context.messages.length, truncated: e.context.limits.truncated },
        identity: { source: i.identity.sourcePrincipalId, canonical: i.identity.canonical ?? null, resolverRef: i.identity.resolverRef ?? null, resolverRevision: i.identity.resolverRevision ?? null },
        authority: i.authority ?? null,
        updates: i.updates, createdAt: i.createdAt,
      };
    });
  },
});
