/**
 * Verified identity linking (Slice 5 of the AppPort foundation): an external surface account is bound
 * to a Anywhere Aide person only with proof of both sides, exactly once, revocably, and without granting
 * anything. Real FeltKit runtime, the REAL Resolver server (tests/fixtures/anywhere.ts) and the REAL
 * private AuthBoundry (@authboundry/local, no stub authority): what a link does or does not change in
 * delegation is AuthBoundry's own answer.
 *
 * The linking flow itself, forged identities, the Resolver keys and revocation are also covered in
 * tests/interactions.test.ts and tests/x.test.ts; this file adds the ownership, replay, uniqueness,
 * authorization-boundary, restart and audit guarantees.
 */
import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { startServer } from "@feltdb/feltkit/server";
import { api } from "../feltkit/_generated/api.js";
import { CONTRACT } from "../feltkit/_interaction.js";
import { startResolver, type TestResolver } from "./fixtures/anywhere.js";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

/** Outside agents (registration, per-agent grants, delegated /appport) need a FeltKit with delegation; published 0.3.30 has none. */
const AGENTS = existsSync(join(dirname(createRequire(import.meta.url).resolve("@feltdb/feltkit/package.json")), "dist/runtime/delegation.js"));
const NO_AGENTS = AGENTS ? false : "the installed @feltdb/feltkit has no outside agents (registration, per-agent grants, delegated /appport)";

const BRIDGE = { id: "multiplayer", type: "service" as const, displayName: "Multiplayer bridge", roles: ["bridge"] };
const OTHER_BRIDGE = { id: "slackbridge", type: "service" as const, roles: ["bridge"] };
const EVE = { id: "eve", type: "agent" as const, roles: ["agent"] };

let resolver: TestResolver;
let INSTANCE = "id-test";
let seq = 0;

before(async () => {
  delete process.env.AUTHBOUNDRY_URL;
  delete process.env.FELTKIT_CREDENTIAL_AUTHBOUNDRY_CHECK;
  resolver = await startResolver();
});
after(async () => { await resolver.close(); });

type Bridge = typeof BRIDGE | typeof OTHER_BRIDGE;
function envelope(text: string, o: { from: string; name?: string; direct?: boolean; claimed?: Record<string, string>; bridge?: Bridge }) {
  const n = ++seq;
  const adapter = (o.bridge ?? BRIDGE).id;
  return {
    contract: CONTRACT,
    source: { adapter, instance: INSTANCE, eventId: `id-${n}`, sequence: n, receivedAt: Date.now() },
    sender: { sourcePrincipalId: o.from, displayName: o.name ?? o.from, timeZone: "America/New_York", ...(o.claimed ? { claimed: o.claimed } : {}) },
    conversation: { workspaceId: "ws", workspaceName: "WS", conversationId: o.direct ? `dm-${o.from}` : "ch-general", kind: o.direct ? "dm" as const : "public" as const, name: o.direct ? undefined : "general", participantCount: o.direct ? 2 : 5, directWithAssistant: !!o.direct },
    message: { id: `id-${n}`, text, mentions: { assistant: !o.direct, handles: o.direct ? [] : ["personalos"] }, attachments: [] },
    context: { scope: "none" as const, messages: [], limits: { maxMessages: 50, maxChars: 1000, truncated: false } },
    respondTo: { conversationId: "ch-general" },
    idempotencyKey: `${INSTANCE}:id-${n}`,
  };
}
const deliver = (t: TestApp, text: string, o: Parameters<typeof envelope>[1]) =>
  t.as(o.bridge ?? BRIDGE).mutation(api.interactions.receive, { envelope: envelope(text, o) as any });

async function settle(t: TestApp) {
  await (t.runtime as any).settleAgents();
  await t.runtime.runServices();
}

