/**
 * Operations: the only code that changes the assistant's state. Chat, the screens, a job, and an
 * approved model proposal all come here, so every change is checked, verified and logged the same
 * way. Each operation runs inside the calling mutation's transaction: the change, its read-back
 * verification, and its action record commit together or not at all.
 */
import { fail } from "@feltdb/feltkit";
import type { MutationCtx } from "@feltdb/feltkit";
import { actions, memories, projects, tasks } from "./app.js";
import { instant, nextOccurrence, type Day } from "./_dates.js";
import type { MemoryKind } from "./_interpret.js";

export type Via = "chat" | "ui" | "model" | "job";
export interface Meta {
  via: Via;
  conversationId?: string;
  messageId?: string;
}

export function me(ctx: { auth: { requirePrincipal(): { id: string } } }): string {
  return ctx.auth.requirePrincipal().id;
}

/** A record of `collection` that belongs to the caller, or NOT_FOUND (another person's record does not exist for them). */
export async function own<T extends { owner: string }>(ctx: { db: { get(c: any, id: string): Promise<any> }; auth: any }, collection: unknown, id: string, what: string): Promise<T & { id: string; __version: number }> {
  const record = await ctx.db.get(collection, id);
  if (!record || record.owner !== me(ctx)) fail("NOT_FOUND", `No ${what} ${id}.`);
  return record;
}

type Evidence = { collection: string; id: string; version: number; verified: boolean };

export async function record(
  ctx: MutationCtx,
  entry: { kind: string; summary: string; status: "proposed" | "succeeded" | "failed" | "rejected"; approval?: "none" | "required"; input: Record<string, unknown>; evidence?: Evidence; error?: { code: string; message: string } },
  meta: Meta,
): Promise<string> {
  const owner = me(ctx);
  return ctx.db.insert(actions, {
    owner,
    seq: await ctx.db.sequence(`actions:${owner}`),
    kind: entry.kind,
    summary: entry.summary.slice(0, 500),
    status: entry.status,
    approval: entry.approval ?? "none",
    input: entry.input,
    ...(entry.evidence ? { evidence: entry.evidence } : {}),
    ...(entry.error ? { error: entry.error } : {}),
    via: meta.via,
    ...(meta.conversationId ? { conversationId: meta.conversationId } : {}),
    ...(meta.messageId ? { messageId: meta.messageId } : {}),
    createdAt: Date.now(),
    ...(entry.status !== "proposed" ? { decidedAt: Date.now() } : {}),
  });
}

/** Read the record back inside the transaction and check the fields the operation meant to set. */
async function verify(ctx: MutationCtx, collection: { name: string } & object, id: string, expect: Record<string, unknown>): Promise<Evidence> {
  const stored = (await ctx.db.get(collection as any, id)) as Record<string, unknown> | null;
  const verified = !!stored && Object.entries(expect).every(([k, v]) => JSON.stringify(stored[k]) === JSON.stringify(v));
  if (!verified) fail("INTERNAL", `Verification failed for ${collection.name}/${id}: the stored record does not match what was written.`);
  return { collection: collection.name, id, version: Number(stored!.__version), verified };
}

export interface TaskInput {
  title: string;
  notes?: string;
  due?: Day;
  time?: string;
  /** Required with `time`: the client's Date#getTimezoneOffset(), so the reminder fires at the user's local time. */
  tzOffset?: number;
  reminder?: boolean;
  recurrence?: "none" | "daily" | "weekdays" | "weekly" | "monthly";
  priority?: "low" | "normal" | "high";
  projectId?: string;
}

function reminderAt(input: TaskInput): { remindAt?: number; remindTime?: string; tzOffset?: number } {
  if (!input.reminder || !input.due) return {};
  const time = input.time ?? "09:00";
  const tzOffset = input.tzOffset ?? 0;
  return { remindAt: instant(input.due, time, tzOffset), remindTime: time, tzOffset };
}

function scheduleReminder(ctx: MutationCtx, taskId: string, remindAt: number | undefined) {
  if (remindAt === undefined || remindAt <= Date.now()) return;
  ctx.afterCommit.jobs.enqueue("reminder.fire", { taskId, remindAt }, { runAt: new Date(remindAt).toISOString(), maxAttempts: 5 });
}

