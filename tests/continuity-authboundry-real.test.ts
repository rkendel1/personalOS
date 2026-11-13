/**
 * Cross-surface continuity against the REAL AuthBoundry (the published @authboundry/core in
 * tests/authboundry) and a real Resolver: research summoned from Chrome, continued in a Multiplayer DM
 * under Ada's delegation for continuing; that delegation revoked, the next continuation is refused by
 * AuthBoundry itself and kept as evidence; Grace can't reach it.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { CONTRACT } from "../feltkit/_interaction.js";
import { CAPABILITIES } from "../feltkit/_authority.js";
import { buildEnvelope } from "../extension/src/summon.js";
import { PAGE_READER } from "../feltkit/research.js";
import { authboundryInstalled, startRealAuthority, startResolver, type RealAuthority, type TestResolver } from "./fixtures/anywhere.js";

if (process.env.REQUIRE_REAL_AUTHBOUNDRY === "1" && !authboundryInstalled()) throw new Error("REQUIRE_REAL_AUTHBOUNDRY=1 but AuthBoundry is not installed (npm ci --prefix tests/authboundry)");
const SKIP = authboundryInstalled() ? false : "AuthBoundry is not installed here (npm ci --prefix tests/authboundry); CI installs it";
const BRIDGE = { id: "multiplayer", type: "service" as const, displayName: "Multiplayer bridge", roles: ["bridge"] };

let resolver: TestResolver;
let ab: RealAuthority;
before(async () => {
  if (SKIP) return;
  resolver = await startResolver();
  ab = await startRealAuthority({ ada: [...CAPABILITIES], grace: [...CAPABILITIES] }, CAPABILITIES);
  (globalThis as any)[PAGE_READER] = async (url: string) => ({ url, finalUrl: url, ms: 1, status: "read", httpStatus: 200, title: "Acme Ops", detail: "", text: "Acme Ops builds internal tools for operations teams.\nOur platform team writes every internal tool in TypeScript." });
});
after(async () => { await ab?.close(); await resolver?.close(); delete (globalThis as any)[PAGE_READER]; });

let seq = 0;
const INSTANCE = `mp-cont-real-${Math.random().toString(36).slice(2, 8)}`;
const mp = (t: TestApp, text: string, from = "ada") => {
  const n = ++seq;
  return t.as(BRIDGE).mutation(api.interactions.receive, { envelope: {
    contract: CONTRACT, source: { adapter: "multiplayer", instance: INSTANCE, eventId: `m-${n}`, sequence: n, receivedAt: Date.now() },
    sender: { sourcePrincipalId: from, displayName: from, timeZone: "America/New_York" },
    conversation: { workspaceId: "ws", workspaceName: "Acme", conversationId: `dm-${from}`, kind: "dm", participantCount: 2, directWithAssistant: true },
    message: { id: `m-${n}`, text, mentions: { assistant: false, handles: [] }, attachments: [] },
    context: { scope: "none", messages: [], limits: { maxMessages: 50, maxChars: 1000, truncated: false } },
    respondTo: { conversationId: `dm-${from}` }, idempotencyKey: `real:${n}:${Math.random()}`,
  } as any });
};
async function settle(t: TestApp) {
  const jobs = (t.runtime.services as any).jobs;
  for (let i = 0; i < 200; i++) {
    await (t.runtime as any).settleAgents();
    await t.runtime.runServices();
    const due = (await jobs.listJobs("personalos")).filter((j: any) => ["queued", "scheduled", "pending"].includes(j.status) && (j.type === "invocation.process" || j.type === "research.step"));
    if (!due.length) return;
    for (const j of due) await jobs.executeJob("personalos", j.id, "test-worker");
  }
}
async function link(t: TestApp, owner: string) {
  const { id, code } = await t.as(owner).mutation(api.links.start, {});
  await mp(t, `link ${code}`, owner);
  await t.as(owner).mutation(api.links.confirm, { id });
  await settle(t);
}

test("real AuthBoundry: Chrome research continued in Multiplayer under Ada's delegation; revoked, the next continuation is refused by AuthBoundry and kept as evidence; Grace can't reach it", { skip: SKIP }, async () => {
  await ab.delegate("ada-research", "ada", ["personalos.research.run"]);
  await ab.delegate("ada-continue", "ada", ["personalos.conversation.continue"]);
  const t = await createTestApp();
  try {
    await link(t, "ada");
    await link(t, "grace");
    const built = buildEnvelope({ invocationId: `browser-real-${Date.now()}`, tab: { url: "https://www.acme-ops.com/", title: "Acme Ops" }, page: null, instruction: "Research this company and tell me whether it could be a customer for FeltKit.", includeSelection: false, now: Date.now(), timeZone: "America/New_York", version: "0.1.0" });
    if ("error" in built) throw new Error(built.error);
    const { conversationId } = await t.as("ada").mutation(api.invocations.submit, { envelope: built.envelope });
    await settle(t);

    const continued = await mp(t, `continue ${conversationId}`);
    assert.equal(continued.state, "completed", continued.reply);
    assert.match(continued.reply, /authority personalos\.research\.run: allow \(delegation ada-research\)/, "the Chrome part's own decision, from when it ran");
    const w1 = await t.as("ada").query(api.continuity.of, { conversationId });
    const cont = w1.entries.find((x: any) => x.kind === "interaction")!;
    assert.deepEqual([cont.authority!.capability, cont.authority!.outcome, cont.authority!.delegationId], ["personalos.conversation.continue", "allow", "ada-continue"], "the continuation's own decision");

    await ab.revokeDelegation("ada-continue");
    const refused = await mp(t, "status");
    assert.equal(refused.state, "refused");
    assert.match(refused.reply, /personalos\.conversation\.continue/);
    const w2 = await t.as("ada").query(api.continuity.of, { conversationId });
    const denial = w2.entries.filter((x: any) => x.kind === "interaction").at(-1)!;
    assert.deepEqual([denial.state, denial.authority!.outcome], ["refused", "deny"], "the denial, with AuthBoundry's decision, is in the history");
    assert.ok(denial.authority!.decisionId, "AuthBoundry's decision id");

    const grace = await mp(t, `continue ${conversationId}`, "grace");
    assert.deepEqual([grace.state, grace.refusal?.code, grace.conversationId], ["refused", "NOT_FOUND", null]);
  } finally { await t.close(); await ab.revokeDelegation("ada-research").catch(() => {}); }
});
