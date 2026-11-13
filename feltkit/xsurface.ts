/**
 * X as a surface for PersonalOS: mention the bot account (@anywhereaide) and PersonalOS works for
 * you, in your own PersonalOS, with nothing private posted publicly. Not another agent and not another
 * store: a mention becomes a `personalos.invocation/1` record (surface `x`) in your conversation,
 * handled by the same assistant, the same AuthBoundry decisions and the same research as every surface.
 *
 * Two identities, never confused (feltkit/_x.ts):
 *   the bot     the `x` integration's token: PersonalOS may read the bot's mentions and post as the bot.
 *   a person    the mention's author as X's API reports it (`author_id`), resolved through a link that
 *               person confirmed in PersonalOS (Resolver, adapter `x`, links.ts). Unlinked, revoked or
 *               ambiguous: nothing is done for anyone. Text in a post is never identity or authority.
 *
 * Lifecycle (durable at every step; each step idempotent):
 *   startPolling   the X adapter's service session (role xadapter) starts a chain of `x.poll` jobs.
 *                  Polling, not webhooks: X's webhooks need a public HTTPS endpoint answering CRC
 *                  challenges, which this deployment does not have.
 *   poll (job)     reads new mentions (since the last one seen), hands each to `receive` oldest first,
 *                  delivers waiting replies, and queues the next poll. A mention that cannot be handled
 *                  now (Resolver or AuthBoundry unreachable) stops the cursor there: it is read again.
 *   receive        one record per post id (unique), so a mention read twice is handled once:
 *                    a link code   presents the author's X account on that code; the owner confirms it
 *                    unlinked      recorded, nothing done, no reply (no engagement with strangers)
 *                    linked        an invocation in the owner's conversation: the X thread continues
 *                                  the same conversation for the same author only; `continue <id>`
 *                                  points it at another of their conversations (AuthBoundry decides)
 *                  Notes, tasks and reminders run now for the owner after AuthBoundry allows them (as
 *                  for Multiplayer). Research and model answers wait for the owner to run them in
 *                  PersonalOS: FeltKit runs work as the principal that queued it, and only the owner's
 *                  own session may run research for them.
 *   replies        a generic acknowledgement, never a result. Each reply is posted at most once:
 *                  claimed before sending, sent with an idempotency key (FeltKit refuses to resend a
 *                  call whose outcome it could not see), and an unclear outcome is left `unknown` for a
 *                  person to check, never retried.
 *   publish        the owner's explicit act in PersonalOS, decided by AuthBoundry
 *                  (personalos.x.publish), with the exact text they wrote. Nothing is published
 *                  because a post asked for it.
 */
import { fail, s, type ActionCtx, type MutationCtx } from "@feltdb/feltkit";
import { api } from "./_generated/api.js";
import { actions, app, conversations, identityLinks, invocations, xPosts, xState } from "./app.js";
import { acknowledgement, commandOf, instructionOf, MENTION_FIELDS, newer, postUrl, publication, readMentions, X_ADAPTER, X_INSTANCE, type Mention } from "./_x.js";
import { digest } from "./_interaction.js";
import { describeContext, intentByRules, INVOCATION_CONTRACT, InvocationRefusal, normalizeInvocation } from "./_invocation.js";
import { authorityPrincipal, capabilityFor } from "./_authority.js";
import { resolveExternal } from "./_resolver.js";
import { PRESENTED_TTL_MS } from "./links.js";
import { appendMessage, respond } from "./assistant.js";
import { interpret } from "./_interpret.js";
import { clockFor } from "./_clock.js";
import { moveInvocation, saveShared } from "./invocationstate.js";
import { assistantText, requestText } from "./invocations.js";
import * as ops from "./_ops.js";

const KEY = "mentions";
const DEFAULT_INTERVAL_MS = 120_000;
/** Pages of 100 mentions read per poll (X's maximum page size). */
const MAX_PAGES = 3;
/** How long a reply X rate-limited (429) waits before it is tried again (X's limits are per 15 minutes). */
/** How often the bot's account is read again from X, to pick up a renamed handle. */
const BOT_RECHECK_MS = 60 * 60_000;
const retryAfterMs = () => Number(process.env.X_REPLY_RETRY_MS ?? 15 * 60_000);
const due = (r: { status: string; limitedAt?: number }) => r.status === "pending" && (!r.limitedAt || Date.now() >= r.limitedAt + retryAfterMs());
/** Attempts to post one reply that never reached X before it is reported failed. */
const MAX_REPLY_ATTEMPTS = 5;
const ID = s.string({ pattern: "^[0-9]{1,19}$" });

