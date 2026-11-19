/**
 * An agent outside Anywhere Aide (an eve agent) manages a person's tasks over /appport under that person's
 * grants to it: FeltKit's delegated execution (`X-AppPort-On-Behalf-Of`, ctx.auth.delegation), the REAL
 * private AuthBoundry (@authboundry/local), real HTTP, real jobs. Anywhere Aide's own task, reminder and
 * briefing code does the work; nothing here replaces it.
 *
 * Skipped, saying why, unless the installed FeltKit has delegated /appport and @authboundry/local has
 * per-agent delegation.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { startServer } from "@feltdb/feltkit/server";
import { api } from "../feltkit/_generated/api.js";

function skipReason(): string | false {
  const require = createRequire(import.meta.url);
  const feltkit = dirname(require.resolve("@feltdb/feltkit/package.json"));
  if (!existsSync(join(feltkit, "dist/runtime/delegation.js"))) return "the installed @feltdb/feltkit has no delegated /appport (needs a release after 0.3.32)";
  try {
    const local = require(require.resolve("@authboundry/local/package.json")).version as string;
    if (local === "0.1.0") return "@authboundry/local 0.1.0 has no per-agent delegation";
  } catch { return "@authboundry/local is not installed"; }
  return false;
}
const SKIP = skipReason();
const EVE = { id: "eve", type: "agent" as const, roles: ["agent"] };

let t: TestApp;
let server: { url: string; close(): unknown };
const tokens = new Map<string, string>();
let n = 0;

before(async () => {
  if (SKIP) return;
  delete process.env.AUTHBOUNDRY_URL;
  delete process.env.FELTKIT_CREDENTIAL_AUTHBOUNDRY_CHECK;
  t = await createTestApp();
  server = await startServer({ runtime: t.runtime as never, projectDir: process.cwd(), port: 0, dashboard: { enabled: false, adminToken: `fka_${"x".repeat(43)}`, dir: null } });
  tokens.set("eve", (await (t.runtime as any).issueSession(EVE, { kind: "agent", via: "cli" })).token);
});
after(async () => {
  await server?.close();
  await t?.close();
});

async function appport(capability: string, input: unknown, onBehalfOf: string, idempotencyKey?: string) {
  const res = await fetch(`${server.url}/appport`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${tokens.get("eve")}`, "x-appport-on-behalf-of": onBehalfOf },
    body: JSON.stringify({ protocol: "appport/1", type: "request", requestId: `r_${++n}`, capability: { name: capability, version: 1 }, input, ...(idempotencyKey ? { idempotencyKey } : {}) }),
  });
  return (await res.json()) as any;
}
const grantEve = (who: string, capabilities: string[]) => t.as(who).action(api.delegation.set, { agent: "eve", capabilities });
const tasksOf = (who: string) => t.as(who).query(api.tasks.list, {});
const actionsOf = (who: string) => t.as(who).query(api.actions.list, {});
const jobs = () => (t.runtime.services as any).jobs;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** A refusal: FORBIDDEN (or UNKNOWN_CAPABILITY), and neither the person's tasks nor their action log changed. */
async function refused(attempt: Promise<any>, owner: string, why: string, code = "FORBIDDEN") {
  const [tasks, actions] = [await tasksOf(owner), await actionsOf(owner)];
  const r = await attempt;
  assert.equal(r.ok, false, `${why}: ${JSON.stringify(r)}`);
  assert.equal(r.error.code, code, `${why}: ${JSON.stringify(r.error)}`);
  assert.deepEqual(await tasksOf(owner), tasks, `${why}: no task changed`);
  assert.deepEqual(await actionsOf(owner), actions, `${why}: nothing recorded`);
}