async function link(t: TestApp, owner: string, source: string) {
  const { id, code } = await t.as(owner).mutation(api.links.start, {});
  assert.equal((await deliver(t, `link ${code}`, { from: source, direct: true })).state, "completed");
  await t.as(owner).mutation(api.links.confirm, { id });
  await settle(t);
  return id;
}

const linksOf = async (t: TestApp, owner: string) => (await t.as(owner).query(api.links.list)).map((l) => ({ id: l.id, status: l.status, source: l.sourcePrincipalId, error: l.error }));

async function hex(x: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(x))), (b) => b.toString(16).padStart(2, "0")).join("");
}
/** Every link reference Resolver holds for this sender in this installation (active and revoked). */
async function refsFor(source: string, adapter = "multiplayer") {
  return (await resolver.admin.list(`ref://identity/personalos/${adapter}/${await hex(INSTANCE)}/${await hex(source)}/`)).refs;
}
const activeRefs = async (source: string) => (await refsFor(source)).filter((r) => r.state !== "revoked");

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: any) => (e?.code === code ? true : assert.fail(`expected ${code}, got ${e?.code}: ${e?.message}`)));
}

async function withApp(fn: (t: TestApp) => Promise<void>) {
  INSTANCE = `id-test-${Math.random().toString(36).slice(2, 10)}`;
  const t = await createTestApp();
  try { await fn(t); } finally { await t.close(); }
}

// ── Proof of both sides ───────────────────────────────────────────────────────

test("1-3: an authenticated person initiates; an unverified identity cannot be linked; a verified one links to that person", () => withApp(async (t) => {
  // Initiating needs a Anywhere Aide session: anonymous and viewer sessions cannot.
  await rejects(t.as(null as never).mutation(api.links.start, {}), "UNAUTHORIZED");
  await rejects(t.as("guest").mutation(api.links.start, {}), "FORBIDDEN");
  const { id, code, expiresAt } = await t.as("ada").mutation(api.links.start, {});
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.ok(expiresAt > Date.now() && expiresAt <= Date.now() + 10 * 60_000);
  // Nothing has been presented by an authenticated surface account: nothing to confirm, nothing linked.
  await rejects(t.as("ada").mutation(api.links.confirm, { id }), "FAILED_PRECONDITION");
  // Presented by the authenticated surface account, but not yet confirmed: still not linked.
  await deliver(t, `link ${code}`, { from: "sam", direct: true });
  assert.equal((await deliver(t, "@personalos show my tasks", { from: "sam" })).refusal?.code, "NOT_LINKED");
  assert.deepEqual(await activeRefs("sam"), []);
  await t.as("ada").mutation(api.links.confirm, { id });
  await settle(t);
  assert.deepEqual((await linksOf(t, "ada")).map((l) => [l.status, l.source]), [["active", "sam"]]);
  const [ref] = await activeRefs("sam");
  const value = (await resolver.admin.resolve(ref!.ref)).selected.value as any;
  assert.equal(value.canonical, "personalos:account:ada");
  assert.deepEqual(value.external, { adapter: "multiplayer", instance: INSTANCE, principalId: "sam" });
  assert.equal(value.verification.method, "personalos.link-code/dm+owner-confirmed");
}));

test("4-5: a matching email, display name or handle is never identity; only the authenticated source id is", () => withApp(async (t) => {
  await link(t, "ada", "ada-mp");
  const forgeries: Array<{ from: string; name?: string; claimed?: Record<string, string> }> = [
    { from: "mallory", name: "Ada Lovelace", claimed: { email: "ada@example.com", handle: "ada-mp", username: "ada" } },
    { from: "ADA-MP", name: "ada-mp" },
    { from: "ada@example.com", claimed: { email: "ada@example.com", verified_email: "true" } },
  ];
  for (const forged of forgeries) {
    assert.equal((await deliver(t, "@personalos show my tasks", forged)).refusal?.code, "NOT_LINKED", JSON.stringify(forged));
  }
  // The same holds for linking: a code is presented by the authenticated account, whatever it claims.
  const { id, code } = await t.as("grace").mutation(api.links.start, {});
  await deliver(t, `link ${code}`, { from: "mallory", name: "Grace Hopper", claimed: { email: "grace@example.com" }, direct: true });
  assert.deepEqual((await linksOf(t, "grace")).map((l) => [l.id, l.status, l.source]), [[id, "presented", "mallory"]]);
}));