const MentionArg = s.object({
  id: ID, text: s.string({ maxLength: 4000 }), authorId: ID, authorUsername: s.optional(s.string({ maxLength: 50 })),
  conversationId: s.optional(ID), inReplyToPostId: s.optional(ID), createdAt: s.optional(s.string({ maxLength: 40 })),
  referenced: s.array(s.object({ type: s.string({ maxLength: 20 }), id: ID, authorId: s.optional(ID), text: s.optional(s.string({ maxLength: 4000 })) })),
});
const Received = s.object({
  postId: s.string(), state: s.string(), replayed: s.boolean(),
  invocationId: s.nullable(s.string()), conversationId: s.nullable(s.string()),
  refusal: s.nullable(s.object({ code: s.string(), message: s.string() })),
});

const received = (p: any, replayed: boolean) => ({
  postId: p.postId, state: p.state, replayed, invocationId: p.invocationId ?? null, conversationId: p.conversationId ?? null, refusal: p.refusal ?? null,
});
const reply = (kind: "acknowledgement" | "publication", text: string, extra: Record<string, unknown> = {}) => ({ kind, text, status: "pending" as const, attempts: 0, requestedAt: Date.now(), ...extra });

// ── Polling ──────────────────────────────────────────────────────────────────────────────────

/** Start (or restart) polling the bot's mentions. The X adapter's session; its jobs run as it. */
export const startPolling = app.mutation({
  access: "x.poll",
  args: { intervalMs: s.optional(s.integer({ minimum: 15_000, maximum: 3_600_000 })) },
  handler: async (ctx, { intervalMs }) => {
    const chain = await ctx.crypto.token(16);
    const [st] = await ctx.db.find(xState, { key: KEY });
    const patch = { running: true, intervalMs: intervalMs ?? st?.intervalMs ?? DEFAULT_INTERVAL_MS, chain, tick: 0, startedBy: ctx.auth.requirePrincipal().id };
    if (st) await ctx.db.patch(xState, st.id, patch);
    else await ctx.db.insert(xState, { key: KEY, ...patch });
    ctx.afterCommit.jobs.enqueue("x.poll", { chain, tick: 0 }, { maxAttempts: 3 });
    return { chain };
  },
});

export const stopPolling = app.mutation({
  access: "x.poll",
  handler: async (ctx) => {
    const [st] = await ctx.db.find(xState, { key: KEY });
    if (st) await ctx.db.patch(xState, st.id, { running: false, chain: undefined });
  },
});

/** The token belongs to another account than the one polling began with: stop, and say why. */
export const stopForOtherAccount = app.mutation({
  access: "x.poll",
  args: { message: s.string({ maxLength: 500 }) },
  handler: async (ctx, { message }) => {
    const [st] = await ctx.db.find(xState, { key: KEY });
    if (st) await ctx.db.patch(xState, st.id, { running: false, chain: undefined, lastError: message });
  },
});

export const pollState = app.query({ access: "x.poll", handler: async (ctx) => (await ctx.db.find(xState, { key: KEY }))[0] ?? null });

/** The bot account, as X reported it for the token (GET /2/users/me). */
export const botIs = app.mutation({
  access: "x.poll",
  args: { id: ID, username: s.string({ maxLength: 50 }) },
  handler: async (ctx, { id, username }) => {
    const [st] = await ctx.db.find(xState, { key: KEY });
    if (st) await ctx.db.patch(xState, st.id, { botUserId: id, botUsername: username, botCheckedAt: Date.now() });
  },
});

/** After failures in a row, the wait doubles (at most 30 minutes); one success resets it. */
const MAX_BACKOFF_MS = 30 * 60_000;
export const nextDelay = (intervalMs: number, failures: number) => Math.min(intervalMs * 2 ** Math.min(failures, 6), Math.max(intervalMs, MAX_BACKOFF_MS));

/**
 * A poll starts: it takes its tick and queues the next poll FIRST, so the chain goes on whatever
 * happens to this one (an error, a throw, a crash). A retried or stale job finds its tick taken and
 * does nothing.
 */
export const beginPoll = app.mutation({
  access: "x.poll",
  args: { chain: s.string(), tick: s.integer() },
  returns: s.object({ go: s.boolean() }),
  handler: async (ctx, a) => {
    const [st] = await ctx.db.find(xState, { key: KEY });
    if (!st || !st.running || st.chain !== a.chain || (st.tick ?? 0) !== a.tick) return { go: false };
    await ctx.db.patch(xState, st.id, { tick: a.tick + 1 });
    ctx.afterCommit.jobs.enqueue("x.poll", { chain: a.chain, tick: a.tick + 1 }, { runAt: new Date(Date.now() + nextDelay(st.intervalMs, st.failures ?? 0)).toISOString(), maxAttempts: 3 });
    return { go: true };
  },
});