test("an agent manages Ada's tasks, reminders and briefing only as each capability is delegated to it", { skip: SKIP }, async () => {
  // The operator registers the agent; it can do nothing yet.
  assert.deepEqual(await t.as("ada").action(api.delegation.registerAgent, { id: "eve" }), { id: "agent:eve", status: "active" });
  await assert.rejects(t.as("grace").action(api.delegation.registerAgent, { id: "rogue" }), /feltkit\.authority\.agents|permission/i);
  await t.as("ada").mutation(api.tasks.create, { title: "Ada's own task" });
  await t.as("grace").mutation(api.tasks.create, { title: "Grace's task" });

  // Ada's grants to Anywhere Aide and to Eve are separate: changing one never revokes the other.
  await t.as("ada").action(api.delegation.set, { capabilities: ["personalos.tasks.read"] });
  await refused(appport("tasks.list", {}, "ada"), "ada", "nothing granted to Eve yet");
  await grantEve("ada", ["tasks.list", "tasks.create", "briefing.today"]);
  const executorGrants = (await t.as("ada").action(api.delegation.list, {})).capabilities.filter((c) => c.granted).map((c) => c.id);
  assert.deepEqual(executorGrants, ["personalos.tasks.read"], "Ada's grant to Anywhere Aide is untouched");
  const eveGrants = (await t.as("ada").action(api.delegation.list, { agent: "eve" })).capabilities.filter((c) => c.granted).map((c) => c.id);
  assert.deepEqual(eveGrants.sort(), ["briefing.today", "tasks.create", "tasks.list"]);
  await assert.rejects(grantEve("ada", ["personalos.tasks.read"]), /Not something an agent can be given/);
  await assert.rejects(grantEve("ada", ["tasks.delete"]), /Not something an agent can be given/);

  // Lists Ada's tasks, and only hers.
  const listed = await appport("tasks.list", {}, "ada");
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.deepEqual(listed.output.map((x: any) => [x.owner, x.title]), [["ada", "Ada's own task"]]);

  // Creates a task with a reminder, in Ada's space, through Anywhere Aide's own createTask: evidence, action log, job.
  const tomorrow = day(1);
  const created = await appport("tasks.create", { title: "Call the dentist", due: tomorrow, time: "10:00", tzOffset: 0, reminder: true }, "ada", "eve-k1");
  assert.equal(created.ok, true, JSON.stringify(created));
  const task = created.output;
  assert.deepEqual([task.owner, task.title, task.due, task.remindTime, task.remindAt], ["ada", "Call the dentist", tomorrow, "10:00", Date.parse(`${tomorrow}T10:00:00Z`)]);
  assert.ok((await tasksOf("ada")).some((x) => x.id === task.id), "visible through Anywhere Aide's normal read");
  const [action] = await actionsOf("ada");
  assert.deepEqual([action!.kind, action!.status, action!.via, action!.evidence?.id, action!.evidence?.verified], ["reminder.create", "succeeded", "agent", task.id, true]);
  assert.deepEqual([action!.delegation?.agent, action!.delegation?.agentAuthority, action!.delegation?.capability], ["eve", "agent:eve", "tasks.create"]);
  assert.match(action!.delegation!.decisionId, /\S/);
  assert.match(action!.delegation!.delegationId, /\S/);
  const audit = (await (t.runtime as any).auditTrail()).filter((r: any) => r.function === "tasks:create" && r.authority.delegation);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].authority.delegation.decisionId, action!.delegation!.decisionId, "Anywhere Aide's action and FeltKit's audit name the same decision");

  // The same key again: the same task, no second task, no second reminder. Grace's same key is her own.
  const again = await appport("tasks.create", { title: "Call the dentist", due: tomorrow, time: "10:00", tzOffset: 0, reminder: true }, "ada", "eve-k1");
  assert.equal(again.output.id, task.id);
  assert.equal((await tasksOf("ada")).filter((x) => x.title === "Call the dentist").length, 1);
  await (t.runtime as any).runServices();
  const reminderJobs = (await jobs().listJobs("personalos")).filter((j: any) => j.type === "reminder.fire" && j.payload.taskId === task.id);
  assert.equal(reminderJobs.length, 1, "one reminder job");
  assert.deepEqual([reminderJobs[0].status, reminderJobs[0].principal.principalId, reminderJobs[0].runAt], ["scheduled", "ada", new Date(task.remindAt).toISOString()], "queued as Ada, owned by Anywhere Aide");
  await refused(appport("tasks.create", { title: "Call the dentist", due: tomorrow, time: "10:00", tzOffset: 0, reminder: true }, "grace", "eve-k1"), "grace", "Grace delegated nothing");
  await grantEve("grace", ["tasks.create"]);
  const graces = await appport("tasks.create", { title: "Call the dentist", due: tomorrow, time: "10:00", tzOffset: 0, reminder: true }, "grace", "eve-k1");
  assert.deepEqual([graces.output.owner, graces.output.id === task.id], ["grace", false], "the same key for Grace is Grace's own task");

  // The reminder fires through Anywhere Aide's own job, with the agent nowhere involved.
  assert.equal(await jobs().executeJob("personalos", reminderJobs[0].id, "test-worker"), true);
  await (t.runtime as any).runServices();
  assert.deepEqual((await t.as("ada").query(api.inbox.list, {})).map((x) => [x.type, x.title]), [["reminder.due", "Call the dentist"]]);
  const [fired] = await actionsOf("ada");
  assert.deepEqual([fired!.kind, fired!.via, fired!.delegation], ["reminder.fire", "job", undefined]);

  // Update and complete need their own grants; reopen its own; deletion is never delegable.
  await refused(appport("tasks.update", { id: task.id, title: "Call the dentist at 9" }, "ada"), "ada", "update not granted");
  await refused(appport("tasks.complete", { id: task.id }, "ada"), "ada", "complete not granted");
  await grantEve("ada", ["tasks.list", "tasks.create", "briefing.today", "tasks.update", "tasks.complete"]);
  const moved = await appport("tasks.update", { id: task.id, due: day(2), time: "09:00", tzOffset: 0, reminder: true }, "ada", "eve-k2");
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.deepEqual([moved.output.due, moved.output.remindTime, moved.output.remindedAt], [day(2), "09:00", undefined], "moving it re-arms the reminder");
  await (t.runtime as any).runServices();
  assert.equal((await jobs().listJobs("personalos")).filter((j: any) => j.type === "reminder.fire" && j.payload.taskId === task.id && j.status === "scheduled").length, 1, "one new reminder for the new time");

  // The briefing, read by Eve, reflects what Eve did: a task due today, then done.
  const today = day(0);
  const dueToday = await appport("tasks.create", { title: "Pay rent", due: today }, "ada", "eve-k3");
  let brief = await appport("briefing.today", { today }, "ada");
  assert.equal(brief.ok, true, JSON.stringify(brief));
  assert.ok(brief.output.dueToday.some((x: any) => x.id === dueToday.output.id));
  const done = await appport("tasks.complete", { id: dueToday.output.id }, "ada", "eve-k4");
  assert.equal(done.output.status, "done");
  brief = await appport("briefing.today", { today }, "ada");
  assert.ok(!brief.output.dueToday.some((x: any) => x.id === dueToday.output.id), "done is gone from today");
  assert.deepEqual((await t.as("ada").query(api.briefing.today, { today })).dueToday, brief.output.dueToday, "the same briefing Ada reads herself");

  await refused(appport("tasks.reopen", { id: dueToday.output.id }, "ada"), "ada", "reopen not granted");
  await grantEve("ada", ["tasks.list", "tasks.create", "briefing.today", "tasks.update", "tasks.complete", "tasks.reopen"]);
  const reopened = await appport("tasks.reopen", { id: dueToday.output.id }, "ada", "eve-k5");
  assert.equal(reopened.output.status, "open");
  await refused(appport("tasks.delete", { id: dueToday.output.id }, "ada"), "ada", "deletion is not a capability", "UNKNOWN_CAPABILITY");

  // Never another person's records: Grace granted only tasks.create.
  await refused(appport("tasks.list", {}, "grace"), "grace", "Grace did not grant listing");
  await refused(appport("tasks.complete", { id: graces.output.id }, "ada"), "grace", "Ada's grant does not reach Grace's task", "NOT_FOUND");

  // Revoking stops the next call.
  await grantEve("ada", []);
  await refused(appport("tasks.list", {}, "ada"), "ada", "revoked");

  // Ada's own use is unchanged, and her records name no agent.
  const mine = await t.as("ada").mutation(api.tasks.create, { title: "Still mine" });
  const [direct] = await actionsOf("ada");
  assert.deepEqual([direct!.kind, direct!.via, direct!.delegation, mine.owner], ["task.create", "ui", undefined, "ada"]);
});
