import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createFeltDB } from "@feltdb/core";

import { buildScriptedAgent } from "./fixture-agent.mjs";
import { hostProcess } from "./host-process.mjs";
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

const scratch = mkdtempSync(join(tmpdir(), "appport-settle-"));
const fixture = join(root, ".settle-agent");
const workDir = join(scratch, "work");
const AGENT_JWT_SECRET = "settle-agent-jwt-secret-0123456789abcdef";
const ALICE = "appport-agent-operator:alice";
const OPERATOR = "appport-agent-operator:operator";
const OPERATOR_ISSUER = "https://operators.example";
const AUDIENCE = "appport-agent-settlement";
const operatorKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const strangerKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const host = hostProcess({
  env: { PROBE_GRANTS: ALICE },
  port: 5900 + Math.floor(Math.random() * 300),
  scratch,
});

let agent;
let lib;

function signEs256(privateKey, claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({
    aud: AUDIENCE,
    exp: now + 600,
    iat: now,
    iss: OPERATOR_ISSUER,
    ...claims,
  });
  const signature = createSign("SHA256")
    .update(`${header}.${payload}`)
    .sign({ dsaEncoding: "ieee-p1363", key: privateKey })
    .toString("base64url");
  return `${header}.${payload}.${signature}`;
}

const operatorToken = (sub = "dana") => signEs256(operatorKeys.privateKey, { sub });

const startAgent = () =>
  startProcess(
    join(root, "node_modules/.bin/eve"),
    ["start", "--host", "127.0.0.1"],
    cleanEnv({
      AGENT_JWT_SECRET,
      APPPORT_AGENT_CAPABILITIES: "catalog.lookup,catalog.reserve,catalog.reservation",
      APPPORT_AGENT_CREDENTIAL_FILE: host.files.credential,
      APPPORT_AGENT_OPERATOR: OPERATOR,
      APPPORT_AGENT_OPERATOR_ISSUER: OPERATOR_ISSUER,
      APPPORT_AGENT_OPERATOR_PUBLIC_KEY: operatorKeys.publicKey
        .export({ format: "pem", type: "spki" })
        .toString(),
      APPPORT_AGENT_RECONCILERS: "catalog.reserve=catalog.reservation",
      APPPORT_AGENT_WORK_DIR: workDir,
      APPPORT_URL: host.url,
      PORT: "0",
    }),
    /\[START\] server listening at (\S+)/u,
    fixture,
  );

async function restartAgent() {
  await stop(agent.child);
  assert.equal(groupAlive(agent.child.pid), false);
  agent = await startAgent();
}

const requesterToken = (principal) => signJwt(AGENT_JWT_SECRET, principal.split(":").at(-1));

