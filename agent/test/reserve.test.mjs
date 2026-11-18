import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createFeltDB } from "@feltdb/core";

import { openInventory } from "../appport-host/inventory.mjs";
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

const scratch = mkdtempSync(join(tmpdir(), "appport-reserve-"));
const fixture = join(root, ".reserve-agent");
const workDir = join(scratch, "work");
const AGENT_JWT_SECRET = "reserve-agent-jwt-secret-0123456789abcdef";
const AGENT_ID = "agent:appport-agent";
const ALICE = "appport-agent-operator:alice";
const BOB = "appport-agent-operator:bob";
const CAROL = "appport-agent-operator:carol";
const OPERATOR = "appport-agent-operator:operator";
const host = hostProcess({
  env: { PROBE_GRANTS: `${ALICE},${CAROL}`, PROBE_READ_GRANTS: BOB },
  port: 5600 + Math.floor(Math.random() * 300),
  scratch,
});
const subjectOf = (principal) => principal.split(":").at(-1);

let agent;
let lib;
let firstGrants;

const startAgent = () =>
  startProcess(
    join(root, "node_modules/.bin/eve"),
    ["start", "--host", "127.0.0.1"],
    cleanEnv({
      AGENT_JWT_SECRET,
      APPPORT_AGENT_CAPABILITIES: "catalog.lookup,catalog.reserve,catalog.reservation",
      APPPORT_AGENT_CREDENTIAL_FILE: host.files.credential,
      APPPORT_AGENT_OPERATOR: OPERATOR,
      APPPORT_AGENT_RECONCILERS: "catalog.reserve=catalog.reservation",
      APPPORT_AGENT_WORK_DIR: workDir,
      APPPORT_URL: host.url,
      PORT: "0",
    }),
    /\[START\] server listening at (\S+)/u,
    fixture,
  );

