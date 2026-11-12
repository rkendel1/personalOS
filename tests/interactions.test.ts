/**
 * PersonalOS Anywhere, the PersonalOS side: interactions delivered by a connected surface's bridge
 * (personalos.interaction/1), on the real FeltKit runtime and an isolated FeltDB instance.
 * The Multiplayer side (the adapter) is tested in the multiplayer repository; the two together in
 * its e2e/personalos-anywhere.e2e.mjs.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { api } from "../feltkit/_generated/api.js";
import { CONTRACT } from "../feltkit/_interaction.js";
import { startAuthority, startResolver, type TestAuthority, type TestResolver } from "./fixtures/anywhere.js";

let resolver: TestResolver;
let authority: TestAuthority;
before(async () => { resolver = await startResolver(); authority = await startAuthority(); });
after(async () => { await authority.close(); await resolver.close(); });
/** Each test is its own Multiplayer installation, so links in the shared Resolver never cross tests. */
let INSTANCE = "mp-test";

/** The Multiplayer bridge: an operator-issued service session with role "bridge" (and nothing else). */
const BRIDGE = { id: "multiplayer", type: "service" as const, displayName: "Multiplayer bridge", roles: ["bridge"] };
const OTHER_BRIDGE = { id: "slackbridge", type: "service" as const, roles: ["bridge"] };

let seq = 0;
type Opts = { from?: string; name?: string; kind?: "public" | "private" | "dm" | "group"; direct?: boolean; thread?: string; context?: Array<{ id: string; author: string; text: string; requester?: boolean }>; key?: string; sequence?: number; adapter?: string; claimed?: Record<string, string>; channel?: string; instance?: string };

function envelope(text: string, o: Opts = {}) {
  const n = ++seq;
  const from = o.from ?? "ada";
  const kind = o.kind ?? (o.direct ? "dm" : "public");
  const context = (o.context ?? []).map((m, i) => ({ id: m.id, authorSourcePrincipalId: m.author.toLowerCase(), authorName: m.author, authorKind: "human" as const, isRequester: !!m.requester, text: m.text, at: Date.UTC(2026, 10, 10, 9, i), attachments: [] }));
  return {
    contract: CONTRACT,
    source: { adapter: o.adapter ?? "multiplayer", instance: o.instance ?? INSTANCE, eventId: `msg-${n}`, sequence: o.sequence ?? n, receivedAt: Date.now() },
    sender: { sourcePrincipalId: from, displayName: o.name ?? from, timeZone: "America/New_York", ...(o.claimed ? { claimed: o.claimed } : {}) },
    conversation: { workspaceId: "ws-acme", workspaceName: "Acme", conversationId: o.channel ?? (o.direct ? `dm-${from}` : "ch-general"), kind, name: o.direct ? undefined : "general", ...(o.thread ? { threadId: o.thread } : {}), participantCount: o.direct ? 2 : 5, directWithAssistant: !!o.direct },
    message: { id: `msg-${n}`, text, mentions: { assistant: !o.direct, handles: o.direct ? [] : ["personalos"] }, attachments: [] },
    context: { scope: (o.thread ? "thread" : context.length ? "channel" : "none") as "thread" | "channel" | "none", messages: context, limits: { maxMessages: 50, maxChars: 1000, truncated: false } },
    respondTo: { conversationId: o.channel ?? "ch-general", ...(o.thread ? { threadId: o.thread } : {}) },
    idempotencyKey: o.key ?? `mp-test:msg-${n}`,
  };
}

const deliver = (t: TestApp, text: string, o: Opts = {}) => t.as(BRIDGE).mutation(api.interactions.receive, { envelope: envelope(text, o) as any });
/** Deliver, and keep the source idempotency key (what the surface keeps to ask for updates). */
async function deliverKeyed(t: TestApp, text: string, o: Opts = {}) {
  const e = envelope(text, o);
  return { ...(await t.as(BRIDGE).mutation(api.interactions.receive, { envelope: e as any })), key: e.idempotencyKey };
}

/** Link a source identity to a PersonalOS account the real way: a code here, redeemed in a DM there. */
async function link(t: TestApp, owner: string, source: string) {
  const { code } = await t.as(owner).mutation(api.links.start, {});
  const r = await deliver(t, `link ${code}`, { from: source, direct: true });
  assert.equal(r.state, "completed", r.reply);
  return r;
}

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: any) => (e?.code === code ? true : assert.fail(`expected ${code}, got ${e?.code}: ${e?.message}`)));
}

async function withApp(fn: (t: TestApp) => Promise<void>) {
  INSTANCE = `mp-test-${Math.random().toString(36).slice(2, 10)}`;
  authority.mode = "up";
  authority.policy.clear();
  authority.grant("ada");
  authority.grant("grace");
  const t = await createTestApp();
  try { await fn(t); } finally { await t.close(); }
}