test("6: an agent cannot assert an identity link: no session, grant or /appport call reaches linking", { skip: NO_AGENTS }, () => withApp(async (t) => {
  await (t.as("ada") as any).action(api.delegation.registerAgent, { id: "eve" });
  // An outside agent's own session holds nothing.
  await rejects(t.as(EVE).mutation(api.links.start, {}), "FORBIDDEN");
  const { id, code } = await t.as("ada").mutation(api.links.start, {});
  await deliver(t, `link ${code}`, { from: "sam", direct: true });
  await rejects(t.as(EVE).mutation(api.links.confirm, { id }), "FORBIDDEN");
  // Linking cannot be delegated: a person cannot grant it to an agent.
  await assert.rejects(t.as("ada").action(api.delegation.set, { agent: "eve", capabilities: ["links.confirm"] }), /Not something an agent can be given: links\.confirm/);
  await assert.rejects(t.as("ada").action(api.delegation.set, { agent: "eve", capabilities: ["links.start", "links.revoke"] }), /Not something an agent can be given/);
  // Nor through FeltKit's delegated /appport, with a real grant of everything an agent can be given.
  await t.as("ada").action(api.delegation.set, { agent: "eve", capabilities: ["tasks.list", "tasks.create"] });
  const server = await startServer({ runtime: t.runtime as never, projectDir: process.cwd(), port: 0, dashboard: { enabled: false, adminToken: `fka_${"x".repeat(43)}`, dir: null } });
  try {
    const token = (await (t.runtime as any).issueSession(EVE, { kind: "agent", via: "cli" })).token;
    for (const [capability, input] of [["links.confirm", { id }], ["links.start", {}], ["links.revoke", { id }]] as const) {
      const res = await fetch(`${server.url}/appport`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-appport-on-behalf-of": "user:ada" },
        body: JSON.stringify({ protocol: "appport/1", type: "request", requestId: `r-${capability}`, capability: { name: capability, version: 1 }, input }),
      });
      const body = (await res.json()) as any;
      assert.equal(body.ok, false, `${capability} ran for an agent`);
    }
  } finally { await server.close(); }
  // The bridge, which delivers the sender's identity, cannot confirm it either.
  await rejects(t.as(BRIDGE).mutation(api.links.confirm, { id }), "FORBIDDEN");
  assert.deepEqual((await linksOf(t, "ada")).map((l) => l.status), ["presented"]);
  assert.deepEqual(await activeRefs("sam"), []);
}));

// ── Challenge semantics ──────────────────────────────────────────────────────

