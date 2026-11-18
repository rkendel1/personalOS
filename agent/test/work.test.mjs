import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createFeltDB, openAgentState } from "@feltdb/core";
import { defineCapability, s } from "@appport/sdk";

import { AGENT_ID, startInventoryHost } from "../appport-host/host.mjs";
import { buildScriptedAgent } from "./fixture-agent.mjs";
import {
  cleanEnv,
  groupAlive,
  readJsonl,
  root,
  signJwt,
  startProcess,
  stop,
  stopAll,
  waitFor,
} from "./support.mjs";

const scratch = mkdtempSync(join(tmpdir(), "appport-agent-work-"));
const fixture = join(root, ".acceptance-agent");
const provenanceFile = join(scratch, "provenance.jsonl");
const agentCredentialFile = join(scratch, "agent-credential");
const workDir = join(scratch, "work");
const AGENT_JWT_SECRET = "acceptance-agent-jwt-secret-0123456789abcdef";
const APPPORT_PORT = 4800 + Math.floor(Math.random() * 400);
const ALICE = "appport-agent-operator:alice";
const BOB = "appport-agent-operator:bob";
const OPERATOR = "appport-agent-operator:operator";
const submitted = new Set();
const subjectOf = (principalId) => principalId.split(":").at(-1);

const effects = new Map();
const effectCount = (capability, token) => effects.get(`${capability}:${token}`) ?? 0;
const probe = (name, idempotency) =>
  defineCapability({
    authorization: ["probe.write"],
    description: "Test-only side effect with an observable counter.",
    effect: "consequential",
    handler({ token }) {
      const applied = effectCount(name, token) + 1;
      effects.set(`${name}:${token}`, applied);
      return { applied, token };
    },
    idempotency,
    input: s.object({ token: s.string() }),
    name,
    output: s.object({ applied: s.integer(), token: s.string() }),
    version: 1,
  });

let host;
let agent;
let aliceGrant;

const provenance = () => readJsonl(provenanceFile);

const startAgent = () =>
  startProcess(
    join(root, "node_modules/.bin/eve"),
    ["start", "--host", "127.0.0.1"],
    cleanEnv({
      AGENT_JWT_SECRET,
      APPPORT_AGENT_CAPABILITIES: "catalog.lookup,probe.applykeyed,probe.applyunkeyed",
      APPPORT_AGENT_CREDENTIAL_FILE: agentCredentialFile,
      APPPORT_AGENT_OPERATOR: OPERATOR,
      APPPORT_AGENT_WORK_DIR: workDir,
      APPPORT_URL: `http://127.0.0.1:${APPPORT_PORT}/appport`,
      PORT: "0",
    }),
    /\[START\] server listening at (\S+)/u,
    fixture,
  );

const workIdFor = (user, key) =>
  `work_${createHash("sha256").update(`${user}\n${key}`).digest("hex").slice(0, 32)}`;

const lookupsFor = (workId) =>
  provenance().filter(
    (entry) =>
      entry.kind === "request" && entry.capability === "catalog.lookup" && entry.traceId === workId,
  );

