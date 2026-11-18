import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createFeltDB } from "@feltdb/core";

import { buildScriptedAgent } from "./fixture-agent.mjs";
import {
  cleanEnv,
  groupAlive,
  root,
  signJwt,
  startProcess,
  stop,
  stopAll,
  waitFor,
} from "./support.mjs";

const sdk = process.env.FELTKIT_SDK_DIR ?? "";
const SKIP =
  sdk && existsSync(join(sdk, "src/runtime/delegation.ts"))
    ? false
    : "set FELTKIT_SDK_DIR to a FeltKit packages/sdk checkout with delegated /appport (runtime/delegation.ts) and its dependencies installed";

const scratch = mkdtempSync(join(tmpdir(), "appport-feltkit-"));
const fixture = join(root, ".feltkit-agent");
const projectDir = join(scratch, "app");
const workDir = join(scratch, "work");
const credentialFile = join(scratch, "agent-session");
const tokensDir = join(scratch, "tokens");
const AGENT_JWT_SECRET = "feltkit-agent-jwt-secret-0123456789abcdef";
const port = 6200 + Math.floor(Math.random() * 300);
const appportUrl = `http://127.0.0.1:${port}/appport`;

let agent;
let feltkit;

const hostEnv = (extra = {}) =>
  cleanEnv({
    APPPORT_AGENT_CREDENTIAL_FILE: credentialFile,
    FELTKIT_PORT: String(port),
    FELTKIT_PROJECT_DIR: projectDir,
    FELTKIT_SDK_DIR: sdk,
    FELTKIT_USER_TOKENS_DIR: tokensDir,
    NODE_ENV: "development",
    ...extra,
  });
const tsx = ["--import", "tsx", join(root, "test/feltkit-host.mjs")];

const startFeltKit = (extra) =>
  startProcess(process.execPath, tsx, hostEnv(extra), /\[feltkit-host\] listening at (\S+)/u, sdk);

async function stopFeltKit() {
  await stop(feltkit.child);
  assert.equal(groupAlive(feltkit.child.pid), false);
  const pids = `${projectDir}.authority-pids`;
  for (const pid of existsSync(pids)
    ? readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number)
    : []) {
    if (groupAlive(pid)) process.kill(-pid, "SIGKILL");
    await waitFor(() => !groupAlive(pid));
  }
}

function report() {
  return JSON.parse(
    execFileSync(process.execPath, [...tsx, "--report"], {
      cwd: sdk,
      env: hostEnv(),
      encoding: "utf8",
    }),
  );
}

const startAgent = () =>
  startProcess(
    join(root, "node_modules/.bin/eve"),
    ["start", "--host", "127.0.0.1"],
    cleanEnv({
      AGENT_JWT_SECRET,
      APPPORT_AGENT_CAPABILITIES: "notes.list,notes.add",
      APPPORT_AGENT_CREDENTIAL_FILE: credentialFile,
      APPPORT_AGENT_OPERATOR: "appport-agent-operator:operator",
      APPPORT_AGENT_WORK_DIR: workDir,
      APPPORT_ON_BEHALF_OF: "subject",
      APPPORT_URL: appportUrl,
      PORT: "0",
    }),
    /\[START\] server listening at (\S+)/u,
    fixture,
  );