export async function createTask(ctx: MutationCtx, input: TaskInput, meta: Meta) {
  const owner = me(ctx);
  const title = input.title.trim();
  if (!title) fail("INVALID_ARGUMENT", "A task needs a title.");
  if (input.projectId) await own(ctx, projects, input.projectId, "project");
  const now = Date.now();
  const fields = {
    owner,
    title,
    ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
    status: "open" as const,
    priority: input.priority ?? "normal",
    ...(input.due ? { due: input.due } : {}),
    ...reminderAt(input),
    recurrence: input.recurrence ?? "none",
    ...(input.projectId ? { projectId: input.projectId } : {}),
    source: { kind: meta.via === "chat" ? ("conversation" as const) : meta.via === "model" ? ("model" as const) : ("manual" as const), ...(meta.conversationId ? { conversationId: meta.conversationId } : {}), ...(meta.messageId ? { messageId: meta.messageId } : {}) },
    createdAt: now,
    updatedAt: now,
  };
  const id = await ctx.db.insert(tasks, fields);
  const evidence = await verify(ctx, tasks, id, { title, status: "open", due: fields.due, remindAt: (fields as { remindAt?: number }).remindAt });
  scheduleReminder(ctx, id, (fields as { remindAt?: number }).remindAt);
  const actionId = await record(ctx, { kind: input.reminder ? "reminder.create" : "task.create", summary: `${input.reminder ? "Reminder" : "Task"} created: ${title}`, status: "succeeded", input: { ...input }, evidence }, meta);
  return { task: (await ctx.db.get(tasks, id))!, actionId };
}

export async function completeTask(ctx: MutationCtx, id: string, meta: Meta) {
  const task = await own<any>(ctx, tasks, id, "task");
  if (task.status === "done") fail("FAILED_PRECONDITION", `"${task.title}" is already done.`);
  await ctx.db.patch(tasks, id, { status: "done", completedAt: Date.now(), updatedAt: Date.now() });
  const evidence = await verify(ctx, tasks, id, { status: "done" });
  const actionId = await record(ctx, { kind: "task.complete", summary: `Completed: ${task.title}`, status: "succeeded", input: { id }, evidence }, meta);
  // A recurring task comes back: the next occurrence is a new record, so history stays intact.
  let next: any = null;
  if (task.recurrence !== "none" && task.due) {
    const due = nextOccurrence(task.due, task.recurrence);
    const remindAt = task.remindAt !== undefined ? instant(due, task.remindTime ?? "09:00", task.tzOffset ?? 0) : undefined;
    const { id: _i, __version: _v, completedAt: _c, remindedAt: _r, ...rest } = task;
    const nextId = await ctx.db.insert(tasks, { ...rest, status: "open", due, ...(remindAt !== undefined ? { remindAt } : {}), source: { kind: "recurrence" }, createdAt: Date.now(), updatedAt: Date.now() });
    const ev = await verify(ctx, tasks, nextId, { status: "open", due });
    scheduleReminder(ctx, nextId, remindAt);
    await record(ctx, { kind: "task.recur", summary: `Next "${task.title}" scheduled for ${due}`, status: "succeeded", input: { from: id, due }, evidence: ev }, meta);
    next = await ctx.db.get(tasks, nextId);
  }
  return { task: (await ctx.db.get(tasks, id))!, next, actionId };
}

export async function reopenTask(ctx: MutationCtx, id: string, meta: Meta) {
  const task = await own<any>(ctx, tasks, id, "task");
  await ctx.db.patch(tasks, id, { status: "open", completedAt: undefined, updatedAt: Date.now() });
  const evidence = await verify(ctx, tasks, id, { status: "open" });
  const actionId = await record(ctx, { kind: "task.reopen", summary: `Reopened: ${task.title}`, status: "succeeded", input: { id }, evidence }, meta);
  return { task: (await ctx.db.get(tasks, id))!, actionId };
}