async function reachable() {
  try {
    await fetch(agent.url, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

async function stopAgent() {
  await stop(agent.child);
  assert.equal(groupAlive(agent.child.pid), false);
}

async function submit(principal, key, objective) {
  const response = await fetch(new URL("/work", agent.url), {
    body: JSON.stringify({ objective }),
    headers: {
      authorization: `Bearer ${signJwt(AGENT_JWT_SECRET, subjectOf(principal))}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    method: "POST",
  });
  return await response.json();
}

async function settled(principal, workId) {
  let work;
  await waitFor(async () => {
    const response = await fetch(new URL(`/work/${workId}`, agent.url), {
      headers: { authorization: `Bearer ${signJwt(AGENT_JWT_SECRET, subjectOf(principal))}` },
    });
    work = await response.json();
    return work.status === "completed" || work.status === "blocked";
  });
  return work;
}

async function reconcile() {
  const response = await fetch(new URL("/work/reconcile", agent.url), {
    headers: { authorization: `Bearer ${signJwt(AGENT_JWT_SECRET, subjectOf(OPERATOR))}` },
    method: "POST",
  });
  assert.equal(response.status, 200);
}

async function ledger(workId) {
  await stopAgent();
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

async function reserveDirect(principal, key, input) {
  const caller = { principalId: principal };
  const resolved = await lib.resolveCapability(caller, "catalog.reserve");
  assert.equal(resolved.ok, true);
  return await lib.sendRequest(caller, resolved.entry, input, `direct-${key}`, key);
}

async function reservationRead(principal, key) {
  const caller = { principalId: principal };
  const resolved = await lib.resolveCapability(caller, "catalog.reservation");
  return (await lib.sendRequest(caller, resolved.entry, { key }, undefined, undefined)).output;
}

const decisionsFor = (requestId) =>
  readJsonl(host.files.provenance).filter(
    (entry) => entry.kind === "authorization" && entry.requestId === requestId,
  );

before(async () => {
  await host.start();
  firstGrants = host.grants();
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

describe("catalog.reserve: one real state-changing capability through eve, AppPort and AuthBoundry", () => {
  let aliceWork;

  it("reserves stock for an authorized person, with a durable, attributable record", async () => {
    const { workId } = await submit(ALICE, "reserve-1", "Reserve 2 of ALPHA-1");
    aliceWork = await settled(ALICE, workId);
    assert.equal(aliceWork.status, "completed");
    const [operation] = aliceWork.operations;
    assert.equal(operation.state, "succeeded");
    assert.equal(operation.capability, "catalog.reserve");
    assert.equal(await available("ALPHA-1"), 40);

    const answer = await reservationRead(ALICE, operation.operationId);
    assert.equal(answer.status.kind, "committed");
    assert.equal(answer.business.kind, "present");
    assert.equal(answer.status.operation.key, operation.operationId);
    assert.deepEqual(answer.status.operation.input, { quantity: 2, sku: "ALPHA-1" });
    const [decision] = decisionsFor(operation.requestIds[0]);
    assert.equal(decision.decision, "allow");
    assert.equal(decision.delegationId, firstGrants[ALICE]);
    assert.equal(decision.onBehalfOf, ALICE);
    assert.equal(decision.agent, AGENT_ID);
  });

  it("rejects a person without the reserve delegation before any effect", async () => {
    const { workId } = await submit(BOB, "reserve-bob", "Reserve 1 of ALPHA-1");
    const work = await settled(BOB, workId);
    assert.equal(work.operations[0].state, "failed");
    assert.equal(work.operations[0].errorCode, "FORBIDDEN");
    assert.equal(decisionsFor(work.operations[0].requestIds[0])[0].reason, "delegation_missing");
    assert.equal(
      (await reservationRead(BOB, work.operations[0].operationId)).status.kind,
      "not_applied",
    );
    assert.equal(await available("ALPHA-1"), 40);
  });

  it("does not reserve twice when the same operation is requested again", async () => {
    const { workId } = await submit(ALICE, "reserve-repeat", "[repeat] Reserve 1 of BETA-2");
    const work = await settled(ALICE, workId);
    assert.equal(work.status, "completed");
    assert.equal(work.operations.length, 1);
    assert.equal(work.operations[0].requestIds.length, 1);
    const sent = readJsonl(host.files.provenance).filter(
      (entry) =>
        entry.kind === "request" &&
        entry.capability === "catalog.reserve" &&
        entry.traceId === workId,
    );
    assert.equal(sent.length, 1);
    assert.equal(await available("BETA-2"), 6);
  });

  it("reserves once for concurrent requests with one key", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        reserveDirect(ALICE, "concurrent-reserve", { quantity: 1, sku: "BETA-2" }),
      ),
    );
    assert.ok(
      results.every((result) => result.ok),
      JSON.stringify(results),
    );
    assert.equal(new Set(results.map((result) => result.output.reservation_id)).size, 1);
    const ran = readJsonl(host.files.provenance).filter(
      (entry) =>
        entry.kind === "execution" &&
        entry.capability === "catalog.reserve" &&
        results.some((result) => result.requestId === entry.requestId),
    );
    assert.equal(ran.length, 1);
    assert.equal(await available("BETA-2"), 5);
  });

  it("rejects a forged agent credential before any effect", async () => {
    writeFileSync(join(scratch, "forged"), "aga_forged.0000000000000000000000000000\n");
    process.env.APPPORT_AGENT_CREDENTIAL_FILE = join(scratch, "forged");
    try {
      const forged = await lib.sendRequest(
        { principalId: ALICE },
        { authorization: ["catalog.reserve"], latestVersion: 1, name: "catalog.reserve" },
        { quantity: 1, sku: "BETA-2" },
        undefined,
        "forged-reserve",
      );
      assert.equal(forged.error.code, "UNAUTHORIZED");
    } finally {
      process.env.APPPORT_AGENT_CREDENTIAL_FILE = host.files.credential;
    }
    assert.equal(await available("BETA-2"), 5);
  });

  it("resumes safely after eve crashes before invoking", async () => {
    const { workId } = await submit(
      ALICE,
      "reserve-prepared",
      "[crash:operation.prepared] Reserve 1 of ALPHA-1",
    ).catch(() => ({}));
    await waitFor(async () => !(await reachable()));
    await stopAgent();
    assert.equal(await available("ALPHA-1"), 40);
    agent = await startAgent();
    const work = await settled(ALICE, workId ?? "");
    assert.equal(work.status, "completed");
    assert.equal(await available("ALPHA-1"), 39);
  });

  it("reconciles a reservation whose result eve lost, without reserving again", async () => {
    const { workId } = await submit(
      ALICE,
      "reserve-lost",
      "[crash:invocation.record] Reserve 1 of ALPHA-1",
    );
    await waitFor(async () => !(await reachable()));
    await stopAgent();
    assert.equal(await available("ALPHA-1"), 38);
    agent = await startAgent();
    const work = await settled(ALICE, workId);
    assert.equal(work.status, "completed");
    assert.equal(await available("ALPHA-1"), 38);
    const [operation] = await ledger(workId);
    assert.equal(operation.state, "succeeded");
    assert.equal(operation.reconciliations[0].finding, "completed");
    assert.equal(operation.outcome.reconciled_after_interruption, true);
  });

  it("keeps a host crash after the effect uncertain, preserves it across the host restart, then reconciles it", async () => {
    writeFileSync(host.files.crashPlan, "completing catalog.reserve");
    const { workId } = await submit(ALICE, "reserve-host-crash", "Reserve 3 of ALPHA-1");
    const stuck = await settled(ALICE, workId);
    assert.equal(stuck.status, "blocked");
    assert.match(stuck.decisions.at(-1), /^indeterminate: /u);

    await host.terminate();
    await host.start();
    assert.equal(await available("ALPHA-1"), 35);
    const [operation] = await ledger(workId);
    assert.equal(operation.state, "indeterminate");
    const retry = await reserveDirect(ALICE, operation.idempotency_key, {
      quantity: 3,
      sku: "ALPHA-1",
    });
    assert.equal(retry.error.details.reason, "IDEMPOTENCY_OUTCOME_UNKNOWN");
    assert.equal(await available("ALPHA-1"), 35);

    await reconcile();
    const work = await settled(ALICE, workId);
    assert.equal(work.status, "completed");
    assert.equal(work.operations[0].state, "succeeded");
    assert.equal(await available("ALPHA-1"), 35);
  });

  it("keeps an operation indeterminate when the host died before the effect", async () => {
    writeFileSync(host.files.crashPlan, "claimed catalog.reserve");
    const { workId } = await submit(ALICE, "reserve-claim-crash", "Reserve 1 of BETA-2");
    assert.equal((await settled(ALICE, workId)).status, "blocked");
    await host.terminate();
    await host.start();
    await reconcile();
    await reconcile();
    const work = await settled(ALICE, workId);
    assert.equal(work.status, "blocked");
    assert.match(work.decisions.at(-1), /^indeterminate: /u);
    const [operation] = await ledger(workId);
    assert.equal(operation.state, "indeterminate");
    assert.ok(operation.reconciliations.length >= 2);
    assert.ok(operation.reconciliations.every((entry) => entry.finding === "indeterminate"));
    assert.equal(await available("BETA-2"), 5);
    const retry = await reserveDirect(ALICE, operation.idempotency_key, {
      quantity: 1,
      sku: "BETA-2",
    });
    assert.equal(retry.error.details.reason, "IDEMPOTENCY_OUTCOME_UNKNOWN");
  });

  it("stops reserving once the person revokes the delegation", async () => {
    const first = await submit(CAROL, "carol-1", "Reserve 1 of BETA-2");
    assert.equal((await settled(CAROL, first.workId)).status, "completed");
    assert.equal(await available("BETA-2"), 4);
    await host.terminate();
    await host.start({ PROBE_REVOKE: CAROL });
    const second = await submit(CAROL, "carol-2", "Reserve 1 of BETA-2");
    const work = await settled(CAROL, second.workId);
    assert.equal(work.operations[0].errorCode, "FORBIDDEN");
    assert.equal(decisionsFor(work.operations[0].requestIds[0])[0].reason, "delegation_revoked");
    assert.equal(await available("BETA-2"), 4);
  });

  it("matches the inventory to the recorded outcomes and traces every reservation to its delegation", async () => {
    await stopAgent();
    await host.terminate();
    const work = createFeltDB({ namespace: "appport-agent-work", path: workDir });
    const operations = await work
      .collection("appport_operations")
      .find({ capability: "catalog.reserve" });
    await work.close?.();
    const reservations = await host.readStore("inventory", "inventory", "reservations");
    const items = await host.readStore("inventory", "inventory", "items");

    for (const { sku, quantity } of [
      { quantity: 42, sku: "ALPHA-1" },
      { quantity: 7, sku: "BETA-2" },
    ]) {
      const item = items.find((entry) => entry.sku === sku);
      const held = reservations.filter((entry) => entry.sku === sku && entry.status === "held");
      const reserved = held.reduce((sum, entry) => sum + entry.quantity, 0);
      assert.equal(item.quantity, quantity - reserved, sku);
      assert.equal(item.reserved, reserved, sku);
    }
    for (const operation of operations) {
      const matching = reservations.filter(
        (entry) => entry.idempotency_key === operation.idempotency_key,
      );
      if (operation.state === "succeeded") {
        assert.equal(matching.length, 1, operation.operation_id);
        const [reservation] = matching;
        assert.equal(reservation.reservation_id, operation.outcome.output.reservation_id);
        assert.equal(reservation.principal, operation.requester);
        assert.equal(reservation.agent, AGENT_ID);
        assert.equal(reservation.delegation_id, firstGrants[operation.requester]);
      } else {
        assert.equal(matching.length, 0, `${operation.state} ${operation.operation_id}`);
      }
    }
    assert.equal(operations.filter((operation) => operation.state === "indeterminate").length, 1);

    const inventory = await openInventory({
      path: join(host.files.dataDir, "inventory"),
      seed: [],
    });
    const first = reservations.find(
      (entry) => entry.idempotency_key === aliceWork.operations[0].operationId,
    );
    const released = await inventory.release(first.reservation_id);
    assert.equal(released.status, "released");
    assert.equal((await inventory.item("ALPHA-1")).quantity, 35 + 2);
    await inventory.close();
  });
});
