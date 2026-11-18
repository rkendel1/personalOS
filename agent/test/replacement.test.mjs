/**
 * Contract-verified replacement (slice 8): eve's AppPort dependency is a Resolver `agent` reference, and
 * the implementation behind it is replaced, refused, rolled back and re-checked, end to end.
 *
 *   real      eve (`eve start`, scripted model); the Resolver server (`@appport/resolver` 0.4.1, its CLI,
 *             production outbound policy: only listed origins); the inventory AppPort application
 *             (test/probe-host.mjs) with its private AuthBoundry and FeltDB.
 *   labelled  A and B are two deployments of the same inventory application (one store, so one AuthBoundry
 *             and the same grants), at two origins, each writing its own provenance file. The refused
 *             candidates are the same host started with PROBE_CONTRACT (breaking, effect, removed), Resolver's
 *             own origin (another application), a closed port, a hanging origin, and an unlisted one.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { capabilityDigest } from "@appport/protocol";
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

const RESOLVER_CLI = join(root, "node_modules/@appport/resolver/dist/cli.js");
const scratch = mkdtempSync(join(tmpdir(), "appport-replacement-"));
const fixture = join(root, ".replacement-agent");
const workDir = join(scratch, "work");
const AGENT_JWT_SECRET = "replacement-agent-jwt-secret-0123456789abcdef";
const ALICE = "appport-agent-operator:alice";
const BOB = "appport-agent-operator:bob";
const REF = "ref://prod/eve/inventory";
const USED = [
  "catalog.lookup@1",
  "catalog.reserve@1",
  "catalog.reservation@1",
  "probe.applykeyed@1",
];

const freePort = () =>
  new Promise((resolve) => {
    const server = createNetServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

let ports;
let origin;
let resolver;
let agent;
const deployments = {};
const candidates = {};
let hanging;
let forwarder;

// ── Resolver (real), production outbound policy ─────────────────────────────────────────────────
const resolverDir = join(scratch, "resolver");
let adminKey;
let consumerKey;
let operatorKey;
const forwarded = [];

async function startResolver() {
  const child = spawn(
    process.execPath,
    [
      RESOLVER_CLI,
      "serve",
      "--dir",
      resolverDir,
      "--port",
      String(ports.resolver),
      "--host",
      "127.0.0.1",
    ],
    {
      detached: true,
      env: cleanEnv({
        RESOLVER_ENV: "production",
        RESOLVER_OUTBOUND_ALLOW_HTTP: "1",
        RESOLVER_OUTBOUND_ORIGINS: [
          origin.a,
          origin.b,
          origin.breaking,
          origin.effect,
          origin.removed,
          origin.closed,
          origin.hanging,
          origin.resolver,
          origin.forward,
        ].join(","),
        RESOLVER_OUTBOUND_PRIVATE_NETWORKS: "127.0.0.0/8",
      }),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await new Promise((resolve, reject) => {
    const ready = (data) => String(data).includes("listening") && resolve();
    child.stdout.on("data", ready);
    child.stderr.on("data", ready);
    child.on("exit", (code) => reject(new Error(`resolver exited ${code}`)));
  });
  return child;
}
const killResolver = async () => {
  if (groupAlive(resolver.pid)) process.kill(-resolver.pid, "SIGKILL");
  await waitFor(() => !groupAlive(resolver.pid));
};

async function resolverCall(key, name, input) {
  const response = await fetch(`${origin.resolver}/appport`, {
    body: JSON.stringify({
      capability: { name, version: 1 },
      input,
      protocol: "appport/1",
      requestId: `t-${Math.random()}`,
      type: "request",
    }),
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    method: "POST",
  });
  return await response.json();
}
const current = async () => (await resolverCall(adminKey, "resolver.resolve", { ref: REF })).output;
const bind = (key, expectedRevision, target, reason) =>
  resolverCall(key, "resolver.put", {
    binding: { value: target },
    expectedRevision,
    kind: "agent",
    ref: REF,
    reason,
    ttlSeconds: 0,
  });
const history = async () => (await resolverCall(adminKey, "resolver.history", { ref: REF })).output;

/** The pins a binding is written with: AppPort's capabilityDigest of each capability eve uses, from the served manifest. */
async function pinsOf(at) {
  const manifest = await (await fetch(`${at}/appport/manifest`)).json();
  return Object.fromEntries(
    USED.map((reference) => [reference, capabilityDigest(manifest, reference.split("@")[0], 1)]),
  );
}
const target = (at, pins) => ({ application: "inventory", capabilities: pins, origin: at });

