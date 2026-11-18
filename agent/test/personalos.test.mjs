import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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

// This agent lives in PersonalOS (agent/): its PersonalOS is the repository it is in, unless named.
const personalos = process.env.PERSONALOS_DIR ?? fileURLToPath(new URL("../..", import.meta.url));
const SKIP =
  personalos &&
  existsSync(join(personalos, "node_modules/@feltdb/feltkit/dist/runtime/delegation.js")) &&
  existsSync(join(personalos, "feltkit/delegation.ts"))
    ? false
    : "set PERSONALOS_DIR to a Personal OS checkout with agent delegation, its dependencies installed and a FeltKit with delegated /appport";

const scratch = mkdtempSync(join(tmpdir(), "appport-personalos-"));
const fixture = join(root, ".personalos-agent");
const workDir = join(scratch, "work");
const credentialFile = join(scratch, "agent-session");
const crashFile = join(scratch, "crash-after-commit");
const AGENT_JWT_SECRET = "personalos-agent-jwt-secret-0123456789abcdef";
const port = 6600 + Math.floor(Math.random() * 300);
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const TODAY = day(0);
const TOMORROW = day(1);
const READ = "tasks.list+briefing.today";
const WRITE = `${READ}+tasks.create+tasks.update+tasks.complete`;

let agent;
let host;

// The web search provider research calls, as a stand-in owned by the test (the Brave Search API's shape):
// every request is counted, and a request can be held while the test acts.
const SEARCH_KEY = "brave_test_key_0123456789abcdef";
const searchProvider = { hold: null, requests: [], url: "" };
const searchServer = createServer(async (request, response) => {
  searchProvider.requests.push(new URL(request.url, "http://x").searchParams.get("q") ?? "");
  if (searchProvider.hold) await searchProvider.hold(searchProvider.requests.length);
  if (request.headers["x-subscription-token"] !== SEARCH_KEY) return response.writeHead(401).end();
  response.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({
      query: {},
      type: "search",
      web: {
        results: [
          {
            description: "Acme Ops builds internal tools in TypeScript.",
            title: "Acme Ops",
            url: "https://www.acme-ops.com/",
          },
        ],
      },
    }),
  );
});

const hostEnv = (extra = {}) =>
  cleanEnv({
    APPPORT_AGENT_CREDENTIAL_FILE: credentialFile,
    FELTKIT_CREDENTIAL_WEBSEARCH: SEARCH_KEY,
    NODE_ENV: "development",
    PERSONALOS_CRASH_FILE: crashFile,
    PERSONALOS_DIR: personalos,
    PERSONALOS_PORT: String(port),
    PERSONALOS_PROJECT_DIR: join(scratch, "personalos"),
    PERSONALOS_PAGE_STUB: "1",
    PERSONALOS_TODAY: TODAY,
    PERSONALOS_WORKER_MS: "200",
    WEBSEARCH_URL: searchProvider.url,
    ...extra,
  });
const harness = join(root, "test/personalos-host.mjs");
const startHost = (grants, extra = {}) =>
  startProcess(
    process.execPath,
    [harness],
    hostEnv({ ...(grants === undefined ? {} : { PERSONALOS_GRANTS: grants }), ...extra }),
    /\[personalos-host\] listening at (\S+)/u,
  );
const report = (extra) =>
  JSON.parse(
    execFileSync(process.execPath, [harness, "--report"], {
      env: hostEnv(extra),
      encoding: "utf8",
    }),
  );

async function stopHost() {
  await stop(host.child);
  const pids = join(scratch, "personalos.authority-pids");
  for (const pid of existsSync(pids)
    ? readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number)
    : []) {
    if (groupAlive(pid)) process.kill(-pid, "SIGKILL");
    await waitFor(() => !groupAlive(pid));
  }
}

async function restartHost(grants, extra) {
  await stopHost();
  host = await startHost(grants, extra);
}