test("7-10: a code is single use, expires, belongs to the person who started it, and to one surface", () => withApp(async (t) => {
  // Reuse: presented once; a second presentation, even by the same account, is refused.
  const first = await t.as("ada").mutation(api.links.start, {});
  await deliver(t, `link ${first.code}`, { from: "sam", direct: true });
  assert.equal((await deliver(t, `link ${first.code}`, { from: "sam", direct: true })).refusal?.code, "LINK_CODE_INVALID");
  await t.as("ada").mutation(api.links.confirm, { id: first.id });
  await rejects(t.as("ada").mutation(api.links.confirm, { id: first.id }), "FAILED_PRECONDITION");
  await settle(t);
  // Expired: a code not presented within its 10 minutes is refused.
  const late = await t.as("grace").mutation(api.links.start, {});
  mock.timers.enable({ apis: ["Date"], now: Date.now() + 10 * 60_000 + 1000 });
  try {
    assert.equal((await deliver(t, `link ${late.code}`, { from: "gus", direct: true })).refusal?.code, "LINK_CODE_INVALID");
  } finally { mock.timers.reset(); }
  assert.deepEqual((await linksOf(t, "grace")).map((l) => [l.status, l.source]), [["pending", null]]);
  // Another person: Grace cannot confirm, revoke or see Ada's presented link.
  const adas = await t.as("ada").mutation(api.links.start, {});
  await deliver(t, `link ${adas.code}`, { from: "sam2", direct: true });
  await rejects(t.as("grace").mutation(api.links.confirm, { id: adas.id }), "NOT_FOUND");
  await rejects(t.as("grace").mutation(api.links.revoke, { id: adas.id }), "NOT_FOUND");
  assert.ok(!(await linksOf(t, "grace")).some((l) => l.id === adas.id));
  // Another surface: a code started for X is refused from Multiplayer, and one for Multiplayer from another bridge.
  const forX = await t.as("grace").mutation(api.links.start, { adapter: "x" });
  assert.equal((await deliver(t, `link ${forX.code}`, { from: "gus", direct: true })).refusal?.code, "LINK_CODE_INVALID");
  const forMp = await t.as("grace").mutation(api.links.start, {});
  assert.equal((await deliver(t, `link ${forMp.code}`, { from: "gus", direct: true, bridge: OTHER_BRIDGE })).refusal?.code, "LINK_CODE_INVALID");
  // Neither attempt used the code up: it still works where it was meant to.
  assert.equal((await deliver(t, `link ${forMp.code}`, { from: "gus", direct: true })).state, "completed");
}));

// ── Ownership and uniqueness ────────────────────────────────────────────────

test("11, 13: one surface account belongs to one person; a later claim is refused, never a transfer", () => withApp(async (t) => {
  // Grace's code is presented by sam before Ada links sam; then Ada links sam first.
  const graces = await t.as("grace").mutation(api.links.start, {});
  await deliver(t, `link ${graces.code}`, { from: "sam", direct: true });
  await link(t, "ada", "sam");
  // Grace confirming now does not move sam to her: refused in her own confirmation, with the reason.
  await assert.rejects(t.as("grace").mutation(api.links.confirm, { id: graces.id }), (e: any) => e.code === "FAILED_PRECONDITION" && /already connected, or being connected, to a different Anywhere Aide account/.test(e.message));
  await settle(t);
  assert.deepEqual((await linksOf(t, "grace")).map((l) => l.status), ["presented"]);
  // A fresh code from Grace presented by sam is refused at presentation.
  const again = await t.as("grace").mutation(api.links.start, {});
  assert.equal((await deliver(t, `link ${again.code}`, { from: "sam", direct: true })).refusal?.code, "ALREADY_LINKED");
  const active = await activeRefs("sam");
  assert.equal(active.length, 1);
  assert.equal(((await resolver.admin.resolve(active[0]!.ref)).selected.value as any).canonical, "personalos:account:ada");
}));

test("12: two people confirming one surface account at the same time: exactly one owns it, and it still resolves", () => withApp(async (t) => {
  for (let round = 0; round < 3; round++) {
    const sender = `sam-${round}`;
    const adas = await t.as("ada").mutation(api.links.start, {});
    const graces = await t.as("grace").mutation(api.links.start, {});
    // Both codes presented by the same account (it is not linked yet, so both presentations are recorded).
    await deliver(t, `link ${adas.code}`, { from: sender, direct: true });
    await deliver(t, `link ${graces.code}`, { from: sender, direct: true });
    // Both owners confirm at once: two identity agent runs would otherwise race to record a link.
    await Promise.allSettled([t.as("ada").mutation(api.links.confirm, { id: adas.id }), t.as("grace").mutation(api.links.confirm, { id: graces.id })]);
    await settle(t);
    const statuses = [...(await linksOf(t, "ada")), ...(await linksOf(t, "grace"))].filter((l) => l.source === sender);
    assert.equal(statuses.filter((l) => l.status === "active").length, 1, JSON.stringify(statuses));
    assert.equal((await activeRefs(sender)).length, 1, "exactly one link in Resolver");
    assert.notEqual((await deliver(t, "@personalos show my tasks", { from: sender })).refusal?.code, "AMBIGUOUS_IDENTITY");
  }
}));