// ── The inventory application: deployments A and B share one store and authority ───────────────
const shared = mkdtempSync(join(tmpdir(), "appport-replacement-host-"));
const provenance = { a: join(shared, "provenance-a.jsonl"), b: join(shared, "provenance-b.jsonl") };
const inventory = () =>
  hostProcess({ env: { PROBE_GRANTS: ALICE, PROBE_READ_GRANTS: "" }, port: 0, scratch: shared });
async function deploy(which, extra = {}) {
  deployments.current = inventory();
  await deployments.current.start({
    APPPORT_PORT: String(ports[which]),
    APPPORT_PROVENANCE_FILE: provenance[which],
    ...extra,
  });
  deployments.which = which;
}
async function undeploy() {
  if (deployments.current) await deployments.current.terminate();
  deployments.current = undefined;
}
const sends = (which, capability) =>
  existsSync(provenance[which])
    ? readJsonl(provenance[which]).filter(
        (e) => e.kind === "authorization" && e.capability === capability,
      )
    : [];

// ── eve ──────────────────────────────────────────────────────────────────────────────────────────
const startAgent = (extra = {}) =>
  startProcess(
    join(root, "node_modules/.bin/eve"),
    ["start", "--host", "127.0.0.1"],
    cleanEnv({
      AGENT_JWT_SECRET,
      APPPORT_AGENT_CAPABILITIES:
        "catalog.lookup,catalog.reserve,catalog.reservation,probe.applykeyed",
      APPPORT_AGENT_CREDENTIAL_FILE: join(shared, "agent-credential"),
      APPPORT_AGENT_DEPENDENCY: REF,
      APPPORT_AGENT_OPERATOR: "appport-agent-operator:operator",
      APPPORT_AGENT_WORK_DIR: workDir,
      // A decoy: with a dependency reference configured, a static URL must never be used, even as a fallback.
      APPPORT_URL: `${origin.a}/appport`,
      PORT: "0",
      RESOLVER_API_KEY: consumerKey,
      RESOLVER_URL: origin.resolver,
      ...extra,
    }),
    /\[START\] server listening at (\S+)/u,
    fixture,
  );