/** A poll is done: where the cursor is now (it never moves back), and what went wrong, if anything. */
export const polled = app.mutation({
  access: "x.poll",
  args: { chain: s.string(), sinceId: s.optional(ID), error: s.optional(s.string({ maxLength: 500 })), baselined: s.optional(s.boolean()) },
  handler: async (ctx, a) => {
    const [st] = await ctx.db.find(xState, { key: KEY });
    if (!st || st.chain !== a.chain) return;
    await ctx.db.patch(xState, st.id, {
      polledAt: Date.now(),
      ...(a.sinceId && newer(a.sinceId, st.sinceId) ? { sinceId: a.sinceId } : {}),
      ...(a.baselined && !st.baselineAt ? { baselineAt: Date.now() } : {}),
      lastError: a.error,
      failures: a.error ? (st.failures ?? 0) + 1 : 0,
    });
  },
});

/** The `x.poll` job. */
export const poll = app.action({
  access: "x.poll",
  args: { chain: s.string(), tick: s.integer() },
  handler: async (ctx, { chain, tick }) => {
    const st = (await ctx.runQuery(api.xsurface.pollState, {})) as any;
    if (!st?.running || st.chain !== chain || (st.tick ?? 0) !== tick) return { stopped: true };
    if (!((await ctx.runMutation(api.xsurface.beginPoll, { chain, tick })) as { go: boolean }).go) return { stopped: true };
    let sinceId: string | undefined = st.sinceId;
    let error: string | undefined;
    let handled = 0;
    try {
      let bot = st.botUserId ? { id: st.botUserId as string, username: st.botUsername as string } : null;
      if (!bot || !st.botCheckedAt || Date.now() - st.botCheckedAt > BOT_RECHECK_MS) {
        const me = (await ctx.integrations.invoke("x.me", {})) as { data?: { id?: unknown; username?: unknown } };
        const id = me?.data?.id, username = me?.data?.username;
        if (typeof id !== "string" || !/^[0-9]{1,19}$/.test(id) || typeof username !== "string") throw new Error("X did not say which account the token belongs to (GET /2/users/me).");
        // A renamed account keeps its id, so only the handle changes. A different id means the token now
        // belongs to another account: its mentions are not this cursor's, so stop rather than mix them.
        if (bot && bot.id !== id) {
          await ctx.runMutation(api.xsurface.stopForOtherAccount, { message: `The X token now belongs to a different account (${username}, not ${bot.username}). Polling stopped on purpose: connect the intended account, then start polling again.` });
          return { stopped: true };
        }
        bot = { id, username };
        await ctx.runMutation(api.xsurface.botIs, bot);
      }
      const seen: Mention[] = [];
      let newest: string | undefined;
      let token: string | undefined;
      for (let page = 0; page < MAX_PAGES; page++) {
        const body = await ctx.integrations.invoke("x.mentions", { id: bot.id, ...(st.sinceId ? { since_id: st.sinceId } : {}), ...(token ? { pagination_token: token } : {}), max_results: 100, ...MENTION_FIELDS });
        const r = readMentions(body);
        seen.push(...r.mentions);
        if (r.newestId && newer(r.newestId, newest)) newest = r.newestId;
        if (!r.nextToken) break;
        token = r.nextToken;
      }
      if (!st.sinceId && !st.baselineAt) {
        // The first poll: mentions from before polling started are history, not requests. Start from now.
        sinceId = newest;
      } else {
        const ordered = [...new Map(seen.map((m) => [m.id, m])).values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
        for (const m of ordered) {
          try { await ctx.runMutation(api.xsurface.receive, { mention: m, bot }); } catch (e) {
            // Not handled (nothing of it was committed): stop here, and read it again next time.
            error = `post ${m.id}: ${String((e as Error).message ?? e).slice(0, 300)}`;
            break;
          }
          handled++;
          if (newer(m.id, sinceId)) sinceId = m.id;
        }
        if (!error && newest && token === undefined && newer(newest, sinceId)) sinceId = newest;
      }
    } catch (e) {
      const err = e as { code?: string; message?: string };
      error = `${err.code ?? "ERROR"}: ${String(err.message ?? e).slice(0, 400)}`;
    }
    try {
      for (const r of (await ctx.runQuery(api.xsurface.waitingReplies, {})) as Array<{ postId: string; index: number }>) await sendReply(ctx, r.postId, r.index);
    } catch (e) {
      error ??= `replies: ${String((e as Error).message ?? e).slice(0, 400)}`;
    }
    await ctx.runMutation(api.xsurface.polled, { chain, ...(sinceId ? { sinceId } : {}), ...(error ? { error: error.slice(0, 500) } : { baselined: true }) });
    return { handled, sinceId: sinceId ?? null, error: error ?? null };
  },
});

// ── Receiving one mention ────────────────────────────────────────────────────────────────────

/** The owner's time zone, as their own devices last reported it (for "tomorrow at 9"); UTC otherwise. */
async function zoneOf(ctx: MutationCtx, owner: string): Promise<string | null> {
  const recent = (await ctx.db.find(invocations, { owner }, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: 20 })).find((i: any) => i.timeZone && i.surface.adapter !== X_ADAPTER);
  return recent?.timeZone ?? null;
}