export async function updateTask(ctx: MutationCtx, id: string, change: Partial<TaskInput> & { clearDue?: boolean }, meta: Meta) {
  const task = await own<any>(ctx, tasks, id, "task");
  if (change.projectId) await own(ctx, projects, change.projectId, "project");
  const due = change.clearDue ? undefined : (change.due ?? task.due);
  const keepsReminder = change.reminder ?? task.remindAt !== undefined;
  const time = change.time ?? task.remindTime;
  const reminder = keepsReminder && due ? reminderAt({ title: task.title, due, time, tzOffset: change.tzOffset ?? task.tzOffset ?? 0, reminder: true }) : {};
  const patch: Record<string, unknown> = {
    ...(change.title !== undefined ? { title: change.title.trim() } : {}),
    ...(change.notes !== undefined ? { notes: change.notes.trim() || undefined } : {}),
    ...(change.priority ? { priority: change.priority } : {}),
    ...(change.recurrence ? { recurrence: change.recurrence } : {}),
    ...(change.projectId !== undefined ? { projectId: change.projectId || undefined } : {}),
    due,
    remindAt: reminder.remindAt,
    remindTime: reminder.remindTime,
    tzOffset: reminder.tzOffset,
    remindedAt: reminder.remindAt !== task.remindAt ? undefined : task.remindedAt,
    updatedAt: Date.now(),
  };
  await ctx.db.patch(tasks, id, patch);
  const evidence = await verify(ctx, tasks, id, { due, remindAt: reminder.remindAt });
  if (reminder.remindAt !== task.remindAt) scheduleReminder(ctx, id, reminder.remindAt);
  const moved = due !== task.due;
  const actionId = await record(ctx, { kind: moved ? "task.reschedule" : "task.update", summary: moved ? `Moved "${task.title}" to ${due ?? "no date"}` : `Updated: ${change.title ?? task.title}`, status: "succeeded", input: { id, ...change }, evidence }, meta);
  return { task: (await ctx.db.get(tasks, id))!, before: task, actionId };
}

export async function deleteTask(ctx: MutationCtx, id: string, meta: Meta) {
  const task = await own<any>(ctx, tasks, id, "task");
  await ctx.db.delete(tasks, id);
  const gone = !(await ctx.db.get(tasks, id));
  if (!gone) fail("INTERNAL", `Verification failed: task ${id} still exists.`);
  const actionId = await record(ctx, { kind: "task.delete", summary: `Deleted task: ${task.title}`, status: "succeeded", input: { id, title: task.title }, evidence: { collection: "tasks", id, version: task.__version, verified: true } }, meta);
  return { task, actionId };
}

export interface MemoryInput {
  kind: MemoryKind;
  subject: string;
  content: string;
  status: "confirmed" | "inferred";
  date?: Day;
  quote?: string;
}

export async function remember(ctx: MutationCtx, input: MemoryInput, meta: Meta) {
  const owner = me(ctx);
  const now = Date.now();
  const content = input.content.trim();
  if (!content) fail("INVALID_ARGUMENT", "There is nothing to remember.");
  // The same sentence twice is one memory; repeating it confirms it.
  const existing = (await ctx.db.find(memories, { owner })).find((m) => m.content.toLowerCase() === content.toLowerCase());
  if (existing) {
    if (input.status === "confirmed" && existing.status === "inferred") return confirmMemory(ctx, existing.id, meta);
    return { memory: existing, actionId: null as string | null, duplicate: true };
  }
  const id = await ctx.db.insert(memories, {
    owner,
    kind: input.kind,
    subject: input.subject.trim().toLowerCase().slice(0, 200),
    content,
    status: input.status,
    source: { kind: meta.via === "chat" ? "conversation" : meta.via === "model" ? "model" : "manual", ...(meta.conversationId ? { conversationId: meta.conversationId } : {}), ...(meta.messageId ? { messageId: meta.messageId } : {}), ...(input.quote ? { quote: input.quote.slice(0, 500) } : {}) },
    ...(input.date ? { date: input.date } : {}),
    createdAt: now,
    updatedAt: now,
    ...(input.status === "confirmed" ? { confirmedAt: now } : {}),
  });
  const evidence = await verify(ctx, memories, id, { content, status: input.status });
  const actionId = await record(ctx, { kind: input.status === "confirmed" ? "memory.remember" : "memory.infer", summary: `${input.status === "confirmed" ? "Remembered" : "Noted (unconfirmed)"}: ${content}`, status: "succeeded", input: { ...input }, evidence }, meta);
  return { memory: (await ctx.db.get(memories, id))!, actionId, duplicate: false };
}

