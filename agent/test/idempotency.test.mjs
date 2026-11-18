import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createFeltDB } from "@feltdb/core";

import { createDurableIdempotencyStore } from "../appport-host/idempotency-store.mjs";
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

const scratch = mkdtempSync(join(tmpdir(), "appport-idempotency-"));
const fixture = join(root, ".idempotency-agent");
const hostDataDir = join(scratch, "host");
const provenanceFile = join(scratch, "provenance.jsonl");
const effectsFile = join(scratch, "effects.log");
const agentCredentialFile = join(scratch, "agent-credential");
const authorityPidFile = join(scratch, "authority.pid");
const workDir = join(scratch, "work");
const ADMIN_SECRET = "idempotency-authority-admin-secret-0123456789";
const AGENT_JWT_SECRET = "idempotency-agent-jwt-secret-0123456789abcdef";
const PORT = 5200 + Math.floor(Math.random() * 400);
const APPPORT_URL = `http://127.0.0.1:${PORT}/appport`;
const AGENT_ID = "agent:appport-agent";
const ALICE = "appport-agent-operator:alice";
const BOB = "appport-agent-operator:bob";
const KEYED = "probe.applykeyed";

let host;
let lib;

const effects = (token, capability = KEYED) =>
  existsSync(effectsFile)
    ? readFileSync(effectsFile, "utf8")
        .split("\n")
        .filter((line) => line === `${capability}:${token}`).length
    : 0;

const sessionOf = (principal) =>
  `agent_${createHash("sha256").update(`${AGENT_ID}\n${principal}`).digest("hex").slice(0, 32)}`;
const storageKey = (principal, key, capability = KEYED) =>
  `${sessionOf(principal)}|${capability}@1|${key}`;

function startHost() {
  return startProcess(
    process.execPath,
    ["test/probe-host.mjs"],
    cleanEnv({
      APPPORT_AGENT_CREDENTIAL_FILE: agentCredentialFile,
      APPPORT_HOST_DATA_DIR: hostDataDir,
      APPPORT_PORT: String(PORT),
      APPPORT_PROVENANCE_FILE: provenanceFile,
      AUTHBOUNDRY_ADMIN_SECRET: ADMIN_SECRET,
      PROBE_AUTHORITY_PID_FILE: authorityPidFile,
      PROBE_EFFECTS_FILE: effectsFile,
      PROBE_GRANTS: `${ALICE},${BOB}`,
    }),
    /\[probe-host\] owner (\S+) listening at/u,
  );
}

async function terminateHost() {
  await stop(host.child);
  const authority = Number(readFileSync(authorityPidFile, "utf8"));
  if (groupAlive(authority)) process.kill(-authority, "SIGKILL");
  await waitFor(() => !groupAlive(authority) && !groupAlive(host.child.pid));
}

async function restartHost() {
  await terminateHost();
  host = await startHost();
}

async function storedRows() {
  const db = createFeltDB({
    namespace: "appport-idempotency",
    path: join(hostDataDir, "idempotency"),
  });
  try {
    return await db.collection("idempotency").find({});
  } finally {
    await db.close?.();
  }
}

const rowFor = async (principal, key) =>
  (await storedRows()).find((row) => row.key === storageKey(principal, key));

async function send(principal, key, token) {
  const caller = { principalId: principal };
  const resolved = await lib.resolveCapability(caller, KEYED);
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  return await lib.sendRequest(caller, resolved.entry, { token }, `trace-${key}`, key);
}

before(async () => {
  host = await startHost();
  process.env.APPPORT_URL = APPPORT_URL;
  process.env.APPPORT_AGENT_CREDENTIAL_FILE = agentCredentialFile;
  process.env.APPPORT_AGENT_CAPABILITIES = `catalog.lookup,${KEYED},probe.applyunkeyed`;
  lib = await import("../agent/lib/appport.ts");
});

after(async () => {
  await stopAll();
  if (existsSync(authorityPidFile)) {
    const authority = Number(readFileSync(authorityPidFile, "utf8"));
    if (groupAlive(authority)) process.kill(-authority, "SIGKILL");
  }
  rmSync(fixture, { force: true, recursive: true });
  rmSync(scratch, { force: true, recursive: true });
});