/**
 * Hand PersonalOS one mention of the bot account (from `poll`). Idempotent per post id. Throws only
 * when it cannot decide now (identity or authority unreachable): then nothing is recorded, and the
 * same mention is handled on the next poll.
 */
export const receive = app.mutation({
  access: "x.receive",
  args: { mention: MentionArg, bot: s.object({ id: ID, username: s.optional(s.string({ maxLength: 50 })) }) },
  returns: Received,
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { mention: m, bot }) => {
    const prior = (await ctx.db.find(xPosts, { postId: m.id }))[0];
    if (prior) return received(prior, true);
    const now = Date.now();
    const base = {
      postId: m.id, authorId: m.authorId, ...(m.authorUsername ? { authorUsername: m.authorUsername } : {}), botUserId: bot.id,
      ...(m.conversationId ? { xConversationId: m.conversationId } : {}), ...(m.inReplyToPostId ? { inReplyToPostId: m.inReplyToPostId } : {}),
      text: m.text, referenced: m.referenced, ...(m.createdAt ? { createdAt: m.createdAt } : {}), receivedAt: now, replies: [] as any[], updatedAt: now,
    };
    const record = async (state: "ignored" | "refused" | "linking" | "invoked", extra: Record<string, unknown> = {}) => {
      const id = await ctx.db.insert(xPosts, { ...base, state, ...extra } as any);
      const p = (await ctx.db.get(xPosts, id))!;
      if ((p.replies as any[]).length) ctx.afterCommit.jobs.enqueue("x.reply", { postId: m.id, index: 0 }, { maxAttempts: 2 });
      return received(p, false);
    };
    if (m.authorId === bot.id) return record("ignored", { refusal: { code: "OWN_POST", message: "The bot's own post." } });

    const instruction = instructionOf(m.text);
    const command = commandOf(instruction);
    const handle = m.authorUsername ? `@${m.authorUsername}` : `X account ${m.authorId}`;
    // The author as X's API reported it: the only identity used.
    const external = { adapter: X_ADAPTER, instance: X_INSTANCE, principalId: m.authorId };

    // ── Linking: the author proves control of this X account by posting the code PersonalOS showed ──
    if (command.kind === "link") {
      const [pending] = await ctx.db.find(identityLinks, { codeDigest: await digest(command.code) });
      if (!pending || pending.status !== "pending" || pending.adapter !== X_ADAPTER || (pending.codeExpiresAt ?? 0) < now) {
        return record("refused", { refusal: { code: "LINK_CODE_INVALID", message: "No such link code (expired, used, or for another surface)." } });
      }
      const current = await resolveExternal(ctx, external);
      if (current.status === "ambiguous" || (current.status === "resolved" && current.owner !== pending.owner)) {
        // A posted code is public: it is used up whatever happens.
        await ctx.db.patch(identityLinks, pending.id, { status: "revoked", revokedAt: now, codeDigest: undefined, codeExpiresAt: undefined, error: "That X account is already connected to a different PersonalOS account." });
        return record("refused", { refusal: { code: current.status === "ambiguous" ? "AMBIGUOUS_IDENTITY" : "ALREADY_LINKED", message: "This X account is already connected elsewhere." } });
      }
      // Used up now (one presentation per code). Nothing is linked yet: the owner sees this X account in
      // PersonalOS and confirms it is theirs (links:confirm), which is what writes the link to Resolver.
      // The code is public once posted, but it was already used by the first post that carried it, and
      // a post by someone else would show *their* account, which the owner does not confirm.
      await ctx.db.patch(identityLinks, pending.id, { status: "presented", sourcePrincipalId: m.authorId, sourceDisplayName: handle, sourceInstance: X_INSTANCE, presentedAt: now, codeDigest: undefined, codeExpiresAt: now + PRESENTED_TTL_MS, error: undefined });
      return record("linking", { owner: pending.owner, replies: [reply("acknowledgement", acknowledgement("link", m.id))] });
    }

    // ── Identity: the author's X account → the PersonalOS account it was verifiably linked to ──
    const resolved = await resolveExternal(ctx, external);
    if (resolved.status === "ambiguous") return record("refused", { refusal: { code: "AMBIGUOUS_IDENTITY", message: "This X account resolves to more than one PersonalOS link." } });
    // Strangers get nothing: no work, no reply (the bot does not engage with accounts it doesn't know).
    if (resolved.status !== "resolved") return record("refused", { refusal: { code: "NOT_LINKED", message: `${handle} is not connected to a PersonalOS account.` } });
    const owner = resolved.owner;
    const [index] = (await ctx.db.find(identityLinks, { owner })).filter((l) => l.resolverRef === resolved.ref);
    if (index && (index.status === "revoking" || index.status === "revoked")) return record("refused", { owner, refusal: { code: "NOT_LINKED", message: "This X account was disconnected from PersonalOS." } });
    if (index) await ctx.db.patch(identityLinks, index.id, { lastUsedAt: now });
    const octx = ops.actingFor(ctx, owner);
    const identity = { resolverRef: resolved.ref, resolverRevision: resolved.revision };

    // ── Which conversation: this author's earlier mentions in this X thread, or an explicit one ──
    let conversationId = await threadConversation(ctx, owner, m);
    let text = command.kind === "continue" ? command.rest : instruction;
    let continued: { decision: Record<string, unknown>; allowed: boolean } | null = null;
    let missing = false;
    if (command.kind === "continue") {
      const target = await ctx.db.get(conversations, command.conversationId);
      if (!target || target.owner !== owner) missing = true;
      else {
        const decision = await ctx.authority.decide({ capability: "personalos.conversation.continue", onBehalfOf: authorityPrincipal(owner), context: { surface: X_ADAPTER, post: m.id } });
        if (decision.outcome === "unavailable" || decision.outcome === "invalid") fail("UNAVAILABLE", `The authority could not decide (${decision.reason ?? decision.outcome}).`);
        continued = { decision: authorityOf("personalos.conversation.continue", decision), allowed: decision.allowed };
        conversationId = command.conversationId;
      }
    }
    conversationId ??= await ctx.db.insert(conversations, { owner, title: `X: ${handle}${text ? ` — ${text}` : ""}`.slice(0, 60), createdAt: now, updatedAt: now, messageCount: 0 });

    // ── The invocation: what was asked, what the thread showed (data), and where it came from ──
    const context = [
      ...m.referenced.filter((r) => r.text?.trim()).map((r) => ({ kind: "text" as const, text: r.text!, url: postUrl(r.id), title: `${r.type === "quoted" ? "Quoted" : r.type === "replied_to" ? "Replied-to" : "Referenced"} post on X` })),
      { kind: "url" as const, url: postUrl(m.id), title: `Post by ${handle} on X` },
    ];
    let n;
    try {
      n = normalizeInvocation({ invocationId: `x-${m.id}`, surface: { adapter: X_ADAPTER, device: handle }, instruction: text.slice(0, 2000), context, submittedAt: m.createdAt && Number.isFinite(Date.parse(m.createdAt)) ? Date.parse(m.createdAt) : now, correlation: { conversationId } });
    } catch (error) {
      if (!(error instanceof InvocationRefusal)) throw error;
      return record("refused", { owner, refusal: { code: error.code, message: error.message } });
    }
    const timeZone = await zoneOf(ctx, owner);
    const invId = await ctx.db.insert(invocations, {
      owner, invocationId: n.invocationId, contract: INVOCATION_CONTRACT, surface: n.surface, instruction: n.instruction, context: n.context,
      submittedAt: n.submittedAt, receivedAt: now, ...(timeZone ? { timeZone } : {}), digest: n.digest, conversationId, returnTo: "personalos", state: "accepted",
      updates: [{ seq: 1, state: "accepted", text: `PersonalOS has it, from ${handle} on X: ${n.instruction ? `"${n.instruction.slice(0, 200)}"` : "(no request)"}.`, at: now }],
      createdAt: now, updatedAt: now,
    });
    const inv = () => ctx.db.get(invocations, invId);
    const finish = async () => record("invoked", { owner, invocationId: n.invocationId, conversationId, ...identity, replies: [reply("acknowledgement", acknowledgement("invoked", m.id))] });
    const say = async (assistant: string) => {
      await appendMessage(octx, conversationId!, { role: "user", text: requestText({ instruction: n.instruction, context: n.context, surface: n.surface }) });
      return appendMessage(octx, conversationId!, { role: "assistant", text: assistant });
    };

    if (missing) {
      const t = `There's no conversation ${command.kind === "continue" ? command.conversationId.slice(0, 40) : ""} in your PersonalOS, so nothing was continued or done.`;
      await moveInvocation(ctx, (await inv())!, "failed", t, { work: { replyId: await say(t) }, error: { code: "NOT_FOUND", message: "no such conversation for this account" } });
      return finish();
    }
    if (continued && !continued.allowed) {
      const t = `You haven't allowed PersonalOS to continue conversations from X (personalos.conversation.continue${continued.decision.reason ? `: ${continued.decision.reason}` : ""}). Nothing was done.`;
      await moveInvocation(ctx, (await inv())!, "failed", t, { authority: continued.decision, work: { replyId: await say(t) }, error: { code: "FORBIDDEN", message: "personalos.conversation.continue was not allowed" } });
      return finish();
    }
    if (continued && !n.instruction) {
      const t = `Continuing this conversation from X (${handle}). Mention me again in that thread to carry on; the results stay here.`;
      await moveInvocation(ctx, (await inv())!, "completed", t, { authority: continued.decision, interpretation: { intent: "assistant", basis: "rules", detail: "continue a conversation" }, work: { replyId: await say(t) } });
      return finish();
    }

    // ── What was asked, by rules (no model is asked from here) ──
    const rules = intentByRules(n.instruction) ?? { intent: "assistant" as const, detail: "the assistant handles it" };
    const interpretation = { ...rules, basis: "rules" as const };
    if (rules.intent === "research" || rules.intent === "answer") {
      // Only the owner's own session may run this for them (research and model work run as whoever
      // queued them). It waits, with the conversation saying so; invocations:run starts it.
      const t = `This came from X and needs ${rules.intent === "research" ? "research" : "a model to answer"}, which runs only from your own PersonalOS session. Choose “Run it” under “Where this came from” in this conversation. Nothing is posted on X either way.`;
      // (No replyId: processing treats one as work already done.)
      await say(t);
      await moveInvocation(ctx, (await inv())!, "needs_approval", t, { interpretation, work: { waitingFor: "owner" } });
      return finish();
    }
    const clock = clockFor(timeZone);
    const shaped = rules.intent === "save" ? null : assistantText({ instruction: n.instruction, context: n.context });
    const understood = shaped ? interpret(shaped, clock.today as any).intent : null;
    const capability = rules.intent === "save" ? "personalos.memory.write" : capabilityFor(understood!.kind, { reminder: understood!.kind === "task.create" ? (understood as any).reminder : false });
    const decision = await ctx.authority.decide({ capability, onBehalfOf: authorityPrincipal(owner), context: { surface: X_ADAPTER, post: m.id } });
    if (decision.outcome === "unavailable" || decision.outcome === "invalid") fail("UNAVAILABLE", `The authority could not decide (${decision.reason ?? decision.outcome}); this mention is read again on the next poll.`);
    const authority = authorityOf(capability, decision);
    if (!decision.allowed) {
      const t = `You haven't allowed PersonalOS to do this for you from X (${capability}${decision.reason ? `: ${decision.reason}` : ""}). Nothing was done.`;
      await moveInvocation(ctx, (await inv())!, "failed", t, { interpretation, authority, work: { replyId: await say(t) }, error: { code: "FORBIDDEN", message: `${capability} was not allowed${decision.reason ? `: ${decision.reason}` : ""}` } });
      return finish();
    }
    if (rules.intent === "save") {
      const r = await saveShared(octx, (await inv())!);
      await moveInvocation(ctx, (await inv())!, "completed", r.text, { interpretation, authority, work: { replyId: r.replyId } });
      return finish();
    }
    const r = await respond(octx, conversationId, shaped!, clock.today as any, clock.tzOffset);
    const pending = (await Promise.all((r.reply.actionIds ?? []).map((id: string) => ctx.db.get(actions, id)))).filter((a) => a?.status === "proposed").map((a) => a!.id);
    await moveInvocation(ctx, (await inv())!, pending.length ? "needs_approval" : "completed", pending.length ? `${r.reply.text.slice(0, 1500)}\n\nIt needs your approval in PersonalOS.` : r.reply.text.slice(0, 2000), {
      interpretation, authority, work: { replyId: r.replyId, ...(pending.length ? { actionIds: pending } : {}) },
    });
    return finish();
  },
});

