import { s } from "@feltdb/feltkit";
import { app, tasks } from "./app.js";
import { record } from "./_ops.js";

/**
 * Job "reminder.fire": queued (after commit) when a reminder is set, to run at its time, as the
 * owner. It fires only if the task is still open and still wants *this* reminder (moving a task
 * queues a new job and leaves the old one to find a different remindAt and do nothing).
 */
export const fire = app.mutation({
  access: "tasks.write",
  args: { taskId: s.string(), remindAt: s.number() },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { taskId, remindAt }) => {
    const task = await ctx.db.get(tasks, taskId);
    const who = ctx.auth.requirePrincipal().id;
    if (!task || task.owner !== who || task.status !== "open" || task.remindAt !== remindAt || task.remindedAt) return { fired: false };
    await ctx.db.patch(tasks, taskId, { remindedAt: Date.now() });
    ctx.afterCommit.notifications.send({ recipient: who, type: "reminder.due", title: task.title, data: { taskId }, idempotencyKey: `reminder:${taskId}:${remindAt}` });
    ctx.afterCommit.webhooks.emit("reminder.fired", { taskId, title: task.title, remindAt });
    const stored = await ctx.db.get(tasks, taskId);
    await record(ctx, { kind: "reminder.fire", summary: `Reminder sent: ${task.title}`, status: "succeeded", input: { taskId, remindAt }, evidence: { collection: "tasks", id: taskId, version: stored!.__version, verified: !!stored!.remindedAt } }, { via: "job" });
    return { fired: true };
  },
});
