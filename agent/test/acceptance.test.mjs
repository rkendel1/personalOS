import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { AGENT_ID, startInventoryHost } from "../appport-host/host.mjs";
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

const scratch = mkdtempSync(join(tmpdir(), "appport-agent-acceptance-"));
const provenanceFile = join(scratch, "provenance.jsonl");
const agentCredentialFile = join(scratch, "agent-credential");
const hostDataDir = join(scratch, "host");
const ADMIN_SECRET = "acceptance-authority-admin-secret-0123456789";
const AGENT_JWT_SECRET = "acceptance-agent-jwt-secret-0123456789abcdef";
const APPPORT_PORT = 4400 + Math.floor(Math.random() * 400);
const APPPORT_URL = `http://127.0.0.1:${APPPORT_PORT}/appport`;
const ANTHROPIC_API_KEY = process.env.APPPORT_AGENT_E2E_ANTHROPIC_API_KEY ?? "";
const ALICE = "appport-agent-operator:alice";
const BOB = "appport-agent-operator:bob";
const CAROL = "appport-agent-operator:carol";
const catalog = JSON.parse(readFileSync(join(root, "appport-host/catalog.json"), "utf8"));
const ALPHA = catalog.items.find((item) => item.sku === "ALPHA-1");

let host;
let lib;
let aliceGrant;

const startHost = () =>
  startInventoryHost({
    adminSecret: ADMIN_SECRET,
    agentCredentialFile,
    dataDir: hostDataDir,
    port: APPPORT_PORT,
    provenanceFile,
  });

const provenance = () => readJsonl(provenanceFile);

const recordsFor = (requestId, kind) =>
  provenance().filter((entry) => entry.requestId === requestId && entry.kind === kind);

const lookup = (principalId, input = { sku: "ALPHA-1" }) =>
  lib.invokeCapability({ principalId }, "catalog.lookup", input, undefined);

function assertRejectedBeforeExecution(result, code, reason) {
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
  assert.deepEqual(recordsFor(result.requestId, "execution"), []);
  if (reason !== undefined)
    assert.equal(recordsFor(result.requestId, "authorization")[0].reason, reason);
}

before(async () => {
  host = await startHost();
  process.env.APPPORT_URL = APPPORT_URL;
  process.env.APPPORT_AGENT_CREDENTIAL_FILE = agentCredentialFile;
  process.env.APPPORT_AGENT_CAPABILITIES = "catalog.lookup";
  lib = await import("../agent/lib/appport.ts");
});

after(async () => {
  await stopAll();
  await host?.close();
  rmSync(scratch, { force: true, recursive: true });
});

