/**
 * The assistant's execution loop, one user message per mutation:
 *
 *   1. understand   interpret() → intent + slots (deterministic; feltkit/_interpret.ts)
 *   2. outcome      the intent names the outcome; nothing is guessed beyond it
 *   3. missing      ask instead of acting when a slot is missing or a reference is ambiguous
 *   4. capabilities only the operations in feltkit/_ops.ts exist; there are no others to call
 *   5. authorize    the caller's role (FeltKit) + ownership of every record touched (_ops.own)
 *   6. plan         direct operation, or a proposal when the change is destructive
 *   7. execute      inside this mutation's transaction
 *   8. verify       each operation reads its record back before commit
 *   9. evidence     each operation writes an `actions` row citing the record and its version
 *  10. report       the reply is composed from those rows; it states nothing they do not show
 *
 * This is the deterministic assistant: the path when the model is off or unavailable. With a
 * model, a turn is feltkit/turn.ts (generation, tools as proposals, approval), which falls back
 * to this. Either way nothing a model says is stored as fact or executed without approval.
 */
import { fail, s } from "@feltdb/feltkit";
import type { MutationCtx } from "@feltdb/feltkit";
import { actions, app, conversations, memories, messages, projects, settings, tasks } from "./app.js";
import { addDays, describeDay, describeTime, instant, isDay, type Day } from "./_dates.js";
import { clockFor } from "./_clock.js";
import { interpret, keywords, relevance, type Intent, type TaskRef } from "./_interpret.js";
import { briefing, forgetting, rank, weekPlan, type TaskLike } from "./_briefing.js";
import * as ops from "./_ops.js";

interface Reply {
  text: string;
  actionIds?: string[];
  suggestions?: string[];
  agentTaskId?: string;
}

/** Deterministic variety: the same message always gets the same wording. */
function pick(seed: string, options: string[]): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return options[h % options.length]!;
}

function whenText(task: { due?: Day; remindTime?: string; recurrence?: string }, today: Day): string {
  const parts: string[] = [];
  if (task.recurrence && task.recurrence !== "none") parts.push(task.recurrence === "weekdays" ? "every weekday" : task.recurrence);
  if (task.due) parts.push(task.recurrence && task.recurrence !== "none" ? `starting ${describeDay(task.due, today)}` : describeDay(task.due, today));
  if (task.remindTime) parts.push(`at ${describeTime(task.remindTime)}`);
  return parts.join(" ");
}

function taskLine(t: TaskLike, today: Day): string {
  const when = t.due ? ` — ${describeDay(t.due, today)}${t.remindTime ? ` ${describeTime(t.remindTime)}` : ""}` : "";
  return `- ${t.priority === "high" ? "**!** " : ""}${t.title}${when}`;
}

async function nextSeq(ctx: MutationCtx, conversationId: string) {
  return ctx.db.sequence(`messages:${conversationId}`);
}

export async function appendMessage(ctx: MutationCtx, conversationId: string, message: { role: "user" | "assistant"; text: string; interpretation?: any; actionIds?: string[]; suggestions?: string[] }) {
  const id = await ctx.db.insert(messages, {
    owner: ops.me(ctx),
    conversationId,
    seq: await nextSeq(ctx, conversationId),
    role: message.role,
    text: message.text.slice(0, 8000),
    createdAt: Date.now(),
    ...(message.interpretation ? { interpretation: message.interpretation } : {}),
    ...(message.actionIds?.length ? { actionIds: message.actionIds } : {}),
    ...(message.suggestions?.length ? { suggestions: message.suggestions } : {}),
  });
  const conversation = await ctx.db.get(conversations, conversationId);
  if (conversation) await ctx.db.patch(conversations, conversationId, { updatedAt: Date.now(), messageCount: conversation.messageCount + 1 });
  return id;
}

