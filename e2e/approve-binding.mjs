/**
 * The chat proposal card binds an approval to the exact operation it shows (FeltKit inputDigest).
 *   node e2e/approve-binding.mjs <url> [screenshotDir]   (run from the project directory; `feltkit dev` is running)
 * A loopback OpenAI-compatible streaming model proposes tasks.create twice. Checks:
 *   1. Approve from the card sends the live record's own inputDigest; exactly the proposed task is created once.
 *   2. The action record keeps who proposed (model, generation), who approved, the digest and the outcome,
 *      and its outcome names the activity entry of the execution.
 *   3. Approving the second proposal with the first one's real digest, or a forged one, is refused (409)
 *      and runs nothing; approving it from its card then succeeds.
 * Note: it points the development model at the loopback server (`feltkit model set`).
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

let n = 0;
const titles = ["Buy oat milk", "Call the plumber"];
const server = createServer(async (req, res) => {
  let b = "";
  for await (const c of req) b += c;
  const body = JSON.parse(b || "{}");
  const hasToolResult = (body.messages ?? []).some((m) => m.role === "tool");
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (d) => res.write(`data: ${JSON.stringify(d)}\n\n`);
  const base = { id: "x", object: "chat.completion.chunk", model: "loop" };
  if (!hasToolResult) {
    const title = titles[n++ % titles.length];
    send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "I'll add that." } }] });
    send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: "tasks_create", arguments: JSON.stringify({ title }) } }] } }] });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
  } else {
    send({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Proposed; approve it below." } }] });
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
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

async function propose(text, title) {
  await page.getByLabel("Message").fill(text);
  await page.getByLabel("Send").click();
  const card = page.getByTestId("proposal").last();
  await card.getByText(`Add task: ${title}`).waitFor({ timeout: 20000 });
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll('[data-testid="proposal"] button')].filter((x) => x.textContent === "Approve").at(-1);
    return b && !b.disabled;
  }, null, { timeout: 15000 });
  return card;
}

await page.goto(`${url}/#/chat`);
await page.getByLabel("New conversation").click();

// 1. Success: the card approves the live record with its own digest; exactly that input runs, once.
const cardA = await propose("add oat milk to my list", "Buy oat milk");
const a = await actionFor("Buy oat milk");
assert.equal(a.state, "proposed");
assert.equal(await tasksTitled("Buy oat milk"), 0, "nothing ran before approval");
await page.screenshot({ path: `${shots}/proposal-card.png` });
await cardA.getByRole("button", { name: "Approve" }).click();
await cardA.getByText(/^Done$/).waitFor({ timeout: 30000 });
assert.equal(approvals.length, 1, "one approve request");
assert.deepEqual(approvals[0], { taskId: a.taskId, actionId: a.actionId, inputDigest: a.inputDigest }, "the card sent this proposal's own digest");
assert.equal(await tasksTitled("Buy oat milk"), 1, "the approved task exists exactly once");
log("approve from the card carried the live record's digest; the proposed task was created once:", a.inputDigest);

// 2. Provenance, as FeltKit records it for this action.
const done = await actionFor("Buy oat milk");
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
const cardB = await propose("and call the plumber", "Call the plumber");
const b = await actionFor("Call the plumber");
for (const [label, inputDigest] of [["the other proposal's real digest", a.inputDigest], ["a forged digest", "sha256:forged"]]) {
  const r = await api("/api/agent/actions/approve", { taskId: b.taskId, actionId: b.actionId, inputDigest });
  assert.equal(r.status, 409, `${label}: refused`);
  assert.equal(r.json.error?.code, "FAILED_PRECONDITION");
  assert.equal((await actionFor("Call the plumber")).state, "proposed", `${label}: still proposed`);
  assert.equal(await tasksTitled("Call the plumber"), 0, `${label}: nothing ran`);
  log(`approve with ${label} was refused (409 FAILED_PRECONDITION); still proposed, nothing ran`);
}
await cardB.getByRole("button", { name: "Approve" }).click();
await cardB.getByText(/^Done$/).waitFor({ timeout: 30000 });
assert.deepEqual(approvals.at(-1), { taskId: b.taskId, actionId: b.actionId, inputDigest: b.inputDigest });
assert.equal(await tasksTitled("Call the plumber"), 1);
log("the same proposal approved from its card, with its own digest, ran once");
await page.screenshot({ path: `${shots}/proposal-approved.png` });

await browser.close();
server.close();
