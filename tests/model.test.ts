/**
 * DoD 10: the model is replaceable. Two loopback OpenAI-compatible servers stand in for two
 * providers; everything else is the real FeltKit runtime (decision runtime, agent lifecycle,
 * approval, execution as the owner). The switch happens through FeltKit's own model selection
 * (the same call as Studio → Models / `feltkit model set`), with a restart in between.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";

const ADA = { id: "ada", type: "user" as const, roles: ["owner", "admin"] };

/** A model that always answers `label`, and counts what it was asked. */
async function fakeModel(label: string): Promise<{ url: string; server: Server; asked: string[] }> {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      asked.push(body);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", object: "chat.completion", model: label, choices: [{ index: 0, message: { role: "assistant", content: label }, finish_reason: "stop" }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, server, asked };
}

async function settle(t: TestApp, taskId: string) {
  for (let i = 0; i < 50; i++) {
    await t.runtime.runServices();
    const view: any = await (t.runtime as any).agent.get(taskId, "admin");
    const proposed = (view.actions ?? []).find((a: any) => a.state === "proposed");
    if (proposed) return { view, actionId: proposed.actionId ?? proposed.id };
    if (view.task.status === "completed" || view.task.status === "failed") return { view, actionId: null };
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the decision never settled");
}

test("DoD 10: change the model; conversations, memory, tasks and the log survive, and each decision names its model", async () => {
  const a = await fakeModel("task");
  const b = await fakeModel("memory");
  const t = await createTestApp();
  try {
    const ada = t.as("ada");
    await ada.mutation(api.settings.set, { modelAssist: true });
    await ada.mutation(api.assistant.send, { text: "Remember that I take my coffee black", today: "2026-11-11", tzOffset: 0 });

    // Model A.
    await t.runtime.models.select({ provider: "ollama", model: "model-a", endpoint: a.url }, ADA as any);
    const first = await ada.mutation(api.assistant.send, { text: "pick up the dry cleaning", today: "2026-11-11", tzOffset: 0 });
    const reply1 = (await ada.query(api.conversations.messagesOf, { conversationId: first.conversationId })).at(-1)!;
    assert.match(reply1.text, /asked the model/);
    assert.ok(reply1.interpretation?.agentTaskId);
    assert.deepEqual(await ada.query(api.tasks.list, {}), [], "a model's reading changes nothing by itself");

    const s1 = await settle(t, reply1.interpretation!.agentTaskId!);
    assert.equal(a.asked.length, 1);
    assert.match(a.asked[0]!, /pick up the dry cleaning/);
    assert.ok(JSON.stringify(s1.view.checkpoints).includes("ollama/model-a chose"), "the decision names model A");
    await (t.runtime as any).agent.approve(reply1.interpretation!.agentTaskId!, s1.actionId, ADA);
    await t.runtime.runServices();
    const [task] = await ada.query(api.tasks.list, {});
    assert.deepEqual([task!.title, task!.source.kind], ["Pick up the dry cleaning", "model"]);
    const follow = (await ada.query(api.conversations.messagesOf, { conversationId: first.conversationId })).at(-1)!;
    assert.match(follow.text, /the model read it as a task and you approved/);

    // Switch to model B and restart: nothing about the application changes.
    await t.runtime.models.select({ provider: "ollama", model: "model-b", endpoint: b.url }, ADA as any);
    await t.restart();
    const second = await ada.mutation(api.assistant.send, { text: "the garage code is 7731", today: "2026-11-11", tzOffset: 0 });
    const reply2 = (await ada.query(api.conversations.messagesOf, { conversationId: second.conversationId })).at(-1)!;
    const s2 = await settle(t, reply2.interpretation!.agentTaskId!);
    assert.equal(b.asked.length, 1, "B answered");
    assert.equal(a.asked.length, 1, "A was not asked again");
    assert.ok(JSON.stringify(s2.view.checkpoints).includes("ollama/model-b chose"), "the decision names model B");
    await (t.runtime as any).agent.approve(reply2.interpretation!.agentTaskId!, s2.actionId, ADA);
    await t.runtime.runServices();

    const memory = await ada.query(api.memory.list);
    assert.deepEqual(
      memory.map((m) => [m.content, m.status, m.source.kind]).sort(),
      [["I take my coffee black", "confirmed", "conversation"], ["The garage code is 7731", "inferred", "model"]],
      "the model's reading of a fact is stored unconfirmed",
    );
    assert.equal((await ada.query(api.conversations.list)).length, 3);
    assert.equal((await ada.query(api.tasks.list, {})).length, 1);
    const log = await ada.query(api.actions.list, {});
    assert.deepEqual(log.map((x) => [x.kind, x.via]), [["memory.infer", "model"], ["task.create", "model"], ["memory.remember", "chat"]]);
  } finally {
    await t.close();
    a.server.close();
    b.server.close();
  }
});

test("model assist is off by default: no model is called, nothing is proposed", async () => {
  const a = await fakeModel("task");
  const t = await createTestApp();
  try {
    await t.runtime.models.select({ provider: "ollama", model: "model-a", endpoint: a.url }, ADA as any);
    const r = await t.as("ada").mutation(api.assistant.send, { text: "pick up the dry cleaning", today: "2026-11-11", tzOffset: 0 });
    await t.runtime.runServices();
    const reply = (await t.as("ada").query(api.conversations.messagesOf, { conversationId: r.conversationId })).at(-1)!;
    assert.equal(reply.interpretation?.agentTaskId, undefined);
    assert.equal(a.asked.length, 0);
  } finally {
    await t.close();
    a.server.close();
  }
});
