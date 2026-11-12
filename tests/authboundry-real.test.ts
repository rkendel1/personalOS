/**
 * Delegated execution against the REAL AuthBoundry server (the published @authboundry/core, pinned
 * in tests/authboundry/package.json and its lockfile) and a real Resolver. Nothing here is a stand-in for the
 * component whose behavior it establishes:
 *
 *   requester  Ada, resolved by Resolver from her Multiplayer identity
 *   executor   agent:personalos, PersonalOS's own principal at AuthBoundry
 *   authority  Ada's delegation to agent:personalos, decided by AuthBoundry on_behalf_of user:ada
 *
 * Without that install these tests are skipped and say so; CI installs it, so CI never skips them.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { CONTRACT } from "../feltkit/_interaction.js";
import { CAPABILITIES } from "../feltkit/_authority.js";
import { authboundryInstalled, startRealAuthority, startResolver, type RealAuthority, type TestResolver } from "./fixtures/anywhere.js";

// CI sets REQUIRE_REAL_AUTHBOUNDRY=1: there a missing server build is a failure, never a skip.
if (process.env.REQUIRE_REAL_AUTHBOUNDRY === "1" && !authboundryInstalled()) throw new Error("REQUIRE_REAL_AUTHBOUNDRY=1 but AuthBoundry is not installed (npm ci --prefix tests/authboundry)");
const SKIP = authboundryInstalled() ? false : "AuthBoundry is not installed here (npm ci --prefix tests/authboundry); CI installs it";
const BRIDGE = { id: "multiplayer", type: "service" as const, displayName: "Multiplayer bridge", roles: ["bridge"] };

let resolver: TestResolver;
let ab: RealAuthority;
before(async () => {
  if (SKIP) return;
  resolver = await startResolver();
  // Both people hold every capability themselves; what PersonalOS may do for them is their delegation.
  ab = await startRealAuthority({ ada: [...CAPABILITIES], grace: [...CAPABILITIES] }, CAPABILITIES);
});
after(async () => { await ab?.close(); await resolver?.close(); });

let n = 0;
let INSTANCE = "";
function envelope(text: string, from: string, direct = false) {
  const i = ++n;
  return {
    contract: CONTRACT,
    source: { adapter: "multiplayer", instance: INSTANCE, eventId: `m${i}`, sequence: i, receivedAt: Date.now() },
    sender: { sourcePrincipalId: from, displayName: from, timeZone: "UTC" },
    conversation: { workspaceId: "ws", conversationId: direct ? `dm-${from}` : "ch", kind: direct ? "dm" : "public", ...(direct ? {} : { name: "general" }), participantCount: direct ? 2 : 5, directWithAssistant: direct },
    message: { id: `m${i}`, text, mentions: { assistant: !direct, handles: [] }, attachments: [] },
    context: { scope: "none", messages: [], limits: { maxMessages: 0, maxChars: 0, truncated: false } },
    respondTo: { conversationId: "ch" },
    idempotencyKey: `${INSTANCE}:m${i}`,
  } as any;
}
const deliver = (t: TestApp, text: string, from: string, direct = false) => t.as(BRIDGE).mutation(api.interactions.receive, { envelope: envelope(text, from, direct) });
async function link(t: TestApp, owner: string) {
  const { id, code } = await t.as(owner).mutation(api.links.start, {});
  assert.equal((await deliver(t, `link ${code}`, owner, true)).state, "completed");
  await t.as(owner).mutation(api.links.confirm, { id });
  await (t.runtime as any).settleAgents(); // the identity agent records it in Resolver
}
async function withApp(fn: (t: TestApp) => Promise<void>) {
  INSTANCE = `real-${Math.random().toString(36).slice(2, 10)}`;
  const t = await createTestApp();
  try { await fn(t); } finally { await t.close(); }
}
const authorityOf = async (t: TestApp, owner: string, intent: string) => (await t.as(owner).query(api.interactions.list, {})).find((x) => x.intent === intent)?.authority;

test("real AuthBoundry: Ada's delegation lets PersonalOS create her reminder; requester, executor and delegation are all recorded", { skip: SKIP }, () => withApp(async (t) => {
  await ab.delegate("ada-reminders", "ada", ["personalos.reminders.create", "personalos.tasks.create"]);
  await link(t, "ada");
  const r = await deliver(t, "@personalos remind me to call the bank tomorrow at 9am", "ada");
  assert.equal(r.state, "completed", r.reply);
  const authority = await authorityOf(t, "ada", "task.create");
  assert.deepEqual([authority!.principal, authority!.onBehalfOf, authority!.delegationId, authority!.outcome], ["agent:personalos", "user:ada", "ada-reminders", "allow"]);
  assert.match(authority!.decisionId!, /^personalos-decision-/, "AuthBoundry's own durable decision id");
  const [task] = await t.as("ada").query(api.tasks.list, {});
  assert.deepEqual([task!.owner, task!.title], ["ada", "Call the bank"]);
}));

test("real AuthBoundry: a capability outside Ada's delegation is denied, though Ada holds it and PersonalOS was delegated others", { skip: SKIP }, () => withApp(async (t) => {
  await link(t, "ada");
  const r = await deliver(t, "@personalos remember that my PIN is 1234", "ada", true);
  assert.equal(r.state, "refused");
  assert.match(r.reply, /personalos\.memory\.write/);
  assert.equal((await t.as("ada").query(api.memory.list)).length, 0);
}));

test("real AuthBoundry: Grace without a delegation cannot have PersonalOS act for her, and Ada's delegation never serves her", { skip: SKIP }, () => withApp(async (t) => {
  await link(t, "grace");
  const r = await deliver(t, "@personalos add buy flowers to my list", "grace");
  assert.equal(r.state, "refused");
  assert.match(r.reply, /delegation_missing|capability_not_granted/);
  assert.equal((await t.as("grace").query(api.tasks.list, {})).length, 0);
  assert.equal((await authorityOf(t, "grace", "task.create"))!.delegationId, undefined);
}));

test("real AuthBoundry: revoking Ada's delegation stops the next operation", { skip: SKIP }, () => withApp(async (t) => {
  await ab.delegate("ada-tasks-revocable", "ada", ["personalos.tasks.read"]);
  await link(t, "ada");
  assert.equal((await deliver(t, "@personalos show my tasks", "ada", true)).state, "completed");
  await ab.revokeDelegation("ada-tasks-revocable");
  const r = await deliver(t, "@personalos show my tasks", "ada", true);
  assert.equal(r.state, "refused", r.reply);
}));

test("real AuthBoundry: an expired delegation fails closed", { skip: SKIP }, () => withApp(async (t) => {
  // Expires three seconds from now (AuthBoundry's clock is in seconds).
  await ab.delegate("ada-projects-short", "ada", ["personalos.projects.create"], Math.floor(Date.now() / 1000) + 3);
  await link(t, "ada");
  await new Promise((r) => setTimeout(r, 4100));
  const r = await deliver(t, "@personalos start a project called Moonshot", "ada", true);
  assert.equal(r.state, "refused", r.reply);
  assert.equal((await t.as("ada").query(api.projects.list)).length, 0);
}));