// ── Lifecycle, revocation, restart ──────────────────────────────────────────

test("14-17: a person sees and unlinks their identities; an unlinked one never resolves again; history stays", () => withApp(async (t) => {
  const id = await link(t, "ada", "sam");
  await link(t, "ada", "sam-phone");
  assert.deepEqual((await linksOf(t, "ada")).map((l) => [l.status, l.source]).sort(), [["active", "sam"], ["active", "sam-phone"]]);
  await t.as("ada").mutation(api.links.revoke, { id });
  // Refused at once, before the identity agent has revoked it in Resolver.
  assert.equal((await deliver(t, "@personalos show my tasks", { from: "sam" })).refusal?.code, "NOT_LINKED");
  await settle(t);
  assert.equal((await deliver(t, "@personalos show my tasks", { from: "sam" })).refusal?.code, "NOT_LINKED");
  assert.deepEqual((await linksOf(t, "ada")).map((l) => [l.status, l.source]), [["active", "sam-phone"]]);
  // The record and Resolver's history remain: created by the link, revoked by the owner's decision.
  const [ref] = await refsFor("sam");
  assert.equal(ref!.state, "revoked");
  const history = await resolver.admin.history(ref!.ref);
  assert.deepEqual(history.entries.map((e: any) => e.action), ["create", "revoke"]);
  assert.match(JSON.stringify(history), /disconnected by ada/);
  // Relinking the same account after unlinking is a new, confirmed link with a new reference.
  await link(t, "ada", "sam");
  assert.equal((await refsFor("sam")).length, 2);
}));

test("21: a restart of Anywhere Aide and of Resolver keeps verified links and revocations", () => withApp(async (t) => {
  await link(t, "ada", "sam");
  const gone = await link(t, "ada", "sam-old");
  await t.as("ada").mutation(api.links.revoke, { id: gone });
  await settle(t);
  await resolver.restart();
  await t.restart();
  assert.deepEqual((await linksOf(t, "ada")).map((l) => [l.status, l.source]), [["active", "sam"]]);
  assert.notEqual((await deliver(t, "@personalos show my tasks", { from: "sam" })).refusal?.code, "NOT_LINKED");
  assert.equal((await deliver(t, "@personalos show my tasks", { from: "sam-old" })).refusal?.code, "NOT_LINKED");
}));

test("22: failed attempts leave no partial link: no Resolver reference, no ownership, and the code state is exact", () => withApp(async (t) => {
  await link(t, "ada", "sam");
  const before = await linksOf(t, "ada");
  // Refused presentations (unknown code, shared conversation, already linked) change nothing anywhere.
  assert.equal((await deliver(t, "link ABCD-EFGH", { from: "gus", direct: true })).refusal?.code, "LINK_CODE_INVALID");
  const graces = await t.as("grace").mutation(api.links.start, {});
  assert.equal((await deliver(t, `link ${graces.code}`, { from: "sam", direct: true })).refusal?.code, "ALREADY_LINKED");
  assert.deepEqual(await linksOf(t, "ada"), before);
  assert.deepEqual(await activeRefs("gus"), []);
  // A confirmation the identity agent refuses leaves nothing recorded, and does not block a legitimate link.
  const later = await t.as("grace").mutation(api.links.start, {});
  await deliver(t, `link ${later.code}`, { from: "gus", direct: true });
  const theirs = await t.as("ada").mutation(api.links.start, {});
  await deliver(t, `link ${theirs.code}`, { from: "gus", direct: true });
  await t.as("ada").mutation(api.links.confirm, { id: theirs.id });
  await settle(t);
  await t.as("grace").mutation(api.links.confirm, { id: later.id }).catch((e) => assert.equal(e.code, "FAILED_PRECONDITION"));
  await settle(t);
  assert.equal((await activeRefs("gus")).length, 1);
  // Ada unlinks gus; Grace can now link it with a new code: the refused attempt held nothing.
  await t.as("ada").mutation(api.links.revoke, { id: theirs.id });
  await settle(t);
  await link(t, "grace", "gus");
  assert.equal(((await resolver.admin.resolve((await activeRefs("gus"))[0]!.ref)).selected.value as any).canonical, "personalos:account:grace");
}));