// ── Identity and linking ─────────────────────────────────────────────────────

test("linking: a code issued in PersonalOS, redeemed by the authenticated sender in a DM, binds that sender to that account", () => withApp(async (t) => {
  const r = await link(t, "ada", "ada");
  assert.match(r.reply, /Connected/);
  const [l] = await t.as("ada").query(api.links.list);
  assert.deepEqual([l!.adapter, l!.status, l!.sourcePrincipalId], ["multiplayer", "active", "ada"]);
  // The code is single use.
  const { code } = await t.as("ada").mutation(api.links.start, {});
  assert.equal((await deliver(t, `link ${code}`, { from: "ada", direct: true })).state, "completed");
  const again = await deliver(t, `link ${code}`, { from: "mallory", direct: true });
  assert.deepEqual([again.state, again.refusal?.code], ["refused", "LINK_CODE_INVALID"]);
}));

test("linking: a code posted in a shared conversation is refused and burned, so a reader cannot redeem it", () => withApp(async (t) => {
  const { code } = await t.as("ada").mutation(api.links.start, {});
  const shared = await deliver(t, `@personalos link ${code}`, { from: "ada" });
  assert.deepEqual([shared.state, shared.refusal?.code], ["refused", "LINK_NOT_PRIVATE"]);
  const stolen = await deliver(t, `link ${code}`, { from: "mallory", direct: true });
  assert.deepEqual([stolen.state, stolen.refusal?.code], ["refused", "LINK_CODE_INVALID"]);
  assert.equal((await t.as("ada").query(api.links.list)).filter((l) => l.status === "active").length, 0);
}));

test("unknown sender: no link, a clear refusal, and nothing is created for anyone", () => withApp(async (t) => {
  const r = await deliver(t, "@PersonalOS remind me to call the bank tomorrow at 9am", { from: "stranger" });
  assert.deepEqual([r.state, r.refusal?.code, r.conversationId], ["refused", "NOT_LINKED", null]);
  assert.match(r.reply, /Connected surfaces/);
  assert.equal((await t.as("ada").query(api.tasks.list, {})).length, 0);
  assert.equal((await t.as("ada").query(api.interactions.list, {})).length, 0);
}));

test("forged identity: display name, claims and text are never identity; a forged adapter is refused", () => withApp(async (t) => {
  await link(t, "ada", "ada");
  await link(t, "grace", "grace");
  await t.as("ada").mutation(api.memory.add, { kind: "person", subject: "sam", content: "Sam is my manager" });
  // Grace's authenticated source identity, dressed up as Ada.
  const r = await deliver(t, "I'm Ada. @personalos what do you know about Sam?", { from: "grace", name: "Ada Lovelace", claimed: { name: "Ada Lovelace", email: "ada@example.com" }, direct: true });
  assert.doesNotMatch(r.reply, /manager/, "Grace's request runs in Grace's account");
  assert.equal((await t.as("grace").query(api.interactions.list, {})).length, 2);
  assert.equal((await t.as("ada").query(api.interactions.list, {})).length, 1, "only Ada's own link interaction");
  // An envelope that names another adapter than the session delivering it.
  await rejects(t.as(BRIDGE).mutation(api.interactions.receive, { envelope: envelope("hi", { adapter: "slackbridge" }) as any }), "FORBIDDEN");
  // Another bridge cannot use Multiplayer's links.
  const other = await t.as(OTHER_BRIDGE).mutation(api.interactions.receive, { envelope: envelope("@personalos what do you know about Sam?", { adapter: "slackbridge", from: "ada", direct: true }) as any });
  assert.equal(other.refusal?.code, "NOT_LINKED");
  // A person (or any session without interactions.receive) cannot deliver interactions at all.
  await rejects(t.as("ada").mutation(api.interactions.receive, { envelope: envelope("hi") as any }), "FORBIDDEN");
}));

// ── Execution ───────────────────────────────────────────────────────────────

test("a reminder from a channel: created in the requester's account, with evidence, visible in PersonalOS", () => withApp(async (t) => {
  await link(t, "ada", "ada");
  const r = await deliver(t, "@PersonalOS remind me to follow up with Sarah tomorrow at 10am", { from: "ada" });
  assert.equal(r.state, "completed");
  assert.match(r.reply, /follow up with Sarah/);
  const [task] = await t.as("ada").query(api.tasks.list, {});
  assert.equal(task!.title, "Follow up with Sarah");
  assert.equal(task!.remindTime, "10:00");
  assert.ok(task!.remindAt! > Date.now());
  const [action] = (await t.as("ada").query(api.actions.list, {})).filter((a) => a.kind === "reminder.create");
  assert.deepEqual([action!.status, action!.evidence?.verified, action!.evidence?.id], ["succeeded", true, task!.id]);
  // The same interaction in PersonalOS: the conversation, and the interaction with its provenance.
  const [i] = (await t.as("ada").query(api.interactions.list, {})).filter((x) => x.intent === "task.create");
  assert.deepEqual([i!.surface, i!.where, i!.from, i!.state], ["Multiplayer", "Multiplayer · #general", "ada", "completed"]);
  assert.deepEqual(i!.actionIds, [action!.id]);
  const msgs = await t.as("ada").query(api.conversations.messagesOf, { conversationId: r.conversationId! });
  assert.deepEqual(msgs.map((m) => m.role), ["user", "assistant"]);
  assert.equal(msgs[0]!.text, "remind me to follow up with Sarah tomorrow at 10am");
  // Grace sees none of it.
  assert.equal((await t.as("grace").query(api.tasks.list, {})).length, 0);
  await rejects(t.as("grace").query(api.conversations.messagesOf, { conversationId: r.conversationId! }), "NOT_FOUND");
}));

