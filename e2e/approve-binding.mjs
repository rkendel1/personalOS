/**
 * The chat proposal card binds an approval to the exact operation it shows (FeltKit inputDigest).
 *   node e2e/approve-binding.mjs <url> [screenshotDir]   (run from the project directory; `feltkit dev` is running)
 * A loopback OpenAI-compatible streaming model proposes tasks.create. Approving from the card must send
 * the live record's inputDigest; an approval with a digest that is not the proposal's must be refused
 * and nothing run. Note: it points the development model at the loopback server (`feltkit model set`).
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const { chromium } = createRequire(import.meta.url)("playwright");
const [url = "http://localhost:5180", shots = "."] = process.argv.slice(2);
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
  if (r.method() === "POST" && r.url().endsWith("/api/agent/actions/approve")) approvals.push({ url: r.url(), body: r.postDataJSON?.() ?? r.postData() });
});

await page.goto(`${url}/#/chat`);
await page.getByLabel("New conversation").click();
await page.getByLabel("Message").fill("add oat milk to my list");
await page.getByLabel("Send").click();
const card = page.getByTestId("proposal").last();
await card.getByText("Add task: Buy oat milk").waitFor({ timeout: 20000 });
const approve = card.getByRole("button", { name: "Approve" });
await page.waitForFunction(() => {
  const b = [...document.querySelectorAll('[data-testid="proposal"] button')].filter((x) => x.textContent === "Approve").at(-1);
  return b && !b.disabled;
}, null, { timeout: 15000 });
log("card shows the live record; Approve enabled once the live record (with its digest) is loaded");
await page.screenshot({ path: `${shots}/proposal-card.png` });
await approve.click();
await card.getByText(/^Done$/).waitFor({ timeout: 30000 });
assert.equal(approvals.length, 1, "one approve request");
const sent = approvals[0].body;
assert.match(String(sent?.inputDigest ?? ""), /\S{16,}/, `approve carried an inputDigest: ${JSON.stringify(sent)}`);
log("approve request from the chat card carried inputDigest:", sent.inputDigest);
await page.screenshot({ path: `${shots}/proposal-approved.png` });

// Second proposal: a forged digest through the same endpoint must be refused and nothing run.
await page.getByLabel("Message").fill("and call the plumber");
await page.getByLabel("Send").click();
const card2 = page.getByTestId("proposal").last();
await card2.getByText("Add task: Call the plumber").waitFor({ timeout: 20000 });
const forged = await page.evaluate(async () => {
  const { csrf } = await (await fetch("/api/session", { headers: { "X-FeltKit-Session": "cookie" } })).json();
  const h = { "content-type": "application/json", "X-FeltKit-Session": "cookie", "X-FeltKit-CSRF": csrf };
  const { actions } = await (await fetch("/api/agent/actions", { headers: h })).json();
  const a = actions.find((x) => x.input?.title === "Call the plumber" && x.state === "proposed");
  const r = await fetch("/api/agent/actions/approve", { method: "POST", headers: h, body: JSON.stringify({ taskId: a.taskId, actionId: a.actionId, inputDigest: "sha256:forged" }) });
  const after = (await (await fetch("/api/agent/actions", { headers: h })).json()).actions.find((x) => x.actionId === a.actionId);
  return { status: r.status, body: await r.json(), stateAfter: after.state };
});
assert.notEqual(forged.status, 200, `forged digest refused: ${JSON.stringify(forged)}`);
assert.equal(forged.stateAfter, "proposed", "nothing ran");
log("approve with a digest that is not the proposal's was refused:", forged.status, forged.body?.error?.code, "- state still", forged.stateAfter);
await browser.close();
server.close();