describe("AppPort with AuthBoundry delegation (real servers, no model)", () => {
  it("discovers the read-only capability and marks it invocable", async () => {
    const capabilities = await lib.listCapabilities({ principalId: ALICE });
    assert.deepEqual(
      capabilities.filter((entry) => entry.name === "catalog.lookup"),
      [
        {
          authorization: ["catalog.read"],
          description: "Reads one catalog item by SKU. Read-only.",
          effect: "observation",
          idempotency: "unsupported",
          invocable: true,
          name: "catalog.lookup",
          version: 1,
        },
      ],
    );
    const reserve = capabilities.find((entry) => entry.name === "catalog.reserve");
    assert.equal(reserve.effect, "consequential");
    assert.equal(reserve.idempotency, "supported");
    assert.equal(reserve.invocable, false);
  });

  it("reads the capability's contract and input schema", async () => {
    const contract = await lib.readContract({ principalId: ALICE }, "catalog.lookup");
    assert.equal(contract.found, true);
    assert.equal(contract.effect, "observation");
    assert.deepEqual(contract.inputSchema.required, ["sku"]);
    assert.equal(contract.inputSchema.properties.sku.type, "string");
  });

  it("rejects a user who has granted nothing", async () => {
    assertRejectedBeforeExecution(await lookup(ALICE), "FORBIDDEN", "delegation_missing");
  });

  it("invokes for Alice once she grants the agent catalog.read, with attributable provenance", async () => {
    aliceGrant = await host.authority.grant({
      agent: AGENT_ID,
      capabilities: ["catalog.read"],
      delegator: ALICE,
    });
    const result = await lookup(ALICE);
    assert.equal(result.ok, true);
    assert.deepEqual(result.output, ALPHA);

    const [decision] = recordsFor(result.requestId, "authorization");
    assert.equal(decision.decision, "allow");
    assert.equal(decision.agent, AGENT_ID);
    assert.equal(decision.onBehalfOf, ALICE);
    assert.equal(decision.delegationId, aliceGrant.id);
    assert.match(decision.decisionId, /^inventory-decision-/u);
    const [execution] = recordsFor(result.requestId, "execution");
    assert.equal(execution.delegationId, aliceGrant.id);
    const [request] = recordsFor(result.requestId, "request");
    assert.equal(request.success, true);
    assert.equal(request.principal, ALICE);
    assert.equal(request.capability, "catalog.lookup");
  });

  it("does not let Bob use Alice's delegation", async () => {
    assertRejectedBeforeExecution(await lookup(BOB), "FORBIDDEN", "delegation_missing");
  });

  it("rejects input that violates the contract", async () => {
    for (const input of [{}, { sku: 5 }]) {
      const result = await lookup(ALICE, input);
      assertRejectedBeforeExecution(result, "INVALID_INPUT");
    }
  });

  it("stops invoking once Alice revokes, and a new grant is a new delegation", async () => {
    await host.authority.revoke(aliceGrant.id);
    assertRejectedBeforeExecution(await lookup(ALICE), "FORBIDDEN", "delegation_revoked");
    const renewed = await host.authority.grant({
      agent: AGENT_ID,
      capabilities: ["catalog.read"],
      delegator: ALICE,
    });
    assert.notEqual(renewed.id, aliceGrant.id);
    aliceGrant = renewed;
    assert.equal((await lookup(ALICE)).ok, true);
  });

  it("rejects a delegation once it has expired", async () => {
    await host.authority.grant({
      agent: AGENT_ID,
      capabilities: ["catalog.read"],
      delegator: CAROL,
      expiresAt: Date.now() + 1500,
    });
    assert.equal((await lookup(CAROL)).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assertRejectedBeforeExecution(await lookup(CAROL), "FORBIDDEN", "delegation_expired");
  });

  it("treats a forged agent credential as unauthenticated", async () => {
    const forged = join(scratch, "forged-credential");
    writeFileSync(forged, "aga_forged.0000000000000000000000000000000000000000\n");
    process.env.APPPORT_AGENT_CREDENTIAL_FILE = forged;
    try {
      const result = await lookup(ALICE);
      assertRejectedBeforeExecution(result, "UNAUTHORIZED");
      assert.deepEqual(recordsFor(result.requestId, "authorization"), []);
    } finally {
      process.env.APPPORT_AGENT_CREDENTIAL_FILE = agentCredentialFile;
    }
  });

  it("fails closed while AuthBoundry is down and recovers when it is restarted", async () => {
    process.kill(-host.authority.process.pid, "SIGKILL");
    const result = await lookup(ALICE);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INTERNAL_ERROR");
    assert.equal(recordsFor(result.requestId, "authorization")[0].decision, "unavailable");
    assert.deepEqual(recordsFor(result.requestId, "execution"), []);
    await waitFor(async () => (await lookup(ALICE)).ok);
    assert.equal(host.authority.restarts, 1);
  });

  it("reports an unreachable AppPort as a failure, never a result", async () => {
    process.env.APPPORT_URL = "http://127.0.0.1:9/appport";
    try {
      const result = await lookup(ALICE);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "UNAVAILABLE");
    } finally {
      process.env.APPPORT_URL = APPPORT_URL;
    }
  });

  it("never sends a capability the operator did not expose", async () => {
    process.env.APPPORT_AGENT_CAPABILITIES = "";
    try {
      const lookups = () =>
        provenance().filter((entry) => entry.capability === "catalog.lookup").length;
      const before = lookups();
      const result = await lookup(ALICE);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "NOT_EXPOSED");
      assert.equal(lookups(), before);
    } finally {
      process.env.APPPORT_AGENT_CAPABILITIES = "catalog.lookup";
    }
  });

  it("keeps grants and the agent's credential across a restart of the application", async () => {
    const credential = readFileSync(agentCredentialFile, "utf8");
    await host.close();
    host = await startHost();
    assert.equal(host.authority.issuedCheckCredential, false);
    assert.equal(host.authority.registeredAgents[0].issuedAgentCredential, false);
    assert.equal(readFileSync(agentCredentialFile, "utf8"), credential);
    const result = await lookup(ALICE);
    assert.equal(result.ok, true);
    assert.equal(recordsFor(result.requestId, "authorization")[0].delegationId, aliceGrant.id);
  });
});

const signAgentJwt = (sub) => signJwt(AGENT_JWT_SECRET, sub);

async function turn(agentUrl, user, message, sessionId) {
  const headers = {
    authorization: `Bearer ${signAgentJwt(user)}`,
    "content-type": "application/json",
  };
  const path = sessionId === undefined ? "/eve/v1/session" : `/eve/v1/session/${sessionId}`;
  const created = await fetch(new URL(path, agentUrl), {
    body: JSON.stringify({ message }),
    headers,
    method: "POST",
  });
  assert.ok(created.ok, `send failed with HTTP ${created.status}`);
  const id = sessionId ?? (await created.json()).sessionId;
  const stream = await fetch(new URL(`/eve/v1/session/${id}/stream`, agentUrl), {
    headers,
    signal: AbortSignal.timeout(180_000),
  });
  const decoder = new TextDecoder();
  let buffered = "";
  let replies = [];
  let settled = 0;
  const target = sessionId === undefined ? 1 : 2;
  for await (const chunk of stream.body) {
    buffered += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (!line.trim()) continue;
      for (const fact of JSON.parse(line).facts ?? []) {
        if (fact.type === "content.completed" && fact.data.kind === "text")
          replies.push(fact.data.value);
        if (fact.type === "turn.settled") settled += 1;
      }
      if (settled >= target) return { reply: replies.at(-1) ?? "", sessionId: id };
    }
  }
  return { reply: replies.at(-1) ?? "", sessionId: id };
}