// ── Identity is not authority ────────────────────────────────────────────────

test("18-20: a link creates and changes no AuthBoundry grant, grants nothing, and leaves the person's own session as it was", () => withApp(async (t) => {
  // Grants to Anywhere Aide's own executor always; an outside agent's too where this FeltKit has them.
  if (AGENTS) await (t.as("ada") as any).action(api.delegation.registerAgent, { id: "eve" });
  await t.as("ada").action(api.delegation.set, { capabilities: ["personalos.tasks.read"] });
  if (AGENTS) await t.as("ada").action(api.delegation.set, { agent: "eve", capabilities: ["tasks.list"] });
  const grants = async (who: string) => JSON.stringify([await t.as(who).action(api.delegation.list, {}), ...(AGENTS ? [await t.as(who).action(api.delegation.list, { agent: "eve" })] : [])]);
  const before = { ada: await grants("ada"), grace: await grants("grace") };
  await t.as("ada").mutation(api.tasks.create, { title: "mine" } as any);
  const id = await link(t, "ada", "sam");
  await link(t, "grace", "gus");
  assert.deepEqual({ ada: await grants("ada"), grace: await grants("grace") }, before, "linking changed no grant");
  // Grace granted Anywhere Aide nothing: her linked account resolves to her and is refused by AuthBoundry.
  const refused = await deliver(t, "@personalos add buy milk to my list", { from: "gus" });
  assert.notEqual(refused.state, "completed", JSON.stringify(refused));
  assert.deepEqual(await t.as("grace").query(api.tasks.list, {}), []);
  // Ada granted reading only: her linked account may read, never create.
  const created = await deliver(t, "@personalos add buy milk to my list", { from: "sam" });
  assert.notEqual(created.state, "completed", JSON.stringify(created));
  assert.deepEqual((await t.as("ada").query(api.tasks.list, {})).map((x: any) => x.title), ["mine"]);
  // Unlinking removes no grant and no person; Ada's own session works as before.
  await t.as("ada").mutation(api.links.revoke, { id });
  await settle(t);
  assert.deepEqual({ ada: await grants("ada"), grace: await grants("grace") }, before, "unlinking changed no grant");
  await t.as("ada").mutation(api.tasks.create, { title: "still mine" } as any);
  assert.deepEqual((await t.as("ada").query(api.tasks.list, {})).map((x: any) => x.title).sort(), ["mine", "still mine"]);
}));