function authorityOf(capability: string, d: { outcome: string; executor?: string | null; onBehalfOf?: string | null; delegationId?: string | null; decisionId?: string | null; reason?: string | null }) {
  return {
    capability, outcome: d.outcome, at: Date.now(), ...(d.executor ? { principal: d.executor } : {}), ...(d.onBehalfOf ? { onBehalfOf: d.onBehalfOf } : {}),
    ...(d.delegationId ? { delegationId: d.delegationId } : {}), ...(d.decisionId ? { decisionId: d.decisionId } : {}), ...(d.reason ? { reason: String(d.reason).slice(0, 500) } : {}),
  };
}

/**
 * The PersonalOS conversation an X thread is on, for THIS author: their latest handled mention in it.
 * Another person replying in the same public thread is never taken to be them (each author resolves
 * on their own, and their mentions go to their own conversations).
 */
async function threadConversation(ctx: MutationCtx, owner: string, m: Mention): Promise<string | undefined> {
  if (!m.conversationId) return undefined;
  const earlier = (await ctx.db.find(xPosts, { xConversationId: m.conversationId, authorId: m.authorId }))
    .filter((p) => p.state === "invoked" && p.owner === owner && p.conversationId)
    .sort((a, b) => (BigInt(b.postId) > BigInt(a.postId) ? 1 : -1));
  for (const p of earlier) if ((await ctx.db.get(conversations, p.conversationId!))?.owner === owner) return p.conversationId!;
  return undefined;
}