async function submit(key, objective) {
  const response = await fetch(new URL("/work", agent.url), {
    body: JSON.stringify({ objective }),
    headers: {
      authorization: `Bearer ${requesterToken(ALICE)}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    method: "POST",
  });
  return await response.json();
}

async function readWork(workId) {
  const response = await fetch(new URL(`/work/${workId}`, agent.url), {
    headers: { authorization: `Bearer ${requesterToken(ALICE)}` },
  });
  return await response.json();
}

async function settled(workId) {
  let work;
  await waitFor(async () => {
    work = await readWork(workId);
    return work.status === "completed" || work.status === "blocked";
  });
  return work;
}

async function settle(operationId, body, token = operatorToken()) {
  const response = await fetch(new URL(`/operations/${operationId}/settle`, agent.url), {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    method: "POST",
  });
  return { body: await response.json().catch(() => null), status: response.status };
}

async function reconcile() {
  const response = await fetch(new URL("/work/reconcile", agent.url), {
    headers: { authorization: `Bearer ${requesterToken(OPERATOR)}` },
    method: "POST",
  });
  assert.equal(response.status, 200);
}

async function ledgerWhileStopped(workId) {
  await stop(agent.child);
  const db = createFeltDB({ namespace: "appport-agent-work", path: workDir });
  try {
    return await db.collection("appport_operations").find({ work_id: workId });
  } finally {
    await db.close?.();
    agent = await startAgent();
  }
}

async function available(sku) {
  const result = await lib.invokeCapability(
    { principalId: ALICE },
    "catalog.lookup",
    { sku },
    undefined,
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.output.quantity;
}

async function reservation(key) {
  const caller = { principalId: ALICE };
  const resolved = await lib.resolveCapability(caller, "catalog.reservation");
  return (await lib.sendRequest(caller, resolved.entry, { key }, undefined, undefined)).output;
}

const reserveRequests = (workId) =>
  readJsonl(host.files.provenance).filter(
    (entry) =>
      entry.kind === "request" &&
      entry.capability === "catalog.reserve" &&
      entry.traceId === workId,
  );

async function indeterminateWork(key, crashPlan, objective) {
  writeFileSync(host.files.crashPlan, crashPlan);
  const { sessionId, workId } = await submit(key, objective);
  const work = await settled(workId);
  assert.equal(work.status, "blocked");
  assert.match(work.decisions.at(-1), /^indeterminate: 1 AppPort operation\(s\) .*: op_\S+$/u);
  await host.terminate();
  await host.start();
  const operationId = work.decisions.at(-1).split(": ").at(-1);
  return { operationId, sessionId, workId };
}

async function callLinks(workId) {
  await stop(agent.child);
  const db = createFeltDB({ namespace: "appport-agent-work", path: workDir });
  try {
    const links = await db.collection("appport_invocations").find({ work_id: workId });
    return links.sort((left, right) => left.recorded_at.localeCompare(right.recorded_at));
  } finally {
    await db.close?.();
    agent = await startAgent();
  }
}

async function turnInSession(sessionId, message) {
  const headers = {
    authorization: `Bearer ${requesterToken(ALICE)}`,
    "content-type": "application/json",
  };
  const sent = await fetch(new URL(`/eve/v1/session/${sessionId}`, agent.url), {
    body: JSON.stringify({ message }),
    headers,
    method: "POST",
  });
  assert.ok(sent.ok, `send failed with HTTP ${sent.status}: ${await sent.clone().text()}`);
  const stream = await fetch(new URL(`/eve/v1/session/${sessionId}/stream`, agent.url), {
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  const decoder = new TextDecoder();
  let buffered = "";
  let turns = 0;
  for await (const chunk of stream.body) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      for (const fact of JSON.parse(line).facts ?? []) {
        if (fact.type === "turn.settled") turns += 1;
      }
      if (turns >= 2) return;
    }
  }
}

before(async () => {
  await host.start();
  process.env.APPPORT_URL = host.url;
  process.env.APPPORT_AGENT_CREDENTIAL_FILE = host.files.credential;
  process.env.APPPORT_AGENT_CAPABILITIES = "catalog.lookup,catalog.reserve,catalog.reservation";
  lib = await import("../agent/lib/appport.ts");
  buildScriptedAgent(fixture);
  agent = await startAgent();
});

after(async () => {
  await stopAll();
  await host.terminate().catch(() => undefined);
  rmSync(fixture, { force: true, recursive: true });
  rmSync(scratch, { force: true, recursive: true });
});

describe("operator settlement of indeterminate operations", () => {
  let lost;
  let lostBefore;
  let lostSettled;
  let unapplied;
  let unappliedBefore;

  it("leaves work blocked while a consequential operation is indeterminate", async () => {
    lost = await indeterminateWork(
      "settle-lost",
      "completing catalog.reserve",
      "Reserve 3 of ALPHA-1",
    );
    assert.equal((await readWork(lost.workId)).status, "blocked");
    assert.equal(await available("ALPHA-1"), 39);
    [lostBefore] = await ledgerWhileStopped(lost.workId);
    assert.equal(lostBefore.state, "indeterminate");
    assert.ok(lostBefore.reconciliations.length >= 1);
  });

  it("refuses every credential except an operator token signed by the operator key", async () => {
    const credential = readFileSync(host.files.credential, "utf8").trim();
    const body = { evidence: "inventory read", outcome: "succeeded", reason: "applied" };
    for (const token of [
      credential,
      requesterToken(ALICE),
      requesterToken(OPERATOR),
      signEs256(strangerKeys.privateKey, { sub: "dana" }),
      signEs256(operatorKeys.privateKey, { aud: "appport-agent", sub: "dana" }),
      signEs256(operatorKeys.privateKey, { iss: "appport-agent-operator", sub: "dana" }),
      signEs256(operatorKeys.privateKey, {
        exp: Math.floor(Date.now() / 1000) - 3600,
        sub: "dana",
      }),
    ]) {
      const refused = await settle(lost.operationId, body, token);
      assert.equal(refused.status, 401, token.slice(0, 16));
    }
    const missing = await fetch(new URL(`/operations/${lost.operationId}/settle`, agent.url), {
      body: JSON.stringify(body),
      method: "POST",
    });
    assert.equal(missing.status, 401);
    const [unchanged] = await ledgerWhileStopped(lost.workId);
    assert.deepEqual(unchanged, lostBefore);
  });

  it("rejects malformed or incomplete settlements", async () => {
    for (const body of [
      "not json",
      [],
      { evidence: "e", reason: "r" },
      { evidence: "e", outcome: "executed", reason: "r" },
      { evidence: "e", outcome: "failed" },
      { evidence: "e", outcome: "failed", reason: "   " },
      { outcome: "failed", reason: "r" },
      { evidence: "line one\nline two", outcome: "failed", reason: "r" },
      { evidence: "x".repeat(513), outcome: "failed", reason: "r" },
      { evidence: "e", operator: "appport-agent-operator:mallory", outcome: "failed", reason: "r" },
    ]) {
      const refused = await settle(lost.operationId, body);
      assert.equal(refused.status, 400, JSON.stringify(body));
    }
    const unknown = await settle("op_missing", { evidence: "e", outcome: "failed", reason: "r" });
    assert.equal(unknown.status, 404);
    const [unchanged] = await ledgerWhileStopped(lost.workId);
    assert.deepEqual(unchanged, lostBefore);
  });

  it("settles an operation whose effect happened as succeeded, and the work completes", async () => {
    const evidence = await reservation(lostBefore.idempotency_key);
    assert.equal(evidence.business.kind, "present");
    const reservationId = evidence.status.reported.reservation_id;
    const result = await settle(lost.operationId, {
      evidence: `catalog.reservation shows ${reservationId}`,
      outcome: "succeeded",
      reason: "The host committed the reservation before it crashed.",
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    assert.equal(result.body.operation.state, "succeeded");
    const work = await readWork(lost.workId);
    assert.equal(work.status, "completed");
    assert.equal(
      work.decisions.at(-1),
      "completed after 1 authorized invocation(s); 1 settled by an operator",
    );
    assert.equal(work.operations[0].state, "succeeded");
    assert.equal(work.operations[0].settlement.outcome, "succeeded");
    assert.equal(await available("ALPHA-1"), 39);
    lostSettled = result.body.operation;
  });

  it("keeps an unapplied operation indeterminate through reconciliation until an operator settles it", async () => {
    unapplied = await indeterminateWork(
      "settle-unapplied",
      "claimed catalog.reserve",
      "Reserve 1 of BETA-2",
    );
    await reconcile();
    await reconcile();
    const work = await readWork(unapplied.workId);
    assert.equal(work.status, "blocked");
    assert.match(work.decisions.at(-1), /^indeterminate: /u);
    assert.equal(await available("BETA-2"), 7);
    [unappliedBefore] = await ledgerWhileStopped(unapplied.workId);
    assert.equal(unappliedBefore.state, "indeterminate");
    assert.ok(unappliedBefore.reconciliations.length >= 3);
    assert.ok(unappliedBefore.reconciliations.every((entry) => entry.finding === "indeterminate"));
  });

  it("settles it as failed, appending the settlement and preserving its history", async () => {
    const result = await settle(unapplied.operationId, {
      evidence: "catalog.reservation: not_applied, BETA-2 stock unchanged at 7",
      outcome: "failed",
      reason: "The host died after claiming the key and before reserving.",
    });
    assert.equal(result.status, 201, JSON.stringify(result.body));
    const work = await readWork(unapplied.workId);
    assert.equal(work.status, "blocked");
    assert.equal(
      work.decisions.at(-1),
      "waiting: every AppPort invocation was rejected; 1 settled by an operator",
    );

    const [record] = await ledgerWhileStopped(unapplied.workId);
    assert.equal(record.state, "failed");
    assert.deepEqual(record.settlement, {
      at: record.settlement.at,
      evidence: "catalog.reservation: not_applied, BETA-2 stock unchanged at 7",
      operator: `${OPERATOR_ISSUER}:dana`,
      outcome: "failed",
      prior_state: "indeterminate",
      reason: "The host died after claiming the key and before reserving.",
    });
    assert.ok(Date.parse(record.settlement.at) >= Date.parse(unappliedBefore.updated_at));
    for (const field of [
      "agent",
      "attempts",
      "capability",
      "capability_version",
      "created_at",
      "idempotency_key",
      "input_digest",
      "operation_id",
      "operation_key",
      "outcome",
      "reconciliations",
      "request_ids",
      "requester",
      "resolution",
      "retry_safety",
      "work_id",
    ])
      assert.deepEqual(record[field], unappliedBefore[field], field);
  });

  it("writes a settlement once, including a repeated identical request", async () => {
    const repeat = await settle(unapplied.operationId, {
      evidence: "catalog.reservation: not_applied, BETA-2 stock unchanged at 7",
      outcome: "failed",
      reason: "The host died after claiming the key and before reserving.",
    });
    assert.equal(repeat.status, 409);
    assert.match(repeat.body.message, /already settled as failed/u);
    const flip = await settle(
      unapplied.operationId,
      { evidence: "second look", outcome: "succeeded", reason: "changed my mind" },
      operatorToken("erin"),
    );
    assert.equal(flip.status, 409);
    const [record] = await ledgerWhileStopped(unapplied.workId);
    assert.equal(record.settlement.operator, `${OPERATOR_ISSUER}:dana`);
    assert.equal(record.state, "failed");
  });

  it("refuses to settle an operation that is not indeterminate", async () => {
    const { workId } = await submit("settle-normal", "Reserve 1 of ALPHA-1");
    const work = await settled(workId);
    assert.equal(work.status, "completed");
    const refused = await settle(work.operations[0].operationId, {
      evidence: "e",
      outcome: "failed",
      reason: "r",
    });
    assert.equal(refused.status, 409);
    assert.match(refused.body.message, /is succeeded; only an indeterminate operation/u);
    assert.equal((await readWork(workId)).operations[0].settlement, null);
    assert.equal(await available("ALPHA-1"), 38);
  });

  it("never dispatches a settled failure again, even when the model repeats the call", async () => {
    const before = reserveRequests(unapplied.workId).length;
    const callsBefore = (await callLinks(unapplied.workId)).length;
    await turnInSession(unapplied.sessionId, "[repeat] Reserve 1 of BETA-2");
    const links = await callLinks(unapplied.workId);
    assert.equal(links.length, callsBefore + 1, "the model repeated the call");
    assert.equal(links.at(-1).operation_id, unapplied.operationId);
    assert.equal(reserveRequests(unapplied.workId).length, before);
    const [record] = await ledgerWhileStopped(unapplied.workId);
    assert.equal(record.state, "failed");
    assert.deepEqual(record.request_ids, unappliedBefore.request_ids);
    assert.equal(record.attempts, unappliedBefore.attempts);
    assert.deepEqual(record.reconciliations, unappliedBefore.reconciliations);
    await reconcile();
    assert.equal(reserveRequests(unapplied.workId).length, before);
    assert.equal(await available("BETA-2"), 7);
  });

  it("keeps the settlement across an eve restart and reconciliation", async () => {
    await restartAgent();
    await reconcile();
    const work = await readWork(lost.workId);
    assert.equal(work.status, "completed");
    assert.deepEqual(work.operations[0].settlement, lostSettled.settlement);
    const [record] = await ledgerWhileStopped(lost.workId);
    assert.deepEqual(record.settlement, lostSettled.settlement);
    assert.deepEqual(record.reconciliations, lostBefore.reconciliations);
    assert.equal(
      (await settle(lost.operationId, { evidence: "e", outcome: "failed", reason: "r" })).status,
      409,
    );
    assert.equal(await available("ALPHA-1"), 38);
  });

  it("is reachable by no model tool and no AppPort capability", async () => {
    const tools = readdirSync(join(root, "agent/tools"));
    assert.deepEqual(tools.sort(), [
      "appport_capabilities.ts",
      "appport_contract.ts",
      "appport_invoke.ts",
    ]);
    for (const tool of tools)
      assert.doesNotMatch(
        readFileSync(join(root, "agent/tools", tool), "utf8"),
        /settleOperation/u,
        tool,
      );
    const importers = ["agent/channels/eve.ts", "agent/channels/work.ts", "agent/agent.ts"].filter(
      (file) => readFileSync(join(root, file), "utf8").includes("settleOperation"),
    );
    assert.deepEqual(importers, ["agent/channels/work.ts"]);
    const capabilities = await lib.listCapabilities({ principalId: ALICE });
    assert.ok(capabilities.length > 0);
    assert.ok(capabilities.every((entry) => !/settle/iu.test(entry.name)));
  });
});
