import { fail, s } from "@feltdb/feltkit";
import { actions, app, memories, projects, settings, tasks } from "./app.js";
import { briefing } from "./_briefing.js";
import { isDay } from "./_dates.js";
import { clockFor } from "./_clock.js";
import { me } from "./_ops.js";

const Task = s.doc(tasks);
const Briefing = s.object({
  name: s.nullable(s.string()),
  date: s.string(),
  focus: s.array(Task),
  overdue: s.array(Task),
  dueToday: s.array(Task),
  upcoming: s.array(Task),
  undated: s.number(),
  dates: s.array(s.object({ memory: s.doc(memories), on: s.string(), inDays: s.number() })),
  projects: s.array(s.object({ project: s.doc(projects), open: s.number(), next: s.nullable(Task) })),
  attention: s.object({ inferredMemories: s.number(), pendingApprovals: s.number(), failedActions: s.number() }),
  completedYesterday: s.number(),
});

/** Today's briefing, live: it re-runs whenever a task, memory, project or action changes. */
export const today = app.query({
  access: "briefing.read",
  /** `today` overrides the caller's own date (from their time zone) for tests and replays. */
  args: { today: s.optional(s.string()) },
  returns: Briefing,
  capability: { name: "briefing.today", description: "The daily briefing: focus, overdue, due today, coming up, dates, projects, and what needs attention." },
  handler: async (ctx, args) => {
    if (args.today !== undefined && !isDay(args.today)) fail("INVALID_ARGUMENT", "today must be YYYY-MM-DD.");
    const today = args.today ?? clockFor(ctx.auth.context.timeZone).today;
    const owner = me(ctx);
    const [ts, ms, ps, proposed, failed, pref] = await Promise.all([
      ctx.db.find(tasks, { owner }),
      ctx.db.find(memories, { owner }),
      ctx.db.find(projects, { owner }),
      ctx.db.count(actions, { owner, status: "proposed" }),
      ctx.db.count(actions, { owner, status: "failed" }),
      ctx.db.find(settings, { owner }),
    ]);
    return { name: pref[0]?.name ?? null, ...briefing({ today, tasks: ts, memories: ms, projects: ps, pendingApprovals: proposed, failedActions: failed, now: Date.now() }) };
  },
});