test("audit: each step is recorded with its actor; no code or digest is ever in an audit record or the Resolver value", () => withApp(async (t) => {
  const { id, code } = await t.as("ada").mutation(api.links.start, {});
  await deliver(t, `link ${code}`, { from: "sam", direct: true });
  await deliver(t, "link ZZZZ-ZZZZ", { from: "mallory", direct: true });
  await t.as("ada").mutation(api.links.confirm, { id });
  await settle(t);
  await t.as("ada").mutation(api.links.revoke, { id });
  await settle(t);
  const trail = (await (t.runtime as any).auditTrail()).filter((r: any) => /^(links|interactions):/.test(r.function) || r.principal?.id === "personalos-identity");
  const steps = trail.map((r: any) => [r.function, r.principal?.id]);
  for (const step of [["links:start", "ada"], ["interactions:receive", "multiplayer"], ["links:confirm", "ada"], ["links:revoke", "ada"]]) {
    assert.ok(steps.some((s: string[]) => s[0] === step[0] && s[1] === step[1]), `missing ${step.join(" by ")} in ${JSON.stringify(steps)}`);
  }
  assert.equal(trail.filter((r: any) => r.principal?.id === "personalos-identity").length >= 2, true, "the identity agent's writes (link, revoke) are recorded as its own");
  // The refused attempt is kept: its own committed interaction record, delivered by the bridge.
  const receipts = trail.filter((r: any) => r.function === "interactions:receive" && r.writes.some((w: any) => w.collection === "interactions" && w.op === "insert"));
  assert.equal(receipts.length, 2, "the presentation and the refused attempt each left a record");
  const digest = await hex(code.replace("-", ""));
  const everything = JSON.stringify(trail) + JSON.stringify(await resolver.admin.history((await refsFor("sam"))[0]!.ref));
  assert.ok(!everything.includes(code) && !everything.includes(code.replace("-", "")) && !everything.includes(digest), "a code or its digest reached an audit record");
}));

test("revocation holds before Resolver hears of it: while the link cannot be revoked there, the account is already refused", () => withApp(async (t) => {
  const id = await link(t, "ada", "sam");
  const key = process.env.FELTKIT_CREDENTIAL_RESOLVER_LINK;
  // The identity agent cannot write to Resolver (its key no longer works), so the reference stays active.
  process.env.FELTKIT_CREDENTIAL_RESOLVER_LINK = "app_live_not-a-key";
  try {
    await t.as("ada").mutation(api.links.revoke, { id });
    await settle(t);
    assert.equal((await activeRefs("sam")).length, 1, "Resolver still resolves it");
    assert.equal((await deliver(t, "@personalos show my tasks", { from: "sam" })).refusal?.code, "NOT_LINKED");
  } finally { process.env.FELTKIT_CREDENTIAL_RESOLVER_LINK = key; }
}));

test("a link recorded before ownership claims existed still cannot be taken over by a later confirmation", () => withApp(async (t) => {
  const { lookupEntry } = await import("../feltkit/_resolver.js");
  // Grace's code is presented by sam while sam is not linked to anyone.
  const graces = await t.as("grace").mutation(api.links.start, {});
  await deliver(t, `link ${graces.code}`, { from: "sam", direct: true });
  // Then a link of sam to Ada appears in Resolver that Anywhere Aide holds no claim for (an older link).
  const external = { adapter: "multiplayer", instance: INSTANCE, principalId: "sam" };
  const ref = `ref://identity/personalos/multiplayer/${await hex(INSTANCE)}/${await hex("sam")}/legacy`;
  await resolver.admin.put({ ref, kind: "value", binding: { value: { canonical: "personalos:account:ada", external, verification: { method: "personalos.link-code/dm+owner-confirmed", challengeId: "legacy", verifiedAt: new Date().toISOString() }, linkedAt: new Date().toISOString() } }, expectedRevision: 0, ttlSeconds: 0, lookup: await lookupEntry(external) } as any);
  // Grace's confirmation holds the claim, but the identity agent finds sam already Ada's and refuses.
  await t.as("grace").mutation(api.links.confirm, { id: graces.id });
  await settle(t);
  const [g] = await linksOf(t, "grace");
  assert.deepEqual([g!.status, g!.error], ["presented", "That account is already connected to a different Anywhere Aide account."]);
  assert.deepEqual((await activeRefs("sam")).map((r) => r.ref), [ref]);
  // The refused confirmation released its claim (a held claim would refuse this one), and is refused again.
  await t.as("grace").mutation(api.links.confirm, { id: graces.id });
  await settle(t);
  assert.deepEqual((await linksOf(t, "grace")).map((l) => l.status), ["presented"]);
  assert.deepEqual((await activeRefs("sam")).map((r) => r.ref), [ref]);
}));
