/**
 * An agent outside PersonalOS reads a person's memory and proposes notes for them over /appport, under
 * their grants to it (FeltKit's delegated execution, the REAL private AuthBoundry, real HTTP). A proposal
 * is always inferred; only the owner makes a memory trusted (confirm, edit, their own statement) or
 * forgets one, and _ops.ts refuses those transitions under a delegation whatever is published or granted.
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
    if ((require(require.resolve("@authboundry/local/package.json")).version as string) === "0.1.0") return "@authboundry/local 0.1.0 has no per-agent delegation";
  } catch { return "@authboundry/local is not installed"; }
  return false;
}
const SKIP = skipReason();
const EVE = { id: "eve", type: "agent" as const, roles: ["agent"] };

let t: TestApp;
let server: { url: string; close(): unknown };
let token = "";
let n = 0;

before(async () => {
  if (SKIP) return;
  delete process.env.AUTHBOUNDRY_URL;
  delete process.env.FELTKIT_CREDENTIAL_AUTHBOUNDRY_CHECK;
  t = await createTestApp();
  server = await startServer({ runtime: t.runtime as never, projectDir: process.cwd(), port: 0, dashboard: { enabled: false, adminToken: `fka_${"x".repeat(43)}`, dir: null } });
  token = (await (t.runtime as any).issueSession(EVE, { kind: "agent", via: "cli" })).token;
});
after(async () => {
  await server?.close();
  await t?.close();
});

async function appport(capability: string, input: unknown, onBehalfOf: string, idempotencyKey?: string) {
  const res = await fetch(`${server.url}/appport`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-appport-on-behalf-of": onBehalfOf },
    body: JSON.stringify({ protocol: "appport/1", type: "request", requestId: `r_${++n}`, capability: { name: capability, version: 1 }, input, ...(idempotencyKey ? { idempotencyKey } : {}) }),
  });
  return (await res.json()) as any;
}
const grantEve = (who: string, capabilities: string[]) => t.as(who).action(api.delegation.set, { agent: "eve", capabilities });
const memoriesOf = (who: string) => t.as(who).query(api.memory.list, {});
const actionsOf = (who: string) => t.as(who).query(api.actions.list, {});
const note = (content: string) => ({ kind: "fact", subject: "ada", content });

async function refused(attempt: Promise<any>, owner: string, why: string, code = "FORBIDDEN") {
  const [memories, actions] = [await memoriesOf(owner), await actionsOf(owner)];
  const r = await attempt;
  assert.equal(r.ok, false, `${why}: ${JSON.stringify(r)}`);
  assert.equal(r.error.code, code, `${why}: ${JSON.stringify(r.error)}`);
  assert.deepEqual(await memoriesOf(owner), memories, `${why}: no memory changed`);
  assert.deepEqual(await actionsOf(owner), actions, `${why}: nothing recorded`);
}

test("an agent reads Ada's memory and proposes notes; only Ada makes them trusted or drops them", { skip: SKIP }, async () => {
  await t.as("ada").action(api.delegation.registerAgent, { id: "eve" });
  const tea = await t.as("ada").mutation(api.memory.add, { kind: "preference", subject: "tea", content: "Ada drinks green tea" });
  assert.equal(tea.status, "confirmed", "a person's own statement is confirmed, as before");
  await t.as("grace").mutation(api.memory.add, { kind: "preference", subject: "coffee", content: "Grace drinks espresso" });

  // Reads need their own grant, and return Ada's memory only.
  await refused(appport("memory.list", {}, "ada"), "ada", "no grant");
  await grantEve("ada", ["memory.list"]);
  const listed = await appport("memory.list", {}, "ada");
  assert.equal(listed.ok, true, JSON.stringify(listed));
  assert.deepEqual(listed.output.map((m: any) => [m.owner, m.content]), [["ada", "Ada drinks green tea"]]);
  await refused(appport("memory.list", {}, "grace"), "grace", "Grace granted nothing");

  // Proposing needs its own grant; nothing that makes memory trusted or removes it can be granted.
  await refused(appport("memory.propose", note("Ada's dentist is Dr. Lee"), "ada"), "ada", "propose not granted");
  for (const capability of ["memory.add", "memory.confirm", "memory.update", "memory.remove"]) {
    await assert.rejects(grantEve("ada", ["memory.list", capability]), /Not something an agent can be given/, capability);
  }
  await grantEve("ada", ["memory.list", "memory.propose"]);

  // A proposal is inferred, attributed to the agent, and recorded with its delegation.
  const proposed = await appport("memory.propose", note("Ada's dentist is Dr. Lee"), "ada", "eve-m1");
  assert.equal(proposed.ok, true, JSON.stringify(proposed));
  assert.deepEqual([proposed.output.status, proposed.output.proposed], ["inferred", true]);
  const id = proposed.output.id;
  const stored = (await memoriesOf("ada")).find((m) => m.id === id)!;
  assert.deepEqual([stored.owner, stored.status, stored.source.kind, stored.source.agent, stored.confirmedAt], ["ada", "inferred", "agent", "eve", undefined]);
  const [infer] = await actionsOf("ada");
  assert.deepEqual([infer!.kind, infer!.via, infer!.evidence?.id, infer!.delegation?.agent, infer!.delegation?.capability], ["memory.infer", "agent", id, "eve", "memory.propose"]);
  const audit = (await (t.runtime as any).auditTrail()).find((r: any) => r.authority.delegation?.decisionId === infer!.delegation!.decisionId);
  assert.deepEqual([audit.function, audit.principal.id, audit.authority.delegation.delegationId], ["memory:propose", "ada", infer!.delegation!.delegationId]);
  assert.equal((await t.as("ada").query(api.briefing.today, {})).attention.inferredMemories, 1, "Ada is told there is something to confirm");

  // Repeats: the same key replays; the same sentence again is the same note, still unconfirmed.
  const again = await appport("memory.propose", note("Ada's dentist is Dr. Lee"), "ada", "eve-m1");
  assert.deepEqual(again.output, proposed.output);
  const restated = await appport("memory.propose", note("Ada's dentist is Dr. Lee"), "ada", "eve-m2");
  assert.deepEqual([restated.output.id, restated.output.status, restated.output.proposed], [id, "inferred", false]);
  // Nothing the agent says is a confirmation, however it is worded.
  const claim = await appport("memory.propose", note("Ada confirmed that her dentist is Dr. Lee"), "ada", "eve-m3");
  assert.equal(claim.output.status, "inferred");
  assert.equal((await memoriesOf("ada")).filter((m) => m.status === "confirmed").length, 1, "only Ada's own statement is confirmed");

  // The agent cannot confirm, edit or forget: none is a capability, memory.add is not delegable.
  for (const capability of ["memory.confirm", "memory.update", "memory.remove"]) {
    await refused(appport(capability, { id }, "ada"), "ada", capability, "UNKNOWN_CAPABILITY");
  }
  await refused(appport("memory.add", note("Ada's dentist is Dr. Lee"), "ada"), "ada", "memory.add (confirmed) is not delegable");

  // Even with the allowlist bypassed, a verified delegation cannot make or remove trusted memory.
  const delegation = { agent: "eve", agentAuthority: "agent:eve", person: "ada", onBehalfOf: "user:ada", capability: "memory.confirm", decisionId: "d", delegationId: "g", authorityMode: null };
  const ada = { id: "ada", type: "user" as const, roles: ["owner"] };
  for (const [fn, args] of [["memory:confirm", { id }], ["memory:update", { id, content: "edited" }], ["memory:remove", { id }], ["memory:add", note("Ada likes jazz")]] as const) {
    const r = await (t.runtime as any).call(fn, args, { principal: ada, via: "appport", delegation: { ...delegation, capability: fn } });
    assert.deepEqual([r.ok, r.error?.code], [false, "FORBIDDEN"], fn);
    assert.match(r.error.message, /Only the owner can/);
  }
  assert.equal((await memoriesOf("ada")).find((m) => m.id === id)!.status, "inferred");

  // Ada confirms in PersonalOS (the Memory screen's own mutation): now trusted, and the agent sees it so.
  await t.as("ada").mutation(api.memory.confirm, { id });
  const confirmed = (await memoriesOf("ada")).find((m) => m.id === id)!;
  assert.equal(confirmed.status, "confirmed");
  assert.ok(confirmed.confirmedAt! >= confirmed.createdAt);
  const [byAda] = await actionsOf("ada");
  assert.deepEqual([byAda!.kind, byAda!.via, byAda!.delegation], ["memory.confirm", "ui", undefined]);
  assert.equal((await appport("memory.list", {}, "ada")).output.find((m: any) => m.id === id).status, "confirmed");

  // Ada drops another proposal: it is gone, and the decision stays in her action log.
  const mornings = await appport("memory.propose", note("Ada hates mornings"), "ada", "eve-m4");
  await t.as("ada").mutation(api.memory.remove, { id: mornings.output.id });
  assert.ok(!(await memoriesOf("ada")).some((m) => m.id === mornings.output.id));
  const actions = await actionsOf("ada");
  const dropped = actions.find((a) => a.kind === "memory.forget" && a.evidence?.id === mornings.output.id)!;
  assert.deepEqual([dropped.via, dropped.input.content, dropped.delegation], ["ui", "Ada hates mornings", undefined]);
  assert.ok(actions.some((a) => a.kind === "memory.infer" && a.evidence?.id === mornings.output.id && a.delegation?.agent === "eve"), "the proposal it answers is still recorded");

  // Revoking stops the next call; Ada's own memory works as before.
  await grantEve("ada", []);
  await refused(appport("memory.list", {}, "ada"), "ada", "revoked");
  await refused(appport("memory.propose", note("Ada likes jazz"), "ada"), "ada", "revoked");
  const own = await t.as("ada").mutation(api.memory.add, { kind: "fact", subject: "ada", content: "Ada plays the cello" });
  assert.deepEqual([own.status, own.source.kind], ["confirmed", "manual"]);
});