// ── Replies: each posted at most once ────────────────────────────────────────────────────────

/** Replies waiting to be posted (acknowledgements, and publications the owner asked for). */
export const waitingReplies = app.query({
  access: "x.post",
  handler: async (ctx) => {
    const out: Array<{ postId: string; index: number }> = [];
    for (const p of await ctx.db.find(xPosts, {})) {
      (p.replies as any[]).forEach((r, index) => { if (due(r)) out.push({ postId: p.postId, index }); });
    }
    return out.slice(0, 50);
  },
});

/** Claim one reply for sending: only a pending one, and only once at a time. */
export const claimReply = app.mutation({
  access: "x.post",
  args: { postId: ID, index: s.integer({ minimum: 0 }) },
  handler: async (ctx, { postId, index }) => {
    const p = (await ctx.db.find(xPosts, { postId }))[0];
    const r = (p?.replies as any[] | undefined)?.[index];
    if (!p || !r || !due(r)) return null;
    const replies = [...(p.replies as any[])];
    replies[index] = { ...r, status: "sending", attempts: r.attempts + 1, at: Date.now() };
    await ctx.db.patch(xPosts, p.id, { replies, updatedAt: Date.now() });
    return { text: r.text as string, attempts: r.attempts + 1 };
  },
});

/** Record what happened to one reply. */
export const settleReply = app.mutation({
  access: "x.post",
  args: { postId: ID, index: s.integer({ minimum: 0 }), status: s.enum(["pending", "sent", "failed", "unknown"] as const), replyPostId: s.optional(ID), error: s.optional(s.string({ maxLength: 500 })), rateLimited: s.optional(s.boolean()) },
  handler: async (ctx, a) => {
    const p = (await ctx.db.find(xPosts, { postId: a.postId }))[0];
    const r = (p?.replies as any[] | undefined)?.[a.index];
    if (!p || !r || r.status !== "sending") return;
    const replies = [...(p.replies as any[])];
    replies[a.index] = { ...r, status: a.status, at: Date.now(), ...(a.replyPostId ? { replyPostId: a.replyPostId } : {}), error: a.error, limitedAt: a.rateLimited ? Date.now() : undefined };
    await ctx.db.patch(xPosts, p.id, { replies, updatedAt: Date.now() });
  },
});