/** The task a reference points to: "that" is the last task this conversation touched; a phrase is matched by title. */
async function resolveTask(ctx: MutationCtx, ref: TaskRef, conversationId: string, statuses: Array<"open" | "done">): Promise<{ task?: any; candidates: any[] }> {
  const owner = ops.me(ctx);
  if ("that" in ref) {
    const recent = await ctx.db.find(actions, { owner, conversationId }, { orderBy: [{ field: "seq", direction: "desc" }], limit: 20 });
    for (const a of recent) {
      if (a.evidence?.collection !== "tasks" || a.status !== "succeeded") continue;
      const task = await ctx.db.get(tasks, a.evidence.id);
      if (task && task.owner === owner && statuses.includes(task.status)) return { task, candidates: [] };
    }
    return { candidates: [] };
  }
  const all = (await ctx.db.find(tasks, { owner })).filter((t) => statuses.includes(t.status));
  const exact = all.filter((t) => t.title.toLowerCase() === ref.query.toLowerCase());
  if (exact.length === 1) return { task: exact[0], candidates: [] };
  const scored = all.map((t) => ({ t, score: relevance(ref.query, `${t.title} ${t.notes ?? ""}`) })).filter((x) => x.score >= 0.5).sort((a, b) => b.score - a.score || b.t.createdAt - a.t.createdAt);
  if (!scored.length) return { candidates: [] };
  if (scored.length > 1 && scored[1]!.score === scored[0]!.score) return { candidates: scored.filter((x) => x.score === scored[0]!.score).map((x) => x.t) };
  return { task: scored[0]!.t, candidates: [] };
}

async function state(ctx: MutationCtx) {
  const owner = ops.me(ctx);
  const [allTasks, allMemories, allProjects, proposed, failed] = await Promise.all([
    ctx.db.find(tasks, { owner }),
    ctx.db.find(memories, { owner }),
    ctx.db.find(projects, { owner }),
    ctx.db.count(actions, { owner, status: "proposed" }),
    ctx.db.count(actions, { owner, status: "failed" }),
  ]);
  return { tasks: allTasks as unknown as TaskLike[], memories: allMemories as any[], projects: allProjects as any[], proposed, failed };
}

export function briefingText(b: ReturnType<typeof briefing>, today: Day, name?: string): string {
  const lines: string[] = [];
  const open = b.overdue.length + b.dueToday.length;
  const hello = name ? `${name}, ` : "";
  const cap = (t: string) => (name ? t : t.charAt(0).toUpperCase() + t.slice(1));
  if (!open && !b.upcoming.length && !b.dates.length && !b.undated) return cap(`${hello}your slate is clean. Nothing due, nothing overdue. Tell me what's on your mind and I'll keep track of it.`);
  if (b.focus.length) {
    lines.push(cap(`${hello}here's where I'd put your energy today:`));
    b.focus.forEach((t, i) => lines.push(`${i + 1}. ${t.title}${t.due && t.due < today ? ` (overdue since ${describeDay(t.due, today)})` : t.remindTime ? ` (${describeTime(t.remindTime)})` : ""}`));
  } else lines.push(cap(`${hello}nothing is due today. A rare open day.`));
  if (b.overdue.length > 1) lines.push(`\n**${b.overdue.length} overdue.** Worth clearing or moving. Overdue lists only get heavier.`);
  else if (b.overdue.length === 1 && !b.focus.includes(b.overdue[0]!)) lines.push(`\n**Overdue:** ${b.overdue[0]!.title}`);
  if (b.upcoming.length) lines.push(`\n**Coming up:** ${b.upcoming.slice(0, 4).map((t) => `${t.title} (${describeDay(t.due!, today)})`).join(", ")}${b.upcoming.length > 4 ? `, +${b.upcoming.length - 4} more` : ""}`);
  if (b.dates.length) lines.push(`\n**Dates:** ${b.dates.map((d) => `${d.memory.content} (${d.inDays === 0 ? "today" : describeDay(d.on, today)})`).join("; ")}`);
  const active = b.projects.filter((p) => p.open);
  if (active.length) lines.push(`\n**Projects:** ${active.map((p) => `${p.project.name}: ${p.open} open${p.next ? `, next "${p.next.title}"` : ""}`).join("; ")}`);
  const a = b.attention;
  const notes = [a.pendingApprovals ? `${a.pendingApprovals} action${a.pendingApprovals > 1 ? "s" : ""} waiting for your approval` : "", a.inferredMemories ? `${a.inferredMemories} thing${a.inferredMemories > 1 ? "s" : ""} I noted but you haven't confirmed` : "", a.failedActions ? `${a.failedActions} failed action${a.failedActions > 1 ? "s" : ""}` : ""].filter(Boolean);
  if (notes.length) lines.push(`\n**Needs you:** ${notes.join(", ")}.`);
  return lines.join("\n");
}