async function submit(person, key, objective) {
  const response = await fetch(new URL("/work", agent.url), {
    body: JSON.stringify({ objective }),
    headers: {
      authorization: `Bearer ${signJwt(AGENT_JWT_SECRET, person)}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    method: "POST",
  });
  return await response.json();
}

async function settled(person, workId) {
  let work;
  await waitFor(async () => {
    const response = await fetch(new URL(`/work/${workId}`, agent.url), {
      headers: { authorization: `Bearer ${signJwt(AGENT_JWT_SECRET, person)}` },
    });
    work = await response.json();
    return work.status === "completed" || work.status === "blocked";
  });
  return work;
}

async function ledger(workId) {
  await stop(agent.child);
  const db = createFeltDB({ namespace: "appport-agent-work", path: workDir });
  try {
    return await db.collection("appport_operations").find({ work_id: workId });
  } finally {
    await db.close?.();
    agent = await startAgent();
  }
}

async function direct(person, capability, input, headers = {}) {
  const response = await fetch(appportUrl, {
    body: JSON.stringify({
      capability: { name: capability, version: 1 },
      input,
      protocol: "appport/1",
      requestId: `direct_${Math.random().toString(36).slice(2)}`,
      type: "request",
    }),
    headers: {
      authorization: `Bearer ${readFileSync(join(tokensDir, person), "utf8")}`,
      "content-type": "application/json",
      ...headers,
    },
    method: "POST",
  });
  return await response.json();
}

before(async () => {
  if (SKIP) return;
  execFileSync(process.execPath, [...tsx, "--write-project"], { cwd: sdk, env: hostEnv() });
  feltkit = await startFeltKit({ FELTKIT_GRANTS: "alice=notes.list+notes.add;carol=notes.list" });
  buildScriptedAgent(fixture);
  agent = await startAgent();
});

after(async () => {
  if (feltkit) await stopFeltKit();
  await stopAll();
  rmSync(fixture, { force: true, recursive: true });
  rmSync(scratch, { force: true, recursive: true });
});

describe("eve acting for a person through FeltKit's delegated /appport", { skip: SKIP }, () => {
  it("adds and lists Alice's notes as Alice, with the agent and her delegation on FeltKit's audit record", async () => {
    const added = await submit("alice", "alice-add", "Apply A1 via notes.add");
    const work = await settled("alice", added.workId);
    assert.equal(work.status, "completed", JSON.stringify(work));
    assert.equal(work.operations[0].state, "succeeded");

    const listed = await submit("alice", "alice-list", "List via notes.list");
    const listing = await settled("alice", listed.workId);
    assert.equal(listing.status, "completed");
    assert.match(listing.summary, /"owner":"alice"/u);
    assert.match(listing.summary, /"agent":"appport-agent"/u);

    const own = await direct("alice", "notes.list", {});
    assert.deepEqual(
      [own.output.owner, own.output.agent, own.output.notes],
      ["alice", null, ["A1"]],
    );
  });

  it("refuses Bob, who delegated nothing, and Carol's read-only delegation for a write, before any effect", async () => {
    for (const [person, key] of [
      ["bob", "bob-add"],
      ["carol", "carol-add"],
    ]) {
      const { workId } = await submit(person, key, `Apply ${person.toUpperCase()}1 via notes.add`);
      const work = await settled(person, workId);
      assert.equal(work.status, "blocked");
      assert.equal(work.operations[0].state, "failed");
      assert.equal(work.operations[0].errorCode, "FORBIDDEN");
    }
  });

  it("refuses a person's own session naming someone else", async () => {
    const forged = await direct("bob", "notes.list", {}, { "x-appport-on-behalf-of": "alice" });
    assert.equal(forged.ok, false);
    assert.equal(forged.code ?? forged.error?.code, "FORBIDDEN");
  });

  it("adds once when eve crashes after FeltKit applied the note and FeltKit restarts too", async () => {
    const { workId } = await submit(
      "alice",
      "alice-crash",
      "[crash:invocation.record] Apply A2 via notes.add",
    );
    await waitFor(async () => {
      try {
        await fetch(agent.url, { signal: AbortSignal.timeout(2000) });
        return false;
      } catch {
        return true;
      }
    });
    await stop(agent.child);
    await stopFeltKit();
    feltkit = await startFeltKit();
    agent = await startAgent();
    const work = await settled("alice", workId);
    assert.equal(work.status, "completed", JSON.stringify(work));
    const [operation] = await ledger(workId);
    assert.equal(operation.state, "succeeded");
    assert.equal(
      operation.request_ids.length,
      1,
      "eve's record of the first request was lost with eve",
    );
    assert.equal(operation.attempts, 2, "the retry reused the operation's key");
    assert.equal(
      (await direct("alice", "notes.list", {})).output.notes.filter((t) => t === "A2").length,
      1,
    );
  });

  it("stops after Alice revokes her delegation", async () => {
    await stopFeltKit();
    feltkit = await startFeltKit({ FELTKIT_REVOKE: "alice" });
    const { workId } = await submit("alice", "alice-after-revoke", "Apply A3 via notes.add");
    const work = await settled("alice", workId);
    assert.equal(work.operations[0].errorCode, "FORBIDDEN");
    assert.deepEqual((await direct("alice", "notes.list", {})).output.notes.sort(), ["A1", "A2"]);
  });

  it("records each delegated write once, as Alice, with the agent and her AuthBoundry decision", async () => {
    await stopFeltKit();
    const { audit, notes } = report();
    feltkit = await startFeltKit();
    assert.deepEqual(notes, { alice: ["A1", "A2"], bob: [], carol: [] });
    const writes = audit.filter((entry) => entry.function === "notes:add");
    assert.equal(writes.length, 2, JSON.stringify(writes));
    for (const entry of writes) {
      assert.deepEqual(
        [entry.principal.id, entry.principal.type, entry.via],
        ["alice", "user", "appport"],
      );
      const delegation = entry.authority.delegation;
      assert.deepEqual(
        [delegation.agent, delegation.agentAuthority, delegation.person, delegation.capability],
        ["appport-agent", "agent:appport-agent", "alice", "notes.add"],
      );
      assert.match(delegation.delegationId, /\S/u);
      assert.equal(entry.authority.appportDecisionId, delegation.decisionId);
    }
  });

  it("keeps the model's tools to the three AppPort tools", () => {
    assert.deepEqual(readdirSync(join(root, "agent/tools")).sort(), [
      "appport_capabilities.ts",
      "appport_contract.ts",
      "appport_invoke.ts",
    ]);
  });
});