const token = (principal) => signJwt(AGENT_JWT_SECRET, principal.split(":").at(-1));
async function submit(principal, key, objective) {
  const response = await fetch(new URL("/work", agent.url), {
    body: JSON.stringify({ objective }),
    headers: {
      authorization: `Bearer ${token(principal)}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    method: "POST",
  });
  return (await response.json()).workId;
}
async function settled(principal, workId) {
  let work;
  await waitFor(async () => {
    const response = await fetch(new URL(`/work/${workId}`, agent.url), {
      headers: { authorization: `Bearer ${token(principal)}` },
    });
    work = await response.json();
    return work.status === "completed" || work.status === "blocked";
  });
  return work;
}
const run = async (principal, key, objective) =>
  await settled(principal, await submit(principal, key, objective));
async function turnInSession(sessionId, message) {
  const headers = { authorization: `Bearer ${token(ALICE)}`, "content-type": "application/json" };
  assert.ok(
    (
      await fetch(new URL(`/eve/v1/session/${sessionId}`, agent.url), {
        body: JSON.stringify({ message }),
        headers,
        method: "POST",
      })
    ).ok,
  );
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
  ports = Object.fromEntries(
    await Promise.all(
      ["a", "b", "breaking", "effect", "removed", "closed", "hanging", "resolver", "forward"].map(
        async (n) => [n, await freePort()],
      ),
    ),
  );
  origin = Object.fromEntries(Object.entries(ports).map(([n, p]) => [n, `http://127.0.0.1:${p}`]));
  // A hanging origin: it accepts the connection and never answers.
  hanging = createServer(() => undefined);
  await new Promise((resolve) => hanging.listen(ports.hanging, "127.0.0.1", resolve));
  const init = execFileSync(
    process.execPath,
    [RESOLVER_CLI, "init", "--dir", resolverDir, "--tenant", "eve"],
    { encoding: "utf8" },
  );
  adminKey = init.split(/\s+/u).find((word) => word.startsWith("app_live_"));
  resolver = await startResolver();
  const admin = cleanEnv({ RESOLVER_API_KEY: adminKey, RESOLVER_URL: origin.resolver });
  // The agent's runtime access: read, one reference. The deployment operator's: read and write, the deployment's references.
  consumerKey = execFileSync(
    process.execPath,
    [RESOLVER_CLI, "keys", "create", "eve-inventory", "--grant", `read:${REF}`],
    { encoding: "utf8", env: admin },
  ).trim();
  operatorKey = execFileSync(
    process.execPath,
    [
      RESOLVER_CLI,
      "keys",
      "create",
      "deployment-operator",
      "--grant",
      "read,write:ref://prod/eve/*",
    ],
    { encoding: "utf8", env: admin },
  ).trim();
  // A forwarding origin to the live deployment (labelled stand-in): a second live origin for the same implementation,
  // so where a request is routed is observable.
  forwarder = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    try {
      if (request.method === "POST")
        forwarded.push(JSON.parse(String(body) || "{}")?.capability?.name ?? null);
      const headers = {};
      for (const name of [
        "accept",
        "authorization",
        "content-type",
        "idempotency-key",
        "x-appport-on-behalf-of",
      ])
        if (request.headers[name] !== undefined) headers[name] = request.headers[name];
      const answer = await fetch(`${origin.a}${request.url}`, {
        body: request.method === "POST" ? body : undefined,
        headers,
        method: request.method,
      });
      response.writeHead(answer.status, {
        "content-type": answer.headers.get("content-type") ?? "application/json",
      });
      response.end(Buffer.from(await answer.arrayBuffer()));
    } catch {
      response.writeHead(502).end();
    }
  });
  await new Promise((resolve) => forwarder.listen(ports.forward, "127.0.0.1", resolve));
  for (const [name, contract] of [
    ["breaking", "breaking"],
    ["effect", "effect"],
    ["removed", "removed"],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), `appport-candidate-${name}-`));
    candidates[name] = {
      dir,
      host: hostProcess({
        env: { PROBE_CONTRACT: contract, PROBE_GRANTS: ALICE },
        port: ports[name],
        scratch: dir,
      }),
    };
    await candidates[name].host.start();
  }
  await deploy("a");
  buildScriptedAgent(fixture);
  agent = await startAgent();
});

after(async () => {
  await stopAll();
  await undeploy().catch(() => undefined);
  for (const candidate of Object.values(candidates)) {
    await candidate.host.terminate().catch(() => undefined);
    rmSync(candidate.dir, { force: true, recursive: true });
  }
  if (resolver) await killResolver().catch(() => undefined);
  hanging?.closeAllConnections?.();
  hanging?.close();
  forwarder?.closeAllConnections?.();
  forwarder?.close();
  rmSync(fixture, { force: true, recursive: true });
  rmSync(scratch, { force: true, recursive: true });
  rmSync(shared, { force: true, recursive: true });
});

