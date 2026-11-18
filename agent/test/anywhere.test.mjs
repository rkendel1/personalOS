/**
 * AnywhereAide surfaces → Personal OS → eve (slice 6), end to end and real except where labelled:
 *
 *   real      eve (`eve start`, scripted model), the Personal OS server process with its own sources,
 *             its private AuthBoundry (@authboundry/local), the Resolver server process, FeltDB.
 *   stand-in  MULTIPLAYER: this test plays the Multiplayer bridge, with a real operator-issued bridge
 *             session, delivering personalos.interaction/1 envelopes and reading interaction updates.
 *             X: this test plays the X adapter's poll (a real `xadapter` session handing
 *             xsurface:receive the mention X's API would return). No X API is involved: the bot's
 *             replies are never sent here (tests/x.test.ts in Personal OS covers that against its
 *             labelled X API stand-in). Nothing here is a live provider test.
 */
import { execFileSync, spawn } from "node:child_process";
import { createSign, generateKeyPairSync } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

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

// This agent lives in PersonalOS (agent/): its PersonalOS is the repository it is in, unless named.
const personalos = process.env.PERSONALOS_DIR ?? fileURLToPath(new URL("../..", import.meta.url));
const RESOLVER_CLI = join(personalos, "tests/resolver/node_modules/@appport/resolver/dist/cli.js");
const SKIP =
  personalos &&
  existsSync(join(personalos, "feltkit/anywhere.ts")) &&
  existsSync(RESOLVER_CLI) &&
  existsSync(join(personalos, "node_modules/@feltdb/feltkit/dist/runtime/delegation.js"))
    ? false
    : "set PERSONALOS_DIR to a Personal OS checkout with feltkit/anywhere.ts, its dependencies (and tests/resolver's) installed, and a FeltKit with delegated /appport";

const scratch = mkdtempSync(join(tmpdir(), "appport-anywhere-"));
const fixture = join(root, ".anywhere-agent");
const workDir = join(scratch, "work");
const credentialFile = join(scratch, "agent-session");
const projectDir = join(scratch, "personalos");
const AGENT_JWT_SECRET = "anywhere-agent-jwt-secret-0123456789abcdef";
const IDENTITY_ISSUER = "personalos";
const identityKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const strangerKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const BOT = { id: "900000000000000001", username: "anywhereaide" };
const ADA_X = "100000000000000001";
const INSTANCE = "mp-anywhere";
const GRANTS =
  "tasks.list+tasks.create+projects.create+projects.list+documents.list+research.list+memory.propose";

let poPort;
let evePort;
let host;
let agent;
let resolver;
let seq = 0;

function signEs256(privateKey, claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({
    aud: "appport-agent-identity",
    exp: now + 3600,
    iat: now,
    iss: IDENTITY_ISSUER,
    ...claims,
  });
  const signature = createSign("SHA256")
    .update(`${header}.${payload}`)
    .sign({ dsaEncoding: "ieee-p1363", key: privateKey })
    .toString("base64url");
  return `${header}.${payload}.${signature}`;
}
const IDENTITY_TOKEN = signEs256(identityKeys.privateKey, { sub: "surfaces" });

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

// ── The Resolver server (real), with Personal OS's two least-privilege keys ──────────────────────
async function startResolver() {
  const dir = join(scratch, "resolver");
  const run = (args) =>
    execFileSync(process.execPath, [RESOLVER_CLI, ...args], { encoding: "utf8" });
  const adminKey = run(["init", "--dir", dir, "--tenant", "personalos"])
    .split(/\s+/u)
    .find((word) => word.startsWith("app_live_"));
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [RESOLVER_CLI, "serve", "--dir", dir, "--port", String(port), "--host", "127.0.0.1"],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise((resolve, reject) => {
    const ready = (data) => String(data).includes("listening") && resolve();
    child.stdout.on("data", ready);
    child.stderr.on("data", ready);
    child.on("exit", (code) => reject(new Error(`resolver exited ${code}`)));
  });
  const url = `http://127.0.0.1:${port}`;
  const { ResolverClient } = await import(
    pathToFileURL(join(personalos, "node_modules/@appport/resolver-client/dist/index.js")).href
  );
  const admin = await ResolverClient.connect({
    apiKey: adminKey,
    live: false,
    maxStaleSeconds: 0,
    url,
  });
  const issue = async (which) => {
    const key = await admin.createKey(`personalos-${which}`);
    await admin.grant(key.principal, [which], "ref://identity/personalos/*");
    return key.secret;
  };
  return { admin, child, keys: { read: await issue("read"), write: await issue("write") }, url };
}

