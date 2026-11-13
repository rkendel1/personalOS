/**
 * Shared-to-PersonalOS invocations against the REAL AuthBoundry server (the published @authboundry/core
 * pinned in tests/authboundry). The person's delegation to agent:personalos decides, when the work runs
 * and before every research step; revoking it in AuthBoundry stops the next step.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { INVOCATION_CONTRACT } from "../feltkit/_invocation.js";
import { CAPABILITIES } from "../feltkit/_authority.js";
import { PAGE_READER } from "../feltkit/research.js";
import { authboundryInstalled, startRealAuthority, type RealAuthority } from "./fixtures/anywhere.js";

if (process.env.REQUIRE_REAL_AUTHBOUNDRY === "1" && !authboundryInstalled()) throw new Error("REQUIRE_REAL_AUTHBOUNDRY=1 but AuthBoundry is not installed (npm ci --prefix tests/authboundry)");
const SKIP = authboundryInstalled() ? false : "AuthBoundry is not installed here (npm ci --prefix tests/authboundry); CI installs it";

let ab: RealAuthority;
before(async () => {
  if (SKIP) return;
  ab = await startRealAuthority({ ada: [...CAPABILITIES] }, CAPABILITIES);
  (globalThis as any)[PAGE_READER] = async (url: string) => ({ url, finalUrl: url, ms: 1, status: "read", httpStatus: 200, title: "Acme Ops", detail: "", text: "Acme Ops builds internal tools for operations teams.\nOur platform team writes every internal tool in TypeScript and is moving approvals to agent workflows this year." });
});
after(async () => { await ab?.close(); delete (globalThis as any)[PAGE_READER]; });

let n = 0;
const envelope = (instruction: string) => ({ contract: INVOCATION_CONTRACT, invocationId: `real-${Date.now()}-${++n}`, surface: { adapter: "ios-share" }, instruction, context: [{ kind: "url", url: "https://www.acme-ops.com/", title: "Acme Ops" }], submittedAt: Date.now(), timeZone: "America/New_York" }) as any;
async function settle(t: TestApp, only?: string) {
  const jobs = (t.runtime.services as any).jobs;
  for (let i = 0; i < 200; i++) {
    await t.runtime.runServices();
    const due = (await jobs.listJobs("personalos")).filter((j: any) => ["queued", "scheduled", "pending"].includes(j.status) && (!only || j.type === only));
    if (!due.length) return;
    for (const j of due) await jobs.executeJob("personalos", j.id, "test-worker");
    if (only) return;
  }
}
const RESEARCH = "Research this company and tell me whether it could be a customer for FeltKit.";

test("real AuthBoundry: a shared page is researched under Ada's delegation, with AuthBoundry's own decision and delegation ids", { skip: SKIP }, async () => {
  await ab.delegate("ada-share-research", "ada", ["personalos.research.run"]);
  const t = await createTestApp();
  try {
    const e = envelope(RESEARCH);
    await t.as("ada").mutation(api.invocations.submit, { envelope: e });
    await settle(t);
    const { invocation } = await t.as("ada").query(api.invocationstate.get, { invocationId: e.invocationId });
    assert.equal(invocation.state, "completed");
    assert.deepEqual([invocation.authority.outcome, invocation.authority.delegationId, invocation.authority.onBehalfOf, invocation.authority.principal], ["allow", "ada-share-research", "user:ada", "agent:personalos"]);
    assert.ok(invocation.authority.decisionId, "AuthBoundry's decision id is the evidence");
  } finally { await t.close(); await ab.revokeDelegation("ada-share-research"); }
});

test("real AuthBoundry: a capability Ada did not delegate is refused when the work runs; nothing is done", { skip: SKIP }, async () => {
  await ab.delegate("ada-share-research-only", "ada", ["personalos.research.run"]);
  const t = await createTestApp();
  try {
    const e = envelope("Remember this");
    await t.as("ada").mutation(api.invocations.submit, { envelope: e });
    await settle(t);
    const { invocation } = await t.as("ada").query(api.invocationstate.get, { invocationId: e.invocationId });
    assert.deepEqual([invocation.state, invocation.error.code, invocation.authority.capability, invocation.authority.outcome], ["failed", "FORBIDDEN", "personalos.memory.write", "deny"]);
    assert.ok(!(await t.as("ada").query(api.memory.list, {})).some((m: any) => /Saved from iOS/.test(m.content)));
  } finally { await t.close(); await ab.revokeDelegation("ada-share-research-only"); }
});

test("real AuthBoundry: revoking the delegation after the work started stops the next research step", { skip: SKIP }, async () => {
  await ab.delegate("ada-share-revocable", "ada", ["personalos.research.run"]);
  const t = await createTestApp();
  try {
    const e = envelope(RESEARCH);
    await t.as("ada").mutation(api.invocations.submit, { envelope: e });
    await settle(t, "invocation.process");
    assert.equal((await t.as("ada").query(api.invocationstate.get, { invocationId: e.invocationId })).invocation.state, "processing");
    await ab.revokeDelegation("ada-share-revocable");
    await settle(t);
    const { invocation } = await t.as("ada").query(api.invocationstate.get, { invocationId: e.invocationId });
    const { run, prospects } = await t.as("ada").query(api.research.get, { runId: invocation.work.researchRunId });
    assert.deepEqual([run.status, run.blocker.state, prospects.length], ["blocked", "needs-authorization", 0]);
    assert.deepEqual([invocation.state, invocation.error.code], ["failed", "BLOCKED"]);
  } finally { await t.close(); }
});
