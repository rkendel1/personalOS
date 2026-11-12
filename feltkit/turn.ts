/**
 * A model turn (FeltKit M1): the assistant answers in its own words, streamed, and acts only by
 * proposing PersonalOS capabilities.
 *
 *   user message ── recordUser (idempotent by the client's message id)
 *        │
 *   agent task for the turn ── ctx.agent.openTask({ key: messageId })  (a retried turn is the same turn)
 *        │
 *   generate (Resolver / Intelligence, streamed to the UI) ──► generation record (FeltDB evidence)
 *        │ tool calls
 *   ctx.agent.propose ── observation: runs now through AppPort, result goes back to the model
 *        │              consequential: waits for the owner's approval (server-side), never runs here
 *   recordReply ── the reply cites its task, generations and proposals
 *
 * The model never writes PersonalOS state. With no model (or the owner turned it off) the turn is
 * the deterministic assistant (assistant:send), unchanged.
 */
import { s } from "@feltdb/feltkit";
import type { GenerationMessage, ToolCall } from "@feltdb/feltkit";
import { api } from "./_generated/api.js";
import { app } from "./app.js";
import { clockFor, offsetFor, type Clock } from "./_clock.js";
import { outcomeOf } from "./_research.js";
import { retryResearch, startResearch } from "./research.js";
import { declaredCapabilities, PROSPECT_NEEDS, describeDiscovery, discover } from "./_capabilities.js";

/** The capabilities the model may use, as tools. Everything else stays with the person. */
const TOOLS = ["tasks.create", "tasks.update", "tasks.complete", "tasks.list", "memory.add", "memory.list", "briefing.today", "projects.list", "documents.list"];
/** Inputs the app fills in itself (from the caller's clock), so the model never guesses them. */
const APP_FILLED: Record<string, string[]> = { "tasks.create": ["tzOffset"], "tasks.update": ["tzOffset"], "briefing.today": ["today"] };
const MAX_ROUNDS = 3;
/** A question about whether PersonalOS can reach the web (search, browse, look things up online). */
const CAPABILITY_QUESTION = /\b(can|could|are|do|don'?t|can'?t|cannot|able)\b.*\b(search|browse|google|look (?:things |it )?up|access|use)\b.*\b(web|internet|online)\b|\bweb access\b|\binternet access\b/i;

function systemPrompt(clock: Clock, info: { name: string | null; tasks: unknown[]; openTaskCount: number; memories: Array<{ content: string; status: string }> }, landscape: string): string {
  return [
    `You are PersonalOS, ${info.name ? `${info.name}'s` : "the user's"} personal assistant: warm, direct, occasionally dry-witted, never corporate. Keep replies short unless asked for more.`,
    `Now: ${clock.weekday} ${clock.today} ${clock.time} (${clock.timeZone}). Resolve "today", "tomorrow", weekdays and times in this time zone. Dates are YYYY-MM-DD, times HH:MM (24h).`,
    "",
    "How you act:",
    "- You change nothing yourself. To create, update or complete a task, or to remember something, call the matching tool: that only PROPOSES it, and the user approves it in the app. Never say it is done, created, scheduled, saved or set. Say you've proposed it and it needs their approval.",
    "- A reminder is tasks.create with reminder: true, a due date and a time.",
    "- Reading tools (tasks.list, briefing.today, memory.list, projects.list, documents.list) run immediately; use them when you need facts you don't have below.",
    "- Never invent tasks, people, dates or facts. Unconfirmed memories are guesses; say so if you rely on one.",
    "- You can list the user's saved documents but cannot read their contents.",
    "- What PersonalOS can do is not limited to the tools in this turn. Research outcomes (for example finding customers, prospects or leads for a product) are run by PersonalOS's research, which the user starts by asking for the outcome in words; it discovers and uses what the platform offers. What it can use right now, as discovered from the platform's catalog:",
    landscape,
    "- Never say a capability does not exist, or that you have no web access, unless the list above says so; if it says something is not configured or not permitted, say exactly that and what would enable it. Never claim you searched, sent or did anything you did not do in this turn.",
    "",
    `Open tasks (${info.openTaskCount}, soonest first): ${JSON.stringify(info.tasks)}`,
    `What you know about the user (status "confirmed" = they said so): ${JSON.stringify(info.memories)}`,
  ].join("\n");
}

/** App-filled inputs: the caller's clock decides the offset and "today", never the model. */
function normalize(capability: string, input: Record<string, unknown>, clock: Clock): Record<string, unknown> {
  const out = { ...input };
  if (capability === "briefing.today") out.today = clock.today;
  if ((capability === "tasks.create" || capability === "tasks.update") && (out.due || out.time)) {
    const due = typeof out.due === "string" ? out.due : clock.today;
    const time = typeof out.time === "string" ? out.time : "09:00";
    out.tzOffset = offsetFor(due, time, clock.timeZone);
  }
  for (const key of Object.keys(out)) if (out[key] === null) delete out[key];
  return out;
}

