/**
 * The daily briefing and the "what am I forgetting" sweep, computed from durable state only.
 * Pure: the same records and the same day give the same briefing.
 */
import { addDays, daysBetween, type Day } from "./_dates.js";

export interface TaskLike {
  id: string;
  title: string;
  status: "open" | "done";
  priority: "low" | "normal" | "high";
  due?: Day;
  remindTime?: string;
  remindAt?: number;
  recurrence: string;
  projectId?: string;
  createdAt: number;
  completedAt?: number;
}
export interface MemoryLike {
  id: string;
  kind: string;
  subject: string;
  content: string;
  status: "confirmed" | "inferred";
  date?: Day;
  createdAt: number;
}
export interface ProjectLike {
  id: string;
  name: string;
  status: "active" | "paused" | "done";
  updatedAt: number;
}

const PRIORITY = { high: 0, normal: 1, low: 2 } as const;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Most important first: overdue, then today, then by priority, then oldest. */
export function rank<T extends TaskLike>(tasks: T[], today: Day): T[] {
  const urgency = (t: TaskLike) => (t.due ? Math.min(daysBetween(today, t.due), 8) : 9);
  return [...tasks].sort((a, b) => urgency(a) - urgency(b) || PRIORITY[a.priority] - PRIORITY[b.priority] || cmp(a.remindTime ?? "99", b.remindTime ?? "99") || a.createdAt - b.createdAt);
}

/** The next date a "date" memory falls on, treating birthdays and anniversaries as yearly. */
export function nextDate(memory: MemoryLike, today: Day): Day | null {
  if (!memory.date) return null;
  if (!/birthday|anniversary/i.test(`${memory.subject} ${memory.content}`)) return memory.date;
  const year = Number(today.slice(0, 4));
  for (const y of [year, year + 1]) {
    const candidate = `${y}-${memory.date.slice(5)}`;
    if (daysBetween(today, candidate) >= 0) return candidate;
  }
  return null;
}

export interface Briefing<T extends TaskLike = TaskLike, M extends MemoryLike = MemoryLike, P extends ProjectLike = ProjectLike> {
  date: Day;
  focus: T[];
  overdue: T[];
  dueToday: T[];
  upcoming: T[];
  undated: number;
  dates: Array<{ memory: M; on: Day; inDays: number }>;
  projects: Array<{ project: P; open: number; next: T | null }>;
  attention: { inferredMemories: number; pendingApprovals: number; failedActions: number };
  completedYesterday: number;
}

export function briefing<T extends TaskLike, M extends MemoryLike, P extends ProjectLike>(input: { today: Day; tasks: T[]; memories: M[]; projects: P[]; pendingApprovals: number; failedActions: number; now: number }): Briefing<T, M, P> {
  const { today } = input;
  const open = input.tasks.filter((t) => t.status === "open");
  const overdue = rank(open.filter((t) => t.due && daysBetween(today, t.due) < 0), today);
  const dueToday = rank(open.filter((t) => t.due === today), today);
  const upcoming = rank(open.filter((t) => t.due && daysBetween(today, t.due) > 0 && daysBetween(today, t.due) <= 7), today);
  const undated = open.filter((t) => !t.due);
  const focus = rank([...overdue, ...dueToday, ...undated.filter((t) => t.priority === "high")], today).slice(0, 3);
  const dates = input.memories
    .filter((m) => m.kind === "date" && m.status === "confirmed")
    .map((memory) => ({ memory, on: nextDate(memory, today) }))
    .filter((d): d is { memory: M; on: Day } => !!d.on && daysBetween(today, d.on) >= 0 && daysBetween(today, d.on) <= 14)
    .map((d) => ({ ...d, inDays: daysBetween(today, d.on) }))
    .sort((a, b) => a.inDays - b.inDays);
  const projects = input.projects
    .filter((p) => p.status === "active")
    .map((project) => {
      const mine = rank(open.filter((t) => t.projectId === project.id), today);
      return { project, open: mine.length, next: mine[0] ?? null };
    });
  const yesterdayStart = input.now - 36 * 3_600_000; // generous: "since yesterday" without a time zone
  return {
    date: today,
    focus,
    overdue,
    dueToday,
    upcoming,
    undated: undated.length,
    dates,
    projects,
    attention: { inferredMemories: input.memories.filter((m) => m.status === "inferred").length, pendingApprovals: input.pendingApprovals, failedActions: input.failedActions },
    completedYesterday: input.tasks.filter((t) => t.status === "done" && (t.completedAt ?? 0) >= yesterdayStart).length,
  };
}

/** Things slipping: overdue work, open tasks nobody dated that are going stale, dates coming up with nothing planned. */
export function forgetting(input: { today: Day; tasks: TaskLike[]; memories: MemoryLike[]; now: number }) {
  const { today } = input;
  const open = input.tasks.filter((t) => t.status === "open");
  const overdue = rank(open.filter((t) => t.due && daysBetween(today, t.due) < 0), today);
  const stale = open.filter((t) => !t.due && input.now - t.createdAt > 5 * 86_400_000).sort((a, b) => a.createdAt - b.createdAt);
  const dates = input.memories
    .filter((m) => m.kind === "date" && m.status === "confirmed")
    .map((memory) => ({ memory, on: nextDate(memory, today) }))
    .filter((d): d is { memory: MemoryLike; on: Day } => !!d.on && daysBetween(today, d.on) >= 0 && daysBetween(today, d.on) <= 21)
    .map((d) => ({ ...d, inDays: daysBetween(today, d.on) }));
  const unconfirmed = input.memories.filter((m) => m.status === "inferred");
  return { overdue, stale, dates, unconfirmed };
}

/** Seven days from today, each with its tasks; undated work listed separately. */
export function weekPlan(input: { today: Day; tasks: TaskLike[] }) {
  const open = input.tasks.filter((t) => t.status === "open");
  const days = Array.from({ length: 7 }, (_, i) => addDays(input.today, i)).map((day) => ({ day, tasks: rank(open.filter((t) => t.due === day), input.today) }));
  const overdue = rank(open.filter((t) => t.due && daysBetween(input.today, t.due) < 0), input.today);
  const undated = rank(open.filter((t) => !t.due), input.today);
  const busiest = [...days].sort((a, b) => b.tasks.length - a.tasks.length)[0]!;
  const lightest = [...days].filter((d) => d.day !== input.today).sort((a, b) => a.tasks.length - b.tasks.length)[0]!;
  return { days, overdue, undated, busiest, lightest };
}