test("duplicate and replayed delivery execute once (also across a restart)", () => withApp(async (t) => {
  await link(t, "ada", "ada");
  const e = envelope("@personalos add renew passport to my list", { from: "ada" });
  const first = await t.as(BRIDGE).mutation(api.interactions.receive, { envelope: e as any });
  const again = await t.as(BRIDGE).mutation(api.interactions.receive, { envelope: e as any });
  assert.deepEqual([first.replayed, again.replayed, again.interactionId, again.reply], [false, true, first.interactionId, first.reply]);
  await t.restart();
  const later = await t.as(BRIDGE).mutation(api.interactions.receive, { envelope: e as any });
  assert.equal(later.replayed, true);
  assert.equal((await t.as("ada").query(api.tasks.list, {})).length, 1);
  assert.equal((await t.as("ada").query(api.actions.list, {})).filter((a) => a.kind === "task.create").length, 1);
}));

test("clarification: PersonalOS asks, the answer in the same thread completes the request; out-of-order never merges backwards", () => withApp(async (t) => {
  await link(t, "ada", "ada");
  const q = await deliver(t, "@personalos remind me to follow up with Sarah", { from: "ada", thread: "root-1", sequence: 10 });
  assert.equal(q.state, "needs_clarification");
  assert.match(q.reply, /When should I remind you/);
  const a = await deliver(t, "@personalos tomorrow at 10am", { from: "ada", thread: "root-1", sequence: 11 });
  assert.equal(a.state, "completed", a.reply);
  assert.equal(a.conversationId, q.conversationId, "one PersonalOS conversation per source thread");
  assert.equal((await t.as("ada").query(api.tasks.list, {}))[0]?.title, "Follow up with Sarah");

  // Out of order: the answer (seq 21) arrives before the question (seq 20). It is not merged into a later question.
  const early = await deliver(t, "@personalos friday at 3pm", { from: "ada", thread: "root-2", sequence: 21 });
  assert.notEqual(early.state, "awaiting_approval");
  const late = await deliver(t, "@personalos remind me to email Omar", { from: "ada", thread: "root-2", sequence: 20 });
  assert.equal(late.state, "needs_clarification");
  assert.equal((await t.as("ada").query(api.tasks.list, {})).length, 1);
}));

test("approval: a destructive request waits for the owner in PersonalOS; approve and deny are reflected as updates", () => withApp(async (t) => {
  await link(t, "ada", "ada");
  await t.as("ada").mutation(api.tasks.create, { title: "Renew passport (confidential case 4471)" });
  await t.as("ada").mutation(api.tasks.create, { title: "Old draft" });
  const r = await deliverKeyed(t, "@personalos delete renew passport", { from: "ada" });
  assert.equal(r.state, "awaiting_approval");
  assert.ok(r.approval?.actionId);
  assert.match(r.reply, /needs your approval/);
  assert.match(r.approval!.reason, /permanent/);
  assert.doesNotMatch(r.reply, /4471/, "the shared reply does not reveal the private task title");
  assert.equal((await t.as("ada").query(api.tasks.list, {})).length, 2, "nothing deleted before approval");
  // The bridge cannot approve.
  await rejects(t.as(BRIDGE).mutation(api.actions.approve, { id: r.approval!.actionId }), "FORBIDDEN");
  // The owner approves in PersonalOS (the existing approval workflow).
  await t.as("ada").mutation(api.actions.approve, { id: r.approval!.actionId });
  const s = await t.as(BRIDGE).query(api.interactions.status, { key: r.key, afterSeq: r.updateSeq });
  assert.deepEqual([s.state, s.updates.map((u) => u.text)], ["completed", ["Approved in PersonalOS and done."]]);
  assert.deepEqual((await t.as("ada").query(api.tasks.list, {})).map((x) => x.title), ["Old draft"]);

  // Denied.
  const d = await deliverKeyed(t, "@personalos delete old draft", { from: "ada" });
  await t.as("ada").mutation(api.actions.reject, { id: d.approval!.actionId });
  const ds = await t.as(BRIDGE).query(api.interactions.status, { key: d.key, afterSeq: 0 });
  assert.equal(ds.state, "cancelled");
  assert.equal(ds.updates.at(-1)!.text, "Declined in PersonalOS. Nothing was changed.");
  assert.equal((await t.as("ada").query(api.tasks.list, {})).length, 1);
}));