async function reachable() {
  try {
    await fetch(agent.url, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

async function restartAgent() {
  await stop(agent.child);
  assert.equal(groupAlive(agent.child.pid), false, "the old eve process group is still alive");
  agent = await startAgent();
}

async function crashThenRestart() {
  await waitFor(async () => !(await reachable()));
  await restartAgent();
}

async function reconcile() {
  const response = await fetch(new URL("/work/reconcile", agent.url), {
    headers: { authorization: `Bearer ${signJwt(AGENT_JWT_SECRET, subjectOf(OPERATOR))}` },
    method: "POST",
  });
  assert.equal(response.status, 200);
  return (await response.json()).results;
}

async function submit(user, key, objective) {
  if (key !== undefined) submitted.add(workIdFor(user, key));
  const response = await fetch(new URL("/work", agent.url), {
    body: JSON.stringify({ objective }),
    headers: {
      authorization: `Bearer ${signJwt(AGENT_JWT_SECRET, subjectOf(user))}`,
      "content-type": "application/json",
      ...(key === undefined ? {} : { "idempotency-key": key }),
    },
    method: "POST",
  });
  return { body: await response.json(), status: response.status };
}

async function read(user, workId) {
  const response = await fetch(new URL(`/work/${workId}`, agent.url), {
    headers: { authorization: `Bearer ${signJwt(AGENT_JWT_SECRET, subjectOf(user))}` },
  });
  return { body: await response.json(), status: response.status };
}

async function settled(user, workId) {
  let work;
  await waitFor(async () => {
    work = (await read(user, workId)).body;
    return work.status === "completed" || work.status === "blocked";
  });
  return work;
}

before(async () => {
  host = await startInventoryHost({
    extraCapabilities: [
      probe("probe.applykeyed", "supported"),
      probe("probe.applyunkeyed", "unsupported"),
    ],
    extraPermissions: ["probe.write"],
    adminSecret: "acceptance-authority-admin-secret-0123456789",
    agentCredentialFile,
    dataDir: join(scratch, "host"),
    port: APPPORT_PORT,
    provenanceFile,
  });
  aliceGrant = await host.authority.grant({
    agent: AGENT_ID,
    capabilities: ["catalog.read", "probe.write"],
    delegator: ALICE,
  });
  buildScriptedAgent(fixture);
  agent = await startAgent();
});

after(async () => {
  await stopAll();
  await host?.close();
  rmSync(fixture, { force: true, recursive: true });
  rmSync(scratch, { force: true, recursive: true });
});

describe("durable work in FeltDB (real eve, FeltDB, AppPort and AuthBoundry; scripted model)", () => {
  let alphaWork;

  it("refuses unauthenticated or keyless submissions", async () => {
    const anonymous = await fetch(new URL("/work", agent.url), { body: "{}", method: "POST" });
    assert.equal(anonymous.status, 401);
    assert.equal((await submit(ALICE, undefined, "Look up SKU ALPHA-1")).status, 400);
  });

  it("creates one work record, runs it in an eve session, and records the actual outcome", async () => {
    const { body, status } = await submit(ALICE, "alpha-1", "Look up SKU ALPHA-1");
    assert.equal(status, 201);
    assert.equal(body.replayed, false);
    assert.match(body.workId, /^work_[0-9a-f]{32}$/u);
    alphaWork = await settled(ALICE, body.workId);

    assert.equal(alphaWork.operations.length, 1);
    assert.equal(alphaWork.operations[0].operationId, alphaWork.evidence[0].id);
    assert.equal(alphaWork.operations[0].capability, "catalog.lookup");
    assert.equal(alphaWork.operations[0].state, "succeeded");
    assert.equal(alphaWork.operations[0].ok, true);
    assert.match(alphaWork.operations[0].requestIds[0], /^eve_/u);
    assert.equal(alphaWork.status, "completed");
    assert.equal(alphaWork.requester, ALICE);
    assert.equal(alphaWork.agent, AGENT_ID);
    assert.equal(alphaWork.objective, "Look up SKU ALPHA-1");
    assert.equal(alphaWork.sessionId, body.sessionId);
    assert.equal(alphaWork.liveSessionId, body.sessionId);
    assert.deepEqual(
      alphaWork.history.map((entry) => entry.status),
      ["ready", "running", "running", "completed"],
    );
    assert.equal(alphaWork.history[2].summary, "AppPort catalog.lookup succeeded.");
    assert.match(alphaWork.summary, /"quantity":42/u);
    assert.deepEqual(alphaWork.decisions, ["completed after 1 authorized invocation(s)"]);
    assert.equal(alphaWork.evidence.length, 1);
    assert.equal(alphaWork.evidence[0].verified, true);
    assert.equal(alphaWork.evidence[0].collection, "appport_operations");
  });

  it("links AppPort's own provenance to the work record and Alice's delegation", () => {
    const requestId = alphaWork.operations[0].requestIds[0];
    const records = provenance().filter((entry) => entry.requestId === requestId);
    const request = records.find((entry) => entry.kind === "request");
    const decision = records.find((entry) => entry.kind === "authorization");
    assert.equal(request.traceId, alphaWork.workId);
    assert.equal(request.principal, ALICE);
    assert.equal(request.success, true);
    assert.equal(decision.decision, "allow");
    assert.equal(decision.delegationId, aliceGrant.id);
    assert.equal(decision.agent, AGENT_ID);
    assert.deepEqual(decision.authority, {
      application: "inventory",
      kind: "authboundry",
      tenant: "local",
    });
  });

  it("replays a repeated submission instead of creating or running it again", async () => {
    const again = await submit(ALICE, "alpha-1", "Look up SKU ALPHA-1");
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.workId, alphaWork.workId);
    assert.equal(again.body.sessionId, alphaWork.sessionId);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal((await read(ALICE, alphaWork.workId)).body.history.length, 4);

    const conflict = await submit(ALICE, "alpha-1", "Look up SKU BETA-2");
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, "IDEMPOTENCY_KEY_REUSED");
  });

  it("does not let Bob read Alice's work, and gives Bob's own key its own record", async () => {
    assert.equal((await read(BOB, alphaWork.workId)).status, 404);
    const bobs = await submit(BOB, "alpha-1", "Look up SKU ALPHA-1");
    assert.equal(bobs.status, 201);
    assert.notEqual(bobs.body.workId, alphaWork.workId);
    const work = await settled(BOB, bobs.body.workId);
    assert.equal(work.status, "blocked");
    assert.deepEqual(work.decisions, ["waiting: every AppPort invocation was rejected"]);
    assert.equal(work.operations[0].errorCode, "FORBIDDEN");
    const decision = provenance().find(
      (entry) =>
        entry.requestId === work.operations[0].requestIds[0] && entry.kind === "authorization",
    );
    assert.equal(decision.reason, "delegation_missing");
  });

  it("does not invoke the capability once Alice revokes her delegation", async () => {
    await host.authority.revoke(aliceGrant.id);
    try {
      const { body } = await submit(ALICE, "after-revoke", "Look up SKU BETA-2");
      const work = await settled(ALICE, body.workId);
      assert.equal(work.status, "blocked");
      const requestId = work.operations[0].requestIds[0];
      const records = provenance().filter((entry) => entry.requestId === requestId);
      assert.equal(
        records.find((entry) => entry.kind === "authorization").reason,
        "delegation_revoked",
      );
      assert.equal(
        records.some((entry) => entry.kind === "execution"),
        false,
      );
    } finally {
      aliceGrant = await host.authority.grant({
        agent: AGENT_ID,
        capabilities: ["catalog.read", "probe.write"],
        delegator: ALICE,
      });
    }
  });

  it("records a failed execution as failed work, not as an outcome", async () => {
    const { body } = await submit(ALICE, "fail-1", "Please FAIL while looking up SKU ALPHA-1");
    const work = await settled(ALICE, body.workId);
    assert.equal(work.status, "blocked");
    assert.deepEqual(work.decisions, ["failed: the eve turn ended failed"]);
    assert.deepEqual(work.evidence, []);
  });

  it("keeps the work record and its session association across an eve restart", async () => {
    await restartAgent();
    const after = (await read(ALICE, alphaWork.workId)).body;
    assert.equal(after.status, "completed");
    assert.equal(after.sessionId, alphaWork.sessionId);
    assert.equal(after.liveSessionId, alphaWork.sessionId);
    assert.deepEqual(after.history, alphaWork.history);

    const again = await submit(ALICE, "alpha-1", "Look up SKU ALPHA-1");
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.sessionId, alphaWork.sessionId);
  });
});

