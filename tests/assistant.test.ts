/**
 * The assistant's workflows against the real FeltKit runtime and a real (isolated) FeltDB instance.
 * Each test maps to the definition of done; restarts prove durability.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";

const TODAY = "2026-11-11";
const TZ = 300; // UTC-5
const say = (t: TestApp, text: string, conversationId?: string, who = "ada") => t.as(who).mutation(api.assistant.send, { text, today: TODAY, tzOffset: TZ, ...(conversationId ? { conversationId } : {}) });
const reply = async (t: TestApp, conversationId: string, who = "ada") => (await t.as(who).query(api.conversations.messagesOf, { conversationId })).at(-1)!;

test("DoD 1-2: a conversation persists across a restart", async () => {
  const t = await createTestApp();
  try {
    const { conversationId } = await say(t, "hello");
    await say(t, "what can you do?", conversationId);
    await t.restart();
    const msgs = await t.as("ada").query(api.conversations.messagesOf, { conversationId });
    assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
    assert.equal((await t.as("ada").query(api.conversations.list)).length, 1);
  } finally {
    await t.close();
  }
});

test("DoD 3-4: told something important, it remembers in a later conversation, with provenance", async () => {
  const t = await createTestApp();
  try {
    const first = await say(t, "Remember that Sam Rivera is my manager");
    const m = (await t.as("ada").query(api.memory.list))[0]!;
    assert.deepEqual([m.status, m.kind, m.content, m.source.kind, m.source.conversationId, m.source.messageId], ["confirmed", "person", "Sam Rivera is my manager", "conversation", first.conversationId, first.messageId]);
    await t.restart();
    const second = await say(t, "who is Sam?");
    assert.notEqual(second.conversationId, first.conversationId);
    assert.match((await reply(t, second.conversationId)).text, /Sam Rivera is my manager/);
  } finally {
    await t.close();
  }
});

test("volunteered facts are stored as inferred, hedged on recall, and only confirmed by the user", async () => {
  const t = await createTestApp();
  try {
    const { conversationId } = await say(t, "I prefer meetings in the afternoon");
    const [m] = await t.as("ada").query(api.memory.list);
    assert.equal(m!.status, "inferred");
    await say(t, "what are my preferences?", conversationId);
    assert.match((await reply(t, conversationId)).text, /Only unconfirmed notes[\s\S]*afternoon\?/);
    await say(t, "yes, remember that", conversationId);
    assert.equal((await t.as("ada").query(api.memory.list))[0]!.status, "confirmed");
  } finally {
    await t.close();
  }
});

test("DoD 5-6: a reminder from chat becomes a task with evidence, and fires through a real job", async () => {
  const t = await createTestApp();
  try {
    const { conversationId, replyId } = await say(t, "Remind me to follow up with John tomorrow at 10am");
    const [task] = await t.as("ada").query(api.tasks.list, { status: "open" });
    assert.deepEqual([task!.title, task!.due, task!.remindTime], ["Follow up with John", "2026-11-12", "10:00"]);
    assert.equal(task!.remindAt, Date.UTC(2026, 10, 12, 10, 0) + TZ * 60_000, "10am in the user's time zone");
    const r = await reply(t, conversationId);
    assert.equal(r.id, replyId);
    assert.match(r.text, /remind you to \*\*follow up with John\*\* tomorrow at 10am/);
    const [action] = await t.as("ada").query(api.actions.list, {});
    assert.deepEqual(r.actionIds, [action!.id], "the reply cites the action it reports");
    assert.deepEqual([action!.kind, action!.status, action!.evidence?.collection, action!.evidence?.id, action!.evidence?.verified], ["reminder.create", "succeeded", "tasks", task!.id, true]);

    // The reminder is a real AppPort Services job, queued after commit to run at that time as Ada.
    await t.runtime.runServices(); // performs the after-commit outbox
    const jobs = (t.runtime.services as any).jobs;
    const [job] = await jobs.listJobs("personalos");
    assert.deepEqual([job.type, job.status, job.runAt, job.payload, job.principal.principalId], ["reminder.fire", "scheduled", new Date(task!.remindAt!).toISOString(), { taskId: task!.id, remindAt: task!.remindAt }, "ada"]);
    // Run it now through the services worker path (the clock cannot be advanced to tomorrow).
    assert.equal(await jobs.executeJob("personalos", job.id, "test-worker"), true);
    await t.runtime.runServices();
    const inbox = await t.as("ada").query(api.inbox.list, {});
    assert.deepEqual(inbox.map((n) => [n.type, n.title]), [["reminder.due", "Follow up with John"]]);
    const [fired] = await t.as("ada").query(api.actions.list, {});
    assert.deepEqual([fired!.kind, fired!.via, fired!.evidence?.verified], ["reminder.fire", "job", true]);
    assert.deepEqual(await t.as("ada").mutation(api.reminders.fire, { taskId: task!.id, remindAt: task!.remindAt! }), { fired: false }, "fires once");
    // Moving the task re-arms it; the old job would now find a different remindAt and do nothing.
    await say(t, "move that to friday at 9am", conversationId);
    assert.deepEqual(await t.as("ada").mutation(api.reminders.fire, { taskId: task!.id, remindAt: task!.remindAt! }), { fired: false });
    const moved = (await t.as("ada").query(api.tasks.list, {}))[0]!;
    assert.deepEqual([moved.due, moved.remindTime, moved.remindedAt], ["2026-11-13", "09:00", undefined]);
  } finally {
    await t.close();
  }
});

test("a reminder with no time asks instead of guessing; nothing is created", async () => {
  const t = await createTestApp();
  try {
    const { conversationId } = await say(t, "remind me to call mom");
    assert.match((await reply(t, conversationId)).text, /When should I remind you/);
    assert.deepEqual(await t.as("ada").query(api.tasks.list, {}), []);
    assert.deepEqual(await t.as("ada").query(api.actions.list, {}), []);
  } finally {
    await t.close();
  }
});

test("\"move that task to Friday\" uses the conversation's context, and completing a recurring task schedules the next", async () => {
  const t = await createTestApp();
  try {
    const { conversationId } = await say(t, "add write the quarterly report to my list");
    await say(t, "move that task to Friday", conversationId);
    const [task] = await t.as("ada").query(api.tasks.list, {});
    assert.equal(task!.due, "2026-11-13");
    assert.match((await reply(t, conversationId)).text, /Moved \*\*Write the quarterly report\*\* to Friday/);

    const c2 = (await say(t, "remind me to water the plants every monday at 8am")).conversationId;
    await say(t, "done", c2);
    const open = await t.as("ada").query(api.tasks.list, { status: "open" });
    const next = open.find((x) => x.title === "Water the plants")!;
    assert.equal(next.due, "2026-11-23");
    assert.equal(next.remindAt, Date.UTC(2026, 10, 23, 8, 0) + TZ * 60_000);
    assert.equal((await t.as("ada").query(api.tasks.list, { status: "done" }))[0]!.title, "Water the plants");
  } finally {
    await t.close();
  }
});

test("DoD 7-8: what needs attention today, from durable state", async () => {
  const t = await createTestApp();
  try {
    await t.as("ada").mutation(api.settings.set, { name: "Ada" });
    await t.as("ada").mutation(api.tasks.create, { title: "Renew passport", due: "2026-11-09", priority: "high" });
    await t.as("ada").mutation(api.tasks.create, { title: "Pay rent", due: TODAY });
    await t.as("ada").mutation(api.tasks.create, { title: "Book flights", due: "2026-11-14" });
    await say(t, "remember that Alex's birthday is November 15");
    const b = await t.as("ada").query(api.briefing.today, { today: TODAY });
    assert.deepEqual(b.focus.map((x) => x.title), ["Renew passport", "Pay rent"]);
    assert.deepEqual([b.overdue.length, b.dueToday.length, b.upcoming.length, b.dates.length], [1, 1, 1, 1]);
    const { conversationId } = await say(t, "What needs my attention today?");
    const text = (await reply(t, conversationId)).text;
    assert.match(text, /^Ada, here's where I'd put your energy today:\n1\. Renew passport \(overdue since Mon, Nov 9\)\n2\. Pay rent/);
    assert.match(text, /\*\*Coming up:\*\* Book flights \(Saturday\)/);
    assert.match(text, /Alex's birthday is November 15 \(Sunday\)/);
  } finally {
    await t.close();
  }
});

test("DoD 9: destructive requests are proposed, wait for approval, and the log shows every step", async () => {
  const t = await createTestApp();
  try {
    const { conversationId } = await say(t, "add dentist appointment to my list");
    await say(t, "delete the dentist task", conversationId);
    let [proposal] = await t.as("ada").query(api.actions.list, { status: "proposed" });
    assert.deepEqual([proposal!.kind, proposal!.approval], ["task.delete", "required"]);
    assert.equal((await t.as("ada").query(api.tasks.list, {})).length, 1, "nothing deleted yet");
    assert.match((await reply(t, conversationId)).text, /approve it below/);

    // An agent holding the permission can only propose approval; a person approves.
    const bot = t.as({ id: "ada", type: "agent", roles: ["owner"] });
    await assert.rejects(bot.mutation(api.actions.approve, { id: proposal!.id }));
    proposal = await t.as("ada").mutation(api.actions.approve, { id: proposal!.id });
    assert.equal(proposal!.status, "succeeded");
    assert.deepEqual(await t.as("ada").query(api.tasks.list, {}), []);
    assert.match((await reply(t, conversationId)).text, /Approved and done: Deleted task: Dentist appointment/);
    const log = await t.as("ada").query(api.actions.list, {});
    assert.deepEqual(log.map((a) => [a.kind, a.status]), [["task.delete", "succeeded"], ["task.delete", "succeeded"], ["task.create", "succeeded"]]);
    await assert.rejects(t.as("ada").mutation(api.actions.approve, { id: proposal!.id }), { code: "FAILED_PRECONDITION" });
  } finally {
    await t.close();
  }
});

test("rejecting a proposal changes nothing; forgetting needs approval too", async () => {
  const t = await createTestApp();
  try {
    const { conversationId } = await say(t, "remember that my locker code is 4412");
    await say(t, "forget my locker code", conversationId);
    const [proposal] = await t.as("ada").query(api.actions.list, { status: "proposed" });
    await t.as("ada").mutation(api.actions.reject, { id: proposal!.id });
    assert.equal((await t.as("ada").query(api.memory.list)).length, 1);
    assert.match((await reply(t, conversationId)).text, /Nothing changed/);
  } finally {
    await t.close();
  }
});

test("people see only their own assistant; viewers cannot write", async () => {
  const t = await createTestApp();
  try {
    const { conversationId } = await say(t, "remember that the wifi password is on the fridge");
    assert.deepEqual(await t.as("grace").query(api.memory.list), []);
    await assert.rejects(t.as("grace").query(api.conversations.messagesOf, { conversationId }), { code: "NOT_FOUND" });
    await assert.rejects(say(t, "hello", conversationId, "grace"), { code: "NOT_FOUND" });
    await assert.rejects(say(t, "hello", undefined, "guest"), { code: "FORBIDDEN" });
    await assert.rejects(t.query(api.memory.list), { code: "UNAUTHORIZED" });
  } finally {
    await t.close();
  }
});

test("editing a message supersedes the old turn and continues from the edit; actions already taken stay logged", async () => {
  const t = await createTestApp();
  try {
    const first = await say(t, "add buy milk to my list");
    const edited = await t.as("ada").mutation(api.assistant.edit, { messageId: first.messageId, text: "add buy oat milk to my list", today: TODAY, tzOffset: TZ });
    const msgs = await t.as("ada").query(api.conversations.messagesOf, { conversationId: first.conversationId });
    assert.deepEqual(msgs.map((m) => [m.role, Boolean(m.supersededBy)]), [["user", true], ["assistant", true], ["user", false], ["assistant", false]]);
    assert.equal(msgs[0]!.supersededBy, edited.messageId);
    assert.deepEqual((await t.as("ada").query(api.tasks.list, {})).map((x) => x.title).sort(), ["Buy milk", "Buy oat milk"]);
  } finally {
    await t.close();
  }
});

test("an unknown message is answered honestly when no model is enabled, and nothing is recorded", async () => {
  const t = await createTestApp();
  try {
    const { conversationId } = await say(t, "the mitochondria is the powerhouse of the cell");
    assert.match((await reply(t, conversationId)).text, /didn't catch an action|Not sure what to do/);
    assert.deepEqual(await t.as("ada").query(api.actions.list, {}), []);
    assert.deepEqual(await t.as("ada").query(api.memory.list), []);
  } finally {
    await t.close();
  }
});
