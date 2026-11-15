/**
 * The chat proposal card binds an approval to the exact operation it shows (FeltKit inputDigest).
 *   node e2e/approve-binding.mjs <url> [screenshotDir]   (run from the project directory; `feltkit dev` is running)
 * A loopback OpenAI-compatible model proposes tasks.create ("add <title> to my list"). Checks:
 *   1. Approve from the card sends that proposal's own {taskId, actionId, inputDigest}; the task is created once.
 *   2. The action record keeps who proposed (model, generation), who approved, the digest and the input that
 *      ran, and names the activity entry of the execution, which ran as the approving owner.
 *   3. Approving a second proposal with the first one's real digest, or a forged one, is refused (409) and runs
 *      nothing; approving it from its card then runs it once.
 *   4. The card shows and approves FeltKit's live record, not the conversation's copy: with the live record
 *      replaced in the browser, the card describes the live input and sends the live digest.
 *   5. Until the live record arrives, Approve stays disabled.
 * Titles carry a per-run suffix, so the script can run again against the same development state.
 * Note: it points the development model at the loopback server (`feltkit model set`) and leaves it there.
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const { chromium } = createRequire(import.meta.url)("playwright");
const [url = "http://localhost:5180", shots = "."] = process.argv.slice(2);
const admin = readFileSync(".feltkit/development/admin-token", "utf8").trim();
const log = (...a) => console.log("✓", ...a);
const run = Date.now().toString(36);
const T = { milk: `Buy oat milk ${run}`, plumber: `Call the plumber ${run}`, roses: `Prune the roses ${run}` };

// The model proposes tasks.create for "add <title> to my list"; anything else gets a plain answer.
const text = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : "");
const server = createServer(async (req, res) => {
  let b = "";
  for await (const c of req) b += c;
  const body = JSON.parse(b || "{}");
  const messages = body.messages ?? [];
  const asked = /add (.+) to my list/i.exec(text(messages.filter((m) => m.role === "user").at(-1)?.content))?.[1];
  const answered = messages.at(-1)?.role === "tool";
  if (!body.stream) {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ id: "x", object: "chat.completion", model: "loop", choices: [{ index: 0, message: { role: "assistant", content: "OK." }, finish_reason: "stop" }] }));
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", model: "loop", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  if (asked && !answered) {
    chunk({ role: "assistant", content: "I'll add that." });
    chunk({ tool_calls: [{ index: 0, id: `call_${asked.length}_${run}`, type: "function", function: { name: "tasks_create", arguments: JSON.stringify({ title: asked }) } }] });
    chunk({}, "tool_calls");
  } else {
    chunk({ role: "assistant", content: answered ? "Proposed; approve it below." : "OK." });
    chunk({}, "stop");
  }
  res.end("data: [DONE]\n\n");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const endpoint = `http://127.0.0.1:${server.address().port}/v1`;
console.log(execFileSync("npx", ["feltkit", "model", "set", "--provider", "ollama", "--model", "loop", "--endpoint", endpoint], { encoding: "utf8" }).trim().split("\n")[0]);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const approvals = [];
page.on("request", (r) => {
  if (r.method() === "POST" && r.url().endsWith("/api/agent/actions/approve")) approvals.push(r.postDataJSON());
});

// Calls as the signed-in person, from the page (session cookie + CSRF), and as the developer (Studio).
const api = (path, body) =>
  page.evaluate(async ({ path, body }) => {
    const { csrf } = await (await fetch("/api/session", { headers: { "X-FeltKit-Session": "cookie" } })).json();
    const r = await fetch(path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "X-FeltKit-Session": "cookie", "X-FeltKit-CSRF": csrf }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json() };
  }, { path, body });
const actionFor = async (title) => (await api("/api/agent/actions")).json.actions.find((a) => a.input?.title === title);
const tasksTitled = async (title) => (await api("/api/query/tasks%3Alist", { args: {} })).json.value.filter((t) => t.title === title).length;
const studio = async (path) => (await fetch(`${url}/_feltkit/api${path}`, { headers: { "x-feltkit-admin": admin } })).json();
const cardFor = (title) => page.getByTestId("proposal").filter({ hasText: title });
const approveEnabled = (title) =>
  page.waitForFunction((t) => {
    const card = [...document.querySelectorAll('[data-testid="proposal"]')].find((c) => c.textContent.includes(t));
    const b = card && [...card.querySelectorAll("button")].find((x) => x.textContent === "Approve");
    return b && !b.disabled;
  }, title, { timeout: 15000 });

async function propose(title) {
  await page.getByLabel("Message").fill(`add ${title} to my list`);
  await page.getByLabel("Send").click();
  await cardFor(`Add task: ${title}`).waitFor({ timeout: 20000 });
  await approveEnabled(title);
  // Found by its title alone: once done, the card reads "Created: <title>".
  return cardFor(title);
}

await page.goto(`${url}/#/chat`);
await page.getByLabel("New conversation").click();

// 1. Success: the card approves the live record with its own digest; exactly that input runs, once.
const cardA = await propose(T.milk);
const a = await actionFor(T.milk);
assert.equal(a.state, "proposed");
assert.equal(await tasksTitled(T.milk), 0, "nothing ran before approval");
await page.screenshot({ path: `${shots}/proposal-card.png` });
await cardA.getByRole("button", { name: "Approve" }).click();
await cardA.getByText(/^Done$/).waitFor({ timeout: 30000 });
assert.equal(approvals.length, 1, "one approve request");
assert.deepEqual(approvals[0], { taskId: a.taskId, actionId: a.actionId, inputDigest: a.inputDigest }, "the card sent this proposal's own digest");
assert.equal(await tasksTitled(T.milk), 1, "the approved task exists exactly once");
log("approve from the card carried the live record's digest; the proposed task was created once:", a.inputDigest);

// 2. Provenance, as FeltKit records it for this action.
const done = await actionFor(T.milk);
assert.equal(done.state, "succeeded");
assert.equal(done.outcome?.ok, true);
assert.equal(done.proposedBy, "model:ollama/loop", "who proposed: the model");
assert.ok(done.generation?.memoryId && done.generation?.toolCallId, "which generation and tool call proposed it");
assert.match(String(done.decidedBy), /^user:/, "who approved: a person");
assert.equal(done.inputDigest, a.inputDigest, "what was approved");
assert.deepEqual(done.input, a.input, "the input that ran is the input proposed");
assert.ok(done.outcome?.activityId, "the execution's activity entry");
const activity = await studio(`/activity/${done.outcome.activityId}`);
const entry = activity.entry ?? activity;
assert.equal(entry.outcome, "success");
assert.equal(`user:${entry.principal?.id}`, done.decidedBy, "the execution ran as the approving owner");
log(`provenance: proposed by ${done.proposedBy} (generation ${done.generation.memoryId}), approved by ${done.decidedBy}, digest ${done.inputDigest.slice(0, 18)}…, executed as activity ${entry.id} (${entry.name}, via ${entry.via})`);

// 3. A digest that is not this proposal's approves nothing; the card's own approval then works.
const cardB = await propose(T.plumber);
const b = await actionFor(T.plumber);
for (const [label, inputDigest] of [["the other proposal's real digest", a.inputDigest], ["a forged digest", "sha256:forged"]]) {
  const r = await api("/api/agent/actions/approve", { taskId: b.taskId, actionId: b.actionId, inputDigest });
  assert.equal(r.status, 409, `${label}: refused`);
  assert.equal(r.json.error?.code, "FAILED_PRECONDITION");
  assert.equal((await actionFor(T.plumber)).state, "proposed", `${label}: still proposed`);
  assert.equal(await tasksTitled(T.plumber), 0, `${label}: nothing ran`);
  log(`approve with ${label} was refused (409 FAILED_PRECONDITION); still proposed, nothing ran`);
}
await cardB.getByRole("button", { name: "Approve" }).click();
await cardB.getByText(/^Done$/).waitFor({ timeout: 30000 });
assert.deepEqual(approvals.at(-1), { taskId: b.taskId, actionId: b.actionId, inputDigest: b.inputDigest });
assert.equal(await tasksTitled(T.plumber), 1);
log("the same proposal approved from its card, with its own digest, ran once");
await page.screenshot({ path: `${shots}/proposal-approved.png` });

// 4. The card follows FeltKit's live record, not the conversation's copy. Replace the live record in the
// browser (same ids, different input and digest): the card must describe and approve the replacement.
await propose(T.roses);
const c = await actionFor(T.roses);
const shown = `Live record ${run}`;
const replaced = { ...c, input: { ...c.input, title: shown }, inputDigest: "sha256:live-record-in-the-browser" };
const actionsStream = "**/api/agent/actions/events*";
await page.route(actionsStream, (route) => route.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `event: actions\ndata: ${JSON.stringify({ actions: [replaced] })}\n\n` }));
await page.reload();
await cardFor(`Add task: ${shown}`).waitFor({ timeout: 20000 });
assert.equal(await cardFor(`Add task: ${T.roses}`).count(), 0, "the conversation's copy is not what the card shows");
await approveEnabled(shown);
const before = approvals.length;
await cardFor(shown).getByRole("button", { name: "Approve" }).click();
for (let i = 0; i < 50 && approvals.length === before; i++) await new Promise((r) => setTimeout(r, 100));
assert.equal(approvals.length, before + 1, "one approve request");
assert.deepEqual(approvals.at(-1), { taskId: c.taskId, actionId: c.actionId, inputDigest: replaced.inputDigest }, "the card approved the live record's digest");
await page.unroute(actionsStream);
assert.equal((await actionFor(T.roses)).state, "proposed", "FeltKit refused a digest that is not the stored proposal's");
assert.equal(await tasksTitled(T.roses), 0, "nothing ran");
log("with the live record replaced in the browser, the card showed and approved the live record (FeltKit then refused it: not the stored input)");

// 5. Until the live record arrives, the conversation's copy is shown and cannot be approved.
const held = [];
await page.route(actionsStream, (route) => void held.push(route));
await page.reload();
const waiting = cardFor(`Add task: ${T.roses}`);
await waiting.waitFor({ timeout: 20000 });
await new Promise((r) => setTimeout(r, 1500));
assert.equal(await waiting.getByRole("button", { name: "Approve" }).isDisabled(), true, "Approve waits for the live record");
await page.unroute(actionsStream);
for (const route of held) await route.abort().catch(() => {});
await approveEnabled(T.roses);
log("before the live record arrived, Approve was disabled; it enabled once the record arrived");

await browser.close();
server.close();