const hostEnv = (extra = {}) =>
  cleanEnv({
    APPPORT_AGENT_CREDENTIAL_FILE: credentialFile,
    FELTKIT_CREDENTIAL_AGENT_IDENTITY: IDENTITY_TOKEN,
    FELTKIT_CREDENTIAL_RESOLVER_LINK: resolver.keys.write,
    FELTKIT_CREDENTIAL_RESOLVER_RESOLVE: resolver.keys.read,
    NODE_ENV: "development",
    PERSONALOS_AGENT_POLL_MS: "200",
    PERSONALOS_AGENT_URL: `http://127.0.0.1:${evePort}`,
    PERSONALOS_DIR: personalos,
    PERSONALOS_EXECUTOR_GRANTS:
      "ada=personalos.assistant.converse;grace=personalos.assistant.converse",
    PERSONALOS_GRANTS: `ada=${GRANTS}`,
    PERSONALOS_PORT: String(poPort),
    PERSONALOS_PROJECT_DIR: projectDir,
    PERSONALOS_SERVICE_SESSIONS: "multiplayer=bridge;x-adapter=xadapter",
    PERSONALOS_SIGNED_IN: "ada,grace",
    PERSONALOS_WORKER_MS: "200",
    RESOLVER_URL: resolver.url,
    ...extra,
  });
const harness = join(root, "test/personalos-host.mjs");
const startHost = (extra) =>
  startProcess(
    process.execPath,
    [harness],
    hostEnv(extra),
    /\[personalos-host\] listening at (\S+)/u,
  );

async function stopHost() {
  await stop(host.child);
  const pids = `${projectDir}.authority-pids`;
  for (const pid of existsSync(pids)
    ? readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number)
    : []) {
    if (groupAlive(pid)) process.kill(-pid, "SIGKILL");
    await waitFor(() => !groupAlive(pid));
  }
}

