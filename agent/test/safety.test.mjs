import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createFeltDB, openAgentState } from "@feltdb/core";

import { buildScriptedAgent } from "./fixture-agent.mjs";
import { hostProcess } from "./host-process.mjs";
import {
  cleanEnv,
  readJsonl,
  root,
  signJwt,
  startProcess,
  stop,
  stopAll,
  waitFor,
} from "./support.mjs";

const scratch = mkdtempSync(join(tmpdir(), "appport-safety-"));
const fixture = join(root, ".safety-agent");
const workDir = join(scratch, "work");
const holdFile = join(scratch, "hold");
const AGENT_JWT_SECRET = "safety-agent-jwt-secret-0123456789abcdef";
const ALICE = "appport-agent-operator:alice";
const OPERATOR = "appport-agent-operator:operator";
const CAPABILITIES =
  "catalog.lookup,catalog.reserve,catalog.reservation,probe.applykeyed,probe.applyunkeyed,probe.unclassified";
const STALL_AFTER_MS = 1500;
const host = hostProcess({
  env: { PROBE_GRANTS: ALICE, PROBE_HOLD_FILE: holdFile },
  port: 6900 + Math.floor(Math.random() * 300),
  scratch,
});

let agent;
let lib;

const startAgent = () =>
  startProcess(
    join(root, "node_modules/.bin/eve"),
    ["start", "--host", "127.0.0.1"],
    cleanEnv({
      AGENT_JWT_SECRET,
      APPPORT_AGENT_CAPABILITIES: CAPABILITIES,
      APPPORT_AGENT_CREDENTIAL_FILE: host.files.credential,
      APPPORT_AGENT_OPERATOR: OPERATOR,
      APPPORT_AGENT_STALL_AFTER_MS: String(STALL_AFTER_MS),
      APPPORT_AGENT_WORK_DIR: workDir,
      APPPORT_URL: host.url,
      PORT: "0",
    }),
    /\[START\] server listening at (\S+)/u,
    fixture,
  );

const token = (principal) => signJwt(AGENT_JWT_SECRET, principal.split(":").at(-1));