test("cancellation by the requester declines the pending proposal; nobody else can cancel", () => withApp(async (t) => {
  await link(t, "ada", "ada");
  await t.as("ada").mutation(api.tasks.create, { title: "Quarterly report" });
  const e = envelope("@personalos delete quarterly report", { from: "ada" });
  const r = await t.as(BRIDGE).mutation(api.interactions.receive, { envelope: e as any });
  await rejects(t.as(BRIDGE).mutation(api.interactions.cancel, { key: e.idempotencyKey, sourcePrincipalId: "grace" }), "FORBIDDEN");
  const c = await t.as(BRIDGE).mutation(api.interactions.cancel, { key: e.idempotencyKey, sourcePrincipalId: "ada" });
  assert.equal(c.state, "cancelled");
  const action = (await t.as("ada").query(api.actions.list, {})).find((a) => a.id === r.approval!.actionId)!;
  assert.equal(action.status, "rejected");
  assert.equal((await t.as("ada").query(api.tasks.list, {})).length, 1);
  await rejects(t.as("ada").mutation(api.actions.approve, { id: action.id }), "FAILED_PRECONDITION");
  // Cancelling again changes nothing.
  assert.deepEqual((await t.as(BRIDGE).mutation(api.interactions.cancel, { key: e.idempotencyKey, sourcePrincipalId: "ada" })).updates, []);
}));