describe("eve agent end to end (real Anthropic model)", { skip: ANTHROPIC_API_KEY === "" }, () => {
  let agent;
  const agentEnv = () =>
    cleanEnv({
      AGENT_JWT_SECRET,
      ANTHROPIC_API_KEY,
      APPPORT_AGENT_CREDENTIAL_FILE: agentCredentialFile,
      APPPORT_AGENT_CAPABILITIES: "catalog.lookup,catalog.reserve,catalog.reservation",
      APPPORT_AGENT_RECONCILERS: "catalog.reserve=catalog.reservation",
      APPPORT_AGENT_WORK_DIR: join(scratch, "work"),
      APPPORT_URL,
      PORT: "0",
    });
  const startAgent = () =>
    startProcess(
      join(root, "node_modules/.bin/eve"),
      ["start", "--host", "127.0.0.1"],
      agentEnv(),
      /\[START\] server listening at (\S+)/u,
    );

  before(async () => {
    rmSync(join(root, ".eve"), { force: true, recursive: true });
    execFileSync(join(root, "node_modules/.bin/eve"), ["build"], {
      cwd: root,
      env: cleanEnv({ EVE_MODEL_CATALOG: "bundled" }),
      stdio: "ignore",
    });
    agent = await startAgent();
  });

  it("rejects unauthenticated requests", async () => {
    const response = await fetch(new URL("/eve/v1/session", agent.url), { method: "POST" });
    assert.equal(response.status, 401);
  });

  it("answers an authorized question through AppPort and continues after a restart", async () => {
    const before = provenance().length;
    const first = await turn(
      agent.url,
      "alice",
      "Using AppPort, how many units of SKU ALPHA-1 are in stock?",
    );
    assert.match(first.reply, /\b42\b/u);
    const invocations = provenance()
      .slice(before)
      .filter((entry) => entry.capability === "catalog.lookup");
    assert.ok(invocations.some((entry) => entry.success && entry.principal === ALICE));
    assert.ok(
      provenance()
        .slice(before)
        .some((entry) => entry.kind === "execution" && entry.delegationId === aliceGrant.id),
    );

    await stop(agent.child);
    agent = await startAgent();
    const second = await turn(
      agent.url,
      "alice",
      "And how many units of SKU BETA-2?",
      first.sessionId,
    );
    assert.match(second.reply, /\b7\b/u);
  });

  it("reports AppPort's rejection for a caller without the permission", async () => {
    const before = provenance().length;
    await turn(agent.url, "bob", "Using AppPort, how many units of SKU ALPHA-1 are in stock?");
    const invocations = provenance()
      .slice(before)
      .filter((entry) => entry.capability === "catalog.lookup");
    assert.ok(
      invocations.some((entry) => entry.kind === "request"),
      "the agent did not attempt the invocation",
    );
    assert.ok(
      invocations.every(
        (entry) =>
          entry.kind !== "execution" &&
          (entry.kind !== "request" || (!entry.success && entry.principal === BOB)),
      ),
    );
  });

  it("reserves stock as a durable operation under Alice's delegation", async () => {
    const grant = await host.authority.grant({
      agent: AGENT_ID,
      capabilities: ["catalog.read", "catalog.reserve"],
      delegator: ALICE,
    });
    const before = (await host.inventory.item("BETA-2")).quantity;
    const submitted = await fetch(new URL("/work", agent.url), {
      body: JSON.stringify({ objective: "Please reserve 2 units of SKU BETA-2 for me." }),
      headers: {
        authorization: `Bearer ${signAgentJwt("alice")}`,
        "content-type": "application/json",
        "idempotency-key": "real-model-reserve",
      },
      method: "POST",
    });
    const { workId } = await submitted.json();
    let work;
    await waitFor(
      async () => {
        const response = await fetch(new URL(`/work/${workId}`, agent.url), {
          headers: { authorization: `Bearer ${signAgentJwt("alice")}` },
        });
        work = await response.json();
        return work.status === "completed" || work.status === "blocked";
      },
      { attempts: 1800 },
    );
    assert.equal(work.status, "completed", JSON.stringify(work.decisions));
    const reserves = work.operations.filter(
      (operation) => operation.capability === "catalog.reserve",
    );
    assert.equal(reserves.length, 1);
    assert.equal(reserves[0].state, "succeeded");
    assert.equal((await host.inventory.item("BETA-2")).quantity, before - 2);
    const decision = provenance().find(
      (entry) => entry.kind === "authorization" && entry.requestId === reserves[0].requestIds[0],
    );
    assert.equal(decision.delegationId, grant.id);
  });
});