/** Post one reply as the bot. Never twice: see the module comment. */
async function sendReply(ctx: ActionCtx, postId: string, index: number) {
  const claim = (await ctx.runMutation(api.xsurface.claimReply, { postId, index })) as { text: string; attempts: number } | null;
  if (!claim) return;
  try {
    const out = (await ctx.integrations.invoke("x.reply", { text: claim.text, reply: { in_reply_to_tweet_id: postId } }, { idempotencyKey: `x-reply:${postId}:${index}` })) as { data?: { id?: unknown } };
    const id = typeof out?.data?.id === "string" && /^[0-9]{1,19}$/.test(out.data.id) ? out.data.id : undefined;
    await ctx.runMutation(api.xsurface.settleReply, { postId, index, status: "sent", ...(id ? { replyPostId: id } : {}) });
  } catch (e) {
    const err = e as { code?: string; message?: string; details?: { status?: number | null } };
    const message = `${err.code ?? "ERROR"}: ${String(err.message ?? e).slice(0, 400)}`;
    // Refused by X (4xx): not posted. Rate limited: not posted, try later. Never sent (unreachable,
    // not configured): try later, a few times. Anything else may have been posted: a person checks.
    const status = err.code === "UPSTREAM_REJECTED"
      ? (err.details?.status === 429 ? "pending" : "failed")
      : err.code === "UNAVAILABLE" || err.code === "CONFIGURATION"
        ? (claim.attempts >= MAX_REPLY_ATTEMPTS ? "failed" : "pending")
        : "unknown";
    await ctx.runMutation(api.xsurface.settleReply, { postId, index, status, error: message, ...(err.code === "UPSTREAM_REJECTED" && err.details?.status === 429 ? { rateLimited: true } : {}) });
  }
}

/** The `x.reply` job: post one waiting reply now (the next poll would too). */
export const deliver = app.action({
  access: "x.post",
  args: { postId: ID, index: s.integer({ minimum: 0 }) },
  handler: async (ctx, { postId, index }) => { await sendReply(ctx, postId, index); },
});

// ── The owner's side, in PersonalOS ──────────────────────────────────────────────────────────