test("execution failure is reported as failed, honestly, and changes nothing", () => withApp(async (t) => {
  await link(t, "ada", "ada");
  await deliver(t, "@personalos start a project called Website relaunch", { from: "ada", direct: true });
  const r = await deliver(t, "@personalos start a project called Website relaunch", { from: "ada", direct: true });
  assert.equal(r.state, "failed");
  assert.match(r.reply, /couldn't do that: You already have a project called "Website relaunch"\. Nothing was changed/);
  assert.equal((await t.as("ada").query(api.projects.list)).length, 1);
}));

test("unsupported requests are answered honestly: nothing is invented and nothing is done", () => withApp(async (t) => {
  await link(t, "ada", "ada");
  for (const text of ["@PersonalOS investigate why this deployment failed", "@PersonalOS draft a response to this customer"]) {
    const r = await deliver(t, text, { from: "ada" });
    assert.equal(r.state, "completed");
    assert.match(r.reply, /can't do that from here/);
  }
  assert.equal((await t.as("ada").query(api.actions.list, {})).length, 0);
}));

// ── Context and privacy ─────────────────────────────────────────────────────

const LAUNCH = [
  { id: "m1", author: "Grace", text: "We decided to ship the release on March 3." },
  { id: "m2", author: "Alan", text: "Risk: the payment migration is still flaky." },
  { id: "m3", author: "Grace", text: "I'll write the release notes by Friday." },
  { id: "m4", author: "Ada", text: "Alan, can you fix the flaky payment test?", requester: true },
  { id: "m5", author: "Alan", text: "Should we tell support before launch?" },
];

test("thread context: summary, decisions and action items read only the conversation, and cite it", () => withApp(async (t) => {
  await link(t, "ada", "ada");
  const sum = await deliver(t, "@PersonalOS summarize this conversation", { from: "ada", thread: "t1", context: LAUNCH });
  assert.equal(sum.state, "completed");
  assert.match(sum.reply, /3 people \(Grace, Alan, Ada\)/);
  assert.match(sum.reply, /We decided to ship the release on March 3/);
  assert.match(sum.reply, /Should we tell support before launch\?/);
  const dec = await deliver(t, "@PersonalOS what did we decide about the release?", { from: "ada", thread: "t1", context: LAUNCH });
  assert.match(dec.reply, /ship the release on March 3 — Grace/);
  const none = await deliver(t, "@PersonalOS what did we decide about pricing?", { from: "ada", thread: "t1", context: LAUNCH });
  assert.match(none.reply, /don't see a decision about pricing/);
  const items = await deliver(t, "@PersonalOS create tasks from the action items in this thread", { from: "ada", thread: "t1", context: LAUNCH });
  assert.match(items.reply, /Added 2 tasks/);
  const tasks = await t.as("ada").query(api.tasks.list, {});
  assert.deepEqual(tasks.map((x) => x.title).sort(), ["Alan, can you fix the flaky payment test? (Alan)", "Write the release notes by Friday (Grace)"]);
  assert.ok(tasks.every((x) => /Source message: m[34]/.test(x.notes ?? "")), "each task cites its source message");
  const [i] = (await t.as("ada").query(api.interactions.list, {})).filter((x) => x.intent === "conversation.actionItems");
  assert.deepEqual(i!.provenance.messageIds.sort(), [i!.provenance.messageIds.find((x) => x.startsWith("msg-"))!, "m3", "m4"].sort());
  assert.equal(i!.provenance.privateDataUsed, false);
  assert.equal(sum.conversationId, items.conversationId);
}));

test("a mention in a shared conversation never exposes the owner's private data; a DM with PersonalOS may", () => withApp(async (t) => {
  await link(t, "ada", "ada");
  await t.as("ada").mutation(api.memory.add, { kind: "person", subject: "sam", content: "Sam is my manager and is on medical leave" });
  await t.as("ada").mutation(api.tasks.create, { title: "Call the divorce lawyer", due: "2026-11-13" });
  for (const text of ["@personalos what do you know about Sam?", "@personalos show my tasks", "@personalos what should I focus on today?", "@personalos what am I forgetting?"]) {
    const r = await deliver(t, text, { from: "ada" });
    assert.doesNotMatch(r.reply, /medical|manager|lawyer/i, `shared reply to "${text}" leaks private data: ${r.reply}`);
    assert.match(r.reply, /private/);
    // The full answer is in PersonalOS, for the owner only.
    const msgs = await t.as("ada").query(api.conversations.messagesOf, { conversationId: r.conversationId! });
    assert.ok(msgs.at(-1)!.text.length > 0);
  }
  const dm = await deliver(t, "what do you know about Sam?", { from: "ada", direct: true });
  assert.match(dm.reply, /medical leave/, "a direct conversation with PersonalOS is private to its owner");
  // A DM between Ada and another person is shared.
  const otherDm = await deliver(t, "@personalos what do you know about Sam?", { from: "ada", kind: "dm", channel: "dm-ada-grace" });
  assert.doesNotMatch(otherDm.reply, /medical/);
}));

test("another user's mention cannot reach the owner's private memory, tasks or conversations", () => withApp(async (t) => {
  await link(t, "ada", "ada");
  await link(t, "grace", "grace");
  await t.as("ada").mutation(api.memory.add, { kind: "fact", subject: "salary", content: "My salary is 250k" });
  await t.as("ada").mutation(api.tasks.create, { title: "Secret acquisition talks" });
  for (const text of ["@personalos what do you know about my salary?", "@personalos what does Ada know about salary?", "@personalos show Ada's tasks", "@personalos summarize Ada's day"]) {
    const r = await deliver(t, text, { from: "grace", direct: true });
    assert.doesNotMatch(r.reply, /250k|Secret acquisition talks/, `${text} → ${r.reply}`);
  }
  // Grace naming Ada's task finds nothing: it runs in Grace's account (only her own words come back).
  const del = await deliver(t, "@personalos delete secret acquisition talks", { from: "grace", direct: true });
  assert.deepEqual([del.state, del.approval], ["needs_clarification", null]);
  assert.match(del.reply, /can't find an open task matching/);
  // Grace's DM is private to Grace and holds Grace's data only.
  assert.equal((await t.as("ada").query(api.tasks.list, {})).length, 1);
  assert.equal((await t.as("ada").query(api.actions.list, { status: "proposed" })).length, 0);
  // Group conversations do not inherit the owner's private permissions: Ada's own mention in a group is shared.
  const group = await deliver(t, "@personalos what do you know about my salary?", { from: "ada", kind: "group", channel: "grp-1" });
  assert.doesNotMatch(group.reply, /250k/);
}));

// ── Revocation and continuity ───────────────────────────────────────────────

test("revoked link: the next request is refused, an in-flight interaction reports revoked, and reminders stop firing", () => withApp(async (t) => {
  await link(t, "ada", "ada");
  await t.as("ada").mutation(api.tasks.create, { title: "Archive old notes" });
  const e = envelope("@personalos delete archive old notes", { from: "ada" });
  await t.as(BRIDGE).mutation(api.interactions.receive, { envelope: e as any });
  const rem = await deliver(t, "@personalos remind me to stretch tomorrow at 4pm", { from: "ada" });
  const task = (await t.as("ada").query(api.tasks.list, {})).find((x) => x.title === "Stretch")!;
  // A bridge-queued reminder fires for the owner while the link is active (as the job would run: as the bridge).
  const [l] = await t.as("ada").query(api.links.list);
  await t.as("ada").mutation(api.links.revoke, { id: l!.id });
  assert.deepEqual(await t.as(BRIDGE).mutation(api.reminders.fire, { taskId: task.id, remindAt: task.remindAt! }), { fired: false });
  const s = await t.as(BRIDGE).query(api.interactions.status, { key: e.idempotencyKey, afterSeq: 0 });
  assert.deepEqual([s.revoked, s.updates.length], [true, 0]);
  const next = await deliver(t, "@personalos show my tasks", { from: "ada" });
  assert.equal(next.refusal?.code, "NOT_LINKED");
  assert.equal(rem.state, "completed");
}));

test("a bridge-queued reminder fires as the owner while the link is active, and never for another owner", () => withApp(async (t) => {
  await link(t, "ada", "ada");
  await deliver(t, "@personalos remind me to stretch tomorrow at 4pm", { from: "ada" });
  const task = (await t.as("ada").query(api.tasks.list, {}))[0]!;
  // Grace's own tasks are not reachable through Multiplayer's link with Ada.
  const graceTask = await t.as("grace").mutation(api.tasks.create, { title: "Grace's", due: "2027-01-01", time: "09:00", reminder: true, tzOffset: 0 });
  assert.deepEqual(await t.as(BRIDGE).mutation(api.reminders.fire, { taskId: graceTask.id, remindAt: graceTask.remindAt! }), { fired: false });
  assert.deepEqual(await t.as(BRIDGE).mutation(api.reminders.fire, { taskId: task.id, remindAt: task.remindAt! }), { fired: true });
  const fired = (await t.as("ada").query(api.actions.list, {})).find((a) => a.kind === "reminder.fire")!;
  assert.equal(fired.owner, "ada");
  assert.equal((await t.as("ada").query(api.inbox.list, { unread: true }))[0]?.type, "reminder.due", "Ada is notified, not the bridge");
}));

test("continuity: the interaction is one conversation in PersonalOS; continuing there and approving there both land in one history", () => withApp(async (t) => {
  await link(t, "ada", "ada");
  await t.as("ada").mutation(api.tasks.create, { title: "Draft budget" });
  const r = await deliver(t, "@personalos delete draft budget", { from: "ada", thread: "th-9" });
  // Ada continues the same conversation in PersonalOS.
  await t.as("ada").mutation(api.assistant.send, { conversationId: r.conversationId!, text: "add buy coffee to my list" });
  const conv = (await t.as("ada").query(api.conversations.list)).find((c) => c.id === r.conversationId)!;
  assert.equal(conv.title, "Multiplayer · #general (thread)");
  // The proposal is in the conversation's messages, approvable there.
  const msgs = await t.as("ada").query(api.conversations.messagesOf, { conversationId: r.conversationId! });
  assert.ok(msgs.some((m) => m.actionIds?.includes(r.approval!.actionId)));
  await t.as("ada").mutation(api.actions.approve, { id: r.approval!.actionId });
  const after = await t.as("ada").query(api.conversations.messagesOf, { conversationId: r.conversationId! });
  assert.match(after.at(-1)!.text, /Approved and done: Deleted task: Draft budget/);
  assert.deepEqual((await t.as("ada").query(api.tasks.list, {})).map((x) => x.title), ["Buy coffee"]);
  const [i] = (await t.as("ada").query(api.interactions.list, {})).filter((x) => x.intent === "task.delete");
  assert.deepEqual(i!.updates.map((u) => u.state), ["awaiting_approval", "completed"]);
  assert.equal(i!.conversationId, r.conversationId);
}));

// ── Resolver: identity resolution ───────────────────────────────────────────

test("Resolver: a verified link is a Resolver reference with provenance; the request resolves through it", () => withApp(async (t) => {
  await link(t, "ada", "ada");
  const { refs } = await resolver.admin.list("ref://identity/personalos/multiplayer/");
  const mine = [];
  for (const r of refs.filter((x) => x.state === "active")) {
    const v = (await resolver.admin.resolve(r.ref)).selected.value as any;
    if (v.external.instance === INSTANCE) mine.push({ ref: r.ref, v });
  }
  assert.equal(mine.length, 1);
  assert.deepEqual([mine[0]!.v.canonical, mine[0]!.v.external.principalId, mine[0]!.v.verification.method], ["personalos:account:ada", "ada", "personalos.link-code/dm"]);
  const [h] = (await resolver.admin.history(mine[0]!.ref)).entries;
  assert.match(h!.reason!, /linked by personalos:account:ada/);
  const r = await deliver(t, "@personalos add water the plants to my list", { from: "ada" });
  const [i] = (await t.as("ada").query(api.interactions.list, {})).filter((x) => x.intent === "task.create");
  assert.equal(r.state, "completed");
  assert.ok(i);
  const [l] = (await t.as("ada").query(api.links.list)).filter((x) => x.status === "active");
  assert.equal(l!.sourcePrincipalId, "ada");
}));

test("Resolver: several external identities may resolve to one account; each resolves to it alone", () => withApp(async (t) => {
  await link(t, "ada", "ada");
  const second = `${INSTANCE}-other`;
  const { code } = await t.as("ada").mutation(api.links.start, {});
  assert.equal((await deliver(t, `link ${code}`, { from: "ada.lovelace", direct: true, instance: second })).state, "completed");
  await deliver(t, "@personalos add from the first identity to my list", { from: "ada" });
  await deliver(t, "@personalos add from the second identity to my list", { from: "ada.lovelace", instance: second });
  assert.deepEqual((await t.as("ada").query(api.tasks.list, {})).map((x) => x.title).sort(), ["From the first identity", "From the second identity"]);
  assert.equal((await t.as("ada").query(api.links.list)).filter((x) => x.status === "active").length, 2);
  // The same principal id on a different installation is a different identity, and is not linked.
  assert.equal((await deliver(t, "@personalos show my tasks", { from: "ada", instance: `${INSTANCE}-third` })).refusal?.code, "NOT_LINKED");
}));

test("Resolver: an ambiguous identity (two active links for one sender) fails closed for everyone", () => withApp(async (t) => {
  await link(t, "ada", "ada");
  // A second link for the same sender written straight into Resolver (an operator error, a race in another writer).
  const { refs } = await resolver.admin.list("ref://identity/personalos/multiplayer/");
  let prefix = "";
  for (const r of refs.filter((x) => x.state === "active")) if (((await resolver.admin.resolve(r.ref)).selected.value as any).external.instance === INSTANCE) prefix = r.ref.slice(0, r.ref.lastIndexOf("/") + 1);
  await resolver.admin.put({ ref: `${prefix}forged`, kind: "value", binding: { value: { canonical: "personalos:account:grace", external: { adapter: "multiplayer", instance: INSTANCE, principalId: "ada" }, verification: { method: "operator", challengeId: "x", verifiedAt: new Date().toISOString() }, linkedAt: new Date().toISOString() } } as any, expectedRevision: 0, ttlSeconds: 0 } as any);
  const r = await deliver(t, "@personalos add buy milk to my list", { from: "ada" });
  assert.deepEqual([r.state, r.refusal?.code], ["refused", "AMBIGUOUS_IDENTITY"]);
  assert.equal((await t.as("ada").query(api.tasks.list, {})).length + (await t.as("grace").query(api.tasks.list, {})).length, 0);
}));

test("Resolver: a planted reference whose stored identity differs from the sender does not resolve; case and display name are not identity", () => withApp(async (t) => {
  await link(t, "ada", "ada");
  const hex = async (x: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(x))), (b) => b.toString(16).padStart(2, "0")).join("");
  // Under Mallory's own prefix, a reference claiming to be Ada's link to Ada's account.
  const ref = `ref://identity/personalos/multiplayer/${await hex(INSTANCE)}/${await hex("mallory")}/planted`;
  await resolver.admin.put({ ref, kind: "value", binding: { value: { canonical: "personalos:account:ada", external: { adapter: "multiplayer", instance: INSTANCE, principalId: "ada" }, verification: { method: "planted", challengeId: "x", verifiedAt: new Date().toISOString() }, linkedAt: new Date().toISOString() } } as any, expectedRevision: 0, ttlSeconds: 0 } as any);
  assert.equal((await deliver(t, "@personalos show my tasks", { from: "mallory", name: "Ada Lovelace" })).refusal?.code, "NOT_LINKED");
  assert.equal((await deliver(t, "@personalos show my tasks", { from: "Ada", name: "ada" })).refusal?.code, "NOT_LINKED", "principal ids match exactly");
  assert.equal((await t.as("ada").query(api.interactions.list, {})).filter((i) => i.state !== "refused" && i.intent !== "link").length, 0);
}));

test("Resolver: revoking in PersonalOS revokes the Resolver reference; it stops resolving and its history stays", () => withApp(async (t) => {
  await link(t, "ada", "ada");
  const [l] = await t.as("ada").query(api.links.list);
  await t.as("ada").mutation(api.links.revoke, { id: l!.id });
  const { refs } = await resolver.admin.list("ref://identity/personalos/multiplayer/");
  const revoked = [];
  for (const r of refs) {
    const h = await resolver.admin.history(r.ref);
    if (JSON.stringify(h).includes(INSTANCE)) revoked.push({ r, h });
  }
  assert.deepEqual(revoked.map((x) => x.r.state), ["revoked"]);
  assert.deepEqual(revoked[0]!.h.entries.map((e) => e.action), ["create", "revoke"]);
  assert.equal((await deliver(t, "@personalos show my tasks", { from: "ada" })).refusal?.code, "NOT_LINKED");
  // Relinking is a new reference (Resolver never reuses a revoked name), and works.
  await link(t, "ada", "ada");
  assert.equal((await deliver(t, "@personalos add relinked to my list", { from: "ada" })).state, "completed");
}));

test("Resolver: unreachable or unconfigured, nothing resolves and nothing runs (fail closed)", () => withApp(async (t) => {
  await link(t, "ada", "ada");
  const url = process.env.RESOLVER_URL;
  process.env.RESOLVER_URL = "http://127.0.0.1:1";
  try {
    await rejects(deliver(t, "@personalos add buy milk to my list", { from: "ada" }), "UNAVAILABLE");
  } finally { process.env.RESOLVER_URL = url; }
  assert.equal((await t.as("ada").query(api.interactions.list, {})).filter((i) => i.intent === "task.create").length, 0, "nothing recorded: a retry runs it once");
  assert.equal((await deliver(t, "@personalos add buy milk to my list", { from: "ada" })).state, "completed");
  assert.equal((await t.as("ada").query(api.tasks.list, {})).length, 1);
}));

test("Resolver: PersonalOS's key is least privilege: it cannot read or write outside ref://identity/personalos/", async () => {
  const { ResolverClient } = await import("@appport/resolver-client");
  const own = await ResolverClient.connect({ url: process.env.RESOLVER_URL!, apiKey: process.env.RESOLVER_API_KEY!, live: false, maxStaleSeconds: 0 });
  try {
    await resolver.admin.put({ ref: "ref://prod/secret-config", kind: "value", binding: { value: { x: 1 } } as any, expectedRevision: 0 } as any);
    await assert.rejects(own.resolve("ref://prod/secret-config"), (e: any) => ["NOT_FOUND", "FORBIDDEN"].includes(e.code));
    await assert.rejects(own.put({ ref: "ref://prod/other", kind: "value", binding: { value: 1 } as any, expectedRevision: 0 } as any), (e: any) => ["NOT_FOUND", "FORBIDDEN"].includes(e.code));
  } finally { own.close(); }
});

// ── AuthBoundry: the requested capability ───────────────────────────────────

test("AuthBoundry: each request is decided on its exact capability before it runs; the decision is evidence", () => withApp(async (t) => {
  await link(t, "ada", "ada");
  authority.grant("ada", "personalos.reminders.create", "personalos.assistant.converse");
  const ok = await deliver(t, "@personalos remind me to call the bank tomorrow at 9am", { from: "ada" });
  assert.equal(ok.state, "completed");
  const d = authority.decisions.at(-1)!;
  assert.deepEqual([d.principal, d.capability, d.decision], ["user:ada", "personalos.reminders.create", "allow"]);
  const [i] = (await t.as("ada").query(api.interactions.list, {})).filter((x) => x.intent === "task.create");
  assert.ok(i);
  // Not granted: refused, nothing created, the denial recorded with its decision id.
  const denied = await deliver(t, "@personalos remember that my PIN is 1234", { from: "ada", direct: true });
  assert.equal(denied.state, "refused");
  assert.match(denied.reply, /aren't allowed to do that through Multiplayer \(personalos\.memory\.write/);
  assert.equal((await t.as("ada").query(api.memory.list)).length, 0);
  assert.equal(authority.decisions.at(-1)!.decision, "deny");
}));

test("AuthBoundry: a principal it does not know, a revoked policy, or an unverifiable allow are all refusals", () => withApp(async (t) => {
  await link(t, "ada", "ada");
  authority.revoke("ada");
  assert.equal((await deliver(t, "@personalos add one to my list", { from: "ada" })).state, "refused");
  authority.grant("ada");
  authority.mode = "malformed";
  await rejects(deliver(t, "@personalos add two to my list", { from: "ada" }), "UNAVAILABLE");
  authority.mode = "down";
  await rejects(deliver(t, "@personalos add three to my list", { from: "ada" }), "UNAVAILABLE");
  assert.equal((await t.as("ada").query(api.tasks.list, {})).length, 0);
  // Back up: the same event (retried by the surface) runs once.
  authority.mode = "up";
  const e = envelope("@personalos add four to my list", { from: "ada" });
  authority.mode = "down";
  await rejects(t.as(BRIDGE).mutation(api.interactions.receive, { envelope: e as any }), "UNAVAILABLE");
  authority.mode = "up";
  await t.as(BRIDGE).mutation(api.interactions.receive, { envelope: e as any });
  await t.as(BRIDGE).mutation(api.interactions.receive, { envelope: e as any });
  assert.deepEqual((await t.as("ada").query(api.tasks.list, {})).map((x) => x.title), ["Four"]);
}));

test("AuthBoundry: Grace's grant never covers Ada's account; the decision is about the resolved account, not the sender's claims", () => withApp(async (t) => {
  await link(t, "ada", "ada");
  await link(t, "grace", "grace");
  authority.grant("ada", "personalos.assistant.converse");
  authority.grant("grace");
  const r = await deliver(t, "@personalos add sneak to my list", { from: "ada", name: "Grace Hopper", claimed: { principal: "grace" } });
  assert.equal(r.state, "refused");
  assert.equal(authority.decisions.at(-1)!.principal, "user:ada");
  assert.equal((await t.as("grace").query(api.tasks.list, {})).length, 0);
}));