describe("contract-verified replacement of eve's AppPort dependency", () => {
  let pins;

  it("1: the original implementation resolves through Resolver, is verified against the pinned contract, and executes", async () => {
    pins = await pinsOf(origin.a);
    const created = await bind(operatorKey, 0, target(origin.a, pins), "original: deployment A");
    assert.equal(created.ok, true, JSON.stringify(created));
    const work = await run(ALICE, "a-1", "Reserve 1 of ALPHA-1");
    assert.equal(work.status, "completed", JSON.stringify(work));
    assert.deepEqual(work.ledger[0].implementation, { origin: origin.a, ref: REF, revision: 1 });
    assert.equal(work.ledger[0].contractDigest, pins["catalog.reserve@1"]);
    assert.equal(sends("a", "catalog.reserve").length, 1);
  });

  it("8: with the dependency unresolvable or unreachable there is no fallback: nothing runs unverified", async () => {
    // Resolver down while A (and the decoy APPPORT_URL pointing at it) is up: still refused, nothing reaches A.
    await killResolver();
    const unresolved = await run(ALICE, "down-1", "Reserve 1 of ALPHA-1");
    assert.equal(unresolved.status, "blocked");
    assert.deepEqual(unresolved.ledger, []);
    assert.equal(unresolved.refusals[0].refusal, "DEPENDENCY_UNRESOLVED");
    assert.equal(sends("a", "catalog.reserve").length, 1, "nothing was sent to A");
    resolver = await startResolver();
    // The implementation down: refused, no operation prepared against an unknown implementation.
    await undeploy();
    const work = await run(ALICE, "down-2", "Reserve 1 of ALPHA-1");
    assert.equal(work.status, "blocked");
    assert.deepEqual(work.ledger, []);
    assert.equal(work.refusals[0].refusal, "DEPENDENCY_UNAVAILABLE");
  });

  it("2-6: a candidate serving the same contract is verified by Resolver, explicitly activated, and the next operation runs there", async () => {
    await deploy("b");
    assert.deepEqual(await pinsOf(origin.b), pins, "B serves exactly the pinned contracts");
    const activated = await bind(
      operatorKey,
      1,
      target(origin.b, pins),
      "replacement: deployment B",
    );
    assert.equal(activated.ok, true, JSON.stringify(activated));
    const work = await run(ALICE, "b-1", "Reserve 1 of ALPHA-1");
    assert.equal(work.status, "completed", JSON.stringify(work));
    assert.deepEqual(work.ledger[0].implementation, { origin: origin.b, ref: REF, revision: 2 });
    assert.equal(
      work.ledger[0].contractDigest,
      pins["catalog.reserve@1"],
      "the application-facing contract is unchanged",
    );
    assert.equal(sends("b", "catalog.reserve").length, 1, "B executed it");
    assert.equal(sends("a", "catalog.reserve").length, 1, "A did not");
  });

  it("7, negatives: breaking, effect-changed, missing, other-application, unreachable, hanging and unlisted candidates are refused; the active resolution does not move", async () => {
    const refusedWith = async (at, reason, message, pinsFor = pins) => {
      const answer = await bind(operatorKey, 2, target(at, pinsFor), `candidate ${at}`);
      assert.equal(answer.ok, false, `${at} was accepted`);
      assert.equal(answer.error.details?.reason, reason, `${at}: ${JSON.stringify(answer.error)}`);
      assert.match(answer.error.message, message, at);
    };
    await refusedWith(
      origin.breaking,
      "resolver.incompatible-target",
      /serves probe\.applykeyed@1 with contract sha256:[a-f0-9]+, not the pinned sha256:/u,
    );
    await refusedWith(
      origin.effect,
      "resolver.incompatible-target",
      /serves probe\.applykeyed@1 with contract sha256:[a-f0-9]+, not the pinned/u,
    );
    await refusedWith(
      origin.removed,
      "resolver.incompatible-target",
      /does not serve probe\.applykeyed@1/u,
    );
    await refusedWith(
      origin.resolver,
      "resolver.incompatible-target",
      /serves \S+, not inventory/u,
    );
    await refusedWith(origin.closed, "resolver.agent-unreachable", /could not be discovered/u);
    await refusedWith(origin.hanging, "resolver.agent-unreachable", /could not be discovered/u);
    await refusedWith("http://127.0.0.1:9", "resolver.outbound-refused", /may not be contacted/u);
    // The pins rewritten to a breaking candidate's digest, still pointing at B: B does not serve it, so refused.
    const breakingPins = await pinsOf(origin.breaking);
    assert.notEqual(breakingPins["probe.applykeyed@1"], pins["probe.applykeyed@1"]);
    await refusedWith(origin.b, "resolver.incompatible-target", /not the pinned/u, breakingPins);
    assert.equal((await current()).currentRevision, 2);
    assert.equal((await current()).selected.value.origin, origin.b);
    const work = await run(ALICE, "b-2", "Reserve 1 of ALPHA-1");
    assert.equal(work.ledger[0].implementation.origin, origin.b);
  });

  it("unauthorized and duplicate replacements: eve's own key cannot write; two concurrent writes at one revision commit once", async () => {
    const byConsumer = await bind(
      consumerKey,
      2,
      target(origin.b, pins),
      "eve tries to re-point itself",
    );
    assert.equal(byConsumer.ok, false);
    assert.match(JSON.stringify(byConsumer.error), /FORBIDDEN|forbidden/u);
    const both = await Promise.all([
      bind(operatorKey, 2, target(origin.b, pins), "duplicate 1"),
      bind(operatorKey, 2, target(origin.b, pins), "duplicate 2"),
    ]);
    assert.equal(both.filter((answer) => answer.ok).length, 1, JSON.stringify(both));
    assert.match(JSON.stringify(both.find((answer) => !answer.ok).error), /revision/u);
    assert.equal((await current()).currentRevision, 3);
  });

  it("who owns the dependency: only the deployment operator changes it; the agent reads it; an end user cannot reach it; the operator gets no application authority", async () => {
    // An end user's own credential (their eve token) is not a Resolver credential.
    const byUser = await bind(
      token(ALICE),
      2,
      target(origin.b, pins),
      "Alice tries to re-point the deployment",
    );
    assert.equal(byUser.ok, false);
    assert.equal((await current()).currentRevision, 3);
    // No Resolver key reaches anything eve returns or stores.
    const work = await run(ALICE, "keys-1", "Reserve 1 of ALPHA-1");
    const stored = readdirSync(workDir, { recursive: true })
      .map((f) => join(workDir, String(f)))
      .map((f) => {
        try {
          return readFileSync(f, "latin1");
        } catch {
          return "";
        }
      })
      .join("");
    for (const key of [consumerKey, operatorKey, adminKey])
      assert.ok(
        !JSON.stringify(work).includes(key) && !stored.includes(key),
        "a Resolver key reached eve's answers or store",
      );
    // The operator's Resolver key is not an application credential: the inventory application refuses it.
    const asOperator = await fetch(`${origin.b}/appport`, {
      body: JSON.stringify({
        capability: { name: "catalog.reserve", version: 1 },
        input: { quantity: 1, sku: "ALPHA-1" },
        protocol: "appport/1",
        requestId: "operator-1",
        type: "request",
      }),
      headers: {
        authorization: `Bearer ${operatorKey}`,
        "content-type": "application/json",
        "x-appport-on-behalf-of": ALICE,
      },
      method: "POST",
    });
    assert.equal((await asOperator.json()).ok, false);
    // Every revision so far was made by the deployment operator's key, none by eve's.
    const keys = JSON.parse(
      execFileSync(process.execPath, [RESOLVER_CLI, "keys", "list"], {
        encoding: "utf8",
        env: cleanEnv({ RESOLVER_API_KEY: adminKey, RESOLVER_URL: origin.resolver }),
      }),
    );
    const nameOf = (actor) =>
      (Array.isArray(keys) ? keys : (keys.keys ?? [])).find((k) => actor.endsWith(k.id))?.name;
    assert.deepEqual(
      [...new Set((await history()).entries.map((e) => nameOf(e.actor)))],
      ["deployment-operator"],
    );
  });

  it("9: authority does not change with the implementation: the person and agent are decided as before", async () => {
    const bob = await run(BOB, "bob-1", "Reserve 1 of ALPHA-1");
    assert.equal(bob.status, "blocked");
    assert.equal(bob.operations[0]?.errorCode ?? bob.ledger[0]?.errorCode, "FORBIDDEN");
    const decisions = (which) =>
      sends(which, "catalog.reserve")
        .filter((e) => e.onBehalfOf.endsWith("alice"))
        .map((e) => [e.agent, e.decision, e.authority.application]);
    assert.deepEqual(
      decisions("b")[0],
      decisions("a")[0],
      "the same agent, decision and authority at A and B",
    );
  });

  it("stale: an origin whose served contract changed behind an unchanged binding is refused before anything is sent", async () => {
    await undeploy();
    await deploy("b", { PROBE_CONTRACT: "breaking" });
    const sentBefore = sends("b", "probe.applykeyed").length;
    const work = await run(ALICE, "stale-1", "Apply S1 via probe.applykeyed");
    assert.equal(work.status, "blocked");
    assert.deepEqual(work.ledger, []);
    assert.equal(work.refusals[0].refusal, "CONTRACT_MISMATCH");
    assert.equal(sends("b", "probe.applykeyed").length, sentBefore, "nothing was sent");
    await undeploy();
    await deploy("b");
  });

  it("10, 12: an operation in flight keeps its implementation through a rollback; rollback is re-verified", async () => {
    writeFileSync(deployments.current.files.crashPlan, "completing probe.applykeyed");
    const workId = await submit(ALICE, "inflight-1", "Apply F1 via probe.applykeyed");
    const first = await settled(ALICE, workId);
    assert.deepEqual(
      [first.ledger[0].state, first.ledger[0].implementation.origin],
      ["executing", origin.b],
    );
    await undeploy();
    // Rolling back to A while A is down is refused: a rollback is verified like any write.
    const early = await resolverCall(operatorKey, "resolver.rollback", {
      expectedRevision: 3,
      reason: "back to A",
      ref: REF,
      toRevision: 1,
    });
    assert.equal(early.ok, false);
    assert.match(JSON.stringify(early.error), /agent-unreachable/u);
    await deploy("a");
    const rolled = await resolverCall(operatorKey, "resolver.rollback", {
      expectedRevision: 3,
      reason: "back to A",
      ref: REF,
      toRevision: 1,
    });
    assert.equal(rolled.ok, true, JSON.stringify(rolled));
    assert.equal((await current()).selected.value.origin, origin.a);
    // The uncertain operation is retried in the same work: it is checked against B, where it was sent, never sent to A.
    const sentToA = sends("a", "probe.applykeyed").length;
    await turnInSession(first.sessionId, "[repeat] Apply F1 via probe.applykeyed");
    const work = await settled(ALICE, workId);
    assert.equal(work.ledger[0].implementation.origin, origin.b);
    assert.notEqual(work.ledger[0].state, "succeeded");
    assert.equal(sends("a", "probe.applykeyed").length, sentToA, "never redirected to A");
    // New work goes to A, at the rolled-back revision.
    const fresh = await run(ALICE, "a-2", "Reserve 1 of ALPHA-1");
    assert.deepEqual(fresh.ledger[0].implementation, { origin: origin.a, ref: REF, revision: 4 });
  });

  it("crash: Resolver killed while it verifies a candidate stores nothing; the active resolution is unchanged", async () => {
    const pending = bind(
      operatorKey,
      4,
      target(origin.hanging, pins),
      "candidate that never answers",
    ).catch((error) => ({ error }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    await killResolver();
    await pending;
    resolver = await startResolver();
    const now = await current();
    assert.deepEqual([now.currentRevision, now.selected.value.origin], [4, origin.a]);
  });

  it("11: after restarting Resolver and eve, every replacement decision and each operation's implementation is still on record", async () => {
    await killResolver();
    resolver = await startResolver();
    await stop(agent.child);
    const db = createFeltDB({ namespace: "appport-agent-work", path: workDir });
    const operations = await db.collection("appport_operations").find({});
    await db.close?.();
    agent = await startAgent();
    const entries = (await history()).entries;
    console.log(
      JSON.stringify(
        entries.map(({ action, actor, reason, revision }) => ({ action, actor, reason, revision })),
      ),
    );
    const reasons = entries.map((e) => e.reason);
    for (const reason of ["original: deployment A", "replacement: deployment B", "back to A"])
      assert.ok(reasons.includes(reason), `${reason} not in ${JSON.stringify(reasons)}`);
    assert.equal(
      reasons.filter((r) => r?.startsWith("duplicate")).length,
      1,
      "one of the duplicate writes",
    );
    assert.ok(
      !reasons.some((r) => r?.startsWith("candidate")),
      "no refused candidate is in the history",
    );
    assert.ok(
      entries.every((e) => e.actor),
      "every revision names who made it",
    );
    assert.ok(entries.some((e) => e.action === "rollback"));
    const byOrigin = (o) =>
      operations
        .filter((op) => op.implementation?.origin === o)
        .map((op) => op.implementation.revision);
    assert.ok(
      byOrigin(origin.a).includes(1) &&
        byOrigin(origin.a).includes(4) &&
        byOrigin(origin.b).includes(2),
    );
  });

  it("10: with both implementations live, an operation prepared at one is sent there after the dependency moves to the other", async () => {
    const workId = await submit(
      ALICE,
      "both-live-1",
      "[crash:operation.prepared] Apply L1 via probe.applykeyed",
    );
    await waitFor(async () => {
      try {
        await fetch(agent.url, { signal: AbortSignal.timeout(1000) });
        return false;
      } catch {
        return true;
      }
    });
    await stop(agent.child);
    const moved = await bind(
      operatorKey,
      (await current()).currentRevision,
      target(origin.forward, pins),
      "replacement: forwarding origin",
    );
    assert.equal(moved.ok, true, JSON.stringify(moved));
    const viaForwarder = forwarded.filter((name) => name === "probe.applykeyed").length;
    const atA = sends("a", "probe.applykeyed").length;
    agent = await startAgent();
    const work = await settled(ALICE, workId);
    assert.equal(work.ledger[0].implementation.origin, origin.a);
    assert.equal(work.ledger[0].state, "succeeded", JSON.stringify(work.ledger[0]));
    assert.equal(
      sends("a", "probe.applykeyed").length,
      atA + 1,
      "sent to A, where it was prepared",
    );
    assert.equal(
      forwarded.filter((name) => name === "probe.applykeyed").length,
      viaForwarder,
      "not through the new resolution",
    );
    const fresh = await run(ALICE, "forward-1", "Reserve 1 of ALPHA-1");
    assert.equal(
      fresh.ledger[0].implementation.origin,
      origin.forward,
      "new work uses the new resolution",
    );
    assert.ok(forwarded.includes("catalog.reserve"));
  });

  it("a capability the binding does not pin is not used unverified", async () => {
    const now = await current();
    const partial = Object.fromEntries(
      Object.entries(pins).filter(([reference]) => reference !== "probe.applykeyed@1"),
    );
    const narrowed = await bind(
      operatorKey,
      now.currentRevision,
      target(origin.a, partial),
      "pins without probe.applykeyed",
    );
    assert.equal(narrowed.ok, true, JSON.stringify(narrowed));
    const sentBefore = sends("a", "probe.applykeyed").length;
    const work = await run(ALICE, "unpinned-1", "Apply U1 via probe.applykeyed");
    assert.equal(work.status, "blocked");
    assert.deepEqual([work.ledger.length, work.refusals[0].refusal], [0, "CONTRACT_NOT_PINNED"]);
    assert.equal(sends("a", "probe.applykeyed").length, sentBefore);
    assert.equal(
      (await run(ALICE, "pinned-still", "Reserve 1 of ALPHA-1")).status,
      "completed",
      "pinned capabilities still run",
    );
  });
});