const OwnPost = s.object({
  postId: s.string(), url: s.string(), author: s.string(), state: s.string(), invocationId: s.nullable(s.string()), conversationId: s.nullable(s.string()),
  receivedAt: s.number(), replies: s.array(s.object({ kind: s.string(), text: s.string(), status: s.string(), replyPostId: s.nullable(s.string()), error: s.nullable(s.string()) })),
});
const ownView = (p: any) => ({
  postId: p.postId, url: postUrl(p.postId), author: p.authorUsername ? `@${p.authorUsername}` : p.authorId, state: p.state, invocationId: p.invocationId ?? null, conversationId: p.conversationId ?? null,
  receivedAt: p.receivedAt, replies: (p.replies as any[]).map((r) => ({ kind: r.kind, text: r.text, status: r.status, replyPostId: r.replyPostId ?? null, error: r.error ?? null })),
});

/** Your mentions of the bot, newest first: what was received, and what the bot posted in reply. */
export const mine = app.query({
  access: "invocations.read",
  args: { limit: s.optional(s.integer({ minimum: 1, maximum: 50 })) },
  returns: s.array(OwnPost),
  handler: async (ctx, { limit }) => (await ctx.db.find(xPosts, { owner: ops.me(ctx) }, { orderBy: [{ field: "receivedAt", direction: "desc" }], limit: limit ?? 20 })).map(ownView),
});

/** One of your mentions, by its post id (PersonalOS's #/x/<post id> opens its conversation). Another person's does not exist. */
export const post = app.query({
  access: "invocations.read",
  args: { postId: ID },
  returns: OwnPost,
  handler: async (ctx, { postId }) => {
    const p = (await ctx.db.find(xPosts, { postId }))[0];
    if (!p || p.owner !== ops.me(ctx)) fail("NOT_FOUND", `No post ${postId} of yours.`);
    return ownView(p);
  },
});

/** Whether the bot account is being read, for the Connect X screen. Nothing secret. */
export const bot = app.query({
  access: "links.read",
  returns: s.object({ username: s.nullable(s.string()), polling: s.boolean(), polledAt: s.nullable(s.number()), healthy: s.boolean() }),
  handler: async (ctx) => {
    const st = (await ctx.db.find(xState, { key: KEY }))[0];
    return { username: st?.botUsername ?? null, polling: !!st?.running, polledAt: st?.polledAt ?? null, healthy: !!st?.running && !st?.lastError };
  },
});

/**
 * Publish text on X, as the bot, in reply to one of your mentions: only by your explicit act here, with
 * the exact text you wrote, and only if AuthBoundry allows PersonalOS to publish for you
 * (personalos.x.publish). A refusal is recorded with the decision. The X adapter posts it on its next poll.
 */
export const publish = app.mutation({
  access: "x.publish",
  args: { postId: ID, text: s.string({ minLength: 1, maxLength: 1000 }) },
  returns: s.object({ status: s.string(), reason: s.nullable(s.string()) }),
  handler: async (ctx, { postId, text }) => {
    const owner = ops.me(ctx);
    const p = (await ctx.db.find(xPosts, { postId }))[0];
    if (!p || p.owner !== owner || p.state !== "invoked") fail("NOT_FOUND", `No post ${postId} of yours to reply to.`);
    let body: string;
    try { body = publication(text); } catch (e) { fail("INVALID_ARGUMENT", (e as Error).message); }
    const decision = await ctx.authority.decide({ capability: "personalos.x.publish", onBehalfOf: authorityPrincipal(owner), context: { surface: X_ADAPTER, post: postId } });
    if (decision.outcome === "unavailable" || decision.outcome === "invalid") fail("UNAVAILABLE", `The authority could not decide (${decision.reason ?? decision.outcome}); nothing was published.`);
    const authority = authorityOf("personalos.x.publish", decision);
    const entry = decision.allowed
      ? reply("publication", body, { requestedBy: owner, authority })
      : { ...reply("publication", body, { requestedBy: owner, authority }), status: "failed" as const, error: `Not allowed: personalos.x.publish${decision.reason ? ` (${decision.reason})` : ""}` };
    await ctx.db.patch(xPosts, p.id, { replies: [...(p.replies as any[]), entry], updatedAt: Date.now() });
    if (p.conversationId) {
      await appendMessage(ctx, p.conversationId, { role: "assistant", text: decision.allowed ? `Publishing on X, as the bot, in reply to ${postUrl(postId)}: “${body}”` : `Not published on X: you haven't allowed PersonalOS to publish for you (personalos.x.publish${decision.reason ? `: ${decision.reason}` : ""}).` });
    }
    return { status: decision.allowed ? "pending" : "denied", reason: decision.allowed ? null : (decision.reason ?? "not allowed") };
  },
});

void describeContext;
