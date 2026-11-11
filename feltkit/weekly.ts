/**
 * Weekly review: once a week, at the owner's chosen day and local time, the assistant posts a
 * look back (what got done) and a look ahead (what is overdue, what each day holds, dates coming
 * up, projects) into a "Weekly review" conversation, and sends a notification. Same shape as the
 * daily check-in (feltkit/checkins.ts): a job queued as the owner for one instant, which queues
 * the next. Changing or turning it off changes `reviewAt`, so a job for an old instant does nothing.
 */
import { fail, s } from "@feltdb/feltkit";
import type { MutationCtx } from "@feltdb/feltkit";
import { app, conversations, memories, projects, settings, tasks } from "./app.js";
import { addDays, instant, weekday, WEEKDAYS, describeDay } from "./_dates.js";
import { forgetting, weekPlan } from "./_briefing.js";
import { appendMessage } from "./assistant.js";
import { localDay } from "./checkins.js";
import { me, record } from "./_ops.js";

const DAY_MS = 86_400_000;

/** The next instant that is `dow` (0 = Sunday) at `time` in the owner's local calendar, strictly after `now`. */
export function nextReview(now: number, dow: number, time: string, tzOffset: number): number {
  const today = localDay(now, tzOffset);
  for (let i = 0; i <= 7; i++) {
    const day = addDays(today, i);
    if (weekday(day) !== dow) continue;
    const at = instant(day, time, tzOffset);
    if (at > now) return at;
  }
  return instant(addDays(today, 7), time, tzOffset);
}

export function schedule(ctx: MutationCtx, at: number) {
  ctx.afterCommit.jobs.enqueue("review.fire", { reviewAt: at }, { runAt: new Date(at).toISOString(), maxAttempts: 5 });
}

type TaskRow = any;

/** The review, composed only from what the records show. */
export function reviewText(input: { today: string; tasks: TaskRow[]; memories: any[]; projects: any[]; now: number; name?: string }): string {
  const { today, now } = input;
  const done = input.tasks.filter((t) => t.status === "done" && (t.completedAt ?? 0) >= now - 7 * DAY_MS);
  const { overdue, stale, dates } = forgetting({ today, tasks: input.tasks, memories: input.memories, now });
  const plan = weekPlan({ today, tasks: input.tasks });
  const lines: string[] = [`**Your week in review${input.name ? `, ${input.name}` : ""}**`, ""];
  lines.push(done.length ? `**Done this week (${done.length})**` : "**Done this week**: nothing completed.");
  for (const t of done.slice(0, 6)) lines.push(`- ${t.title}`);
  if (done.length > 6) lines.push(`- …and ${done.length - 6} more`);
  if (overdue.length) {
    lines.push("", `**Overdue (${overdue.length})**`);
    for (const t of overdue.slice(0, 5)) lines.push(`- ${t.title} (was ${t.due})`);
  }
  const busy = plan.days.filter((d) => d.tasks.length);
  lines.push("", busy.length ? "**Next 7 days**" : "**Next 7 days**: nothing is scheduled.");
  for (const d of busy) lines.push(`- ${describeDay(d.day, today)}: ${d.tasks.map((t) => t.title).join(", ")}`);
  if (plan.undated.length) lines.push("", `${plan.undated.length} open task${plan.undated.length === 1 ? " has" : "s have"} no date${stale.length ? `, ${stale.length} of them for more than five days` : ""}.`);
  if (dates.length) {
    lines.push("", "**Dates coming up**");
    for (const d of dates.slice(0, 4)) lines.push(`- ${d.memory.content} (${d.inDays === 0 ? "today" : `in ${d.inDays} day${d.inDays === 1 ? "" : "s"}`})`);
  }
  const active = input.projects.filter((p) => p.status === "active").map((p) => ({ name: p.name as string, open: input.tasks.filter((t) => t.projectId === p.id && t.status === "open").length })).filter((p) => p.open);
  if (active.length) {
    lines.push("", "**Projects with open work**");
    for (const p of active.slice(0, 5)) lines.push(`- ${p.name}: ${p.open} open`);
  }
  return lines.join("\n");
}

export const configure = app.mutation({
  access: "settings.write",
  args: { day: s.nullable(s.number()), time: s.string(), tzOffset: s.number() },
  returns: s.object({ reviewAt: s.nullable(s.number()) }),
  handler: async (ctx, { day, time, tzOffset }) => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) fail("INVALID_ARGUMENT", "time must be HH:MM.");
    if (day !== null && (!Number.isInteger(day) || day < 0 || day > 6)) fail("INVALID_ARGUMENT", "day must be 0 (Sunday) to 6 (Saturday).");
    const owner = me(ctx);
    const row = (await ctx.db.find(settings, { owner }))[0];
    const reviewAt = day === null ? undefined : nextReview(Date.now(), day, time, tzOffset);
    const change = { reviewDay: day ?? undefined, reviewTime: day === null ? undefined : time, reviewTzOffset: tzOffset, reviewAt, updatedAt: Date.now() };
    if (row) await ctx.db.patch(settings, row.id, change);
    else await ctx.db.insert(settings, { owner, modelAssist: true, ...change });
    if (reviewAt) schedule(ctx, reviewAt);
    return { reviewAt: reviewAt ?? null };
  },
});

export const fire = app.mutation({
  access: "briefing.read",
  args: { reviewAt: s.number() },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { reviewAt }) => {
    const owner = me(ctx);
    const pref = (await ctx.db.find(settings, { owner }))[0];
    if (!pref || pref.reviewAt !== reviewAt || pref.reviewDay === undefined || !pref.reviewTime) return { sent: false };
    const tz = pref.reviewTzOffset ?? 0;
    const today = localDay(reviewAt, tz);
    const [ts, ms, ps] = await Promise.all([ctx.db.find(tasks, { owner }), ctx.db.find(memories, { owner }), ctx.db.find(projects, { owner })]);
    const text = reviewText({ today, tasks: ts, memories: ms, projects: ps, now: reviewAt, name: pref.name });
    let conversationId = pref.reviewConversationId;
    if (!conversationId || !(await ctx.db.get(conversations, conversationId)))
      conversationId = await ctx.db.insert(conversations, { owner, title: "Weekly review", createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 });
    const next = nextReview(reviewAt + 60_000, pref.reviewDay, pref.reviewTime, tz);
    await ctx.db.patch(settings, pref.id, { reviewConversationId: conversationId, reviewAt: next, updatedAt: Date.now() });
    const messageId = await appendMessage(ctx, conversationId, { role: "assistant", text, interpretation: { intent: "weekly-review", source: "rules" } });
    ctx.afterCommit.notifications.send({ recipient: owner, type: "review.weekly", title: "Your weekly review", body: `Week of ${describeDay(today, today)}`, data: { conversationId }, idempotencyKey: `review:${owner}:${reviewAt}` });
    schedule(ctx, next);
    const actionId = await record(ctx, { kind: "review.send", summary: `Weekly review for ${today} (${WEEKDAYS[weekday(today)]})`, status: "succeeded", input: { reviewAt, today }, evidence: { collection: "messages", id: messageId, version: 1, verified: !!(await ctx.db.get(conversations, conversationId)) } }, { via: "job", conversationId, messageId });
    return { sent: true, actionId, next };
  },
});
