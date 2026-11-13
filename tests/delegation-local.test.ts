/**
 * What PersonalOS may do for a person, granted in Settings (feltkit/delegation.ts), decided by the
 * REAL private AuthBoundry FeltKit runs for PersonalOS (`authority.local`, @authboundry/local): no
 * AUTHBOUNDRY_URL, nothing set up by hand. Requests arrive from Multiplayer for a person resolved by a
 * real Resolver, as in production.
 *
 * Skipped, saying why, unless @authboundry/local is installed and its server keeps granted policy
 * across restarts (an @authboundry/core release after 1.17.3, or AUTHBOUNDRY_CLI_PATH to such a build).
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { CONTRACT } from "../feltkit/_interaction.js";
import { startResolver, type TestResolver } from "./fixtures/anywhere.js";

function skipReason(): string | false {
  const require = createRequire(import.meta.url);
  let local: string;
  try { local = require.resolve("@authboundry/local/package.json"); } catch { return "@authboundry/local is not installed"; }
  if (process.env.AUTHBOUNDRY_CLI_PATH) return false;
  try {
    const core = createRequire(local)("@authboundry/core/package.json").version as string;
    const [a, b, c] = core.split(".").map(Number);
    return a! > 1 || (a === 1 && (b! > 17 || (b === 17 && c! > 3))) ? false : `@authboundry/core ${core} forgets granted policy on restart; set AUTHBOUNDRY_CLI_PATH to a fixed server`;
  } catch { return "@authboundry/core is not installed"; }
}
const SKIP = skipReason();
const BRIDGE = { id: "multiplayer", type: "service" as const, displayName: "Multiplayer bridge", roles: ["bridge"] };

let resolver: TestResolver;
before(async () => {
  if (SKIP) return;
  delete process.env.AUTHBOUNDRY_URL;
  delete process.env.FELTKIT_CREDENTIAL_AUTHBOUNDRY_CHECK;
  resolver = await startResolver();
});
after(async () => { await resolver?.close(); });

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
  await (t.runtime as any).settleAgents();
}
const granted = async (t: TestApp, who: string) => (await t.as(who).action(api.delegation.list, {})).capabilities.filter((c) => c.granted).map((c) => c.id);

test("local authority: what Ada allows in Settings decides what PersonalOS does for her from Multiplayer, and nothing for Grace", { skip: SKIP }, async () => {
  INSTANCE = `local-${Math.random().toString(36).slice(2, 10)}`;
  const t = await createTestApp();
  try {
    await link(t, "ada");
    await link(t, "grace");
    const before = await t.as("ada").action(api.delegation.list, {});
    assert.equal(before.available, true, before.reason ?? "");
    assert.deepEqual(before.capabilities.filter((c) => c.granted), [], "nothing is allowed until Ada allows it");
    assert.equal((await deliver(t, "@personalos add buy flowers to my list", "ada")).state, "refused");

    await t.as("ada").action(api.delegation.set, { capabilities: ["personalos.tasks.create", "personalos.reminders.create"] });
    assert.deepEqual((await granted(t, "ada")).sort(), ["personalos.reminders.create", "personalos.tasks.create"]);
    const r = await deliver(t, "@personalos add buy flowers to my list", "ada");
    assert.equal(r.state, "completed", r.reply);
    const decided = (await t.as("ada").query(api.interactions.list, {})).find((x) => x.intent === "task.create" && x.authority?.outcome === "allow")!.authority!;
    assert.deepEqual([decided.principal, decided.onBehalfOf], ["agent:personalos", "user:ada"]);
    assert.ok(decided.delegationId, "decided by Ada's grant");
    assert.deepEqual((await t.as("ada").query(api.tasks.list, {})).map((x) => x.title), ["Buy flowers"]);

    // Only what she allowed, and only for her.
    assert.equal((await deliver(t, "@personalos remember that my PIN is 1234", "ada", true)).state, "refused");
    assert.equal((await deliver(t, "@personalos add buy flowers to my list", "grace")).state, "refused");
    assert.deepEqual(await granted(t, "grace"), [], "Grace sees only her own (none)");
    assert.equal((await t.as("grace").query(api.tasks.list, {})).length, 0);

    // Turning one off stops it at once; the other stays.
    await t.as("ada").action(api.delegation.set, { capabilities: ["personalos.reminders.create"] });
    assert.deepEqual(await granted(t, "ada"), ["personalos.reminders.create"]);
    assert.equal((await deliver(t, "@personalos add call mum to my list", "ada")).state, "refused");
    assert.equal((await deliver(t, "@personalos remind me to call the bank tomorrow at 9am", "ada")).state, "completed");

    // A guest can't grant; nobody grants what PersonalOS never asks for.
    await assert.rejects(t.as("guest").action(api.delegation.set, { capabilities: ["personalos.tasks.create"] }), /delegation\.write|permission/i);
    await assert.rejects(t.as("ada").action(api.delegation.set, { capabilities: ["personalos.everything"] }), /Not something PersonalOS asks for/);

    // All off.
    await t.as("ada").action(api.delegation.set, { capabilities: [] });
    assert.deepEqual(await granted(t, "ada"), []);
    assert.equal((await deliver(t, "@personalos remind me to water the plants tomorrow at 9am", "ada")).state, "refused");
  } finally {
    await t.close();
  }
});

test("local authority: a grant with an end stops by itself", { skip: SKIP }, async () => {
  INSTANCE = `local-${Math.random().toString(36).slice(2, 10)}`;
  const t = await createTestApp();
  try {
    await link(t, "ada");
    await t.as("ada").action(api.delegation.set, { capabilities: ["personalos.tasks.create"], expiresAt: Date.now() + 3_000 });
    const [c] = (await t.as("ada").action(api.delegation.list, {})).capabilities.filter((x) => x.granted);
    assert.ok(c!.expiresAt && c!.expiresAt > Date.now());
    assert.equal((await deliver(t, "@personalos add buy flowers to my list", "ada")).state, "completed");
    await new Promise((r) => setTimeout(r, 3_500));
    assert.equal((await deliver(t, "@personalos add buy bread to my list", "ada")).state, "refused");
  } finally {
    await t.close();
  }
});