async function snapshot(extra) {
  await stopHost();
  try {
    return report(extra);
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
      APPPORT_AGENT_CAPABILITIES:
        "tasks.list,tasks.create,tasks.update,tasks.complete,tasks.reopen,tasks.delete,briefing.today,memory.list,memory.propose,memory.add,memory.confirm,projects.list,projects.create,projects.update,documents.list,documents.update,documents.link,research.start,research.list,research.get,research.cancel,research.retry",
      APPPORT_AGENT_CREDENTIAL_FILE: credentialFile,
      APPPORT_AGENT_OPERATOR: "appport-agent-operator:operator",
      APPPORT_AGENT_WORK_DIR: workDir,
      APPPORT_ON_BEHALF_OF: "subject",
      APPPORT_URL: `http://127.0.0.1:${port}/appport`,
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

async function work(person, key, objective) {
  const response = await fetch(new URL("/work", agent.url), {
    body: JSON.stringify({ objective }),
    headers: {
      authorization: `Bearer ${signJwt(AGENT_JWT_SECRET, person)}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    method: "POST",
  });
  const { workId } = await response.json();
  return await outcome(person, workId);
}

async function outcome(person, workId) {
  let result;
  await waitFor(async () => {
    const response = await fetch(new URL(`/work/${workId}`, agent.url), {
      headers: { authorization: `Bearer ${signJwt(AGENT_JWT_SECRET, person)}` },
    });
    result = await response.json();
    return result.status === "completed" || result.status === "blocked";
  });
  return result;
}

const invoke = (capability, input) => `Invoke ${capability} with ${JSON.stringify(input)}`;

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

const titled = (state, owner, title) =>
  state.people[owner].tasks.filter((task) => task.title === title);

before(async () => {
  if (SKIP) return;
  await new Promise((resolve) => searchServer.listen(0, "127.0.0.1", resolve));
  searchProvider.url = `http://127.0.0.1:${searchServer.address().port}`;
  execFileSync(process.execPath, [harness, "--copy-project"], { env: hostEnv() });
  // Ada is signed in somewhere (her phone): FeltKit runs her durable work, reminders included, only while she has a session.
  host = await startHost(`ada=${READ}`, { PERSONALOS_SIGNED_IN: "ada" });
  buildScriptedAgent(fixture);
  agent = await startAgent();
});

after(async () => {
  searchServer.closeAllConnections?.();
  searchServer.close();
  if (host) await stopHost();
  await stopAll();
  rmSync(fixture, { force: true, recursive: true });
  rmSync(scratch, { force: true, recursive: true });
});

describe("eve managing Ada's Personal OS tasks under her delegation", { skip: SKIP }, () => {
  let dentist;
  let rent;

  it("lists Ada's tasks with a read grant, and cannot create with it", async () => {
    const listed = await work("ada", "list-1", invoke("tasks.list", {}));
    assert.equal(listed.status, "completed", JSON.stringify(listed));
    const denied = await work("ada", "create-denied", invoke("tasks.create", { title: "Not yet" }));
    assert.equal(denied.operations[0].errorCode, "FORBIDDEN");
    const state = await snapshot();
    assert.equal(titled(state, "ada", "Not yet").length, 0, "nothing created");
  });

  it("creates a task with a reminder in Ada's space, once for a repeated call, through Personal OS's own code", async () => {
    await restartHost(`ada=${WRITE}`);
    const input = {
      due: TOMORROW,
      reminder: true,
      time: "10:00",
      title: "Call the dentist",
      tzOffset: 0,
    };
    const created = await work("ada", "create-1", `[repeat] ${invoke("tasks.create", input)}`);
    assert.equal(created.status, "completed", JSON.stringify(created));
    assert.equal(created.operations.length, 1);
    assert.equal(created.operations[0].requestIds.length, 1, "one request for the repeated call");

    const state = await snapshot();
    [dentist] = titled(state, "ada", "Call the dentist");
    assert.equal(titled(state, "ada", "Call the dentist").length, 1);
    assert.deepEqual([dentist.owner, dentist.due, dentist.remindTime], ["ada", TOMORROW, "10:00"]);
    assert.deepEqual(
      state.reminders.filter((job) => job.taskId === dentist.id),
      [{ principal: "ada", status: "scheduled", taskId: dentist.id }],
      "one reminder job, queued by Personal OS as Ada",
    );
    const action = state.people.ada.actions.find((entry) => entry.evidence?.id === dentist.id);
    assert.deepEqual(
      [
        action.kind,
        action.status,
        action.via,
        action.evidence.verified,
        action.delegation.agent,
        action.delegation.capability,
      ],
      ["reminder.create", "succeeded", "agent", true, "appport-agent", "tasks.create"],
    );
    const audit = state.audit.find(
      (entry) => entry.authority.delegation?.decisionId === action.delegation.decisionId,
    );
    assert.equal(
      audit.requestId,
      created.operations[0].requestIds[0],
      "eve's operation, FeltKit's audit and Personal OS's action are one chain",
    );
    assert.equal(audit.authority.delegation.delegationId, action.delegation.delegationId);
  });

  it("updates and completes with those grants; the briefing reflects it", async () => {
    const moved = await work(
      "ada",
      "update-1",
      invoke("tasks.update", { id: dentist.id, notes: "Ask about the bill" }),
    );
    assert.equal(moved.status, "completed", JSON.stringify(moved));
    const rentWork = await work(
      "ada",
      "create-rent",
      invoke("tasks.create", { due: TODAY, title: "Pay rent" }),
    );
    assert.equal(rentWork.status, "completed");
    const briefing = await work("ada", "brief-1", invoke("briefing.today", { today: TODAY }));
    assert.match(briefing.summary, /Pay rent/u, "the briefing eve read shows the task eve added");

    let state = await snapshot();
    [rent] = titled(state, "ada", "Pay rent");
    assert.equal(titled(state, "ada", "Call the dentist")[0].notes, "Ask about the bill");
    assert.ok(state.people.ada.briefing.dueToday.some((task) => task.id === rent.id));

    const done = await work("ada", "complete-1", invoke("tasks.complete", { id: rent.id }));
    assert.equal(done.status, "completed");
    state = await snapshot();
    assert.equal(titled(state, "ada", "Pay rent")[0].status, "done");
    assert.ok(
      !state.people.ada.briefing.dueToday.some((task) => task.id === rent.id),
      "done is gone from today",
    );
  });

  it("reopens only once reopen is delegated, and never deletes", async () => {
    const denied = await work("ada", "reopen-denied", invoke("tasks.reopen", { id: rent.id }));
    assert.equal(denied.operations[0].errorCode, "FORBIDDEN");
    await restartHost(`ada=${WRITE}+tasks.reopen`);
    const reopened = await work("ada", "reopen-1", invoke("tasks.reopen", { id: rent.id }));
    assert.equal(reopened.status, "completed", JSON.stringify(reopened));
    const deletion = await work("ada", "delete-1", invoke("tasks.delete", { id: rent.id }));
    assert.equal(deletion.status, "blocked");
    assert.deepEqual(deletion.operations, [], "no operation: tasks.delete is not a capability");
    const state = await snapshot();
    assert.equal(titled(state, "ada", "Pay rent")[0].status, "open");
  });

  it("never reaches Ada's tasks for Grace", async () => {
    const listed = await work("grace", "grace-list", invoke("tasks.list", {}));
    assert.equal(listed.operations[0].errorCode, "FORBIDDEN", "Grace delegated nothing");
    await restartHost(`ada=${WRITE}+tasks.reopen;grace=tasks.complete`);
    const reach = await work("grace", "grace-reach", invoke("tasks.complete", { id: dentist.id }));
    assert.equal(reach.operations[0].errorCode, "NOT_FOUND", "Ada's task does not exist for Grace");
    const state = await snapshot();
    assert.equal(titled(state, "ada", "Call the dentist")[0].status, "open");
  });

  it("adds once when eve crashes after Personal OS committed, and Personal OS restarts too", async () => {
    const response = await fetch(new URL("/work", agent.url), {
      body: JSON.stringify({
        objective: `[crash:invocation.record] ${invoke("tasks.create", { title: "Renew passport" })}`,
      }),
      headers: {
        authorization: `Bearer ${signJwt(AGENT_JWT_SECRET, "ada")}`,
        "content-type": "application/json",
        "idempotency-key": "crash-1",
      },
      method: "POST",
    });
    const { workId } = await response.json();
    await waitFor(async () => !(await reachable()));
    await stop(agent.child);
    await restartHost();
    agent = await startAgent();
    assert.equal((await outcome("ada", workId)).status, "completed");
    const [operation] = await ledger(workId);
    assert.deepEqual([operation.state, operation.attempts], ["succeeded", 2]);
    const state = await snapshot();
    assert.equal(titled(state, "ada", "Renew passport").length, 1);
  });

  it("leaves an operation indeterminate when Personal OS died before recording its answer, and never sends it again", async () => {
    writeFileSync(crashFile, "next idempotency record");
    const response = await fetch(new URL("/work", agent.url), {
      body: JSON.stringify({
        objective: `[crash:invocation.record] ${invoke("tasks.create", { title: "Book flights" })}`,
      }),
      headers: {
        authorization: `Bearer ${signJwt(AGENT_JWT_SECRET, "ada")}`,
        "content-type": "application/json",
        "idempotency-key": "uncertain-1",
      },
      method: "POST",
    });
    const { workId } = await response.json();
    await waitFor(async () => !(await reachable()));
    await stop(agent.child);
    await restartHost();
    agent = await startAgent();
    const blocked = await outcome("ada", workId);
    assert.equal(blocked.status, "blocked");
    assert.match(blocked.decisions.at(-1), /^indeterminate: /u);
    const [operation] = await ledger(workId);
    assert.equal(operation.state, "indeterminate");
    assert.equal(operation.outcome.error.reason, "IDEMPOTENCY_OUTCOME_UNKNOWN");
    const reconcile = await fetch(new URL("/work/reconcile", agent.url), {
      headers: { authorization: `Bearer ${signJwt(AGENT_JWT_SECRET, "operator")}` },
      method: "POST",
    });
    assert.equal(reconcile.status, 200);
    const [after] = await ledger(workId);
    assert.deepEqual(
      [after.state, after.request_ids],
      ["indeterminate", operation.request_ids],
      "nothing sent again",
    );
    const state = await snapshot();
    assert.equal(
      titled(state, "ada", "Book flights").length,
      1,
      "the effect happened exactly once",
    );
  });

  it("stops after Ada revokes", async () => {
    await restartHost("ada=");
    const denied = await work("ada", "after-revoke", invoke("tasks.list", {}));
    assert.equal(denied.operations[0].errorCode, "FORBIDDEN");
  });

  it("fires Ada's reminder through Personal OS's own job, with eve stopped", async () => {
    await stop(agent.child);
    const state = await snapshot({ PERSONALOS_FIRE_REMINDERS: "1" });
    agent = await startAgent();
    assert.deepEqual(
      state.people.ada.inbox.map((entry) => [entry.type, entry.title]),
      [["reminder.due", "Call the dentist"]],
    );
    const fired = state.people.ada.actions.find((entry) => entry.kind === "reminder.fire");
    assert.deepEqual([fired.via, fired.delegation], ["job", undefined]);
    assert.ok(
      state.people.ada.actions
        .filter((entry) => entry.via === "agent")
        .every((entry) => entry.delegation.agent === "appport-agent"),
    );
    assert.deepEqual(state.people.grace.tasks, []);
  });
});

describe(
  "eve reading Ada's Personal OS memory and proposing notes she confirms",
  { skip: SKIP },
  () => {
    const fact = (content) => ({ content, kind: "fact", subject: "ada" });
    const asPerson = async (person, fn, args) => {
      const token = readFileSync(join(scratch, "personalos.tokens", person), "utf8");
      const response = await fetch(`http://127.0.0.1:${port}/api/mutation/${fn}`, {
        body: JSON.stringify({ args }),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        method: "POST",
      });
      return await response.json();
    };
    const memory = (state, content) =>
      state.people.ada.memories.find((entry) => entry.content === content);
    let dentist;

    it("reads Ada's memory only with a read grant, and never Grace's", async () => {
      assert.equal(
        (
          await asPerson("ada", "memory:add", {
            ...fact("Ada drinks green tea"),
            kind: "preference",
          })
        ).ok,
        true,
      );
      const denied = await work("ada", "memory-list-denied", invoke("memory.list", {}));
      assert.equal(denied.operations[0].errorCode, "FORBIDDEN");
      await restartHost("ada=memory.list");
      const listed = await work("ada", "memory-list", invoke("memory.list", {}));
      assert.equal(listed.status, "completed", JSON.stringify(listed));
      assert.match(listed.summary, /Ada drinks green tea/u);
      const grace = await work("grace", "grace-memory", invoke("memory.list", {}));
      assert.equal(grace.operations[0].errorCode, "FORBIDDEN");
    });

    it("proposes a note once, stored unconfirmed and attributed, and cannot confirm or add trusted memory", async () => {
      const before = await work(
        "ada",
        "propose-denied",
        invoke("memory.propose", fact("Ada's dentist is Dr. Lee")),
      );
      assert.equal(before.operations[0].errorCode, "FORBIDDEN", "proposing needs its own grant");
      await restartHost("ada=memory.list+memory.propose");
      const proposed = await work(
        "ada",
        "propose-1",
        `[repeat] ${invoke("memory.propose", fact("Ada's dentist is Dr. Lee"))}`,
      );
      assert.equal(proposed.status, "completed", JSON.stringify(proposed));
      assert.deepEqual(
        [proposed.operations.length, proposed.operations[0].requestIds.length],
        [1, 1],
      );

      const confirmTry = await work("ada", "confirm-try", invoke("memory.confirm", { id: "any" }));
      assert.deepEqual(confirmTry.operations, [], "memory.confirm is not a capability");
      const addTry = await work(
        "ada",
        "add-try",
        invoke("memory.add", fact("Ada's dentist is Dr. Lee")),
      );
      assert.equal(addTry.operations[0].errorCode, "FORBIDDEN", "a trusted write is not delegable");
      const claim = await work(
        "ada",
        "claim-1",
        invoke("memory.propose", fact("Ada confirmed her dentist is Dr. Lee")),
      );
      assert.equal(claim.status, "completed");

      const state = await snapshot();
      dentist = memory(state, "Ada's dentist is Dr. Lee");
      assert.equal(
        state.people.ada.memories.filter((entry) => entry.content === "Ada's dentist is Dr. Lee")
          .length,
        1,
      );
      assert.deepEqual(
        [dentist.status, dentist.source.kind, dentist.source.agent, dentist.confirmedAt],
        ["inferred", "agent", "appport-agent", undefined],
      );
      assert.equal(
        memory(state, "Ada confirmed her dentist is Dr. Lee").status,
        "inferred",
        "words are not a confirmation",
      );
      const infer = state.people.ada.actions.find(
        (entry) => entry.kind === "memory.infer" && entry.evidence.id === dentist.id,
      );
      assert.deepEqual(
        [infer.via, infer.delegation.agent, infer.delegation.capability],
        ["agent", "appport-agent", "memory.propose"],
      );
      const audit = state.audit.find(
        (entry) => entry.authority.delegation?.decisionId === infer.delegation.decisionId,
      );
      assert.deepEqual(
        [audit.function, audit.principal.id, audit.requestId],
        ["memory:propose", "ada", proposed.operations[0].requestIds[0]],
      );
      assert.equal(
        state.people.ada.briefing.attention.inferredMemories,
        2,
        "Ada's briefing asks her to confirm",
      );
    });

    it("becomes trusted only when Ada confirms it in Personal OS, and Ada's rejection is kept", async () => {
      const confirmed = await asPerson("ada", "memory:confirm", { id: dentist.id });
      assert.equal(confirmed.ok, true, JSON.stringify(confirmed));
      const listed = await work("ada", "memory-list-2", invoke("memory.list", {}));
      assert.match(
        listed.summary,
        new RegExp(`"id":"${dentist.id}"[^}]*"status":"confirmed"`, "u"),
      );

      await work("ada", "propose-2", invoke("memory.propose", fact("Ada hates mornings")));
      let state = await snapshot();
      const mornings = memory(state, "Ada hates mornings");
      assert.equal((await asPerson("ada", "memory:remove", { id: mornings.id })).ok, true);
      state = await snapshot();
      assert.equal(memory(state, "Ada hates mornings"), undefined);
      const dropped = state.people.ada.actions.find(
        (entry) => entry.kind === "memory.forget" && entry.evidence.id === mornings.id,
      );
      assert.deepEqual([dropped.via, dropped.input.content], ["ui", "Ada hates mornings"]);
      const trusted = memory(state, "Ada's dentist is Dr. Lee");
      assert.equal(trusted.status, "confirmed");
      const byAda = state.people.ada.actions.find(
        (entry) => entry.kind === "memory.confirm" && entry.evidence.id === dentist.id,
      );
      assert.deepEqual([byAda.via, byAda.delegation], ["ui", undefined]);
    });

    it("proposes once when eve crashes after Personal OS committed, and Personal OS restarts too", async () => {
      const response = await fetch(new URL("/work", agent.url), {
        body: JSON.stringify({
          objective: `[crash:invocation.record] ${invoke("memory.propose", fact("Ada is allergic to penicillin"))}`,
        }),
        headers: {
          authorization: `Bearer ${signJwt(AGENT_JWT_SECRET, "ada")}`,
          "content-type": "application/json",
          "idempotency-key": "memory-crash",
        },
        method: "POST",
      });
      const { workId } = await response.json();
      await waitFor(async () => !(await reachable()));
      await stop(agent.child);
      await restartHost();
      agent = await startAgent();
      assert.equal((await outcome("ada", workId)).status, "completed");
      const [operation] = await ledger(workId);
      assert.deepEqual([operation.state, operation.attempts], ["succeeded", 2]);
      const state = await snapshot();
      const penicillin = state.people.ada.memories.filter(
        (entry) => entry.content === "Ada is allergic to penicillin",
      );
      assert.deepEqual(
        penicillin.map((entry) => entry.status),
        ["inferred"],
      );
    });

    it("stops after Ada revokes", async () => {
      await restartHost("ada=");
      for (const [key, objective] of [
        ["memory-after-revoke", invoke("memory.list", {})],
        ["propose-after-revoke", invoke("memory.propose", fact("Ada likes jazz"))],
      ]) {
        const denied = await work("ada", key, objective);
        assert.equal(denied.operations[0].errorCode, "FORBIDDEN");
      }
      const state = await snapshot();
      assert.equal(memory(state, "Ada likes jazz"), undefined);
    });
  },
);

describe(
  "eve working with Ada's Personal OS projects and documents under her grants",
  { skip: SKIP },
  () => {
    const base = `http://127.0.0.1:${port}`;
    const bearer = (person) =>
      `Bearer ${readFileSync(join(scratch, "personalos.tokens", person), "utf8")}`;
    const asPerson = async (person, fn, args) => {
      const response = await fetch(`${base}/api/mutation/${fn}`, {
        body: JSON.stringify({ args }),
        headers: { authorization: bearer(person), "content-type": "application/json" },
        method: "POST",
      });
      return await response.json();
    };
    const project = (state, owner, name) =>
      state.people[owner].projects.find((entry) => entry.name === name);
    const doc = (state, owner, name) =>
      state.people[owner].documents.find((entry) => entry.name === name);
    let taxes;
    let kitchen;

    it("reads Ada's projects only with a project grant, and that grant reads no documents", async () => {
      taxes = (await asPerson("ada", "projects:create", { name: "Taxes" })).value;
      // A document saved the way the Documents screen saves one: an upload link, the bytes, then attach.
      for (const [name, text, projectId] of [
        ["w2.txt", "wages 100", taxes.id],
        ["lease.txt", "rent 900", undefined],
      ]) {
        const link = (
          await asPerson("ada", "documents:prepareUpload", { contentType: "text/plain", name })
        ).value;
        const put = await fetch(new URL(link.url, base), {
          body: text,
          headers: { "content-type": "text/plain", "x-file-name": name },
          method: "PUT",
        });
        const file = await put.json();
        assert.equal(put.ok, true, JSON.stringify(file));
        const attached = await asPerson("ada", "documents:attach", {
          fileId: file.id ?? file.file?.id,
          ...(projectId ? { projectId } : {}),
        });
        assert.equal(attached.ok, true, JSON.stringify(attached));
      }
      const denied = await work("ada", "projects-denied", invoke("projects.list", {}));
      assert.equal(denied.operations[0].errorCode, "FORBIDDEN");
      await restartHost("ada=projects.list");
      const listed = await work("ada", "projects-list", invoke("projects.list", {}));
      assert.equal(listed.status, "completed", JSON.stringify(listed));
      assert.match(listed.summary, /"name":"Taxes"/u);
      const docs = await work(
        "ada",
        "docs-with-project-grant",
        invoke("documents.list", { projectId: taxes.id }),
      );
      assert.equal(
        docs.operations[0].errorCode,
        "FORBIDDEN",
        "a project grant does not read its documents",
      );
      const grace = await work("grace", "grace-projects", invoke("projects.list", {}));
      assert.equal(grace.operations[0].errorCode, "FORBIDDEN");
    });

    it("creates and updates a project only with those grants, once for a repeated call, attributed to eve", async () => {
      const before = await work(
        "ada",
        "project-create-denied",
        invoke("projects.create", { name: "Kitchen" }),
      );
      assert.equal(before.operations[0].errorCode, "FORBIDDEN");
      await restartHost("ada=projects.list+projects.create");
      const created = await work(
        "ada",
        "project-create",
        `[repeat] ${invoke("projects.create", { name: "Kitchen" })}`,
      );
      assert.equal(created.status, "completed", JSON.stringify(created));
      assert.deepEqual(
        [created.operations.length, created.operations[0].requestIds.length],
        [1, 1],
      );
      const update = await work(
        "ada",
        "project-update-denied",
        invoke("projects.update", { id: taxes.id, status: "paused" }),
      );
      assert.equal(update.operations[0].errorCode, "FORBIDDEN", "update needs its own grant");

      let state = await snapshot();
      kitchen = project(state, "ada", "Kitchen");
      assert.equal(state.people.ada.projects.filter((entry) => entry.name === "Kitchen").length, 1);
      const action = state.people.ada.actions.find(
        (entry) => entry.kind === "project.create" && entry.evidence.id === kitchen.id,
      );
      assert.deepEqual(
        [action.via, action.delegation.agent, action.delegation.capability],
        ["agent", "appport-agent", "projects.create"],
      );
      const audit = state.audit.find(
        (entry) => entry.authority.delegation?.decisionId === action.delegation.decisionId,
      );
      assert.deepEqual(
        [audit.function, audit.principal.id, audit.requestId],
        ["projects:create", "ada", created.operations[0].requestIds[0]],
      );

      await restartHost("ada=projects.list+projects.create+projects.update");
      const paused = await work(
        "ada",
        "project-update",
        invoke("projects.update", { id: kitchen.id, status: "paused" }),
      );
      assert.equal(paused.status, "completed", JSON.stringify(paused));
      state = await snapshot();
      assert.equal(project(state, "ada", "Kitchen").status, "paused");
    });

    it("refuses a second project with the same name, and leaves that operation unresolved rather than retrying it", async () => {
      const duplicate = await work(
        "ada",
        "project-duplicate",
        invoke("projects.create", { name: "kitchen" }),
      );
      assert.equal(duplicate.status, "blocked");
      assert.match(duplicate.decisions.at(-1), /^indeterminate: /u);
      const [operation] = await ledger(duplicate.workId);
      assert.deepEqual(
        [operation.state, operation.outcome.error.code],
        ["indeterminate", "feltkit.FAILED_PRECONDITION"],
      );
      const state = await snapshot();
      assert.equal(
        state.people.ada.projects.filter((entry) => entry.name.toLowerCase() === "kitchen").length,
        1,
      );
    });

    it("reads and re-files Ada's documents only with document grants, never their contents", async () => {
      await restartHost("ada=projects.list+documents.list");
      const listed = await work("ada", "docs-list", invoke("documents.list", {}));
      assert.equal(listed.status, "completed", JSON.stringify(listed));
      assert.match(listed.summary, /lease\.txt/u);
      assert.doesNotMatch(listed.summary, /rent 900|wages 100/u, "names and notes, never contents");
      const link = await work("ada", "doc-link", invoke("documents.link", { id: "any" }));
      assert.deepEqual(link.operations, [], "a download link is not a capability");

      let state = await snapshot();
      const lease = doc(state, "ada", "lease.txt");
      const denied = await work(
        "ada",
        "doc-update-denied",
        invoke("documents.update", { id: lease.id, projectId: kitchen.id }),
      );
      assert.equal(denied.operations[0].errorCode, "FORBIDDEN");
      await restartHost("ada=projects.list+documents.list+documents.update");
      const filed = await work(
        "ada",
        "doc-update",
        invoke("documents.update", {
          id: lease.id,
          note: "for the contractor",
          projectId: kitchen.id,
        }),
      );
      assert.equal(filed.status, "completed", JSON.stringify(filed));
      state = await snapshot();
      assert.deepEqual(
        [doc(state, "ada", "lease.txt").projectId, doc(state, "ada", "lease.txt").note],
        [kitchen.id, "for the contractor"],
      );
      assert.equal(
        doc(state, "ada", "w2.txt").projectId,
        taxes.id,
        "the other relation is untouched",
      );
      const action = state.people.ada.actions.find(
        (entry) => entry.kind === "document.update" && entry.evidence.id === lease.id,
      );
      assert.deepEqual(
        [action.via, action.evidence.verified, action.delegation.capability],
        ["agent", true, "documents.update"],
      );
    });

    it("creates one project when eve crashes after Personal OS committed, and Personal OS restarts too", async () => {
      await restartHost("ada=projects.list+projects.create");
      const response = await fetch(new URL("/work", agent.url), {
        body: JSON.stringify({
          objective: `[crash:invocation.record] ${invoke("projects.create", { name: "Garage" })}`,
        }),
        headers: {
          authorization: `Bearer ${signJwt(AGENT_JWT_SECRET, "ada")}`,
          "content-type": "application/json",
          "idempotency-key": "project-crash",
        },
        method: "POST",
      });
      const { workId } = await response.json();
      await waitFor(async () => !(await reachable()));
      await stop(agent.child);
      await restartHost();
      agent = await startAgent();
      assert.equal((await outcome("ada", workId)).status, "completed");
      const [operation] = await ledger(workId);
      assert.deepEqual([operation.state, operation.attempts], ["succeeded", 2]);
      const state = await snapshot();
      assert.equal(state.people.ada.projects.filter((entry) => entry.name === "Garage").length, 1);
    });

    it("stops after Ada revokes", async () => {
      await restartHost("ada=");
      for (const [key, objective] of [
        ["projects-after-revoke", invoke("projects.list", {})],
        ["docs-after-revoke", invoke("documents.list", {})],
      ]) {
        const denied = await work("ada", key, objective);
        assert.equal(denied.operations[0].errorCode, "FORBIDDEN");
      }
    });
  },
);

describe("eve running Ada's Personal OS research within the budget she set", { skip: SKIP }, () => {
  const RESEARCH = "research.start+research.list+research.get+research.cancel+research.retry";
  const TEXT = "Find me some new customers for FeltKit";
  const base = `http://127.0.0.1:${port}`;
  const adaRead = async (fn, args) => {
    const response = await fetch(`${base}/api/query/${fn}`, {
      body: JSON.stringify({ args }),
      headers: {
        authorization: `Bearer ${readFileSync(join(scratch, "personalos.tokens", "ada"), "utf8")}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    return (await response.json()).value;
  };
  const runOf = async (runId) => (await adaRead("research:get", { runId })).run;
  const until = async (runId, done) => {
    let run;
    await waitFor(async () => done((run = await runOf(runId))), { attempts: 600, intervalMs: 100 });
    return run;
  };
  const quiet = () => new Promise((resolve) => setTimeout(resolve, 1500));
  const runIdOf = (work) => /"runId":"([^"]+)"/u.exec(work.summary)?.[1];
  let runId;

  it("refuses to start without a grant or without a budget Ada set, before any search", async () => {
    const before = searchProvider.requests.length;
    const noGrant = await work(
      "ada",
      "research-no-grant",
      invoke("research.start", { budget: 2, text: TEXT }),
    );
    assert.equal(noGrant.operations[0].errorCode, "FORBIDDEN");
    await restartHost(`ada=${RESEARCH}`);
    const noBudget = await work(
      "ada",
      "research-no-budget",
      invoke("research.start", { budget: 2, text: TEXT }),
    );
    assert.equal(noBudget.operations[0].errorCode, "FORBIDDEN", "a grant is not a budget");
    await quiet();
    assert.equal(searchProvider.requests.length, before, "nothing was searched");
  });

  it("starts research in Ada's Personal OS, stops it at its budget, and records who started it", async () => {
    await restartHost(`ada=${RESEARCH}`, { PERSONALOS_RESEARCH_BUDGET: "ada=12" });
    const before = searchProvider.requests.length;
    const started = await work(
      "ada",
      "research-start",
      invoke("research.start", { budget: 2, text: TEXT }),
    );
    assert.equal(started.status, "completed", JSON.stringify(started));
    runId = runIdOf(started);
    const run = await until(runId, (r) => r.status !== "running");
    assert.deepEqual(
      [run.status, run.blocker.need, run.budget.agent, run.budget.charged],
      ["blocked", "research budget", "agent:appport-agent", 2],
    );
    assert.equal(
      searchProvider.requests.length - before,
      2,
      "exactly the two searches it was given",
    );

    const state = await snapshot();
    const action = state.people.ada.actions.find(
      (entry) => entry.kind === "research.start" && entry.evidence?.id === runId,
    );
    assert.deepEqual(
      [action.via, action.delegation.agent, action.delegation.capability],
      ["agent", "appport-agent", "research.start"],
    );
    const audit = state.audit.find(
      (entry) => entry.authority.delegation?.decisionId === action.delegation.decisionId,
    );
    assert.deepEqual(
      [audit.function, audit.principal.id, audit.requestId],
      ["researchstate:start", "ada", started.operations[0].requestIds[0]],
    );
  });

  it("reads the run, continues it within budget, and never runs a completed run again", async () => {
    const read = await work("ada", "research-get", invoke("research.get", { runId }));
    assert.equal(read.status, "completed", JSON.stringify(read));
    const resumed = await work(
      "ada",
      "research-retry",
      invoke("research.retry", { budget: 4, runId }),
    );
    assert.equal(resumed.status, "completed", JSON.stringify(resumed));
    const run = await until(runId, (r) => r.status !== "running");
    assert.equal(run.status, "completed");
    assert.equal(run.budget.charged, run.usage.searches, "every search was charged");
    assert.ok(run.budget.charged <= run.budget.allocation);
    const { sources } = await adaRead("research:get", { runId });
    assert.ok(
      sources.length > 0 &&
        sources.every((source) => source.runId === runId && source.owner === "ada"),
      "its citations are its own",
    );

    const searched = searchProvider.requests.length;
    const again = await work("ada", "research-retry-done", invoke("research.retry", { runId }));
    // Personal OS refuses (completed research is never run again); eve's ledger keeps that refusal unresolved, never retried.
    assert.match(again.decisions.at(-1), /^indeterminate: /u);
    const [refused] = await ledger(again.workId);
    assert.deepEqual(
      [refused.state, refused.outcome.error.code],
      ["indeterminate", "feltkit.FAILED_PRECONDITION"],
    );
    await quiet();
    assert.equal(searchProvider.requests.length, searched, "a completed run is not run again");
  });

  it("cancels a run mid-search: the search in flight finishes, nothing more is searched, and a restart does not resume it", async () => {
    let seen;
    const holding = new Promise((resolve) => (seen = resolve));
    let release;
    const released = new Promise((resolve) => (release = resolve));
    const before = searchProvider.requests.length;
    searchProvider.hold = async () => {
      seen();
      await released;
    };
    const started = await work(
      "ada",
      "research-live",
      invoke("research.start", { budget: 5, text: TEXT }),
    );
    const live = runIdOf(started);
    await holding;
    const cancelled = await work(
      "ada",
      "research-cancel",
      invoke("research.cancel", { runId: live }),
    );
    assert.equal(cancelled.status, "completed", JSON.stringify(cancelled));
    searchProvider.hold = null;
    release();
    await quiet();
    let run = await runOf(live);
    assert.deepEqual(
      [run.status, run.cancelledBy, run.budget.charged, run.budget.released],
      ["cancelled", "agent:appport-agent", 1, true],
    );
    assert.equal(searchProvider.requests.length - before, 1, "only the search in flight");
    const repeat = await work(
      "ada",
      "research-cancel-again",
      invoke("research.cancel", { runId: live }),
    );
    assert.equal(repeat.status, "completed");

    await restartHost();
    await quiet();
    run = await runOf(live);
    assert.equal(run.status, "cancelled");
    assert.equal(searchProvider.requests.length - before, 1, "nothing ran after the restart");
  });

  it("starts once when eve crashes after Personal OS committed, and Personal OS restarts too", async () => {
    const response = await fetch(new URL("/work", agent.url), {
      body: JSON.stringify({
        objective: `[crash:invocation.record] ${invoke("research.start", { budget: 1, text: "Find me some new customers for Brightpipe" })}`,
      }),
      headers: {
        authorization: `Bearer ${signJwt(AGENT_JWT_SECRET, "ada")}`,
        "content-type": "application/json",
        "idempotency-key": "research-crash",
      },
      method: "POST",
    });
    const { workId } = await response.json();
    await waitFor(async () => !(await reachable()));
    await stop(agent.child);
    await restartHost();
    agent = await startAgent();
    assert.equal((await outcome("ada", workId)).status, "completed");
    const [operation] = await ledger(workId);
    assert.deepEqual([operation.state, operation.attempts], ["succeeded", 2]);
    const runs = (await adaRead("research:list", {})).filter((entry) =>
      /Brightpipe/u.test(entry.request),
    );
    assert.equal(runs.length, 1, "one run");
  });

  it("stops after Ada revokes", async () => {
    await restartHost("ada=");
    const denied = await work("ada", "research-after-revoke", invoke("research.list", {}));
    assert.equal(denied.operations[0].errorCode, "FORBIDDEN");
  });
});