async function reachable() {
  try {
    await fetch(agent.url, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

async function post(key, objective, readOnly) {
  return await fetch(new URL("/work", agent.url), {
    body: JSON.stringify({ objective, ...(readOnly === undefined ? {} : { readOnly }) }),
    headers: {
      authorization: `Bearer ${token(ALICE)}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    method: "POST",
  });
}

async function submit(key, objective, readOnly) {
  return (await (await post(key, objective, readOnly)).json()).workId;
}

async function read(workId) {
  const response = await fetch(new URL(`/work/${workId}`, agent.url), {
    headers: { authorization: `Bearer ${token(ALICE)}` },
  });
  return await response.json();
}

async function settled(workId) {
  let work;
  await waitFor(async () => {
    work = await read(workId);
    return work.status === "completed" || work.status === "blocked";
  });
  return work;
}

async function reconcile() {
  const response = await fetch(new URL("/work/reconcile", agent.url), {
    headers: { authorization: `Bearer ${token(OPERATOR)}` },
    method: "POST",
  });
  assert.equal(response.status, 200);
}

async function crashed() {
  await waitFor(async () => !(await reachable()));
  await stop(agent.child);
}

/** The work store read directly (eve stopped: FeltDB holds one writer), then eve started again. */
async function stored(workId, change) {
  await stop(agent.child);
  const db = createFeltDB({ namespace: "appport-agent-work", path: workDir });
  try {
    if (change) await change(db);
    const state = await openAgentState(db);
    return {
      checkpoint: (await state.getTask(workId))?.checkpoint ?? null,
      operations: await db.collection("appport_operations").find({ work_id: workId }),
    };
  } finally {
    await db.close?.();
    agent = await startAgent();
  }
}

// The host authorizes every request before its handler runs: the count of decisions is what was sent.
const sends = (capability) =>
  existsSync(host.files.provenance)
    ? readJsonl(host.files.provenance).filter(
        (entry) => entry.kind === "authorization" && entry.capability === capability,
      ).length
    : 0;
const applied = (token) =>
  existsSync(host.files.effects)
    ? String(readFileSync(host.files.effects))
        .split("\n")
        .filter((line) => line === `probe.applykeyed:${token}`).length
    : 0;

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

async function restartHost(contract) {
  await host.terminate();
  await host.start(contract ? { PROBE_CONTRACT: contract } : {});
}

async function turnInSession(sessionId, message) {
  const headers = { authorization: `Bearer ${token(ALICE)}`, "content-type": "application/json" };
  const sent = await fetch(new URL(`/eve/v1/session/${sessionId}`, agent.url), {
    body: JSON.stringify({ message }),
    headers,
    method: "POST",
  });
  assert.ok(sent.ok, `send failed with HTTP ${sent.status}`);
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
      for (const fact of JSON.parse(line).facts ?? []) if (fact.type === "turn.settled") turns += 1;
      if (turns >= 2) return;
    }
  }
}

before(async () => {
  await host.start();
  process.env.APPPORT_URL = host.url;
  process.env.APPPORT_AGENT_CREDENTIAL_FILE = host.files.credential;
  process.env.APPPORT_AGENT_CAPABILITIES = CAPABILITIES;
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

describe("stuck-run detection", () => {
  it("classifies a turn that makes no progress as stalled, durably, and re-sends nothing", async () => {
    const workId = await submit("stall-1", "[hang] Look up SKU ALPHA-1");
    await new Promise((resolve) => setTimeout(resolve, STALL_AFTER_MS + 1000));
    await reconcile();
    const work = await read(workId);
    assert.equal(work.status, "blocked");
    assert.match(
      work.decisions.at(-1),
      /^stalled: no progress since \S+ \(no AppPort operation in flight, no interaction awaited\)$/u,
    );
    assert.deepEqual(work.ledger, [], "nothing was dispatched to make progress");
    // Durable: the stored checkpoint says so with eve stopped.
    const { checkpoint } = await stored(workId);
    assert.match(checkpoint.decisions.at(-1), /^stalled: /u);
    assert.equal(checkpoint.status, "blocked");
    // After a restart the turn resumes and hangs again: classified again once it stalls again.
    await new Promise((resolve) => setTimeout(resolve, STALL_AFTER_MS + 1000));
    await reconcile();
    assert.match((await read(workId)).decisions.at(-1), /^stalled: /u);
  });

  it("does not call an operation that takes long stalled while it is in flight", async () => {
    writeFileSync(holdFile, "hold");
    const sent = sends("probe.applykeyed");
    const workId = await submit("long-1", "Apply H1 via probe.applykeyed");
    await waitFor(() => sends("probe.applykeyed") > sent);
    await new Promise((resolve) => setTimeout(resolve, STALL_AFTER_MS + 1000));
    await reconcile();
    const during = await read(workId);
    assert.equal(during.status, "running", JSON.stringify(during.decisions));
    assert.ok(!during.decisions.some((decision) => decision.startsWith("stalled:")));
    rmSync(holdFile);
    const work = await settled(workId);
    assert.equal(work.status, "completed");
    assert.equal(applied("H1"), 1);
  });
});

describe("evidence-based completion", () => {
  it("does not complete work on the agent's word: no operation, no completion", async () => {
    const work = await settled(await submit("words-1", "Say that everything is done"));
    assert.equal(work.status, "blocked");
    assert.equal(
      work.decisions.at(-1),
      "blocked: not completed: no AppPort operation was recorded for it; a reply is not evidence",
    );
  });

  it("does not complete work while an operation is unresolved or indeterminate", async () => {
    writeFileSync(host.files.crashPlan, "completing probe.applykeyed");
    const unresolved = await settled(await submit("unresolved-1", "Apply U1 via probe.applykeyed"));
    assert.equal(unresolved.status, "blocked");
    assert.match(unresolved.decisions.at(-1), /^indeterminate: /u);
    assert.equal(unresolved.ledger[0].state, "executing");
    await restartHost();

    const workId = await submit(
      "indeterminate-1",
      "[crash:invocation.record] Apply N1 via probe.applyunkeyed",
    );
    await crashed();
    agent = await startAgent();
    const work = await settled(workId);
    assert.equal(work.status, "blocked");
    assert.equal(work.ledger[0].state, "indeterminate");
  });

  it("refuses completion through recovery when a result is missing from the ledger", async () => {
    const workId = await submit(
      "evidence-1",
      "[crash:checkpoint.final] Apply E1 via probe.applykeyed",
    );
    await crashed();
    // The operation succeeded and was recorded, then its recorded result is lost (as if never written).
    await stored(workId, async (db) => {
      const [operation] = await db.collection("appport_operations").find({ work_id: workId });
      await db
        .collection("appport_operations")
        .updateIfVersion(operation.operation_id, operation.__version, {
          outcome: { ...operation.outcome, output_digest: null },
        });
    });
    const work = await settled(workId);
    assert.equal(work.status, "blocked");
    assert.match(
      work.decisions.at(-1),
      /^blocked: not completed: operation \S+ has no recorded result$/u,
    );
    // The same crash with the record intact completes through the same recovery path.
    const intact = await submit(
      "evidence-2",
      "[crash:checkpoint.final] Apply E2 via probe.applykeyed",
    );
    await crashed();
    agent = await startAgent();
    assert.equal((await settled(intact)).status, "completed");
  });
});

describe("capability contract pinning", () => {
  let pinnedDigest;

  it("pins the capability's contract digest before the operation is sent", async () => {
    const resolved = await lib.resolveCapability({ principalId: ALICE }, "probe.applykeyed");
    pinnedDigest = lib.contractPin(resolved.manifest, "probe.applykeyed", 1).digest;
    const workId = await submit(
      "pin-1",
      "[crash:operation.prepared] Apply P1 via probe.applykeyed",
    );
    await crashed();
    // A compatible change (an optional field, new words) while eve is down: on recovery it runs, the pin
    // is kept, the change recorded.
    await restartHost("compatible");
    const { operations } = await stored(workId);
    assert.deepEqual(
      [operations[0].state, operations[0].contract.digest, operations[0].request_ids.length],
      ["prepared", pinnedDigest, 0],
    );
    const work = await settled(workId);
    assert.equal(work.status, "completed", JSON.stringify(work));
    assert.equal(work.ledger[0].contractDigest, pinnedDigest, "never replaced by the newer digest");
    assert.deepEqual(
      work.ledger[0].contractChecks.map((check) => check.verdict),
      ["compatible"],
    );
    assert.equal(applied("P1"), 1);
    await restartHost();
  });

  it("refuses to send an operation whose contract changed incompatibly before it was sent", async () => {
    const sent = sends("probe.applykeyed");
    const workId = await submit(
      "pin-2",
      "[crash:operation.prepared] Apply P2 via probe.applykeyed",
    );
    await crashed();
    await restartHost("breaking");
    agent = await startAgent();
    const work = await settled(workId);
    assert.equal(work.status, "blocked");
    assert.deepEqual(
      [work.ledger[0].state, work.ledger[0].errorCode],
      ["failed", "CONTRACT_CHANGED"],
    );
    assert.match(
      work.ledger[0].contractChecks[0].detail.join(" "),
      /breaking: input\.field-added/u,
    );
    assert.equal(sends("probe.applykeyed"), sent, "never sent");
    assert.equal(applied("P2"), 0);
    await restartHost();
  });

  it("does not retry an operation whose contract changed after it was sent", async () => {
    writeFileSync(host.files.crashPlan, "completing probe.applykeyed");
    const sent = sends("probe.applykeyed");
    const workId = await submit("pin-3", "Apply R1 via probe.applykeyed");
    const first = await settled(workId);
    assert.equal(first.ledger[0].state, "executing");
    await restartHost("breaking");
    await turnInSession(first.sessionId, "[repeat] Apply R1 via probe.applykeyed");
    const work = await read(workId);
    assert.equal(work.ledger[0].state, "indeterminate");
    assert.match(work.ledger[0].resolution, /^Not sent again: /u);
    assert.equal(sends("probe.applykeyed"), sent + 1, "only the original request");
    assert.equal(applied("R1"), 1);
    await restartHost();
  });

  it("does not resend on recovery after a contract change", async () => {
    const sent = sends("probe.applykeyed");
    const workId = await submit("pin-4", "[crash:invocation.record] Apply D1 via probe.applykeyed");
    await crashed();
    await restartHost("breaking");
    agent = await startAgent();
    const work = await settled(workId);
    assert.equal(work.status, "blocked");
    assert.equal(work.ledger[0].state, "indeterminate", JSON.stringify(work));
    assert.equal(sends("probe.applykeyed"), sent + 1);
    assert.equal(applied("D1"), 1);
    await restartHost();
  });

  it("reports a pinned contract that the current manifest no longer has as unavailable", async () => {
    const resolved = await lib.resolveCapability({ principalId: ALICE }, "probe.applykeyed");
    const pin = lib.contractPin(resolved.manifest, "probe.applykeyed", 1);
    const without = {
      ...resolved.manifest,
      capabilities: resolved.manifest.capabilities.filter(
        (entry) => entry.name !== "probe.applykeyed",
      ),
    };
    assert.equal(lib.verifyContract(pin, without).kind, "unavailable");
    assert.equal(lib.contractPin(without, "probe.applykeyed", 1), null);
    assert.equal(lib.verifyContract(pin, resolved.manifest).kind, "same");
  });

  it("fails closed when the contract can no longer be found", async () => {
    const sent = sends("probe.applykeyed");
    const workId = await submit(
      "pin-5",
      "[crash:operation.prepared] Apply V1 via probe.applykeyed",
    );
    await crashed();
    await restartHost("removed");
    agent = await startAgent();
    const work = await settled(workId);
    assert.equal(work.status, "blocked");
    assert.notEqual(work.ledger[0].state, "succeeded");
    assert.equal(sends("probe.applykeyed"), sent);
    assert.equal(applied("V1"), 0);
    await restartHost();
  });
});

describe("read-only work", () => {
  it("runs observations", async () => {
    const work = await settled(await submit("ro-1", "Look up SKU ALPHA-1", true));
    assert.equal(work.status, "completed");
    assert.equal(work.readOnly, true);
  });

  it("refuses a side effect, and an undeclared effect, before anything is recorded or sent; durably", async () => {
    const before = await available("ALPHA-1");
    const reserve = await settled(await submit("ro-2", "Reserve 1 of ALPHA-1", true));
    assert.equal(reserve.status, "blocked");
    assert.deepEqual(reserve.ledger, []);
    assert.deepEqual(
      [reserve.refusals[0].refusal, reserve.refusals[0].detail.effect],
      ["READ_ONLY_WORK", "consequential"],
    );
    assert.equal(await available("ALPHA-1"), before);
    const unclassified = await settled(
      await submit("ro-3", "Apply X1 via probe.unclassified", true),
    );
    assert.deepEqual(
      [unclassified.refusals[0].refusal, unclassified.refusals[0].detail.effect],
      ["READ_ONLY_WORK", null],
    );
    assert.equal(unclassified.ledger.length, 0);
  });

  it("cannot be changed by the caller afterwards or by the model", async () => {
    const conflict = await post("ro-2", "Reserve 1 of ALPHA-1", false);
    assert.equal(
      conflict.status,
      409,
      "the same work with readOnly changed is a different request",
    );
  });

  it("holds through recovery: refused again after a crash, and the refusal survives the restart", async () => {
    const before = await available("ALPHA-1");
    const workId = await submit("ro-4", "[crash:checkpoint.final] Reserve 1 of ALPHA-1", true);
    await crashed();
    agent = await startAgent();
    const work = await settled(workId);
    assert.equal(work.status, "blocked");
    assert.deepEqual(work.ledger, []);
    assert.ok(
      work.refusals.length >= 1 &&
        work.refusals.every((refusal) => refusal.refusal === "READ_ONLY_WORK"),
    );
    assert.equal(await available("ALPHA-1"), before);
  });

  it("leaves authorized side-effecting work as it was", async () => {
    const before = await available("ALPHA-1");
    const work = await settled(await submit("rw-1", "Reserve 1 of ALPHA-1"));
    assert.equal(work.status, "completed");
    assert.equal(await available("ALPHA-1"), before - 1);
    assert.equal(work.ledger[0].contractDigest.startsWith("sha256:"), true);
  });
});