describe("durable work recovery (process-group crashes and restarts)", () => {
  let waitingWork;

  it("recovers accepted work whose submission crashed before eve started it", async () => {
    const workId = workIdFor(ALICE, "crash-accepted");
    await submit(ALICE, "crash-accepted", "[crash:work.accepted] Look up SKU ALPHA-1").catch(
      () => undefined,
    );
    await crashThenRestart();
    const work = await settled(ALICE, workId);
    assert.equal(work.status, "completed");
    assert.ok(
      work.decisions.includes("recovered: submitted to eve after an interrupted submission"),
    );
    assert.equal(work.sessionId, work.liveSessionId);
    assert.equal(lookupsFor(workId).length, 1);
  });

  it("repeats an interrupted read, because the capability declares no effect, without resubmitting work", async () => {
    const { body } = await submit(
      ALICE,
      "crash-mid-turn",
      "[crash:invocation.record] Look up SKU BETA-2",
    );
    await crashThenRestart();
    const work = await settled(ALICE, body.workId);
    assert.equal(work.sessionId, body.sessionId);
    assert.equal(work.liveSessionId, body.sessionId);
    assert.equal(
      work.decisions.some((entry) => entry.startsWith("recovered: submitted")),
      false,
    );
    assert.equal(work.status, "completed");
    assert.equal(work.operations.length, 1);
    assert.equal(lookupsFor(body.workId).length, 2);
    assert.equal(work.operations[0].requestIds.length, 1);
    assert.equal(work.operations[0].requestIds[0], lookupsFor(body.workId)[1].requestId);
  });

  it("reconstructs a completed execution whose final work checkpoint was lost", async () => {
    const { body } = await submit(
      ALICE,
      "crash-final",
      "[crash:checkpoint.final] Look up SKU ALPHA-1",
    );
    await crashThenRestart();
    const work = await settled(ALICE, body.workId);
    assert.equal(work.status, "completed");
    assert.deepEqual(work.decisions.slice(-2), [
      `recovered: final state reconstructed from eve session ${body.sessionId}`,
      "completed after 1 authorized invocation(s)",
    ]);
    assert.equal(work.evidence.length, 1);
    assert.equal(work.evidence[0].verified, true);
    assert.equal(lookupsFor(body.workId).length, 1);
  });

  it("leaves a failed checkpoint write visible until reconciliation, then records only real evidence", async () => {
    const { body } = await submit(
      ALICE,
      "fail-final",
      "[fail:checkpoint.final] Look up SKU ALPHA-1",
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const stuck = (await read(ALICE, body.workId)).body;
    assert.equal(stuck.status, "running");
    await reconcile();
    const work = (await read(ALICE, body.workId)).body;
    assert.equal(work.status, "completed");
    assert.equal(
      work.decisions.at(-2),
      `recovered: final state reconstructed from eve session ${body.sessionId}`,
    );
    assert.equal(work.evidence.length, 1);
  });

  it("never cites evidence that was not committed", async () => {
    const { body } = await submit(
      ALICE,
      "fail-evidence",
      "[fail:invocation.record] Look up SKU ALPHA-1",
    );
    const work = await settled(ALICE, body.workId);
    assert.equal(work.status, "blocked");
    assert.equal(work.decisions.length, 1);
    assert.match(
      work.decisions[0],
      /^indeterminate: 1 AppPort operation\(s\) without an established outcome: \S+$/u,
    );
    assert.deepEqual(work.evidence, []);
    assert.equal(lookupsFor(body.workId).length, 1);
    assert.equal(lookupsFor(body.workId)[0].success, true);
  });

  it("keeps waiting work waiting across a restart", async () => {
    const { body } = await submit(ALICE, "approval", "[approval] Wait for a person");
    await waitFor(async () => (await read(ALICE, body.workId)).body.status === "running");
    await restartAgent();
    waitingWork = await settled(ALICE, body.workId);
    assert.equal(waitingWork.status, "blocked");
    assert.equal(
      waitingWork.decisions.at(-1),
      "waiting: the eve session is waiting for an interaction",
    );
    assert.equal(waitingWork.liveSessionId, body.sessionId);
  });

  it("changes nothing when reconciliation runs again", async () => {
    const before = await Promise.all(
      [...submitted].map(async (workId) => (await read(ALICE, workId)).body),
    );
    const first = await reconcile();
    const second = await reconcile();
    assert.ok(first.every((entry) => entry.action === "unchanged"));
    assert.ok(second.every((entry) => entry.action === "unchanged"));
    const after = await Promise.all(
      [...submitted].map(async (workId) => (await read(ALICE, workId)).body),
    );
    assert.deepEqual(after, before);
  });

  it("stays idempotent for a repeated submission after restarts", async () => {
    const workId = workIdFor(ALICE, "crash-accepted");
    const lookups = lookupsFor(workId).length;
    const again = await submit(
      ALICE,
      "crash-accepted",
      "[crash:work.accepted] Look up SKU ALPHA-1",
    );
    assert.equal(again.status, 200);
    assert.equal(again.body.replayed, true);
    assert.equal(again.body.workId, workId);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(lookupsFor(workId).length, lookups);
  });

  it("does not report completion when the eve session is gone", async () => {
    await stop(agent.child);
    const workflowData = join(fixture, ".eve/.workflow-data");
    assert.equal(existsSync(workflowData), true);
    rmSync(workflowData, { force: true, recursive: true });
    agent = await startAgent();
    const work = (await read(ALICE, waitingWork.workId)).body;
    assert.equal(work.status, "blocked");
    assert.equal(
      work.decisions.at(-1),
      `indeterminate: eve session ${waitingWork.sessionId} could not be read`,
    );
  });
});

describe("durable operations (crash-after-effect boundary)", () => {
  const appportRequests = (workId, capability) =>
    provenance().filter(
      (entry) =>
        entry.kind === "request" && entry.capability === capability && entry.traceId === workId,
    );

  async function ledgerOf(workId) {
    await stop(agent.child);
    assert.equal(groupAlive(agent.child.pid), false);
    const db = createFeltDB({ namespace: "appport-agent-work", path: workDir });
    try {
      return {
        links: await db.collection("appport_invocations").find({ work_id: workId }),
        operations: await db.collection("appport_operations").find({ work_id: workId }),
      };
    } finally {
      await db.close?.();
    }
  }

  const operationsOf = async (workId) => (await ledgerOf(workId)).operations;

  it("persists the intent before invoking, and resumes an operation that never reached AppPort", async () => {
    const workId = workIdFor(ALICE, "op-prepared");
    await submit(
      ALICE,
      "op-prepared",
      "[crash:operation.prepared] Apply P1 via probe.applyunkeyed",
    ).catch(() => undefined);
    await waitFor(async () => !(await reachable()));
    const [before] = await operationsOf(workId);
    assert.equal(before.state, "prepared");
    assert.equal(effectCount("probe.applyunkeyed", "P1"), 0);
    assert.equal(appportRequests(workId, "probe.applyunkeyed").length, 0);
    agent = await startAgent();
    const work = await settled(ALICE, workId);
    assert.equal(work.status, "completed");
    assert.equal(work.operations[0].state, "succeeded");
    assert.equal(effectCount("probe.applyunkeyed", "P1"), 1);
  });

  it("does not repeat an idempotent action after a crash between the effect and its record", async () => {
    const { body } = await submit(
      ALICE,
      "op-keyed",
      "[crash:invocation.record] Apply K1 via probe.applykeyed",
    );
    await waitFor(async () => !(await reachable()));
    const [during] = await operationsOf(body.workId);
    assert.equal(during.state, "executing");
    assert.equal(effectCount("probe.applykeyed", "K1"), 1);
    agent = await startAgent();
    const work = await settled(ALICE, body.workId);
    assert.equal(work.status, "completed");
    assert.equal(effectCount("probe.applykeyed", "K1"), 1);
    const requests = appportRequests(body.workId, "probe.applykeyed");
    assert.equal(requests.length, 2);
    assert.equal(requests[1].idempotentReplay, true);
    const [after] = await operationsOf(body.workId);
    assert.equal(after.state, "succeeded");
    assert.equal(after.outcome.reconciled_after_interruption, true);
    assert.equal(after.idempotency_key, after.operation_id);
    agent = await startAgent();
  });

  it("marks a non-idempotent action indeterminate after the same crash, and never repeats it", async () => {
    const { body } = await submit(
      ALICE,
      "op-unkeyed",
      "[crash:invocation.record] Apply U1 via probe.applyunkeyed",
    );
    await crashThenRestart();
    const work = await settled(ALICE, body.workId);
    assert.equal(work.status, "blocked");
    const [unkeyed] = await operationsOf(body.workId);
    assert.equal(
      work.decisions.at(-1),
      `indeterminate: 1 AppPort operation(s) without an established outcome: ${unkeyed.operation_id}`,
    );
    assert.deepEqual(work.evidence, []);
    assert.equal(effectCount("probe.applyunkeyed", "U1"), 1);
    assert.equal(appportRequests(body.workId, "probe.applyunkeyed").length, 1);
    const [operation] = await operationsOf(body.workId);
    assert.equal(operation.state, "indeterminate");
    assert.equal(operation.idempotency_key, null);
    agent = await startAgent();
  });

  it("keeps an indeterminate operation indeterminate across repeated recovery passes", async () => {
    const workId = workIdFor(ALICE, "op-unkeyed");
    await reconcile();
    await reconcile();
    await restartAgent();
    await reconcile();
    assert.equal(effectCount("probe.applyunkeyed", "U1"), 1);
    assert.equal(appportRequests(workId, "probe.applyunkeyed").length, 1);
    const [operation] = await operationsOf(workId);
    assert.equal(operation.state, "indeterminate");
    agent = await startAgent();
  });

  it("returns the recorded result when the same operation is requested again", async () => {
    const { body } = await submit(ALICE, "op-repeat", "[repeat] Apply R1 via probe.applykeyed");
    const work = await settled(ALICE, body.workId);
    assert.equal(work.status, "completed");
    assert.equal(work.operations.length, 1);
    assert.equal(effectCount("probe.applykeyed", "R1"), 1);
    assert.equal(appportRequests(body.workId, "probe.applykeyed").length, 1);
  });

  it("refuses the same operation key with different input and never overwrites the intent", async () => {
    const { body } = await submit(ALICE, "op-conflict", "[conflict] Apply C1 via probe.applykeyed");
    const work = await settled(ALICE, body.workId);
    assert.equal(effectCount("probe.applykeyed", "C1"), 1);
    assert.equal(effectCount("probe.applykeyed", "C1-changed"), 0);
    assert.equal(appportRequests(body.workId, "probe.applykeyed").length, 1);
    assert.equal(work.operations.length, 1);
    const { links, operations } = await ledgerOf(body.workId);
    assert.equal(operations.length, 1);
    assert.equal(operations[0].operation_key, "step-1");
    assert.equal(operations[0].state, "succeeded");
    assert.deepEqual(
      links.map((link) => link.refusal ?? link.operation_id).sort(),
      ["OPERATION_CONFLICT", operations[0].operation_id].sort(),
    );
    agent = await startAgent();
  });

  it("keeps different operations within one work distinct", async () => {
    const { body } = await submit(ALICE, "op-two", "Apply A1,B1 via probe.applykeyed");
    const work = await settled(ALICE, body.workId);
    assert.equal(work.status, "completed");
    assert.equal(work.operations.length, 2);
    assert.notEqual(work.operations[0].operationId, work.operations[1].operationId);
    assert.equal(effectCount("probe.applykeyed", "A1"), 1);
    assert.equal(effectCount("probe.applykeyed", "B1"), 1);
  });

  it("records a failed operation once and does not silently retry it", async () => {
    const { body } = await submit(ALICE, "op-invalid", "[invalid] Apply 5 via probe.applykeyed");
    const work = await settled(ALICE, body.workId);
    assert.equal(work.status, "blocked");
    assert.equal(work.decisions.at(-1), "waiting: every AppPort invocation was rejected");
    assert.equal(work.operations[0].state, "failed");
    assert.equal(work.operations[0].errorCode, "INVALID_INPUT");
    assert.equal(appportRequests(body.workId, "probe.applykeyed").length, 1);
  });

  it("still enforces delegation: Bob's operation fails and causes no effect", async () => {
    const { body } = await submit(BOB, "op-bob", "Apply BOB1 via probe.applykeyed");
    const work = await settled(BOB, body.workId);
    assert.equal(work.operations[0].state, "failed");
    assert.equal(work.operations[0].errorCode, "FORBIDDEN");
    assert.equal(effectCount("probe.applykeyed", "BOB1"), 0);
    assert.equal((await read(ALICE, body.workId)).status, 404);
  });
});

describe("FeltDB is the authority", () => {
  const alphaWork = { workId: workIdFor(ALICE, "alpha-1") };
  it("is authoritative in FeltDB itself, readable without eve", async () => {
    await stop(agent.child);
    const db = createFeltDB({ namespace: "appport-agent-work", path: workDir });
    const state = await openAgentState(db);
    const { tasks } = await state.listTasks({ project: "inventory", limit: 100 });
    assert.deepEqual(new Set(tasks.map((task) => task.task_id)), submitted);
    assert.equal(tasks.length, submitted.size);
    for (const { task_id: workId } of tasks) {
      const { checkpoint: latest } = await state.getTask(workId);
      for (const cited of latest.evidence) {
        const record = await db.collection(cited.collection).get(cited.id);
        assert.equal(record.work_id, workId, `${workId} cites another work's evidence`);
      }
    }

    const { task, checkpoint } = await state.getTask(alphaWork.workId);
    assert.equal(task.status, "completed");
    assert.equal(task.owner, AGENT_ID);
    assert.equal(task.scope.workspace, ALICE);
    assert.equal(checkpoint.version, 4);
    const operation = await db.collection("appport_operations").get(checkpoint.evidence[0].id);
    assert.equal(operation.work_id, alphaWork.workId);
    assert.equal(operation.requester, ALICE);
    assert.equal(operation.agent, AGENT_ID);
    assert.equal(operation.capability, "catalog.lookup");
    assert.equal(operation.state, "succeeded");
    for (const workId of submitted) {
      for (const link of await db.collection("appport_invocations").find({ work_id: workId })) {
        if (link.operation_id === null) continue;
        const linked = await db.collection("appport_operations").get(link.operation_id);
        assert.equal(linked.work_id, workId, `${workId} links another work's operation`);
      }
      for (const linked of await db.collection("appport_operations").find({ work_id: workId }))
        assert.equal(linked.operation_id.startsWith("op_"), true);
    }
    await db.close?.();
  });
});
