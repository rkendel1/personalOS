/**
 * DoD 10 against the running app: switch the model with the real CLI while the app runs, and
 * show that conversations, memory and tasks are untouched and each decision names its model.
 *   node e2e/model.mjs <url>        (run from the project directory; `feltkit dev` is running)
 * Two loopback OpenAI-compatible servers stand in for two providers. A person's approval is
 * given through Studio's own API (what its Approve button calls), with the dev admin token.
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
const { chromium } = createRequire(import.meta.url)("playwright");

const url = process.argv[2] ?? "http://localhost:5180";
const admin = readFileSync(".feltkit/development/admin-token", "utf8").trim();
const log = (...a) => console.log("✓", ...a);

function model(label) {
  const asked = [];
  const server = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      asked.push(b);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: "x", object: "chat.completion", model: label, choices: [{ index: 0, message: { role: "assistant", content: label }, finish_reason: "stop" }] }));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, asked, endpoint: `http://127.0.0.1:${server.address().port}/v1` })));
}
const studio = async (path, body) => {
  const res = await fetch(`${url}/_feltkit/api${path}`, { method: body ? "POST" : "GET", headers: { "x-feltkit-admin": admin, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${JSON.stringify(json)}`);
  return json;
};
const cli = (...args) => execFileSync("npx", ["feltkit", ...args], { encoding: "utf8" });

const a = await model("task");
const b = await model("memory");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
await page.goto(`${url}/#/settings`);
const toggle = page.getByLabel(/Ask the model/);
await toggle.waitFor();
if (!(await toggle.isChecked())) await toggle.click();
await page.waitForFunction(() => [...document.querySelectorAll(".toggle")].find((l) => l.textContent.includes("Ask the model"))?.querySelector("input")?.checked);
log("model assist enabled in Settings");

async function roundTrip(endpoint, name, text) {
  console.log(cli("model", "set", "--provider", "ollama", "--model", name, "--endpoint", endpoint).trim().split("\n")[0]);
  await page.goto(`${url}/#/chat`);
  await page.getByLabel("New conversation").click();
  await page.getByLabel("Message").fill(text);
  await page.getByLabel("Send").click();
  await page.getByText("asked the model").last().waitFor();
  // Find the decision task FeltKit opened for this message and its proposal.
  let task, actionId;
  for (let i = 0; i < 50 && !actionId; i++) {
    const { tasks } = await studio("/agent");
    task = tasks.find((t) => (t.objective ?? t.task?.objective ?? "").includes(text));
    if (task) {
      const view = await studio(`/agent/tasks/${task.task_id ?? task.id ?? task.task?.task_id}?as=ada`);
      actionId = (view.actions ?? []).find((x) => x.state === "proposed")?.actionId;
      if (actionId) task = view;
    }
    if (!actionId) await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(actionId, "a proposal waits for approval");
  const decided = JSON.stringify(task.checkpoints);
  assert.ok(decided.includes(`ollama/${name} chose`), `the decision names ${name}`);
  log(`${name} decided; checkpoint: "${task.checkpoints.find((c) => c.summary.includes("chose")).summary}"`);
  await studio(`/agent/tasks/${task.task.task_id}/approve`, { as: "ada", actionId });
  await page.getByText("you approved").last().waitFor({ timeout: 15000 });
  log("approved in Studio → executed by the app:", (await page.locator(".msg.assistant .bubble").last().innerText()).split("\n")[0]);
}

const before = { memory: null, tasks: null };
await roundTrip(a.endpoint, "model-a", "pick up the dry cleaning");
await roundTrip(b.endpoint, "model-b", "the garage code is 7731");
assert.deepEqual([a.asked.length, b.asked.length], [1, 1], "each model was asked exactly once");
console.log(cli("model", "show").trim().split("\n").slice(0, 3).join("\n"));

await page.goto(`${url}/#/tasks`);
await page.getByText("Pick up the dry cleaning").waitFor();
await page.getByText("Follow up with John").waitFor();
await page.goto(`${url}/#/memory`);
await page.getByText("The garage code is 7731").waitFor();
await page.getByText("Sam Rivera is my manager").waitFor();
log("after two model switches: earlier tasks and memories intact, model results recorded (memory unconfirmed)");
await page.goto(`${url}/#/chat`);
await page.getByLabel("Conversations").click();
log("conversations:", (await page.locator(".thread-title").allInnerTexts()).join(" | "));
await browser.close();
a.server.close();
b.server.close();
