/**
 * X mentions against the REAL AuthBoundry (the published @authboundry/core in tests/authboundry) and a
 * real Resolver, with the LOCAL STAND-IN for the X API (tests/fixtures/x-api.ts; not X). A linked
 * X account's mention is done under Ada's delegation; once that delegation is revoked the next one is
 * refused by AuthBoundry itself and kept as evidence; publishing needs its own delegation.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { CAPABILITIES } from "../feltkit/_authority.js";
import { authboundryInstalled, startRealAuthority, startResolver, type RealAuthority, type TestResolver } from "./fixtures/anywhere.js";
import { startXStub, type XStub } from "./fixtures/x-api.js";

if (process.env.REQUIRE_REAL_AUTHBOUNDRY === "1" && !authboundryInstalled()) throw new Error("REQUIRE_REAL_AUTHBOUNDRY=1 but AuthBoundry is not installed (npm ci --prefix tests/authboundry)");
const SKIP = authboundryInstalled() ? false : "AuthBoundry is not installed here (npm ci --prefix tests/authboundry); CI installs it";
const XA = { id: "x-adapter", type: "service" as const, displayName: "X adapter", roles: ["xadapter"] };

let resolver: TestResolver;
let ab: RealAuthority;
let x: XStub;
before(async () => {
  if (SKIP) return;
  resolver = await startResolver();
  ab = await startRealAuthority({ ada: [...CAPABILITIES] }, CAPABILITIES);
  x = await startXStub();
});
after(async () => { await x?.close(); await ab?.close(); await resolver?.close(); });

test("real AuthBoundry: a linked X mention runs under Ada's delegation; revoked, the next is refused by AuthBoundry and recorded; publishing needs its own delegation", { skip: SKIP }, async () => {
  await ab.delegate("ada-tasks", "ada", ["personalos.tasks.create"]);
  const t = await createTestApp();
  const settle = async () => {
    const jobs = (t.runtime.services as any).jobs;
    for (let i = 0; i < 50; i++) {
      await (t.runtime as any).settleAgents();
      await t.runtime.runServices();
      const due = (await jobs.listJobs("personalos")).filter((j: any) => ["queued", "pending"].includes(j.status) && j.type === "x.reply");
      if (!due.length) return;
      for (const j of due) await jobs.executeJob("personalos", j.id, "test-worker");
    }
  };
  const poll = async () => {
    const st = await t.as(XA).query(api.xsurface.pollState, {});
    await t.as(XA).action(api.xsurface.poll, { chain: st!.chain!, tick: st!.tick ?? 0 });
    await settle();
  };
  try {
    await t.as(XA).mutation(api.xsurface.startPolling, {});
    await settle();
    await poll();
    const { id, code } = await t.as("ada").mutation(api.links.start, { adapter: "x" });
    x.mention({ author: "1001", username: "ada_x", text: `@considered_done link ${code}` });
    await poll();
    await t.as("ada").mutation(api.links.confirm, { id });
    await settle();

    const first = x.mention({ author: "1001", username: "ada_x", text: "@considered_done add a task to send the contract" });
    await poll();
    const a = (await t.as("ada").query(api.invocationstate.get, { invocationId: `x-${first}` })).invocation;
    assert.deepEqual([a.state, a.authority.capability, a.authority.outcome, a.authority.delegationId], ["completed", "personalos.tasks.create", "allow", "ada-tasks"], JSON.stringify(a.updates));

    await ab.revokeDelegation("ada-tasks");
    const second = x.mention({ author: "1001", username: "ada_x", text: "@considered_done add a task to send the invoice" });
    await poll();
    const b = (await t.as("ada").query(api.invocationstate.get, { invocationId: `x-${second}` })).invocation;
    assert.deepEqual([b.state, b.error.code, b.authority.outcome], ["failed", "FORBIDDEN", "deny"]);
    assert.ok(b.authority.decisionId, "AuthBoundry's own decision id");
    assert.equal((await t.as("ada").query(api.tasks.list, {})).length, 1, "only the allowed task exists");

    const denied = await t.as("ada").mutation(api.xsurface.publish, { postId: first, text: "Done, thanks." });
    assert.equal(denied.status, "denied", "no delegation for personalos.x.publish");
    await ab.delegate("ada-publish", "ada", ["personalos.x.publish"]);
    assert.equal((await t.as("ada").mutation(api.xsurface.publish, { postId: first, text: "Done, thanks." })).status, "pending");
    await poll();
    assert.deepEqual(x.replies.filter((r) => r.inReplyTo === first).map((r) => r.text).slice(1), ["Done, thanks."]);
  } finally { await t.close(); await ab.revokeDelegation("ada-publish").catch(() => {}); }
});
