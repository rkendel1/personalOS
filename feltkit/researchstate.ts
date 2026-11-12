/**
 * The writes behind research.begin and research.retry (feltkit/research.ts): recording a run, its plan
 * and its discovery, and replying in the conversation. Separate from research.ts so those actions can
 * name them through the generated API.
 */
import { fail, s } from "@feltdb/feltkit";
import { app, conversations, memories, researchRuns } from "./app.js";
import { describeDiscovery, type Discovery } from "./_capabilities.js";
import { planQueries, productKnowledge } from "./_research.js";
import { appendMessage } from "./assistant.js";
import * as ops from "./_ops.js";

const RunView = s.object({ runId: s.string(), conversationId: s.string(), status: s.string(), reply: s.string(), messageId: s.string(), replyId: s.string() });
const titleOf = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}…` : text);

function blockerOf(d: Discovery) {
  const n = d.needs.find((x) => x.required && x.state !== "available");
  return n ? { need: n.need, state: n.state, detail: n.problems.join(" ") || `${n.need} is ${n.state.replace("-", " ")}.`, ...(n.howToEnable ? { howToEnable: n.howToEnable } : {}) } : undefined;
}

function startReply(product: string, queries: string[], d: Discovery, knowledge: { statements: unknown[] }): string {
  const lines = [`On it: finding qualified prospects for ${product}. I checked what this PersonalOS can do for that (${d.capabilitiesSeen} capabilities):`, describeDiscovery(d), ""];
  lines.push(knowledge.statements.length
    ? `I'm working from what you've told me about ${product} (${knowledge.statements.length} saved note${knowledge.statements.length === 1 ? "" : "s"}).`
    : `You haven't told me what ${product} does, so I'm starting from its name; tell me who it's for and I'll sharpen the search.`);
  lines.push(`Plan: ${queries.length} web searches (${queries.map((q) => `"${q}"`).join(", ")}), then each company found is checked against how ${product} is described, ranked, and saved with its sources. I'll post the result here.`);
  if (!d.complete) lines.push("What isn't available only limits the result (each prospect says what was not verified).");
  lines.push("I won't contact anyone: outreach waits for your approval.");
  return lines.join("\n");
}

function blockedReply(product: string, d: Discovery, blocker: NonNullable<ReturnType<typeof blockerOf>>): string {
  return [
    `I can't run this research yet, and it isn't a permanent limit: ${blocker.need} is the missing piece. Here is what I checked (${d.capabilitiesSeen} capabilities):`,
    describeDiscovery(d),
    "",
    `To unblock it: ${blocker.howToEnable ?? "connect a provider for it."}`,
    `Your request is saved as the objective (find prospects for ${product}); say "retry research" once that's done and I'll pick it up. Nothing was searched, and I have no results to show you.`,
  ].join("\n");
}

/** Record a research run and its first reply. Called by `begin` with what discovery found. */
export const create = app.mutation({
  access: "research.run",
  args: { text: s.string({ minLength: 1, maxLength: 4000 }), product: s.string({ minLength: 1, maxLength: 120 }), objective: s.string({ maxLength: 1000 }), discovery: s.record(s.unknown()), conversationId: s.optional(s.string()) },
  returns: RunView,
  handler: async (ctx, args) => {
    const owner = ops.me(ctx);
    let conversationId = args.conversationId;
    if (conversationId) await ops.own(ctx, conversations, conversationId, "conversation");
    else conversationId = await ctx.db.insert(conversations, { owner, title: titleOf(args.text), createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 });
    const messageId = await appendMessage(ctx, conversationId, { role: "user", text: args.text });
    const discovery = args.discovery as unknown as Discovery;
    const known = (await ctx.db.find(memories, { owner })).map((m: any) => ({ id: m.id, content: String(m.content), status: m.status }));
    const knowledge = productKnowledge(args.product, known);
    const queries = planQueries(args.product, knowledge);
    const blocker = blockerOf(discovery);
    const now = Date.now();
    const runId = await ctx.db.insert(researchRuns, {
      owner, kind: "prospects", request: args.text, product: args.product, objective: args.objective,
      status: blocker ? "blocked" : "running",
      discovery: args.discovery,
      profile: knowledge,
      queries: queries.map((text) => ({ text, state: "pending" as const, attempts: 0 })),
      ...(blocker ? { blocker } : {}),
      conversationId, createdAt: now, updatedAt: now,
    });
    const reply = blocker ? blockedReply(args.product, discovery, blocker) : startReply(args.product, queries, discovery, knowledge);
    const replyId = await appendMessage(ctx, conversationId, { role: "assistant", text: reply });
    if (!blocker) ctx.afterCommit.agent("research", { runId });
    return { runId, conversationId, status: blocker ? "blocked" : "running", reply, messageId, replyId };
  },
});

export const resume = app.mutation({
  access: "research.run",
  args: { runId: s.string(), discovery: s.record(s.unknown()) },
  returns: RunView,
  handler: async (ctx, { runId, discovery }) => {
    const run = await ops.own<any>(ctx, researchRuns, runId, "research run");
    if (run.status === "running") return { runId, conversationId: run.conversationId, status: run.status, reply: "Still running.", messageId: "", replyId: "" };
    if (run.status === "completed") fail("FAILED_PRECONDITION", "This research is complete. Ask again to start a new one.");
    const d = discovery as unknown as Discovery;
    const blocker = blockerOf(d);
    const queries = run.queries.map((q: any) => (q.state === "failed" || (run.status === "cancelled" && q.state === "pending") ? { text: q.text, state: "pending", attempts: 0 } : q));
    const status = blocker ? "blocked" : "running";
    await ctx.db.patch(researchRuns, runId, { status, discovery, queries, cancelRequested: false, blocker: blocker ?? undefined, updatedAt: Date.now() });
    const reply = blocker ? blockedReply(run.product, d, blocker) : `Resuming the research for ${run.product}: ${queries.filter((q: any) => q.state === "pending").length} search(es) to go.`;
    const replyId = run.conversationId ? await appendMessage(ctx, run.conversationId, { role: "assistant", text: reply }) : "";
    if (!blocker) ctx.afterCommit.agent("research", { runId });
    return { runId, conversationId: run.conversationId, status, reply, messageId: replyId, replyId };
  },
});


/** Record a question about what PersonalOS can do, and the answer discovery gave (no model involved). */
export const answer = app.mutation({
  access: "assistant.send",
  args: { text: s.string({ minLength: 1, maxLength: 4000 }), reply: s.string({ minLength: 1, maxLength: 8000 }), conversationId: s.optional(s.string()) },
  returns: s.object({ conversationId: s.string(), messageId: s.string(), replyId: s.string() }),
  handler: async (ctx, args) => {
    const owner = ops.me(ctx);
    let conversationId = args.conversationId;
    if (conversationId) await ops.own(ctx, conversations, conversationId, "conversation");
    else conversationId = await ctx.db.insert(conversations, { owner, title: titleOf(args.text), createdAt: Date.now(), updatedAt: Date.now(), messageCount: 0 });
    const messageId = await appendMessage(ctx, conversationId, { role: "user", text: args.text });
    const replyId = await appendMessage(ctx, conversationId, { role: "assistant", text: args.reply });
    return { conversationId, messageId, replyId };
  },
});