describe("durable AppPort idempotency across real host restarts", () => {
  it("replays a completed response after the host restarts, without another effect", async () => {
    const first = await send(ALICE, "done-1", "D1");
    assert.equal(first.ok, true);
    assert.deepEqual(first.output, { applied: 1, token: "D1" });
    assert.equal((await send(ALICE, "done-1", "D1")).ok, true);
    assert.equal(effects("D1"), 1);

    await terminateHost();
    const row = await rowFor(ALICE, "done-1");
    assert.equal(row.status, "completed");
    assert.equal(row.requestId, first.requestId);
    assert.match(row.requestDigest, /\S/u);
    host = await startHost();

    const replay = await send(ALICE, "done-1", "D1");
    assert.equal(replay.ok, true);
    assert.deepEqual(replay.output, { applied: 1, token: "D1" });
    assert.equal(effects("D1"), 1);
    const recorded = readJsonl(provenanceFile).find(
      (entry) => entry.kind === "request" && entry.requestId === replay.requestId,
    );
    assert.equal(recorded.idempotentReplay, true);
  });

  it("rejects the same key with different input, also after a restart", async () => {
    const changed = await send(ALICE, "done-1", "D1-changed");
    assert.equal(changed.ok, false);
    assert.equal(changed.error.code, "CONFLICT");
    assert.equal(changed.error.details.reason, "IDEMPOTENCY_KEY_REUSED");
    assert.equal(effects("D1-changed"), 0);
  });

  it("persists the claim before execution, and after a restart treats it as uncertain", async () => {
    const key = "claimed-1[crash:claimed]";
    const crashed = await send(ALICE, key, "C1");
    assert.equal(crashed.ok, false);
    assert.equal(crashed.error.code, "UNAVAILABLE");
    const crashedOwner = host.url;
    await terminateHost();
    const row = await rowFor(ALICE, key);
    assert.equal(row.status, "in-progress");
    assert.equal(row.owner, crashedOwner);
    assert.equal(row.requestId, crashed.requestId);
    assert.equal(effects("C1"), 0);

    host = await startHost();
    assert.notEqual(host.url, crashedOwner);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const retry = await send(ALICE, key, "C1");
      assert.equal(retry.ok, false);
      assert.equal(retry.error.details.reason, "IDEMPOTENCY_OUTCOME_UNKNOWN");
      assert.equal(retry.error.details.requestId, crashed.requestId);
    }
    assert.equal(effects("C1"), 0);
  });

  it("keeps an interrupted claim uncertain across further restarts", async () => {
    const key = "claimed-1[crash:claimed]";
    await restartHost();
    const retry = await send(ALICE, key, "C1");
    assert.equal(retry.error.details.reason, "IDEMPOTENCY_OUTCOME_UNKNOWN");
    await terminateHost();
    const row = await rowFor(ALICE, key);
    assert.equal(row.status, "in-progress");
    assert.equal(row.__version, 1);
    assert.equal(effects("C1"), 0);
    host = await startHost();
  });

  it("never repeats an effect that ran before its response was persisted", async () => {
    const key = "completing-1[crash:completing]";
    const crashed = await send(ALICE, key, "E1");
    assert.equal(crashed.ok, false);
    assert.equal(effects("E1"), 1);
    await terminateHost();
    assert.equal((await rowFor(ALICE, key)).status, "in-progress");
    host = await startHost();
    const retry = await send(ALICE, key, "E1");
    assert.equal(retry.ok, false);
    assert.equal(retry.error.details.reason, "IDEMPOTENCY_OUTCOME_UNKNOWN");
    assert.equal(effects("E1"), 1);
  });

  it("executes concurrent requests with one key once", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => send(ALICE, "concurrent-1", "K1")),
    );
    assert.ok(results.every((result) => result.ok));
    assert.equal(effects("K1"), 1);
    assert.ok(results.every((result) => result.output.applied === 1));
  });

  it("decides concurrent claims through FeltDB's conditional insert, not a lock", async () => {
    const store = createDurableIdempotencyStore({ path: join(scratch, "claims") });
    try {
      const claims = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          store.claim({
            capability: KEYED,
            claimedAt: Date.now(),
            expiresAt: Date.now() + 1000,
            key: "race",
            requestDigest: "digest",
            requestId: `request-${index}`,
            status: "in-progress",
            version: 1,
          }),
        ),
      );
      assert.equal(claims.filter((claim) => claim === "claimed").length, 1);
    } finally {
      await store.close();
    }
  });

  it("refuses to start a second host on the same idempotency store", async () => {
    const second = startProcess(
      process.execPath,
      ["test/probe-host.mjs"],
      cleanEnv({
        APPPORT_AGENT_CREDENTIAL_FILE: join(scratch, "second-credential"),
        APPPORT_HOST_DATA_DIR: hostDataDir,
        APPPORT_PORT: String(PORT + 1),
        APPPORT_PROVENANCE_FILE: join(scratch, "second.jsonl"),
        AUTHBOUNDRY_ADMIN_SECRET: ADMIN_SECRET,
        PROBE_AUTHORITY_PID_FILE: join(scratch, "second.pid"),
        PROBE_EFFECTS_FILE: effectsFile,
      }),
      /\[probe-host\] owner (\S+) listening at/u,
    );
    await assert.rejects(second, /STATE_LOCKED/u);
    assert.equal(existsSync(join(scratch, "second.pid")), false);
  });

  it("scopes keys to the person: Bob's request with Alice's key runs as his own", async () => {
    const alice = await send(ALICE, "shared-1", "S1");
    const bob = await send(BOB, "shared-1", "S1");
    assert.deepEqual(alice.output, { applied: 1, token: "S1" });
    assert.deepEqual(bob.output, { applied: 2, token: "S1" });
    assert.notEqual(storageKey(ALICE, "shared-1"), storageKey(BOB, "shared-1"));
  });

  it("writes no claim for a caller the host does not authenticate", async () => {
    const before = (await terminateHost(), (await storedRows()).length);
    host = await startHost();
    writeFileSync(join(scratch, "forged"), "aga_forged.000000000000000000000000000000\n");
    process.env.APPPORT_AGENT_CREDENTIAL_FILE = join(scratch, "forged");
    try {
      const forged = await lib.sendRequest(
        { principalId: ALICE },
        { authorization: ["probe.write"], latestVersion: 1, name: KEYED },
        { token: "F1" },
        undefined,
        "forged-1",
      );
      assert.equal(forged.error.code, "UNAUTHORIZED");
    } finally {
      process.env.APPPORT_AGENT_CREDENTIAL_FILE = agentCredentialFile;
    }
    await terminateHost();
    assert.equal((await storedRows()).length, before);
    assert.equal(effects("F1"), 0);
    host = await startHost();
  });
});

