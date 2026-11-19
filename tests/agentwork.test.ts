/**
 * Handing work from a Anywhere Aide conversation to the person's agent (feltkit/agentwork.ts, _route.ts,
 * anywhere.ts), against a stand-in agent work channel that records what Anywhere Aide sends: routing by
 * rules, the explicit "Work on this", no agent connected, questions and answers, stopping, and owner
 * scoping. The real eve agent runs the same flow end to end in agent/test/anywhere.test.mjs.
 */
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { routeOf } from "../feltkit/_route.js";

type Work = { workId: string; status: string; summary: string; decisions: string[]; questions: any[]; ledger: any[] };
const stand = {
  url: "",
  submissions: [] as Array<{ key: string; body: any }>,
  answers: [] as Array<{ workId: string; answers: any[] }>,
  /** Every answer delivery Anywhere Aide attempted, refused or not. */
  answerAttempts: [] as string[],
  cancels: [] as string[],
  work: new Map<string, Work>(),
};
let server: Server;

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      const path = req.url ?? "";
      if (req.method === "POST" && path === "/work") {
        const key = String(req.headers["idempotency-key"] ?? "");
        const workId = `work_${Buffer.from(key).toString("hex").padEnd(16, "0").slice(0, 32)}`;
        if (!stand.work.has(workId)) {
          stand.submissions.push({ key, body });
          stand.work.set(workId, { workId, status: "running", summary: "Running.", decisions: [], questions: [], ledger: [] });
        }
        return send(201, { workId, sessionId: "wrun_standin" });
      }
      const m = /^\/work\/(work_[a-f0-9]+)(\/answers|\/cancel)?$/.exec(path);
      const work = m ? stand.work.get(m[1]!) : undefined;
      if (!m || !work) return send(404, { code: "WORK_NOT_FOUND" });
      if (req.method === "GET") return send(200, work);
      if (m[2] === "/answers") {
        stand.answerAttempts.push(work.workId);
        const open = new Set(work.questions.map((q) => q.interactionId));
        if (!body.answers?.length || body.answers.some((a: any) => !open.has(a.interactionId))) return send(409, { code: "NOT_WAITING" });
        stand.answers.push({ workId: work.workId, answers: body.answers });
        work.questions = [];
        work.status = "running";
        return send(202, { accepted: body.answers.length });
      }
      if (m[2] === "/cancel") {
        if (work.status === "completed" || work.status === "cancelled") return send(409, { code: "ALREADY_FINISHED" });
        stand.cancels.push(work.workId);
        return send(202, { workId: work.workId });
      }
      send(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stand.url = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

const connect = () => {
  process.env.PERSONALOS_AGENT_URL = stand.url;
  process.env.PERSONALOS_AGENT_POLL_MS = "1";
  process.env.FELTKIT_CREDENTIAL_AGENT_IDENTITY = "stand-in-identity-token";
};
const disconnect = () => {
  delete process.env.PERSONALOS_AGENT_URL;
  delete process.env.PERSONALOS_AGENT_POLL_MS;
  delete process.env.FELTKIT_CREDENTIAL_AGENT_IDENTITY;
};

/** Run every follow-up of agent work now, whenever it was scheduled for. */
async function followNow(t: TestApp) {
  const jobs = (t.runtime.services as any).jobs;
  for (const j of (await jobs.listJobs("personalos")).filter((j: any) => j.type === "anywhere.follow" && !["completed", "succeeded", "failed", "cancelled", "dead"].includes(j.status)))
    await jobs.executeJob("personalos", j.id, "test-worker");
  await (t.runtime as any).settleAgents();
}

async function settle(t: TestApp) {
  const jobs = (t.runtime.services as any).jobs;
  for (let i = 0; i < 50; i++) {
    await (t.runtime as any).settleAgents();
    await t.runtime.runServices();
    const due = (await jobs.listJobs("personalos")).filter((j: any) => ["queued", "pending"].includes(j.status) && j.type === "anywhere.follow");
    if (!due.length) return;
    for (const j of due) await jobs.executeJob("personalos", j.id, "test-worker");
  }
}

const turn = (t: TestApp, who: string, text: string, clientId: string) =>
  t.as(who).action(api.turn.turn, { text, clientId }, { context: { timeZone: "America/New_York", locale: "en-US" } });
const texts = async (t: TestApp, who: string, conversationId: string) =>
  (await t.as(who).query(api.conversations.messagesOf, { conversationId })).map((m) => `${m.role}: ${m.text}`);
const workOf = async (t: TestApp, who: string, conversationId: string) => (await t.as(who).query(api.agentwork.list, { conversationId }))[0]!;

test("routing is deterministic: simple requests and questions stay; multi-step, staged research and explicit background requests go to the agent", () => {
  for (const stay of ["What's on today?", "Remind me to call the dentist Friday at 10", "Research heat pumps for a cold climate", "Help me think through the kitchen remodel.", "Remember my sister's birthday is June 3", "Summarize my week"])
    assert.equal(routeOf(stay).delegate, false, stay);
  for (const go of ["Organize my move, research movers, and prepare a plan.", "Go through my open tasks for the move, organize them, and research movers.", "Research heat pumps and recommend one for my house", "Work on this while I'm away: tidy my projects", "Plan the project, then prepare the next steps"])
    assert.equal(routeOf(go).delegate, true, go);
});

test("with an agent connected, multi-step work from chat is handed over once (the same message is one piece of work), a simple question is answered here, and the agent is told who it is for", async () => {
  connect();
  const t = await createTestApp();
  try {
    const before = stand.submissions.length;
    const simple = await turn(t, "ada", "What's on today?", "client-simple-1");
    assert.equal(simple.mode, "rules");
    assert.equal(stand.submissions.length, before, "a simple question never reaches the agent");

    const out = await turn(t, "ada", "Organize my move, research movers, and prepare a plan.", "client-move-0001");
    assert.equal(out.mode, "agent");
    await settle(t);
    const work = await workOf(t, "ada", out.conversationId);
    assert.deepEqual([work.routedBy, work.messageId, work.agent.state], ["rules", out.messageId, "accepted"]);
    const sent = stand.submissions.at(-1)!;
    assert.equal(sent.key, `chat:${out.messageId}`);
    assert.deepEqual([sent.body.onBehalfOf, sent.body.objective, sent.body.readOnly], ["ada", "Organize my move, research movers, and prepare a plan.", false]);
    assert.match((await texts(t, "ada", out.conversationId)).join("\n"), /Handed to your agent \(it has 3 steps to carry out\)/);

    const again = await turn(t, "ada", "Organize my move, research movers, and prepare a plan.", "client-move-0001");
    await settle(t);
    assert.equal(again.messageId, out.messageId, "a retried turn is the same message");
    assert.equal(stand.submissions.filter((s) => s.key === `chat:${out.messageId}`).length, 1, "and the same work, sent once");
    assert.equal((await t.as("ada").query(api.agentwork.list, {})).length, 1);
  } finally {
    await t.close();
    disconnect();
  }
});

test("without an agent Anywhere Aide works as before: multi-step requests are answered here, and Work on this keeps the request and says nothing was started", async () => {
  disconnect();
  const t = await createTestApp();
  try {
    const before = stand.submissions.length;
    const out = await turn(t, "ada", "Organize my move, research movers, and prepare a plan.", "client-noagent-1");
    assert.equal(out.mode, "rules", "Anywhere Aide's own assistant answers");
    const started = await t.as("ada").mutation(api.agentwork.start, { messageId: out.messageId });
    assert.deepEqual([started.started, started.work.agent.state], [false, "unavailable"]);
    assert.match((await texts(t, "ada", out.conversationId)).join("\n"), /No agent is connected to this Anywhere Aide, so nothing was started\. Your request is kept here/);
    await settle(t);
    assert.equal(stand.submissions.length, before, "nothing was sent anywhere");
    // Ordinary work is unaffected.
    await t.as("ada").mutation(api.tasks.create, { title: "Pack the kitchen" });
    assert.equal((await t.as("ada").query(api.tasks.list, { status: "open" })).length >= 1, true);

    // Once an agent is connected, Work on this on the same request starts it.
    connect();
    const now = await t.as("ada").mutation(api.agentwork.start, { messageId: out.messageId });
    await settle(t);
    assert.equal(now.started, true);
    assert.equal(stand.submissions.filter((s) => s.key === `chat:${out.messageId}`).length, 1);
  } finally {
    await t.close();
    disconnect();
  }
});

test("the agent's question appears in the conversation; only the owner answers it, once, with one of its choices; the answer reaches the same work, which then completes here with its evidence", async () => {
  connect();
  const t = await createTestApp();
  try {
    const out = await turn(t, "ada", "Work on this while I'm away: tidy my projects", "client-ask-00001");
    await settle(t);
    const workId = (await workOf(t, "ada", out.conversationId)).agent.workId!;
    const standWork = stand.work.get(workId)!;
    standWork.status = "blocked";
    standWork.decisions = ["waiting: the eve session is waiting for an interaction"];
    standWork.questions = [{ interactionId: "int_1", kind: "approval", prompt: "Archive the two paused projects?", options: [{ id: "approve", label: "Approve" }, { id: "deny", label: "Deny" }], allowFreeform: false }];
    await followNow(t);

    const waiting = await workOf(t, "ada", out.conversationId);
    assert.equal(waiting.agent.state, "waiting");
    assert.equal(waiting.agent.questions![0]!.prompt, "Archive the two paused projects?");
    assert.match((await texts(t, "ada", out.conversationId)).join("\n"), /Your agent asks: Archive the two paused projects\? Choices: Approve \/ Deny\./);

    await assert.rejects(t.as("grace").mutation(api.agentwork.answer, { id: waiting.id, interactionId: "int_1", optionId: "approve" }), (e: any) => e.code === "NOT_FOUND", "Grace cannot answer Ada's agent");
    await assert.rejects(t.as("ada").mutation(api.agentwork.answer, { id: waiting.id, interactionId: "int_1", optionId: "maybe" }), (e: any) => e.code === "INVALID_ARGUMENT");
    await assert.rejects(t.as("ada").mutation(api.agentwork.answer, { id: waiting.id, interactionId: "int_1", text: "sure" }), (e: any) => e.code === "INVALID_ARGUMENT", "an approval takes one of its choices");
    await assert.rejects(t.as("ada").mutation(api.agentwork.answer, { id: waiting.id, interactionId: "int_other", optionId: "approve" }), (e: any) => e.code === "NOT_FOUND");

    await t.as("ada").mutation(api.agentwork.answer, { id: waiting.id, interactionId: "int_1", optionId: "approve" });
    await assert.rejects(t.as("ada").mutation(api.agentwork.answer, { id: waiting.id, interactionId: "int_1", optionId: "deny" }), (e: any) => e.code === "FAILED_PRECONDITION", "answered once");
    await settle(t);
    assert.deepEqual(stand.answers.filter((a) => a.workId === workId), [{ workId, answers: [{ interactionId: "int_1", optionId: "approve" }] }], "the answer reached the same work");
    await followNow(t);
    await followNow(t);
    assert.equal(stand.answerAttempts.filter((w) => w === workId).length, 1, "and was delivered once: later follow-ups never send it again");

    standWork.status = "completed";
    standWork.summary = "Archived 2 paused projects.";
    standWork.ledger = [{ capability: "projects.update", operationId: "op_1", state: "succeeded", requestIds: ["req_1"] }];
    await followNow(t);
    const done = await workOf(t, "ada", out.conversationId);
    assert.equal(done.agent.state, "completed");
    assert.deepEqual(done.agent.operations, [{ capability: "projects.update", operationId: "op_1", state: "succeeded", requestIds: ["req_1"] }]);
    const conversation = (await texts(t, "ada", out.conversationId)).join("\n");
    assert.match(conversation, /Archive the two paused projects\?\n→ Approve/);
    assert.match(conversation, /Archived 2 paused projects\. \(work work_[a-f0-9]+; projects\.update succeeded\)/);
    assert.equal((await t.as("grace").query(api.agentwork.list, {})).length, 0, "Grace sees none of it");
  } finally {
    await t.close();
    disconnect();
  }
});

test("the owner stops agent work: the stop reaches the agent once, the work ends cancelled here, and finished work cannot be stopped", async () => {
  connect();
  const t = await createTestApp();
  try {
    const out = await turn(t, "ada", "Organize my move, research movers, and prepare a plan.", "client-stop-0001");
    await settle(t);
    const work = await workOf(t, "ada", out.conversationId);
    await assert.rejects(t.as("grace").mutation(api.agentwork.cancel, { id: work.id }), (e: any) => e.code === "NOT_FOUND");
    await t.as("ada").mutation(api.agentwork.cancel, { id: work.id });
    await t.as("ada").mutation(api.agentwork.cancel, { id: work.id });
    await settle(t);
    assert.deepEqual(stand.cancels.filter((c) => c === work.agent.workId), [work.agent.workId], "delivered once");
    assert.equal((await workOf(t, "ada", out.conversationId)).agent.state, "cancelling", "until the agent's record says it stopped");

    const standWork = stand.work.get(work.agent.workId!)!;
    standWork.status = "cancelled";
    standWork.summary = "Cancelled by the requester after 0 authorized invocation(s).";
    await followNow(t);
    assert.equal((await workOf(t, "ada", out.conversationId)).agent.state, "cancelled");
    assert.match((await texts(t, "ada", out.conversationId)).join("\n"), /Stopped, as you asked\./);
    await assert.rejects(t.as("ada").mutation(api.agentwork.cancel, { id: work.id }), (e: any) => e.code === "FAILED_PRECONDITION");
  } finally {
    await t.close();
    disconnect();
  }
});
