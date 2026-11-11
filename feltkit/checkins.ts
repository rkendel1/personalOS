/**
 * Scheduled check-ins: once a day, at the owner's chosen local time, the assistant posts the
 * daily briefing into a "Daily check-in" conversation and sends a notification. Each run is a
 * job queued (after commit) as the owner for that instant; the run queues the next one. Changing
 * or turning off the time changes `checkinAt`, so a job queued for an old instant does nothing.
 */
import { fail, s } from "@feltdb/feltkit";
import type { MutationCtx } from "@feltdb/feltkit";
import { actions, app, conversations, memories, projects, settings, tasks } from "./app.js";
import { addDays, instant } from "./_dates.js";
import { briefing } from "./_briefing.js";
import { appendMessage, briefingText } from "./assistant.js";
import { me, record } from "./_ops.js";

/** The owner's local calendar date at `now`, from their UTC offset. */
export function localDay(now: number, tzOffset: number): string {
  return new Date(now - tzOffset * 60_000).toISOString().slice(0, 10);
}
export function nextCheckin(now: number, time: string, tzOffset: number): number {
  const today = localDay(now, tzOffset);
  const at = instant(today, time, tzOffset);
  return at > now ? at : instant(addDays(today, 1), time, tzOffset);
}

export function schedule(ctx: MutationCtx, at: number) {
  ctx.afterCommit.jobs.enqueue("checkin.fire", { checkinAt: at }, { runAt: new Date(at).toISOString(), maxAttempts: 5 });
}

export const configure = app.mutation({
  access: "settings.write",
  args: { time: s.nullable(s.string()), tzOffset: s.number() },
  returns: s.object({ checkinAt: s.nullable(s.number()) }),
  handler: async (ctx, { time, tzOffset }) => {
    if (time !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fail("INVALID_ARGUMENT", "time must be HH:MM.");
    const owner = me(ctx);
    const row = (await ctx.db.find(settings, { owner }))[0];
    const checkinAt = time ? nextCheckin(Date.now(), time, tzOffset) : undefined;
    const change = { checkinTime: time ?? undefined, tzOffset, checkinAt, updatedAt: Date.now() };
    if (row) await ctx.db.patch(settings, row.id, change);
    else await ctx.db.insert(settings, { owner, modelAssist: true, ...change });
    if (checkinAt) schedule(ctx, checkinAt);
    return { checkinAt: checkinAt ?? null };
  },
});

export const fire = app.mutation({
  access: "briefing.read",
  args: { checkinAt: s.number() },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { checkinAt }) => {
    const owner = me(ctx);
    const pref = (await ctx.db.find(settings, { owner }))[0];
    if (!pref || pref.checkinAt !== checkinAt || !pref.checkinTime) return { sent: false };
    const tz = pref.tzOffset ?? 0;
    const today = localDay(checkinAt, tz);
    const [ts, ms, ps, proposed, failed] = await Promise.all([
      ctx.db.find(tasks, { owner }),
      ctx.db.find(memories, { owner }),
      ctx.db.find(projects, { owner }),
      ctx.db.count(actions, { owner, status: "proposed" }),
      ctx.db.count(actions, { owner, status: "failed" }),
    ]);
    const text = briefingText(briefing({ today, tasks: ts, memories: ms, projects: ps, pendingApprovals: proposed, failedActions: failed, now: Date.now() }), today, pref.name);
    let conversationId = pref.checkinConversationId;
    if (!conversationId || !(await ctx.db.get(conversations, conversationId)))
      conversationId = await ctx.db.insert(conversations, { owner, title: "Daily check-in", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 });
    const next = nextCheckin(checkinAt + 60_000, pref.checkinTime, tz);
    await ctx.db.patch(settings, pref.id, { checkinConversationId: conversationId, checkinAt: next, updatedAt: Date.now() });
    const messageId = await appendMessage(ctx, conversationId, { role: "assistant", text, interpretation: { intent: "briefing", source: "rules" } });
    ctx.afterCommit.notifications.send({ recipient: owner, type: "checkin.daily", title: "Your daily check-in", body: text.split("\n")[0], data: { conversationId }, idempotencyKey: `checkin:${owner}:${checkinAt}` });
    schedule(ctx, next);
    const actionId = await record(ctx, { kind: "checkin.send", summary: `Daily check-in for ${today}`, status: "succeeded", input: { checkinAt, today }, evidence: { collection: "messages", id: messageId, version: 1, verified: !!(await ctx.db.get(conversations, conversationId)) } }, { via: "job", conversationId, messageId });
    return { sent: true, actionId, next };
  },
});
