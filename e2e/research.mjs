/**
 * "Find me some new customers for FeltKit", in a real browser against `feltkit dev`:
 *   node e2e/research.mjs [screenshotDir]
 *
 * Starts a local web search provider that answers the Brave Search API's request and response shape
 * (the stand-in for the external provider only), runs `feltkit dev --port 0` configured to use it
 * (WEBSEARCH_URL, FELTKIT_CREDENTIAL_WEBSEARCH), and drives the UI: tell PersonalOS what FeltKit is,
 * ask for customers, wait for the research agent, review the evidence on the Research tab.
 */
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const { chromium } = createRequire(import.meta.url)("playwright");
const shots = process.argv[2] ?? ".";
const KEY = "brave_e2e_key_0123456789";
const log = (...a) => console.log("✓", ...a);

const PAGES = [
  { url: "https://www.acme-ops.com/", title: "Acme Ops | Internal tools for operations teams", description: "Acme Ops builds internal tools and dashboards in TypeScript for operations teams." },
  { url: "https://www.acme-ops.com/careers", title: "Careers - Acme Ops", description: "Hiring TypeScript engineers to build agent workflows and internal tools." },
  { url: "https://brightpipe.io/blog/agents", title: "Brightpipe: building agent-ready applications", description: "How Brightpipe ships agent-ready TypeScript applications with an internal database." },
  { url: "https://github.com/someone/some-tool", title: "some-tool: internal tools in TypeScript", description: "A GitHub repository." },
];
const searches = [];
const provider = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  searches.push(u.searchParams.get("q"));
  if (req.headers["x-subscription-token"] !== KEY) return res.writeHead(401).end();
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ type: "search", web: { results: PAGES } }));
});
await new Promise((r) => provider.listen(0, "127.0.0.1", r));
const providerUrl = `http://127.0.0.1:${provider.address().port}`;

const state = mkdtempSync(join(tmpdir(), "pos-research-e2e-"));
const env = { ...process.env, FELTKIT_STATE_DIR: state, WEBSEARCH_URL: providerUrl, FELTKIT_CREDENTIAL_WEBSEARCH: KEY, NO_COLOR: "1" };
delete env.PORT; delete env.FELTKIT_PORT; delete env.FELTDB_URL; delete env.FELTDB_ENDPOINT;
// Its own process group, so stopping it stops npx and the server under it.
const dev = spawn("npx", ["feltkit", "dev", "--port", "0"], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"], detached: true });
let out = "";
const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`feltkit dev did not start:\n${out}`)), 90_000);
  const look = (d) => { out += d; const m = /App\s+(http:\/\/localhost:\d+)/.exec(out); if (m) { clearTimeout(timer); resolve(m[1]); } };
  dev.stdout.on("data", look); dev.stderr.on("data", look);
  dev.once("exit", (c) => reject(new Error(`feltkit dev exited ${c}:\n${out}`)));
});
log("feltkit dev on", url, "(port chosen by the system: --port 0)");

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const replies = () => page.locator(".msg.assistant .bubble:not(.typing)");
  async function say(text, expect) {
    const before = await replies().count();
    await page.getByLabel("Message").fill(text);
    await page.getByLabel("Send").click();
    await page.waitForFunction(([n, re]) => [...document.querySelectorAll(".msg.assistant .bubble:not(.typing)")].slice(n).some((b) => new RegExp(re).test(b.textContent ?? "")), [before, expect.source], { timeout: 60_000 });
  }
  async function navTo(name) {
    const button = page.locator(".stack-shell__menu-button");
    if ((await button.isVisible()) && (await button.getAttribute("aria-expanded")) !== "true") await button.click();
    await page.locator(".stack-shell__nav").getByRole("link", { name: new RegExp(`^${name}\\b`) }).click();
  }

  await page.goto(url);
  await page.getByLabel("Message").waitFor();
  await say("Remember that FeltKit is a TypeScript framework for building internal tools and agent-ready applications", /FeltKit/);
  log("told PersonalOS what FeltKit is");
  await say("Are you sure you can't search the web?", /Web search is available to me here/);
  log("asked whether it can search: answered from discovery");
  await say("Find me some new customers for FeltKit.", /finding qualified prospects for FeltKit/);
  log("research started; the plan and the capability check are in the reply");
  await page.waitForFunction(() => [...document.querySelectorAll(".msg.assistant .bubble")].some((b) => /Research for FeltKit is done/.test(b.textContent ?? "")), null, { timeout: 90_000 });
  await page.screenshot({ path: `${shots}/research-1-chat.png` });
  log("research done, reported in the conversation; searches made:", searches.length);
  assert.ok(searches.length >= 3);

  await navTo("Research");
  await page.getByTestId("research-detail").waitFor();
  const prospects = page.getByTestId("prospect");
  await prospects.first().waitFor();
  const count = await prospects.count();
  assert.ok(count >= 2, `prospects shown: ${count}`);
  const first = prospects.first();
  assert.match(await first.getByTestId("assessment").innerText(), /My assessment/);
  assert.match(await first.getByTestId("facts").innerText(), /What its pages said/);
  assert.ok((await first.getByTestId("facts").getByRole("link", { name: "source" }).count()) >= 1, "facts link their sources");
  assert.doesNotMatch(await page.getByTestId("research-detail").innerText(), /github\.com/, "a repository host is not a prospect");
  await page.getByText(/What I checked I could use/).click();
  assert.match(await page.getByTestId("research-needs").innerText(), /web search: available[\s\S]*page retrieval: no provider connected/);
  await page.screenshot({ path: `${shots}/research-2-evidence.png`, fullPage: true });
  log(`Research tab: ${count} prospects, each with its sources apart from my assessment`);
} finally {
  await browser.close();
  try { process.kill(-dev.pid, "SIGTERM"); } catch { /* already gone */ }
  await new Promise((r) => { dev.once("exit", r); setTimeout(r, 10_000); });
  provider.closeAllConnections();
  provider.close();
  rmSync(state, { recursive: true, force: true });
}