async function handle(ctx: MutationCtx, intent: Intent, missing: string[], meta: ops.Meta & { conversationId: string; messageId: string }, today: Day, tzOffset: number, text: string): Promise<Reply> {
  const owner = ops.me(ctx);
  const seed = meta.messageId;

  switch (intent.kind) {
    case "greet":
      return {
        text: pick(seed, ["Hey. What are we getting done?", "Hi! What's on your mind?", "Hello. I'm here. Tasks, reminders, or something you want me to remember?"]),
        suggestions: ["What should I focus on today?", "What am I forgetting?"],
      };
    case "thanks":
      return { text: pick(seed, ["Anytime.", "Happy to. That's the job.", "You got it."]) };
    case "help":
      return {
        text: [
          "Here's what I actually do, as opposed to what I'd like to claim:",
          "- **Tasks & reminders**: \"remind me to call John tomorrow at 3\", \"move that to Friday\", \"mark the report done\"",
          "- **Memory**: \"remember that Sam is my manager\", \"what do you know about Sam?\", \"forget that\"",
          "- **Your day**: \"what should I focus on?\", \"what am I forgetting?\", \"help me plan my week\"",
          "- **Projects**: \"start a project called Website relaunch\", \"status of website relaunch\"",
          "Everything I change shows up under **Activity** with proof. Anything destructive waits for your OK.",
        ].join("\n"),
        suggestions: ["What should I focus on today?", "Remind me to stretch at 4pm"],
      };

    case "remember": {
      const { memory, actionId, duplicate } = await ops.remember(ctx, { kind: intent.memoryKind, subject: intent.subject, content: intent.content, status: intent.status, ...(intent.date ? { date: intent.date } : {}), quote: text }, meta);
      if (duplicate) return { text: `I already have that: "${memory.content}".` };
      if (intent.status === "inferred")
        return {
          text: `Noted: "${memory.content}". I've filed it as **unconfirmed** since you didn't ask me to remember it. I won't treat it as fact until you say so. Keep it?`,
          actionIds: [actionId!],
          suggestions: ["Yes, remember that", "No, don't keep it"],
        };
      return {
        text: `${pick(seed, ["Got it.", "Remembered.", "Locked in."])} ${intent.memoryKind === "fact" ? "" : `Filed under *${intent.memoryKind}*: `}"${memory.content}"${intent.date ? ` (${describeDay(intent.date, today)})` : ""}`,
        actionIds: [actionId!],
      };
    }

    case "confirm": {
      const recent = await ctx.db.find(actions, { owner, conversationId: meta.conversationId, kind: "memory.infer" }, { orderBy: [{ field: "seq", direction: "desc" }], limit: 5 });
      for (const a of recent) {
        const memory = a.evidence ? await ctx.db.get(memories, a.evidence.id) : null;
        if (!memory || memory.status !== "inferred") continue;
        if (intent.yes) {
          const { actionId } = await ops.confirmMemory(ctx, memory.id, meta);
          return { text: `Confirmed. "${memory.content}" is now something I know, not something I guessed.`, actionIds: [actionId!] };
        }
        const { actionId } = await ops.forgetMemory(ctx, memory.id, meta);
        return { text: `Dropped it. I won't keep "${memory.content}".`, actionIds: [actionId] };
      }
      return { text: intent.yes ? "Good. Though I'm not sure what you're confirming. There's nothing pending here." : "Okay. Nothing pending here to undo, for what it's worth." };
    }

    case "recall": {
      const all = (await ctx.db.find(memories, { owner })) as any[];
      const hits = intent.query ? all.map((m) => ({ m, score: relevance(intent.query, `${m.subject} ${m.content}`) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.m.updatedAt - a.m.updatedAt).map((x) => x.m) : [...all].sort((a, b) => b.updatedAt - a.updatedAt);
      const relatedTasks = intent.query ? ((await ctx.db.find(tasks, { owner, status: "open" })) as any[]).filter((t) => relevance(intent.query, t.title) >= 0.5) : [];
      if (!hits.length && !relatedTasks.length)
        return { text: intent.query ? `I don't have anything on "${intent.query}". If it matters, tell me and I'll remember it.` : "I don't know much about you yet. Tell me something worth remembering: people, preferences, dates." };
      const confirmed = hits.filter((m) => m.status === "confirmed").slice(0, 8);
      const inferred = hits.filter((m) => m.status === "inferred").slice(0, 4);
      const lines = [intent.query ? `Here's what I have on **${intent.query}**:` : "Here's what I know about you:"];
      for (const m of confirmed) lines.push(`- ${m.content}${m.date ? ` (${describeDay(m.date, today)})` : ""}`);
      if (inferred.length) {
        lines.push(confirmed.length ? "\nUnconfirmed (my inference, not your word):" : "Only unconfirmed notes (my inference, not your word):");
        for (const m of inferred) lines.push(`- ${m.content}?`);
      }
      if (relatedTasks.length) lines.push(`\nRelated open tasks: ${relatedTasks.slice(0, 4).map((t) => t.title).join("; ")}`);
      return { text: lines.join("\n") };
    }

    case "forget": {
      const all = (await ctx.db.find(memories, { owner })) as any[];
      let target: any = null;
      if (/^(that|it|this)$/i.test(intent.query)) {
        const last = await ctx.db.find(actions, { owner, conversationId: meta.conversationId }, { orderBy: [{ field: "seq", direction: "desc" }], limit: 10 });
        const ref = last.find((a) => a.evidence?.collection === "memories" && a.status === "succeeded");
        target = ref ? all.find((m) => m.id === ref.evidence!.id) : null;
      } else {
        target = all.map((m) => ({ m, score: relevance(intent.query, `${m.subject} ${m.content}`) })).filter((x) => x.score >= 0.5).sort((a, b) => b.score - a.score)[0]?.m ?? null;
      }
      if (!target) return { text: `I don't have a memory matching "${intent.query}", so there's nothing to forget.` };
      const pending = (await ctx.db.find(actions, { owner, status: "proposed", kind: "memory.forget" })).find((a) => a.input.id === target.id);
      if (pending) return { text: `Already waiting on your OK to forget "${target.content}".`, actionIds: [pending.id] };
      const actionId = await ops.propose(ctx, "memory.forget", `Forget: ${target.content}`, { id: target.id, content: target.content }, meta);
      return { text: `I'd forget: "${target.content}". That's permanent, so it needs your approval. Nothing is deleted until you approve.`, actionIds: [actionId] };
    }

    case "task.create": {
      if (missing.includes("title")) return { text: "Sure. What's the task?" };
      if (missing.includes("when"))
        return {
          text: `When should I remind you to ${intent.title.charAt(0).toLowerCase()}${intent.title.slice(1)}?`,
          suggestions: [`Remind me to ${intent.title.toLowerCase()} tomorrow morning`, `Remind me to ${intent.title.toLowerCase()} tonight`, `Add ${intent.title.toLowerCase()} to my list`],
        };
      let due = intent.due;
      let note = "";
      // "remind me at 9am" said after 9am: the next 9am is tomorrow.
      if (intent.reminder && due === today && intent.time) {
        if (instant(today, intent.time, tzOffset) <= Date.now() && !/\btoday\b/i.test(text)) {
          due = addDays(today, 1);
          note = ` (${describeTime(intent.time)} already passed today)`;
        }
      }
      const { task, actionId } = await ops.createTask(ctx, { title: intent.title, priority: intent.priority, reminder: intent.reminder, tzOffset, ...(due ? { due } : {}), ...(intent.time ? { time: intent.time } : {}), ...(intent.recurrence ? { recurrence: intent.recurrence } : {}) }, meta);
      const when = whenText(task, today);
      const inPast = task.remindAt !== undefined && task.remindAt <= Date.now();
      const head = intent.reminder
        ? inPast
          ? `Added **${task.title}** for ${when}, but that time has already passed, so no reminder will fire. Want a different time?`
          : `${pick(seed, ["Done.", "Set.", "On it."])} I'll remind you to **${task.title.charAt(0).toLowerCase()}${task.title.slice(1)}** ${when}${note}.`
        : `${pick(seed, ["Added", "On the list", "Captured"])}: **${task.title}**${when ? ` — ${when}` : ""}${task.priority === "high" ? " (high priority)" : ""}.`;
      return { text: head, actionIds: [actionId], suggestions: task.due ? undefined : ["Move that to Friday"] };
    }

    case "task.complete":
    case "task.reschedule":
    case "task.delete": {
      const { task, candidates } = await resolveTask(ctx, intent.ref, meta.conversationId, intent.kind === "task.delete" ? ["open", "done"] : ["open"]);
      if (!task) {
        if (candidates.length)
          return {
            text: `A few tasks match. Which one?\n${candidates.slice(0, 5).map((t: any) => `- ${t.title}`).join("\n")}`,
            suggestions: candidates.slice(0, 3).map((t: any) => (intent.kind === "task.complete" ? `Mark ${t.title} done` : intent.kind === "task.delete" ? `Delete ${t.title}` : `Move ${t.title} to ${describeDay((intent as any).due ?? today, today)}`)),
          };
        return { text: "that" in intent.ref ? "Which task? I haven't touched one in this conversation yet." : `I can't find an open task matching "${intent.ref.query}".`, suggestions: ["Show my tasks"] };
      }
      if (intent.kind === "task.complete") {
        const { next, actionId } = await ops.completeTask(ctx, task.id, meta);
        return { text: `${pick(seed, ["Nice.", "Done and dusted.", "Checked off."])} **${task.title}** is complete.${next ? ` The next one is due ${describeDay(next.due, today)}.` : ""}`, actionIds: [actionId] };
      }
      if (intent.kind === "task.reschedule") {
        if (missing.includes("when")) return { text: `Move **${task.title}** to when?` };
        const { task: moved, actionId } = await ops.updateTask(ctx, task.id, { ...(intent.due ? { due: intent.due } : {}), ...(intent.time ? { time: intent.time, reminder: true, ...(intent.due ? {} : { due: task.due ?? today }) } : {}), tzOffset }, meta);
        return { text: `Moved **${task.title}** to ${whenText(moved, today)}.`, actionIds: [actionId] };
      }
      const pending = (await ctx.db.find(actions, { owner, status: "proposed", kind: "task.delete" })).find((a) => a.input.id === task.id);
      if (pending) return { text: `Already waiting on your OK to delete "${task.title}".`, actionIds: [pending.id] };
      const actionId = await ops.propose(ctx, "task.delete", `Delete task: ${task.title}`, { id: task.id, title: task.title }, meta);
      return { text: `I'd delete **${task.title}**. Deleting is permanent, so approve it below if you mean it. (Marking it done keeps the history.)`, actionIds: [actionId], suggestions: [`Mark ${task.title} done`] };
    }

    case "task.list": {
      const open = rank(((await ctx.db.find(tasks, { owner, status: "open" })) as unknown) as TaskLike[], today);
      const list =
        intent.range === "overdue" ? open.filter((t) => t.due && t.due < today) : intent.range === "today" ? open.filter((t) => t.due && t.due <= today) : intent.range === "week" ? open.filter((t) => t.due && t.due <= addDays(today, 7)) : open;
      if (!list.length) return { text: intent.range === "overdue" ? "Nothing overdue. Look at you." : intent.range === "today" ? "Nothing due today." : intent.range === "week" ? "Nothing scheduled this week." : "Your list is empty. Suspiciously so." };
      const title = { overdue: "Overdue", today: "Due today", week: "This week", all: "Open tasks" }[intent.range];
      return { text: `**${title}** (${list.length}):\n${list.slice(0, 15).map((t) => taskLine(t, today)).join("\n")}${list.length > 15 ? `\n…and ${list.length - 15} more on the Tasks tab.` : ""}` };
    }

    case "briefing": {
      const st = await state(ctx);
      const pref = await ctx.db.find(settings, { owner });
      const b = briefing({ today, tasks: st.tasks, memories: st.memories, projects: st.projects, pendingApprovals: st.proposed, failedActions: st.failed, now: Date.now() });
      return { text: briefingText(b, today, pref[0]?.name), suggestions: b.overdue.length ? ["What's overdue?", "Help me plan my week"] : ["Help me plan my week"] };
    }

    case "forgetting": {
      const st = await state(ctx);
      const f = forgetting({ today, tasks: st.tasks, memories: st.memories, now: Date.now() });
      const lines: string[] = [];
      if (f.overdue.length) lines.push(`**Overdue (${f.overdue.length}):**\n${f.overdue.slice(0, 5).map((t) => taskLine(t, today)).join("\n")}`);
      if (f.stale.length) lines.push(`**Sitting undated for a while:**\n${f.stale.slice(0, 5).map((t) => `- ${t.title}`).join("\n")}\nGive them a date or let them go.`);
      if (f.dates.length) lines.push(`**Dates coming up:**\n${f.dates.map((d) => `- ${d.memory.content} (${describeDay(d.on, today)})`).join("\n")}`);
      if (f.unconfirmed.length) lines.push(`**Things I noted but you never confirmed:**\n${f.unconfirmed.slice(0, 5).map((m: any) => `- ${m.content}`).join("\n")}`);
      if (!lines.length) return { text: "As far as I can tell: nothing. No overdue tasks, no stale ones, no dates sneaking up. Of course, I only know what you've told me." };
      return { text: `Here's what's slipping:\n\n${lines.join("\n\n")}` };
    }

    case "plan.week": {
      const st = await state(ctx);
      const p = weekPlan({ today, tasks: st.tasks });
      const lines = ["Here's your week as it stands:"];
      for (const d of p.days) lines.push(`- **${describeDay(d.day, today)}**: ${d.tasks.length ? d.tasks.map((t) => t.title).join("; ") : "—"}`);
      if (p.overdue.length) lines.push(`\nCarrying **${p.overdue.length} overdue**: ${p.overdue.slice(0, 3).map((t) => t.title).join("; ")}. I'd deal with those first.`);
      if (p.undated.length) lines.push(`\n**${p.undated.length} undated** task${p.undated.length > 1 ? "s" : ""}. ${describeDay(p.lightest.day, today)} is your lightest day; good home for "${p.undated[0]!.title}".`);
      if (p.busiest.tasks.length >= 5) lines.push(`\n${describeDay(p.busiest.day, today)} is stacked (${p.busiest.tasks.length} things). Consider moving one.`);
      return { text: lines.join("\n"), suggestions: p.undated.length ? [`Move ${p.undated[0]!.title} to ${describeDay(p.lightest.day, today)}`] : undefined };
    }

    case "project.create": {
      const { project, actionId } = await ops.createProject(ctx, { name: intent.name, ...(intent.description ? { description: intent.description } : {}) }, meta);
      return { text: `Started a project: **${project.name}**. Add tasks to it from the Projects tab, and I'll track its status.`, actionIds: [actionId] };
    }

    case "project.status": {
      const all = (await ctx.db.find(projects, { owner })) as any[];
      const project = all.map((p) => ({ p, score: relevance(intent.name, `${p.name} ${p.description ?? ""}`) })).filter((x) => x.score >= 0.5).sort((a, b) => b.score - a.score)[0]?.p;
      if (!project) {
        // Not a project: maybe it's something I remember.
        return handle(ctx, { kind: "recall", query: intent.name }, [], meta, today, tzOffset, text);
      }
      const its = (await ctx.db.find(tasks, { owner, projectId: project.id })) as any[];
      const open = rank(its.filter((t) => t.status === "open"), today);
      const done = its.filter((t) => t.status === "done").sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
      const notes = ((await ctx.db.find(memories, { owner })) as any[]).filter((m) => m.status === "confirmed" && relevance(project.name, `${m.subject} ${m.content}`) >= 0.5);
      const lines = [`**${project.name}** (${project.status})${project.description ? ` — ${project.description}` : ""}`, `${open.length} open, ${done.length} done.`];
      if (open.length) lines.push(`Next up:\n${open.slice(0, 5).map((t) => taskLine(t, today)).join("\n")}`);
      if (done.length) lines.push(`Recently finished: ${done.slice(0, 3).map((t) => t.title).join("; ")}`);
      if (notes.length) lines.push(`What I know about it:\n${notes.slice(0, 5).map((m) => `- ${m.content}`).join("\n")}`);
      return { text: lines.join("\n") };
    }

    case "unknown": {
      const words = keywords(text);
      return {
        text: pick(seed, [
          "I didn't catch an action in that. With the model off I handle tasks, reminders, memory and planning your day, but not open-ended chat (Settings → Model).",
          "Not sure what to do with that one. I can track tasks, set reminders, remember things, and brief you on your day.",
        ]),
        suggestions: words.length ? [`Remember that ${text.replace(/[.!?]+$/, "")}`, `Add ${text.replace(/[.!?]+$/, "")} to my list`] : ["What can you do?"],
      };
    }
  }
}

function titleFrom(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 60 ? `${t.slice(0, 57)}…` : t;
}

const SendResult = s.object({ conversationId: s.string(), messageId: s.string(), replyId: s.string() });

/** Send a message; the assistant interprets it, acts, and replies, in one transaction. */
export const send = app.mutation({
  access: "assistant.send",
  args: {
    conversationId: s.optional(s.string()),
    text: s.string({ minLength: 1, maxLength: 4000 }),
    /** Overrides for tests and replays only: by default the date comes from the caller's time zone (ctx.auth.context). */
    today: s.optional(s.string()),
    tzOffset: s.optional(s.number()),
  },
  returns: SendResult,
  capability: { name: "assistant.send", description: "Send a message to the assistant. It may create or change tasks and memories, and replies citing what it did." },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, args) => {
    const { today, tzOffset } = when(ctx, args);
    const owner = ops.me(ctx);
    let conversationId = args.conversationId;
    if (conversationId) await ops.own(ctx, conversations, conversationId, "conversation");
    else conversationId = await ctx.db.insert(conversations, { owner, title: titleFrom(args.text), createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 });
    return converse(ctx, conversationId, args.text, today, tzOffset);
  },
});

/** The caller's local date and UTC offset: from their time zone, unless a test or replay overrides it. */
export function when(ctx: { auth: { context: { timeZone: string | null } } }, args: { today?: string; tzOffset?: number }): { today: Day; tzOffset: number } {
  if (args.today !== undefined && !isDay(args.today)) fail("INVALID_ARGUMENT", "today must be YYYY-MM-DD.");
  const clock = clockFor(ctx.auth.context.timeZone);
  return { today: args.today ?? clock.today, tzOffset: args.tzOffset ?? clock.tzOffset };
}

async function converse(ctx: MutationCtx, conversationId: string, text: string, today: Day, tzOffset: number) {
  const { intent, missing } = interpret(text, today);
  const messageId = await appendMessage(ctx, conversationId, { role: "user", text, interpretation: { intent: intent.kind, source: "rules", ...(missing.length ? { missing } : {}) } });
  const reply = await handle(ctx, intent, missing, { via: "chat", conversationId, messageId }, today, tzOffset, text);
  const replyId = await appendMessage(ctx, conversationId, {
    role: "assistant",
    text: reply.text,
    interpretation: { intent: intent.kind, source: "rules", ...(missing.length ? { missing } : {}), ...(reply.agentTaskId ? { agentTaskId: reply.agentTaskId } : {}) },
    ...(reply.actionIds ? { actionIds: reply.actionIds } : {}),
    ...(reply.suggestions ? { suggestions: reply.suggestions } : {}),
  });
  return { conversationId, messageId, replyId };
}

/**
 * Edit a message you sent and continue from it. The original and everything after it are kept,
 * marked superseded (actions they caused stay done and stay in the log); the edit is answered anew.
 */
export const edit = app.mutation({
  access: "assistant.send",
  args: { messageId: s.string(), text: s.string({ minLength: 1, maxLength: 4000 }), today: s.optional(s.string()), tzOffset: s.optional(s.number()) },
  returns: SendResult,
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, args) => {
    const original = await ops.own<any>(ctx, messages, args.messageId, "message");
    if (original.role !== "user") fail("FAILED_PRECONDITION", "Only your own messages can be edited.");
    const later = await ctx.db.find(messages, { conversationId: original.conversationId }, { orderBy: [{ field: "seq", direction: "asc" }] });
    const { today, tzOffset } = when(ctx, args);
    const result = await converse(ctx, original.conversationId, args.text, today, tzOffset);
    for (const m of later) if (m.seq >= original.seq && !m.supersededBy) await ctx.db.patch(messages, m.id, { supersededBy: result.messageId });
    return result;
  },
});

/** Ask again: re-run a message against the current state (useful after you changed something). */
export const retry = app.mutation({
  access: "assistant.send",
  args: { messageId: s.string(), today: s.optional(s.string()), tzOffset: s.optional(s.number()) },
  returns: SendResult,
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, args) => {
    const original = await ops.own<any>(ctx, messages, args.messageId, "message");
    if (original.role !== "user") fail("FAILED_PRECONDITION", "Retry one of your own messages.");
    const { today, tzOffset } = when(ctx, args);
    return converse(ctx, original.conversationId, original.text, today, tzOffset);
  },
});
