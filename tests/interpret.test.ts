/** The deterministic interpreter and date parser: pure functions, no app. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { interpret } from "../feltkit/_interpret.js";
import { parseWhen, nextOccurrence, describeDay } from "../feltkit/_dates.js";

const TODAY = "2026-11-11"; // a Wednesday

test("dates resolve against the user's own today", () => {
  assert.equal(parseWhen("tomorrow", TODAY).due, "2026-11-12");
  assert.equal(parseWhen("on friday", TODAY).due, "2026-11-13");
  assert.equal(parseWhen("wednesday", TODAY).due, "2026-11-18", "a weekday name is the next one after today");
  assert.equal(parseWhen("next week", TODAY).due, "2026-11-16");
  assert.equal(parseWhen("in 3 days", TODAY).due, "2026-11-14");
  assert.equal(parseWhen("dec 25", TODAY).due, "2026-12-25");
  assert.equal(parseWhen("jan 2", TODAY).due, "2027-01-02", "a past month-day is next year");
  assert.deepEqual([parseWhen("at 3pm", TODAY).time, parseWhen("at 9:30am", TODAY).time, parseWhen("at 3", TODAY).time, parseWhen("at 15:45", TODAY).time], ["15:00", "09:30", "15:00", "15:45"]);
  assert.deepEqual(parseWhen("tomorrow morning", TODAY), { due: "2026-11-12", time: "09:00", spans: ["tomorrow morning"] });
  assert.equal(nextOccurrence("2026-11-13", "weekdays"), "2026-11-16", "Friday → Monday");
  assert.equal(nextOccurrence("2026-01-31", "monthly"), "2026-02-28");
  assert.equal(describeDay("2026-11-12", TODAY), "tomorrow");
});

test("the examples from the brief", () => {
  const r = interpret("Remind me to follow up with John tomorrow", TODAY);
  assert.deepEqual(r, { intent: { kind: "task.create", title: "Follow up with John", reminder: true, priority: "normal", due: "2026-11-12" }, missing: [] });
  assert.equal(interpret("Help me plan my week", TODAY).intent.kind, "plan.week");
  assert.equal(interpret("What am I forgetting?", TODAY).intent.kind, "forgetting");
  assert.deepEqual(interpret("Move that task to Friday", TODAY).intent, { kind: "task.reschedule", ref: { that: true }, due: "2026-11-13" });
  assert.equal(interpret("What should I focus on today?", TODAY).intent.kind, "briefing");
});

test("tasks, reminders and their missing pieces", () => {
  const r = interpret("remind me to call mom", TODAY);
  assert.equal(r.intent.kind, "task.create");
  assert.deepEqual(r.missing, ["when"], "a reminder without a time asks when");
  const t = interpret("add buy milk to my list", TODAY);
  assert.deepEqual(t.intent, { kind: "task.create", title: "Buy milk", reminder: false, priority: "normal" });
  assert.equal((interpret("add renew passport to my list, it's urgent", TODAY).intent as any).title, "Renew passport");
  const u = interpret("I need to file taxes by friday, it's urgent", TODAY).intent as any;
  assert.deepEqual([u.title, u.due, u.priority], ["File taxes", "2026-11-13", "high"]);
  const rec = interpret("remind me to water the plants every monday at 8am", TODAY).intent as any;
  assert.deepEqual([rec.title, rec.recurrence, rec.due, rec.time], ["Water the plants", "weekly", "2026-11-16", "08:00"]);
  assert.deepEqual(interpret("mark buy milk as done", TODAY).intent, { kind: "task.complete", ref: { query: "buy milk" } });
  assert.deepEqual(interpret("I finished the report", TODAY).intent, { kind: "task.complete", ref: { query: "report" } });
  assert.deepEqual(interpret("delete the dentist task", TODAY).intent, { kind: "task.delete", ref: { query: "dentist" } });
});

test("memory: explicit is confirmed, volunteered is inferred, questions are recall", () => {
  const m = interpret("Remember that Sam is my manager", TODAY).intent as any;
  assert.deepEqual([m.kind, m.status, m.memoryKind, m.subject, m.content], ["remember", "confirmed", "person", "sam", "Sam is my manager"]);
  const p = interpret("I prefer meetings in the afternoon", TODAY).intent as any;
  assert.deepEqual([p.kind, p.status, p.memoryKind], ["remember", "inferred", "preference"]);
  const d = interpret("remember that Alex's birthday is March 3", TODAY).intent as any;
  assert.deepEqual([d.memoryKind, d.date, d.subject], ["date", "2027-03-03", "alex birthday"]);
  assert.deepEqual(interpret("what do you know about Sam?", TODAY).intent, { kind: "recall", query: "Sam" });
  assert.deepEqual(interpret("who is Sam?", TODAY).intent, { kind: "recall", query: "Sam" });
  assert.deepEqual(interpret("forget that Sam is my manager", TODAY).intent, { kind: "forget", query: "Sam is my manager" });
  assert.equal(interpret("remind me to forget nothing", TODAY).intent.kind, "task.create", "\"remind me\" is a reminder, never a memory");
});

test("anything else is unknown, never guessed", () => {
  assert.equal(interpret("the mitochondria is the powerhouse of the cell", TODAY).intent.kind, "unknown");
  assert.equal(interpret("hey there", TODAY).intent.kind, "greet");
});