const trim = (value: unknown) => {
  const text = JSON.stringify(value ?? null);
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
};

const Result = s.object({
  mode: s.enum(["model", "rules"] as const),
  conversationId: s.string(),
  messageId: s.string(),
  replyId: s.string(),
  replayed: s.boolean(),
  reason: s.optional(s.string()),
});

/** One turn of the conversation. Streams text (`delta`) and proposals (`proposal`) to the caller. */
export const turn = app.action({
  access: "assistant.send",
  args: { conversationId: s.optional(s.string()), clientId: s.string({ minLength: 8, maxLength: 100 }), text: s.string({ minLength: 1, maxLength: 4000 }) },
  returns: Result,
  handler: async (ctx, { conversationId, clientId, text }) => {
    const clock = clockFor(ctx.auth.context.timeZone);
    // An outcome to research ("find me new customers for FeltKit") is pursued by research, with or
    // without a model: discovery decides what can run, not the tools a model turn would be given.
    if (outcomeOf(text) && ctx.auth.has("research.run")) {
      const r = await startResearch(ctx, text, conversationId);
      return { mode: "rules" as const, conversationId: r.conversationId, messageId: r.messageId, replyId: r.replyId, replayed: false, reason: `research ${r.status}` };
    }
    const control = /^(retry|resume|continue|stop|cancel) (the )?research\b/i.exec(text.trim());
    if (control && ctx.auth.has("research.run")) {
      const runs = (await ctx.runQuery(api.research.list, {})) as Array<{ id: string; status: string; conversationId: string | null }>;
      const target = runs.find((r) => (/^(stop|cancel)/i.test(control[1]!) ? r.status === "running" || r.status === "blocked" : r.status !== "completed" && r.status !== "running"));
      if (target) {
        const r = /^(stop|cancel)/i.test(control[1]!) ? await ctx.runMutation(api.research.cancel, { runId: target.id }) : await retryResearch(ctx, target.id);
        return { mode: "rules" as const, conversationId: r.conversationId ?? target.conversationId ?? conversationId ?? "", messageId: r.messageId ?? "", replyId: r.replyId ?? "", replayed: false, reason: `research ${control[1]!.toLowerCase()}` };
      }
    }
    const prefs = await ctx.runQuery(api.settings.get, {});
    const status = await ctx.model.status();
    const useModel = prefs.modelAssist && status.ready && ctx.auth.has("feltkit.agent.write");
    // "Can you search the web?" without a model: answered from what discovery finds, not a fixed list.
    if (!useModel && CAPABILITY_QUESTION.test(text)) {
      const d = await discover(ctx.agent, PROSPECT_NEEDS, { declared: declaredCapabilities() });
      const search = d.needs[0]!;
      const reply = [
        search.state === "available" && search.problems.length
          ? "Web search is set up in this PersonalOS; whether its provider is configured is checked when research first uses it. Ask for the outcome (for example, \"find me new customers for <product>\") and I'll run it, or tell you exactly what is missing."
          : search.state === "available"
          ? "Yes. Web search is available to me here, so I can research things for you: ask for the outcome (for example, \"find me new customers for <product>\") and I'll run it."
          : `Not right now, and it isn't a fixed limit: ${search.need} is ${search.state === "needs-configuration" ? "set up but not configured" : search.state === "needs-authorization" ? "not permitted for your account" : "not connected"}.${search.howToEnable ? ` ${search.howToEnable}` : ""}`,
        `What I checked (${d.capabilitiesSeen} capabilities):`,
        describeDiscovery(d),
      ].join("\n");
      const r = await ctx.runMutation(api.researchstate.answer, { text, reply, ...(conversationId ? { conversationId } : {}) });
      return { mode: "rules" as const, ...r, replayed: false, reason: "capabilities" };
    }
    if (!useModel) {
      // The deterministic assistant: still fully working without a model.
      const reason = !prefs.modelAssist ? "model turned off in Settings" : !status.ready ? (status.problems[0]?.message ?? "no model is configured") : "this account may not use the model";
      const r = await ctx.runMutation(api.assistant.send, { ...(conversationId ? { conversationId } : {}), text, today: clock.today, tzOffset: clock.tzOffset });
      return { mode: "rules" as const, ...r, replayed: false, reason };
    }

    const user = await ctx.runMutation(api.turnstate.recordUser, { ...(conversationId ? { conversationId } : {}), clientId, text });
    const landscape = describeDiscovery(await discover(ctx.agent, PROSPECT_NEEDS, { declared: declaredCapabilities() }));
    if (user.replyId) return { mode: "model" as const, conversationId: user.conversationId, messageId: user.messageId, replyId: user.replyId, replayed: true };
    const { taskId } = await ctx.agent.openTask({ key: user.messageId, objective: text.slice(0, 500) });
    ctx.emit({ type: "turn", conversationId: user.conversationId, messageId: user.messageId, taskId });

    const info = await ctx.runQuery(api.turnstate.context, { conversationId: user.conversationId, before: user.messageId, query: text });
    const tools = (await ctx.agent.tools())
      .filter((t) => TOOLS.includes(t.name))
      .map((t) => {
        const hidden = APP_FILLED[t.name] ?? [];
        const schema = JSON.parse(JSON.stringify(t.inputSchema)) as { properties?: Record<string, unknown>; required?: string[] };
        for (const key of hidden) {
          delete schema.properties?.[key];
          if (schema.required) schema.required = schema.required.filter((r) => r !== key);
        }
        return { ...t, inputSchema: schema as Record<string, unknown> };
      });
    const conversation: GenerationMessage[] = [
      { role: "system", content: systemPrompt(clock, info, landscape) },
      ...info.history.map((m) => ({ role: m.role as "user" | "assistant", content: m.text })),
      { role: "user", content: text },
    ];

    let reply = "";
    let model = `${status.provider}/${status.model}`;
    let reference: string | undefined;
    let cancelled = false;
    const generations: string[] = [];
    const proposals: Array<{ taskId: string; actionId: string; capability: string; effect: string; state: string; input: Record<string, unknown> }> = [];
    try {
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        if (round > 0 && reply && !reply.endsWith("\n")) {
          reply += "\n\n";
          ctx.emit({ type: "delta", text: "\n\n" });
        }
        const g = await ctx.model.generate({ taskId, messages: conversation, tools, maxTokens: 700 });
        generations.push(g.memoryId);
        model = `${g.receipt.provider}/${g.receipt.model}`;
        if (g.receipt.resolution) reference = `${g.receipt.resolution.ref}@${g.receipt.resolution.revision}`;
        reply += g.text;
        if (g.finish === "cancelled") {
          cancelled = true;
          break;
        }
        if (!g.toolCalls.length) break;
        const results: Array<{ call: ToolCall; content: string; observed?: boolean }> = [];
        for (const call of g.toolCalls) {
          if (!TOOLS.includes(call.name)) {
            results.push({ call, content: JSON.stringify({ error: `${call.name} is not available to you.` }) });
            continue;
          }
          const input = normalize(call.name, call.input, clock);
          try {
            const p = await ctx.agent.propose(taskId, { capability: call.name, input, reason: text.slice(0, 500), idempotencyKey: call.id, model: { provider: g.receipt.provider, model: g.receipt.model, generation: { generationId: g.generationId, memoryId: g.memoryId, toolCallId: call.id } } });
            proposals.push({ taskId, actionId: p.actionId, capability: p.capability, effect: p.effect, state: p.state, input });
            results.push({
              call,
              observed: p.effect === "observation",
              content: p.effect === "observation" ? (p.state === "succeeded" ? trim(p.output) : JSON.stringify({ error: p.error })) : JSON.stringify({ status: "proposed", note: "Waiting for the user's approval. It has NOT happened yet." }),
            });
          } catch (error) {
            const e = error as { code?: string; message?: string };
            results.push({ call, content: JSON.stringify({ error: `${e.code ?? "ERROR"}: ${e.message ?? String(error)}` }) });
          }
        }
        conversation.push({ role: "assistant", content: g.text, toolCalls: g.toolCalls });
        for (const r of results) conversation.push({ role: "tool", toolCallId: r.call.id, content: r.content });
        // Nothing new to read (no observation ran) and something already said: the turn is complete.
        if (!results.some((r) => r.observed) && reply.trim()) break;
      }
      const replyId = await ctx.runMutation(api.turnstate.recordReply, { conversationId: user.conversationId, replyTo: user.messageId, text: reply.trim(), taskId, model, ...(reference ? { reference } : {}), generations, proposals, ...(cancelled ? { cancelled: true } : {}) });
      return { mode: "model" as const, conversationId: user.conversationId, messageId: user.messageId, replyId, replayed: false };
    } catch (error) {
      // The turn still ends with a reply that says what happened, and what it had already proposed.
      const e = error as { code?: string; message?: string };
      const note = `I couldn't finish that (${e.code ?? "error"}: ${String(e.message ?? error).slice(0, 300)}).${proposals.length ? " What I proposed before that is below, still waiting for you." : " Nothing was changed."}`;
      const replyId = await ctx.runMutation(api.turnstate.recordReply, { conversationId: user.conversationId, replyTo: user.messageId, text: `${reply.trim()}${reply.trim() ? "\n\n" : ""}${note}`, taskId, model, ...(reference ? { reference } : {}), generations, proposals });
      return { mode: "model" as const, conversationId: user.conversationId, messageId: user.messageId, replyId, replayed: false, reason: note };
    }
  },
});


/** The environment's model, as Settings shows it: provider, model, where it comes from (Resolver / Intelligence). Never a secret. */
export const modelStatus = app.action({
  access: "assistant.send",
  handler: async (ctx) => ctx.model.status(),
});