/** Personal OS with eve stopped (FeltDB holds one writer per store): every record, then started again. */
async function snapshot() {
  await stopHost();
  try {
    return JSON.parse(
      execFileSync(process.execPath, [harness, "--report"], {
        encoding: "utf8",
        env: hostEnv(),
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  } finally {
    host = await startHost();
  }
}

const startAgent = () =>
  startProcess(
    join(root, "node_modules/.bin/eve"),
    ["start", "--host", "127.0.0.1"],
    cleanEnv({
      AGENT_JWT_SECRET,
      APPPORT_AGENT_CAPABILITIES: GRANTS.replaceAll("+", ",") + ",memory.list,tasks.update",
      APPPORT_AGENT_CREDENTIAL_FILE: credentialFile,
      APPPORT_AGENT_IDENTITY_ISSUER: IDENTITY_ISSUER,
      APPPORT_AGENT_IDENTITY_PUBLIC_KEY: identityKeys.publicKey.export({
        format: "pem",
        type: "spki",
      }),
      APPPORT_AGENT_OPERATOR: "appport-agent-operator:operator",
      APPPORT_AGENT_WORK_DIR: workDir,
      APPPORT_ON_BEHALF_OF: "subject",
      APPPORT_URL: `http://127.0.0.1:${poPort}/appport`,
      PORT: String(evePort),
    }),
    /\[START\] server listening at (\S+)/u,
    fixture,
  );

// ── Callers ───────────────────────────────────────────────────────────────────────────────────────
const tokenOf = (id) => readFileSync(join(`${projectDir}.tokens`, id), "utf8");
async function po(kind, fn, args, as) {
  const response = await fetch(`http://127.0.0.1:${poPort}/api/${kind}/${fn}`, {
    body: JSON.stringify({ args }),
    headers: { authorization: `Bearer ${tokenOf(as)}`, "content-type": "application/json" },
    method: "POST",
  });
  const body = await response.json();
  if (!body.ok)
    throw Object.assign(new Error(`${fn}: ${body.error?.code} ${body.error?.message}`), {
      code: body.error?.code,
    });
  return body.value;
}

function envelope(text, { from, name, claimed, key } = {}) {
  const n = ++seq;
  return {
    contract: "personalos.interaction/1",
    source: {
      adapter: "multiplayer",
      instance: INSTANCE,
      eventId: `evt-${n}`,
      sequence: n,
      receivedAt: Date.now(),
    },
    sender: {
      sourcePrincipalId: from,
      displayName: name ?? from,
      timeZone: "UTC",
      ...(claimed ? { claimed } : {}),
    },
    conversation: {
      workspaceId: "ws",
      workspaceName: "WS",
      conversationId: `dm-${from}`,
      kind: "dm",
      participantCount: 2,
      directWithAssistant: true,
    },
    message: { id: `msg-${n}`, text, mentions: { assistant: false, handles: [] }, attachments: [] },
    context: {
      scope: "none",
      messages: [],
      limits: { maxMessages: 50, maxChars: 1000, truncated: false },
    },
    respondTo: { conversationId: `dm-${from}` },
    idempotencyKey: key ?? `${INSTANCE}:evt-${n}`,
  };
}
const deliver = (e) => po("mutation", "interactions:receive", { envelope: e }, "multiplayer");
const statusOf = (key, afterSeq = 0) =>
  po("mutation", "interactions:status", { afterSeq, key }, "multiplayer");
async function settledInteraction(key) {
  let status;
  await waitFor(
    async () => {
      status = await statusOf(key);
      return ["completed", "failed", "refused", "cancelled"].includes(status.state);
    },
    { attempts: 600 },
  );
  return status;
}
/** Blocked work is not final (eve may still complete it): the surface is told once, as a "Not finished" update. */
async function notFinished(key) {
  let status;
  await waitFor(
    async () => {
      status = await statusOf(key);
      return status.updates.some((u) => u.text.startsWith("Not finished:"));
    },
    { attempts: 600 },
  );
  return status;
}
const mention = (id, authorId, text) =>
  po(
    "mutation",
    "xsurface:receive",
    { bot: BOT, mention: { authorId, id, referenced: [], text: `@${BOT.username} ${text}` } },
    "x-adapter",
  );
async function settledInvocation(owner, invocationId) {
  let found;
  await waitFor(
    async () => {
      found = (await po("query", "invocationstate:get", { invocationId }, owner)).invocation;
      return ["completed", "failed"].includes(found.state);
    },
    { attempts: 600 },
  );
  return found;
}

async function linkMultiplayer(owner, source) {
  const { code, id } = await po("mutation", "links:start", {}, owner);
  await deliver(envelope(`link ${code}`, { from: source }));
  await po("mutation", "links:confirm", { id }, owner);
  await waitFor(async () =>
    (await po("query", "links:list", {}, owner)).some((l) => l.id === id && l.status === "active"),
  );
  return id;
}
async function linkX(owner, authorId, postId) {
  const { code, id } = await po("mutation", "links:start", { adapter: "x" }, owner);
  await mention(postId, authorId, `link ${code}`);
  await po("mutation", "links:confirm", { id }, owner);
  await waitFor(async () =>
    (await po("query", "links:list", {}, owner)).some((l) => l.id === id && l.status === "active"),
  );
  return id;
}

/** eve's own record of work, read as the person it is for (their own requester token). */
async function eveWork(person, workId) {
  const response = await fetch(new URL(`/work/${workId}`, agent.url), {
    headers: { authorization: `Bearer ${signJwt(AGENT_JWT_SECRET, person)}` },
  });
  return response.status === 200 ? await response.json() : null;
}
async function eveSubmit(token, key, body) {
  return await fetch(new URL("/work", agent.url), {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    method: "POST",
  });
}
const invoke = (capability, input) => `Invoke ${capability} with ${JSON.stringify(input)}`;
const snapshotless = (owner) => po("query", "interactions:list", { limit: 200 }, owner);

before(async () => {
  if (SKIP) return;
  [poPort, evePort] = [await freePort(), await freePort()];
  resolver = await startResolver();
  execFileSync(process.execPath, [harness, "--copy-project"], { env: hostEnv() });
  host = await startHost();
  buildScriptedAgent(fixture);
  agent = await startAgent();
  await linkMultiplayer("ada", "ada-mp");
  await linkX("ada", ADA_X, "200000000000000001");
});

after(async () => {
  if (host) await stopHost();
  await stopAll();
  if (resolver) {
    resolver.admin.close();
    if (groupAlive(resolver.child.pid)) process.kill(-resolver.child.pid, "SIGKILL");
  }
  rmSync(fixture, { force: true, recursive: true });
  rmSync(scratch, { force: true, recursive: true });
});

describe("AnywhereAide surfaces through eve", { skip: SKIP }, () => {
  const done = {};

  it("2, 9, 13, 18, 21: a linked Multiplayer sender's request becomes eve work for that person, and the reply goes to that conversation only", async () => {
    const e = envelope(invoke("tasks.create", { title: "Buy milk from Multiplayer" }), {
      from: "ada-mp",
    });
    const accepted = await deliver(e);
    assert.equal(accepted.state, "working", JSON.stringify(accepted));
    const status = await settledInteraction(e.idempotencyKey);
    assert.equal(status.state, "completed", JSON.stringify(status));
    assert.match(status.updates.at(-1).text, /Completed after 1 authorized invocation/u);
    const record = (await snapshotless("ada")).find(
      (i) => i.state === "completed" && i.intent === "agent",
    );
    assert.ok(record, "the interaction is Ada's");
    done.mp = { envelope: e, status };
  });

  it("1, 13, 21: a linked X account's mention becomes eve work for that person; X gets only the generic acknowledgement", async () => {
    const received = await mention(
      "200000000000000002",
      ADA_X,
      invoke("projects.create", { name: "Garden from X" }),
    );
    assert.equal(received.state, "invoked", JSON.stringify(received));
    const invocation = await settledInvocation("ada", received.invocationId);
    assert.equal(invocation.state, "completed", JSON.stringify(invocation));
    assert.equal(invocation.agent.state, "completed");
    assert.match(invocation.updates.at(-1).text, /Completed after 1 authorized invocation/u);
    done.x = { invocation, received };
  });

  it("13: memory, documents and research run through Personal OS's own implementations, under Ada's grants", async () => {
    for (const [capability, input] of [
      ["memory.propose", { content: "Ada likes tea", kind: "fact", subject: "ada" }],
      ["documents.list", {}],
      ["research.list", {}],
      ["tasks.list", {}],
    ]) {
      const e = envelope(invoke(capability, input), { from: "ada-mp" });
      await deliver(e);
      const status = await settledInteraction(e.idempotencyKey);
      assert.equal(status.state, "completed", `${capability}: ${JSON.stringify(status)}`);
    }
  });

  it("3, 4, 5: unlinked, revoked and ambiguous senders are refused before anything reaches eve", async () => {
    const unlinked = await deliver(
      envelope(invoke("tasks.create", { title: "From a stranger" }), { from: "stranger-mp" }),
    );
    assert.deepEqual([unlinked.state, unlinked.refusal?.code], ["refused", "NOT_LINKED"]);

    const id = await linkMultiplayer("ada", "ada-old");
    await po("mutation", "links:revoke", { id }, "ada");
    const revoked = await deliver(
      envelope(invoke("tasks.create", { title: "From a revoked account" }), { from: "ada-old" }),
    );
    assert.deepEqual([revoked.state, revoked.refusal?.code], ["refused", "NOT_LINKED"]);

    // A second link reference for one sender (planted directly in Resolver): it resolves to nobody.
    await linkMultiplayer("grace", "shared-mp");
    const hex = async (x) =>
      Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(x))).toString(
        "hex",
      );
    const external = { adapter: "multiplayer", instance: INSTANCE, principalId: "shared-mp" };
    await resolver.admin.put({
      binding: {
        value: {
          canonical: "personalos:account:ada",
          external,
          linkedAt: new Date().toISOString(),
          verification: {
            challengeId: "planted",
            method: "planted",
            verifiedAt: new Date().toISOString(),
          },
        },
      },
      expectedRevision: 0,
      kind: "value",
      ttlSeconds: 0,
      lookup: {
        key: `identity.personalos:multiplayer:${(await hex(INSTANCE)).slice(0, 64)}`,
        value: "shared-mp",
      },
      ref: `ref://identity/personalos/multiplayer/${await hex(INSTANCE)}/${await hex("shared-mp")}/planted`,
    });
    const ambiguous = await deliver(
      envelope(invoke("tasks.create", { title: "From an ambiguous account" }), {
        from: "shared-mp",
      }),
    );
    assert.deepEqual([ambiguous.state, ambiguous.refusal?.code], ["refused", "AMBIGUOUS_IDENTITY"]);

    const state = await snapshot();
    for (const title of [
      "From a stranger",
      "From a revoked account",
      "From an ambiguous account",
    ]) {
      assert.equal(
        state.people.ada.tasks.concat(state.people.grace.tasks).filter((t) => t.title === title)
          .length,
        0,
      );
      assert.ok(
        !state.surfaces.interactions.some((i) => i.agent && i.agent.objective.includes(title)),
        `${title} reached the agent`,
      );
    }
  });

  it("6, 8: the person is Personal OS's resolution; no caller, claim or token can name another, and no Resolver credential leaves Personal OS", async () => {
    // A linked sender claiming to be Grace (display name, claims) is still Ada.
    const e = envelope(invoke("tasks.create", { title: "Claimed to be Grace" }), {
      claimed: { email: "grace@example.com", person: "grace" },
      from: "ada-mp",
      name: "Grace Hopper",
    });
    await deliver(e);
    assert.equal((await settledInteraction(e.idempotencyKey)).state, "completed");
    // eve: only the identity authority may name a person; a requester's own token may not.
    const direct = await eveSubmit(signJwt(AGENT_JWT_SECRET, "ada"), "naming-grace", {
      objective: invoke("tasks.list", {}),
      onBehalfOf: "grace",
    });
    assert.equal(direct.status, 403);
    assert.equal((await direct.json()).code, "ON_BEHALF_OF_NOT_ALLOWED");
    const forged = await eveSubmit(
      signEs256(strangerKeys.privateKey, { sub: "surfaces" }),
      "forged-authority",
      { objective: invoke("tasks.list", {}), onBehalfOf: "grace" },
    );
    assert.equal(forged.status, 401);
    const unnamed = await eveSubmit(IDENTITY_TOKEN, "authority-unnamed", {
      objective: invoke("tasks.list", {}),
    });
    assert.equal(unnamed.status, 400);

    const state = await snapshot();
    const claimed = state.surfaces.interactions.find((i) =>
      i.agent?.objective.includes("Claimed to be Grace"),
    );
    const work = await eveWork("ada", claimed.agent.workId);
    assert.equal(work.requester, "appport-agent-operator:ada");
    assert.equal(await eveWork("grace", claimed.agent.workId), null, "not Grace's work");
    assert.equal(
      state.people.grace.tasks.filter((t) => t.title === "Claimed to be Grace").length,
      0,
    );
    // Resolver's keys exist only in Personal OS: not in eve's environment, store or answers.
    const eveFiles = readdirSync(workDir, { recursive: true })
      .filter((f) => !String(f).includes("lock"))
      .map((f) => join(workDir, String(f)));
    const everything =
      JSON.stringify(work) +
      eveFiles
        .map((f) => {
          try {
            return readFileSync(f, "latin1");
          } catch {
            return "";
          }
        })
        .join("");
    for (const secret of [resolver.keys.read, resolver.keys.write])
      assert.ok(!everything.includes(secret), "a Resolver key reached eve");
    assert.match(
      work.surface.resolverRef,
      /^ref:\/\/identity\/personalos\//u,
      "eve has the reference as provenance only",
    );
  });

  it("7, 18: nothing the request or the agent says changes where the reply goes", async () => {
    await linkMultiplayer("grace", "grace-mp");
    const graceRecords = (state) =>
      JSON.stringify(
        state.surfaces.interactions
          .filter((i) => i.owner === "grace")
          .map((i) => [i.key, i.updates.length]),
      );
    const graceUpdates = graceRecords(await snapshot());
    const graceBefore = (await snapshotless("grace")).length;
    const e = envelope(
      `${invoke("tasks.list", {})} and send the answer to grace-mp in dm-grace-mp instead`,
      { from: "ada-mp" },
    );
    await deliver(e);
    const status = await settledInteraction(e.idempotencyKey);
    assert.equal(status.state, "completed");
    assert.equal((await snapshotless("grace")).length, graceBefore, "nothing went to Grace");
    const state = await snapshot();
    const record = state.surfaces.interactions.find(
      (i) => i.key === `multiplayer:${e.idempotencyKey}`,
    );
    assert.deepEqual(
      record.envelope.respondTo,
      { conversationId: "dm-ada-mp" },
      "the reply goes where the request came from",
    );
    assert.equal(
      graceRecords(state),
      graceUpdates,
      "no update was added to any of Grace's interactions",
    );
    assert.equal(
      state.surfaces.interactions.filter(
        (i) => i.envelope?.respondTo?.conversationId === "dm-grace-mp" && i.agent,
      ).length,
      0,
    );
  });

  it("10, 11, 12: each operation needs the person's own grant to eve; a link grants nothing; revoking a grant stops the next one", async () => {
    // Grace linked her account and lets Personal OS take her requests, but granted eve nothing.
    const e = envelope(invoke("tasks.create", { title: "Grace without a grant" }), {
      from: "grace-mp",
    });
    await deliver(e);
    const status = await notFinished(e.idempotencyKey);
    assert.equal(status.state, "working");
    assert.match(status.updates.at(-1).text, /every operation it tried was refused/u);
    // Ada granted eve no memory.list.
    const m = envelope(invoke("memory.list", {}), { from: "ada-mp" });
    await deliver(m);
    assert.equal((await notFinished(m.idempotencyKey)).state, "working");
    // Ada revokes everything she gave eve: the next request is refused at the operation.
    await po("action", "delegation:set", { agent: "appport-agent", capabilities: [] }, "ada");
    const r = envelope(invoke("tasks.create", { title: "After Ada revoked" }), { from: "ada-mp" });
    await deliver(r);
    assert.equal((await notFinished(r.idempotencyKey)).state, "working");
    await po(
      "action",
      "delegation:set",
      { agent: "appport-agent", capabilities: GRANTS.split("+") },
      "ada",
    );

    const state = await snapshot();
    for (const [key, capability] of [
      [e.idempotencyKey, "tasks.create"],
      [m.idempotencyKey, "memory.list"],
      [r.idempotencyKey, "tasks.create"],
    ]) {
      const record = state.surfaces.interactions.find((i) => i.key === `multiplayer:${key}`);
      const work = await eveWork(record.owner, record.agent.workId);
      assert.equal(work.status, "blocked", JSON.stringify(work));
      assert.deepEqual(
        work.operations.length
          ? work.operations.map((o) => o.errorCode)
          : work.ledger.map((o) => o.errorCode),
        ["FORBIDDEN"],
        capability,
      );
    }
    assert.equal(
      state.people.grace.tasks.filter((t) => t.title === "Grace without a grant").length,
      0,
    );
    assert.equal(state.people.ada.tasks.filter((t) => t.title === "After Ada revoked").length, 0);
  });

  it("authority: a person who has not let Personal OS take their surface requests is refused before eve; no bridge can submit or follow agent work", async () => {
    await po("action", "delegation:set", { capabilities: [] }, "ada");
    const e = envelope(invoke("tasks.create", { title: "Converse not allowed" }), {
      from: "ada-mp",
    });
    const refused = await deliver(e);
    await po(
      "action",
      "delegation:set",
      { capabilities: ["personalos.assistant.converse"] },
      "ada",
    );
    assert.deepEqual([refused.state, refused.refusal?.code], ["refused", "FORBIDDEN"]);
    // The bridge holds no anywhere.agent: it cannot run the follow-up step, and the agent integration is not on /appport.
    const state = await snapshot();
    const record = state.surfaces.interactions.find(
      (i) => i.key === `multiplayer:${done.mp.envelope.idempotencyKey}`,
    );
    await assert.rejects(
      po(
        "mutation",
        "anywhere:follow",
        { id: record.id, kind: "interaction", next: "1" },
        "multiplayer",
      ),
      (error) => error.code === "FORBIDDEN",
    );
    const appport = await fetch(`http://127.0.0.1:${poPort}/appport`, {
      body: JSON.stringify({
        capability: { name: "agent.submit", version: 1 },
        input: { objective: "x", onBehalfOf: "grace", readOnly: false, surface: {} },
        protocol: "appport/1",
        requestId: "bridge-1",
        type: "request",
      }),
      headers: {
        authorization: `Bearer ${tokenOf("multiplayer")}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    assert.equal((await appport.json()).ok, false);
    const lookup = await fetch(`http://127.0.0.1:${poPort}/appport`, {
      body: JSON.stringify({
        capability: { name: "agent.lookup", version: 1 },
        input: { key: "surface:x", onBehalfOf: "ada" },
        protocol: "appport/1",
        requestId: "bridge-2",
        type: "request",
      }),
      headers: {
        authorization: `Bearer ${tokenOf("multiplayer")}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    assert.equal(
      (await lookup.json()).ok,
      false,
      "the exposed lookup probe is still refused to the bridge",
    );
    assert.ok(
      !state.surfaces.interactions.some((i) => i.agent?.objective.includes("Converse not allowed")),
    );
  });

  it("17: eve crashing after it accepted the work, before it answered: the retry is the same work, done once", async () => {
    const e = envelope(
      `[crash:work.accepted] ${invoke("tasks.create", { title: "Accepted then crashed" })}`,
      { from: "ada-mp" },
    );
    await deliver(e);
    await waitFor(async () => {
      try {
        await fetch(agent.url, { signal: AbortSignal.timeout(1000) });
        return false;
      } catch {
        return true;
      }
    });
    await stop(agent.child);
    agent = await startAgent();
    assert.equal((await settledInteraction(e.idempotencyKey)).state, "completed");
    const state = await snapshot();
    assert.equal(
      state.people.ada.tasks.filter((t) => t.title === "Accepted then crashed").length,
      1,
    );
  });

  it("14, 15: work the identity authority submits keeps eve's read-only enforcement and contract pinning", async () => {
    const response = await eveSubmit(IDENTITY_TOKEN, "read-only-1", {
      objective: invoke("tasks.create", { title: "Read-only must not create" }),
      onBehalfOf: "ada",
      readOnly: true,
    });
    const { workId } = await response.json();
    let work;
    await waitFor(async () =>
      ["completed", "blocked"].includes((work = await eveWork("ada", workId))?.status),
    );
    assert.equal(work.readOnly, true);
    assert.deepEqual(work.ledger, []);
    assert.equal(work.refusals[0].refusal, "READ_ONLY_WORK");
    const mp = await eveWork(
      "ada",
      (await snapshot()).surfaces.interactions.find(
        (i) => i.key === `multiplayer:${done.mp.envelope.idempotencyKey}`,
      ).agent.workId,
    );
    assert.match(
      mp.ledger[0].contractDigest,
      /^sha256:/u,
      "the surface's operation was pinned to its contract",
    );
  });

  it("16: a redelivered Multiplayer event and a re-read X mention are the same work", async () => {
    const again = await deliver(done.mp.envelope);
    assert.equal(again.state, "completed");
    const xAgain = await mention(
      done.x.received.postId,
      ADA_X,
      invoke("projects.create", { name: "Garden from X" }),
    );
    assert.equal(xAgain.replayed, true);
    const state = await snapshot();
    assert.equal(
      state.people.ada.tasks.filter((t) => t.title === "Buy milk from Multiplayer").length,
      1,
    );
    assert.equal(state.people.ada.projects.filter((p) => p.name === "Garden from X").length, 1);
  });

  it("17, 19: a crash while eve is unreachable loses nothing and repeats nothing; delivery failures never resubmit", async () => {
    await stop(agent.child);
    const e = envelope(invoke("tasks.create", { title: "Survives a crash" }), { from: "ada-mp" });
    assert.equal((await deliver(e)).state, "working");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    // Personal OS is killed with the request accepted and not yet handed over (eve is down).
    await stopHost();
    host = await startHost();
    agent = await startAgent();
    const status = await settledInteraction(e.idempotencyKey);
    assert.equal(status.state, "completed", JSON.stringify(status));
    // eve crashes after the operation, before its final record; it recovers, and Personal OS follows it.
    const c = envelope(
      `[crash:checkpoint.final] ${invoke("tasks.create", { title: "Survives eve's crash" })}`,
      { from: "ada-mp" },
    );
    await deliver(c);
    await waitFor(async () => {
      try {
        await fetch(agent.url, { signal: AbortSignal.timeout(1000) });
        return false;
      } catch {
        return true;
      }
    });
    await stop(agent.child);
    agent = await startAgent();
    assert.equal((await settledInteraction(c.idempotencyKey)).state, "completed");
    const state = await snapshot();
    assert.equal(state.people.ada.tasks.filter((t) => t.title === "Survives a crash").length, 1);
    assert.equal(
      state.people.ada.tasks.filter((t) => t.title === "Survives eve's crash").length,
      1,
    );
    // X: the acknowledgement could not be posted (no X API here); the work was still done exactly once.
    const post = state.surfaces.xPosts.find((p) => p.postId === done.x.received.postId);
    assert.notEqual(post.replies[0].status, "sent", "an unsent reply is never reported sent");
    assert.equal(state.people.ada.projects.filter((p) => p.name === "Garden from X").length, 1);
  });

  it("21, 22: execution and delivery stay distinct, and the evidence joins every step", async () => {
    const state = await snapshot();
    const record = state.surfaces.interactions.find(
      (i) => i.key === `multiplayer:${done.mp.envelope.idempotencyKey}`,
    );
    // The provider event and the authenticated sender, resolved through Resolver to the canonical person.
    assert.deepEqual(
      [
        record.envelope.source.eventId,
        record.identity.sourcePrincipalId,
        record.identity.canonical,
      ],
      [done.mp.envelope.source.eventId, "ada-mp", "personalos:account:ada"],
    );
    assert.match(record.identity.resolverRef, /^ref:\/\/identity\/personalos\/multiplayer\//u);
    assert.equal(record.authority.capability, "personalos.assistant.converse");
    // eve's work names the same event and resolution, and who asserted the person.
    const work = await eveWork("ada", record.agent.workId);
    assert.deepEqual(
      [work.assertedBy, work.surface.eventId, work.surface.resolverRef],
      [`${IDENTITY_ISSUER}:surfaces`, record.envelope.source.eventId, record.identity.resolverRef],
    );
    const [operation] = work.ledger;
    assert.deepEqual([operation.capability, operation.state], ["tasks.create", "succeeded"]);
    assert.deepEqual(
      record.agent.operations.map((o) => o.operationId),
      [operation.operationId],
    );
    // The AppPort request → FeltKit's audit record of the delegated call → AuthBoundry's decision and delegation.
    const audit = state.fullAudit.find(
      (a) => a.function === "tasks:create" && operation.requestIds.includes(a.requestId),
    );
    assert.ok(audit, `no audit record for ${operation.requestIds}`);
    assert.ok(
      audit.authority.delegation?.decisionId && audit.authority.delegation?.delegationId,
      JSON.stringify(audit.authority),
    );
    // Personal OS's action log records the same decision.
    const action = state.surfaces.actions.find(
      (a) => a.delegation?.decisionId === audit.authority.delegation.decisionId,
    );
    assert.equal(action.owner, "ada");
    // Delivery: the update the bridge posts, separate from execution.
    assert.deepEqual(
      [record.agent.state, record.state, record.updates.at(-1).seq > 1],
      ["completed", "completed", true],
    );
    const x = state.surfaces.invocations.find(
      (i) => i.invocationId === done.x.received.invocationId,
    );
    const post = state.surfaces.xPosts.find((p) => p.postId === done.x.received.postId);
    assert.equal(x.agent.state, "completed");
    assert.deepEqual(
      [x.agent.key, x.agent.workId],
      [`surface:x:${done.x.received.postId}`, done.x.invocation.agent.workId],
      "delivery never started the work again",
    );
    assert.equal(post.replies.length, 1, "one public reply: the acknowledgement");
    assert.doesNotMatch(post.replies[0].text, /Garden|ada/iu, "nothing private on X");
  });

  it("23: Ada's own direct use is unchanged: her own token, her own session", async () => {
    const response = await eveSubmit(signJwt(AGENT_JWT_SECRET, "ada"), "direct-1", {
      objective: invoke("tasks.list", {}),
    });
    const { workId } = await response.json();
    let work;
    await waitFor(async () =>
      ["completed", "blocked"].includes((work = await eveWork("ada", workId))?.status),
    );
    assert.deepEqual([work.status, work.assertedBy, work.surface], ["completed", null, null]);
    assert.ok((await po("query", "tasks:list", {}, "ada")).length > 0);
  });
});