describe("eve's operation ledger across an AppPort host restart", () => {
  let agent;

  const startAgent = () =>
    startProcess(
      join(root, "node_modules/.bin/eve"),
      ["start", "--host", "127.0.0.1"],
      cleanEnv({
        AGENT_JWT_SECRET,
        APPPORT_AGENT_CAPABILITIES: `catalog.lookup,${KEYED},probe.applyunkeyed`,
        APPPORT_AGENT_CREDENTIAL_FILE: agentCredentialFile,
        APPPORT_AGENT_WORK_DIR: workDir,
        APPPORT_URL,
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

  async function readWork(workId) {
    const response = await fetch(new URL(`/work/${workId}`, agent.url), {
      headers: { authorization: `Bearer ${signJwt(AGENT_JWT_SECRET, "alice")}` },
    });
    return await response.json();
  }

  before(async () => {
    buildScriptedAgent(fixture);
    agent = await startAgent();
  });

  it("replays an effect from the durable store when eve and the host both restart", async () => {
    const submitted = await fetch(new URL("/work", agent.url), {
      body: JSON.stringify({
        objective: "[crash:invocation.record] Apply H1 via probe.applykeyed",
      }),
      headers: {
        authorization: `Bearer ${signJwt(AGENT_JWT_SECRET, "alice")}`,
        "content-type": "application/json",
        "idempotency-key": "host-restart-1",
      },
      method: "POST",
    });
    const { workId } = await submitted.json();
    await waitFor(async () => !(await reachable()));
    await stop(agent.child);
    assert.equal(effects("H1"), 1);

    await restartHost();
    agent = await startAgent();
    let work;
    await waitFor(async () => {
      work = await readWork(workId);
      return work.status === "completed" || work.status === "blocked";
    });
    assert.equal(work.status, "completed");
    assert.equal(effects("H1"), 1);

    await stop(agent.child);
    const ledger = createFeltDB({ namespace: "appport-agent-work", path: workDir });
    const [operation] = await ledger.collection("appport_operations").find({ work_id: workId });
    await ledger.close?.();
    await terminateHost();
    const row = await rowFor(ALICE, operation.idempotency_key);
    host = await startHost();

    assert.equal(operation.state, "succeeded");
    assert.equal(operation.outcome.reconciled_after_interruption, true);
    assert.equal(row.status, "completed");
    assert.equal(row.key, storageKey(ALICE, operation.operation_id));
    const requests = readJsonl(provenanceFile).filter(
      (entry) => entry.kind === "request" && entry.traceId === workId && entry.capability === KEYED,
    );
    assert.equal(requests.length, 2);
    assert.equal(requests[0].requestId, row.requestId);
    assert.equal(requests[1].idempotentReplay, true);
    assert.deepEqual(operation.request_ids, [requests[1].requestId]);
  });
});
