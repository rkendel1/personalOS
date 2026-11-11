/**
 * FeltKit M1 acceptance, in PersonalOS: a model turn answers in its own words, proposes actions
 * through AppPort, waits for the owner's approval (enforced server-side), and leaves evidence that
 * survives a restart. The provider is a scripted loopback server (deterministic); the real-provider
 * run is in tests/real-provider.test.ts and the browser run in e2e/.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { clockFor } from "../feltkit/_clock.js";
import { addDays } from "../feltkit/_dates.js";
import { startStreamingModel } from "./fixtures/streaming-model.js";

const ZONE = "America/New_York";
const admin = { id: "root", type: "user" as const, roles: ["admin"] };

async function withModel() {
  const model = await startStreamingModel();
  const t = await createTestApp();
  await t.runtime.services.asPrincipal(admin as never, (v) => t.runtime.services.intelligence!.set({ ...t.runtime.services.scope, provider: "ollama", model: "loop", endpoint: `${model.url}/v1` }, v));
  return { t, model };
}

const turn = (t: TestApp, who: string, args: { text: string; clientId: string; conversationId?: string }, events?: Array<Record<string, unknown>>) =>
  t.as(who).action(api.turn.turn, args, { context: { timeZone: ZONE, locale: "en-US" }, ...(events ? { onEvent: (e) => events.push(e) } : {}) });

const lastReply = async (t: TestApp, who: string, conversationId: string) => (await t.as(who).query(api.conversations.messagesOf, { conversationId })).at(-1)!;

test("the acceptance conversation: reply streams, the reminder is proposed (approval required), analysis names the priority; approval creates it; it all survives a restart", async () => {
  const { t, model } = await withModel();
  try {
    const clock = clockFor(ZONE);
    const tomorrow = addDays(clock.today, 1);
    await t.as("ada").mutation(api.tasks.create, { title: "Pending project review", due: clock.today, priority: "high" });
    await t.as("ada").mutation(api.tasks.create, { title: "Water the plants" });

    model.scripts.push({
      text: ["I'll schedule that reminder ", "and look at your outstanding tasks."],
      toolCalls: [
        { id: "call_r", name: "tasks_create", args: JSON.stringify({ title: "Follow up with John", due: tomorrow, time: "10:00", reminder: true }) },
        { id: "call_b", name: "briefing_today", args: "{}" },
      ],
    });
    model.scripts.push({ text: ["Your highest-priority outstanding task is the pending project review. ", "I'd suggest completing that before your afternoon commitments."] });

    const events: Array<Record<string, unknown>> = [];
    const out = await turn(t, "ada", { text: "Remind me to follow up with John tomorrow at 10am, and tell me what else I should prioritize.", clientId: "client-0001" }, events);
    assert.equal(out.mode, "model");

    // Streamed, in order, across both rounds.
    const streamed = events.filter((e) => e.type === "delta").map((e) => e.text).join("");
    assert.match(streamed, /^I'll schedule that reminder and look at your outstanding tasks\.\n\nYour highest-priority outstanding task is the pending project review\./);

    // The model saw the briefing (an observation that ran) and the proposal status (not done).
    const second = model.requests[1]!.body.messages;
    assert.match(JSON.stringify(second), /Pending project review/);
    assert.match(JSON.stringify(second), /Waiting for the user's approval\. It has NOT happened yet/);
    // The app, not the model, filled the time zone offset (DST-aware) and today's date.
    const reply = await lastReply(t, "ada", out.conversationId);
    const [create, briefing] = reply.agent!.proposals;
    assert.deepEqual([create!.capability, create!.effect, create!.state], ["tasks.create", "consequential", "proposed"]);
    assert.deepEqual([create!.input.title, create!.input.due, create!.input.time, create!.input.reminder], ["Follow up with John", tomorrow, "10:00", true]);
    assert.equal(typeof create!.input.tzOffset, "number");
    assert.deepEqual([briefing!.capability, briefing!.effect, briefing!.state, briefing!.input.today], ["briefing.today", "observation", "succeeded", clock.today]);
    assert.equal(reply.agent!.generations.length, 2, "two generations, both recorded");
    assert.equal(reply.agent!.model, "ollama/loop");

    // Nothing happened yet: the reminder does not exist.
    assert.equal((await t.as("ada").query(api.tasks.list, { status: "open" })).some((x) => x.title === "Follow up with John"), false);

    // The owner approves, server-side; it runs through AppPort as Ada.
    await t.runtime.agent.approveOwn(create!.taskId, create!.actionId, { id: "ada", type: "user", roles: ["owner", "admin"] });
    const reminder = (await t.as("ada").query(api.tasks.list, { status: "open" })).find((x) => x.title === "Follow up with John")!;
    assert.equal(reminder.due, tomorrow);
    assert.equal(reminder.remindTime, "10:00");
    // 10:00 in New York, whatever the season.
    const ny = new Intl.DateTimeFormat("en-US", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(reminder.remindAt!));
    assert.equal(ny, "10:00");

    // Evidence and conversation survive a restart.
    await t.restart();
    const after = await lastReply(t, "ada", out.conversationId);
    assert.equal(after.id, reply.id);
    const [action] = await t.runtime.agent.actionsOwnedBy({ id: "ada", type: "user", roles: ["owner", "admin"] }, {});
    assert.deepEqual([action!.action.capability, action!.action.state, action!.action.proposedBy, action!.action.decidedBy], ["tasks.create", "succeeded", "model:ollama/loop", "user:ada"]);
    const generations = await t.runtime.agent.generations(create!.taskId, { id: "ada", type: "user", roles: ["owner", "admin"] });
    assert.deepEqual(generations.map((g) => g.memoryId), reply.agent!.generations);
  } finally {
    await t.close();
    await model.close();
  }
});

test("a retried turn (same client message id) is the same turn: one user message, one model call, no new proposals", async () => {
  const { t, model } = await withModel();
  try {
    model.scripts.push({ text: ["Proposed."], toolCalls: [{ id: "c1", name: "tasks_create", args: JSON.stringify({ title: "Once" }) }] });
    const a = await turn(t, "ada", { text: "add once", clientId: "client-dup-1" });
    const b = await turn(t, "ada", { text: "add once", clientId: "client-dup-1" });
    assert.equal(b.replayed, true);
    assert.equal(b.replyId, a.replyId);
    assert.equal(model.requests.length, 1);
    const msgs = await t.as("ada").query(api.conversations.messagesOf, { conversationId: a.conversationId });
    assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant"]);
  } finally {
    await t.close();
    await model.close();
  }
});

test("two people: Grace cannot read Ada's turn, approve Ada's proposal, or see it in her own list", async () => {
  const { t, model } = await withModel();
  try {
    model.scripts.push({ toolCalls: [{ id: "c1", name: "tasks_create", args: JSON.stringify({ title: "Ada's secret plan" }) }] });
    const a = await turn(t, "ada", { text: "add my secret plan", clientId: "client-iso-1" });
    const [p] = (await lastReply(t, "ada", a.conversationId)).agent!.proposals;
    const grace = { id: "grace", type: "user" as const, roles: ["owner"] };
    await t.runtime.issueSession(grace, { kind: "test", via: "test" });
    await assert.rejects(t.as("grace").query(api.conversations.messagesOf, { conversationId: a.conversationId }), { code: "NOT_FOUND" });
    await assert.rejects(t.runtime.agent.approveOwn(p!.taskId, p!.actionId, grace), { code: "NOT_FOUND" });
    assert.deepEqual(await t.runtime.agent.actionsOwnedBy(grace, {}), []);
    await assert.rejects(t.runtime.agent.generations(p!.taskId, grace), { code: "NOT_FOUND" });
  } finally {
    await t.close();
    await model.close();
  }
});

test("unauthorized: the read-only guest cannot run a turn, and the model is never asked", async () => {
  const { t, model } = await withModel();
  try {
    await assert.rejects(turn(t, "guest", { text: "add a task", clientId: "client-guest" }), { code: "FORBIDDEN" });
    assert.equal(model.requests.length, 0);
  } finally {
    await t.close();
    await model.close();
  }
});

test("with the model off (or none configured), the same turn runs the deterministic assistant and still works", async () => {
  const t = await createTestApp();
  try {
    const out = await turn(t, "ada", { text: "Remind me to follow up with John tomorrow at 10am", clientId: "client-rules" });
    assert.equal(out.mode, "rules");
    assert.match(out.reason!, /No model is selected|not configured|Intelligence/i);
    const task = (await t.as("ada").query(api.tasks.list, { status: "open" })).find((x) => x.title === "Follow up with John")!;
    assert.equal(task.due, addDays(clockFor(ZONE).today, 1), "tomorrow in the caller's time zone, from FeltKit's caller context");
    // And the owner can turn the model off even when one is ready.
    const { t: t2, model } = await withModel();
    try {
      await t2.as("ada").mutation(api.settings.set, { modelAssist: false });
      const off = await turn(t2, "ada", { text: "what am I forgetting?", clientId: "client-off" });
      assert.deepEqual([off.mode, off.reason], ["rules", "model turned off in Settings"]);
      assert.equal(model.requests.length, 0);
    } finally {
      await t2.close();
      await model.close();
    }
  } finally {
    await t.close();
  }
});

test("a provider failure mid-turn ends the turn with an honest reply and no changes", async () => {
  const model = await startStreamingModel();
  const t = await createTestApp();
  try {
    // An endpoint that does not exist: the provider cannot be reached.
    await t.runtime.services.asPrincipal(admin as never, (v) => t.runtime.services.intelligence!.set({ ...t.runtime.services.scope, provider: "ollama", model: "loop", endpoint: "http://127.0.0.1:9/v1" }, v));
    const out = await turn(t, "ada", { text: "hello", clientId: "client-fail" });
    assert.equal(out.mode, "model");
    const reply = await lastReply(t, "ada", out.conversationId);
    assert.match(reply.text, /couldn't finish that \(UNAVAILABLE: .*could not be reached.*\)\. Nothing was changed\./);
    assert.deepEqual(await t.as("ada").query(api.tasks.list, {}), []);
  } finally {
    await t.close();
    await model.close();
  }
});