export async function confirmMemory(ctx: MutationCtx, id: string, meta: Meta) {
  const memory = await own<any>(ctx, memories, id, "memory");
  await ctx.db.patch(memories, id, { status: "confirmed", confirmedAt: Date.now(), updatedAt: Date.now() });
  const evidence = await verify(ctx, memories, id, { status: "confirmed" });
  const actionId = await record(ctx, { kind: "memory.confirm", summary: `Confirmed: ${memory.content}`, status: "succeeded", input: { id }, evidence }, meta);
  return { memory: (await ctx.db.get(memories, id))!, actionId, duplicate: false };
}

export async function updateMemory(ctx: MutationCtx, id: string, change: { content?: string; kind?: MemoryKind; subject?: string; date?: Day | null }, meta: Meta) {
  const memory = await own<any>(ctx, memories, id, "memory");
  // An edit by the user is the user's own statement: it is confirmed.
  await ctx.db.patch(memories, id, {
    ...(change.content !== undefined ? { content: change.content.trim() } : {}),
    ...(change.kind ? { kind: change.kind } : {}),
    ...(change.subject !== undefined ? { subject: change.subject.trim().toLowerCase() } : {}),
    ...(change.date !== undefined ? { date: change.date ?? undefined } : {}),
    status: "confirmed",
    confirmedAt: Date.now(),
    updatedAt: Date.now(),
  });
  const evidence = await verify(ctx, memories, id, { status: "confirmed" });
  const actionId = await record(ctx, { kind: "memory.update", summary: `Edited memory: ${change.content ?? memory.content}`, status: "succeeded", input: { id, before: memory.content, ...change }, evidence }, meta);
  return { memory: (await ctx.db.get(memories, id))!, actionId };
}

export async function forgetMemory(ctx: MutationCtx, id: string, meta: Meta) {
  const memory = await own<any>(ctx, memories, id, "memory");
  await ctx.db.delete(memories, id);
  if (await ctx.db.get(memories, id)) fail("INTERNAL", `Verification failed: memory ${id} still exists.`);
  const actionId = await record(ctx, { kind: "memory.forget", summary: `Forgot: ${memory.content}`, status: "succeeded", input: { id, content: memory.content }, evidence: { collection: "memories", id, version: memory.__version, verified: true } }, meta);
  return { memory, actionId };
}

export async function createProject(ctx: MutationCtx, input: { name: string; description?: string }, meta: Meta) {
  const owner = me(ctx);
  const name = input.name.trim();
  const dup = (await ctx.db.find(projects, { owner })).find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (dup) fail("FAILED_PRECONDITION", `You already have a project called "${dup.name}".`);
  const now = Date.now();
  const id = await ctx.db.insert(projects, { owner, name, ...(input.description?.trim() ? { description: input.description.trim() } : {}), status: "active", createdAt: now, updatedAt: now });
  const evidence = await verify(ctx, projects, id, { name, status: "active" });
  const actionId = await record(ctx, { kind: "project.create", summary: `Project started: ${name}`, status: "succeeded", input: { ...input }, evidence }, meta);
  return { project: (await ctx.db.get(projects, id))!, actionId };
}

/** Actions the assistant may only prepare: they wait in the log until the owner approves or rejects them. */
export const NEEDS_APPROVAL = ["task.delete", "memory.forget"] as const;
export type ProposalKind = (typeof NEEDS_APPROVAL)[number];

export async function propose(ctx: MutationCtx, kind: ProposalKind, summary: string, input: Record<string, unknown>, meta: Meta): Promise<string> {
  return record(ctx, { kind, summary, status: "proposed", approval: "required", input }, meta);
}

/** Run an approved proposal through the same operation a direct request would use. */
export async function execute(ctx: MutationCtx, kind: string, input: Record<string, unknown>, meta: Meta): Promise<{ summary: string; evidence?: Evidence }> {
  if (kind === "task.delete") {
    const { task } = await deleteTask(ctx, String(input.id), meta);
    return { summary: `Deleted task: ${task.title}`, evidence: { collection: "tasks", id: task.id, version: task.__version, verified: true } };
  }
  if (kind === "memory.forget") {
    const { memory } = await forgetMemory(ctx, String(input.id), meta);
    return { summary: `Forgot: ${memory.content}`, evidence: { collection: "memories", id: memory.id, version: memory.__version, verified: true } };
  }
  fail("FAILED_PRECONDITION", `There is no operation for "${kind}".`);
}
