/**
 * FeltKit M1 acceptance, against the running application, in a real browser.
 *
 *   node e2e/acceptance.mjs <screenshot-dir>
 *
 * Starts, as separate processes:
 *   - Resolver (its CLI: `resolver init` / `serve`; RESOLVER_BIN, default ../resolver/packages/server/dist/cli.js)
 *   - PersonalOS (`feltkit dev`), whose development model is the Resolver reference ref://dev/personalos/model
 * The model is real: OpenAI models through Vercel AI Gateway (AI_GATEWAY_API_KEY, stored only in
 * Resolver's vault). Then, through the UI only:
 *   1. the acceptance conversation streams; the reminder is proposed (approval required); the reply names the priority
 *   2. approve → reminder created with an execution receipt
 *   3. Stop cancels a streaming reply
 *   4. Resolver retargets the model (A → B) while the app keeps running; the next reply is B's
 *   5. the app process restarts; conversation, proposals and receipts are still there
 *   6. another person sees none of it and cannot approve it (server-side)
 *   7. with the model off, the deterministic assistant still creates reminders
 */
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const { chromium } = createRequire(import.meta.url)("playwright");

const shots = resolve(process.argv[2] ?? ".");
const root = resolve(new URL("..", import.meta.url).pathname);
const RESOLVER_BIN = process.env.RESOLVER_BIN ?? resolve(root, "../resolver/packages/server/dist/cli.js");
const KEY = process.env.AI_GATEWAY_API_KEY;
if (!KEY) throw new Error("AI_GATEWAY_API_KEY is required (the real model).");
const MODEL_REF = "ref://dev/personalos/model";
const SECRET_REF = "ref://dev/llm/gateway-key";
const MODEL_A = "openai/gpt-4.1-mini";
const MODEL_B = "openai/gpt-4o-mini";
const APP_PORT = 5190;
const RESOLVER_PORT = 4390;
const log = (...a) => console.log("✓", ...a);
// The stack-ui Shell's navigation: a sidebar on wide screens, a menu behind the bar's button below 768px.
async function navTo(page, name) {
  const button = page.locator(".stack-shell__menu-button");
  if ((await button.isVisible()) && (await button.getAttribute("aria-expanded")) !== "true") await button.click();
  await page.locator(".stack-shell__nav").getByRole("link", { name: new RegExp(`^${name}\\b`) }).click();
}

const conversationUrlOf = (page) => page.url();
const children = [];
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VITE_)?FELTDB_|^FELTKIT_CREDENTIAL_|^OPENAI_API_KEY$|^AI_GATEWAY_API_KEY$/.test(k)));

function run(cmd, args, env, label) {
  // Its own process group, so stopping it stops what it started (npx → feltkit dev).
  const child = spawn(cmd, args, { env, cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: true });
  child.stop = (signal = "SIGTERM") => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* already gone */
    }
  };
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.output = () => out;
  child.label = label;
  children.push(child);
  return child;
}
async function until(check, what, ms = 60_000) {
  const start = Date.now();
  for (;;) {
    try {
      if (await check()) return;
    } catch {
      /* not yet */
    }
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
const resolverCli = (args, env, input) => execFileSync("node", [RESOLVER_BIN, ...args], { env: { ...cleanEnv, ...env }, input, encoding: "utf8" });

// ---- Resolver --------------------------------------------------------------------------------
const rdir = join(shots, ".resolver");
rmSync(rdir, { recursive: true, force: true });
mkdirSync(rdir, { recursive: true });
const renv = { ...cleanEnv, RESOLVER_ENV: "development" };
// `init` prints the admin key alone on stdout (its notice goes to stderr).
const lastLine = (out) => out.trim().split("\n").filter(Boolean).at(-1)?.trim();
const adminKey = lastLine(execFileSync("node", [RESOLVER_BIN, "init", "--dir", rdir, "--tenant", "default"], { env: renv, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
assert.ok(adminKey, "resolver init printed an admin key");
const resolverProc = run("node", [RESOLVER_BIN, "serve", "--dir", rdir, "--port", String(RESOLVER_PORT), "--host", "127.0.0.1"], renv, "resolver");
const RESOLVER_URL = `http://127.0.0.1:${RESOLVER_PORT}`;
await until(async () => /listening/.test(resolverProc.output()), "Resolver to serve");
const admin = { RESOLVER_URL, RESOLVER_API_KEY: adminKey };
resolverCli(["set", SECRET_REF, "--kind", "secret", "--secret-stdin", "--reason", "gateway key"], admin, KEY);
resolverCli(["set", MODEL_REF, "--kind", "model", "--value", JSON.stringify({ provider: "custom", model: MODEL_A, endpoint: "https://ai-gateway.vercel.sh/v1", credential: SECRET_REF }), "--reason", "start on A", "--ttl", "300"], admin);
const appKeyOut = resolverCli(["keys", "create", "personalos-dev", "--grant", `read:${MODEL_REF}`, "--grant", "read,reveal:ref://dev/llm/*"], admin);
const appKey = lastLine(appKeyOut);
assert.ok(appKey, "an application key was issued");
log(`Resolver at ${RESOLVER_URL}: ${MODEL_REF} → ${MODEL_A} (r1); the gateway key lives only in Resolver's vault`);

// ---- PersonalOS ------------------------------------------------------------------------------
rmSync(join(root, ".feltkit/development/state"), { recursive: true, force: true });
const appEnv = { ...cleanEnv, RESOLVER_URL, RESOLVER_API_KEY: appKey, PERSONALOS_MODEL_REF: MODEL_REF };
const startApp = async () => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const app = run("npx", ["feltkit", "dev", "--port", String(APP_PORT)], appEnv, "app");
    // A previous server still shutting down holds the environment's lock: FeltKit refuses a second one.
    await until(() => /Ready in|already running/.test(app.output()), "the app to start or refuse");
    if (/Ready in/.test(app.output())) return app;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("the app never started");
};
let appProc = await startApp();
const URL_ = `http://localhost:${APP_PORT}`;
log(`PersonalOS (pid ${appProc.pid}) at ${URL_}`);

const browser = await chromium.launch();
const failures = [];
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, timezoneId: "America/New_York", locale: "en-US" });
  const page = await ctx.newPage();
  await page.goto(URL_);
  await page.getByLabel("Message").waitFor();

  // Seed one outstanding high-priority task through the UI.
  const today = await page.evaluate(() => new Date().toLocaleDateString("en-CA"));
  await navTo(page, "Tasks");
  await page.getByLabel("New task").fill("Pending project review");
  await page.getByLabel("Due date").fill(today);
  await page.getByRole("button", { name: "Add" }).click();
  await page.getByText("Pending project review").click();
  await page.getByRole("combobox").filter({ hasText: "Normal" }).first().selectOption("high");
  await navTo(page, "Chat");

  // 1. The acceptance conversation, streamed.
  await page.getByLabel("Message").fill("Remind me to follow up with John tomorrow at 10am, and tell me what else I should prioritize.");
  // Every length the streaming bubble renders, recorded in the page itself: a fast model can stream a
  // whole reply in a few hundred milliseconds, faster than polling from the test can see.
  await page.evaluate(() => {
    window.__lengths = new Set();
    new MutationObserver(() => {
      const el = document.querySelector('[data-testid="streaming"]');
      if (el) window.__lengths.add(el.textContent.length);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.getByLabel("Send").click();
  const stream = page.getByTestId("streaming");
  await stream.waitFor({ timeout: 60_000 });
  await stream.waitFor({ state: "detached", timeout: 120_000 });
  const seen = new Set(await page.evaluate(() => [...window.__lengths].filter((n) => n > 0)));
  assert.ok(seen.size >= 2, `the reply grew in the UI while streaming (lengths seen: ${[...seen].join(", ")})`);
  log(`streamed: the reply grew through ${seen.size} different lengths before it finished`);
  const card = page.getByTestId("proposal").last();
  await card.waitFor({ timeout: 90_000 });
  await page.screenshot({ path: `${shots}/m1-1-proposed.png` });
  const cardText = await card.innerText();
  assert.match(cardText, /Create reminder: .*John/i);
  assert.match(cardText, /Approval required/);
  assert.match(cardText, /Tomorrow, 10 AM/);
  const replyText = await page.locator(".msg.assistant .bubble").last().innerText();
  assert.match(replyText, /project review/i, "the analysis names the priority");
  assert.doesNotMatch(replyText, /\b(I('ve| have) (created|set|scheduled)|is (now )?(set|scheduled|created))\b/i);
  assert.match(replyText, new RegExp(MODEL_A.replace("/", "\\/")));
  log(`reply (${MODEL_A}): ${replyText.split("\n")[0].slice(0, 160)}`);
  // Nothing ran yet.
  const tasksNow = await page.evaluate(async () => {
    const { csrf } = await (await fetch("/api/session", { headers: { "X-FeltKit-Session": "cookie" } })).json();
    const r = await (await fetch("/api/query/tasks%3Alist", { method: "POST", headers: { "content-type": "application/json", "X-FeltKit-Session": "cookie", "X-FeltKit-CSRF": csrf }, body: JSON.stringify({ args: { status: "open" } }) })).json();
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
  });
  assert.equal(tasksNow.some((t) => /john/i.test(t.title)), false, "the reminder does not exist before approval");

  // 2. Approve in the app, from another session (a second device): this page updates live, without a reload.
  const second = await (await browser.newContext({ timezoneId: "America/New_York" })).newPage();
  await second.goto(conversationUrlOf(page));
  const secondCard = second.getByTestId("proposal").last();
  await secondCard.waitFor({ timeout: 30_000 });
  const navigations = [];
  page.on("framenavigated", (f) => f === page.mainFrame() && navigations.push(f.url()));
  await secondCard.getByRole("button", { name: "Approve" }).click();
  await card.getByText(/^Done$/).waitFor({ timeout: 30_000 });
  assert.equal(navigations.length, 0, "the first page was not reloaded");
  log("live: approved in a second session; the first page's card turned Done without a reload");
  await second.context().close();
  const done = await card.innerText();
  assert.match(done, /Created: .*John/i);
  assert.match(done, /approved by ada/);
  assert.match(done, /receipt /);
  await page.screenshot({ path: `${shots}/m1-2-approved.png` });
  log(`approved: ${done.split("\n").filter(Boolean).join(" | ")}`);
  const conversationUrl = page.url();

  // 3. Stop a streaming reply.
  await page.getByLabel("Message").fill("Write me a 400-word story about a lighthouse keeper. No tools.");
  await page.getByLabel("Send").click();
  await page.getByTestId("streaming").waitFor({ timeout: 60_000 });
  await page.getByLabel("Stop").click();
  await page.getByText(/· stopped/).waitFor({ timeout: 30_000 });
  log("Stop: the reply was cut short and recorded as stopped");

  // 4. Retarget the model in Resolver; the app keeps running.
  const pid = appProc.pid;
  resolverCli(["set", MODEL_REF, "--kind", "model", "--value", JSON.stringify({ provider: "custom", model: MODEL_B, endpoint: "https://ai-gateway.vercel.sh/v1", credential: SECRET_REF, options: { max_tokens: 700 } }), "--reason", "switch to B"], admin);
  await navTo(page, "Settings");
  await until(async () => {
    await page.reload();
    return /gpt-4o-mini/.test(await page.getByTestId("model-status").innerText());
  }, "the app to see revision 2", 30_000);
  const status = await page.getByTestId("model-status").innerText();
  assert.match(status, /r2/);
  await page.screenshot({ path: `${shots}/m1-3-switched.png` });
  await navTo(page, "Chat");
  await page.getByLabel("Message").fill("In one sentence: what's due today?");
  await page.getByLabel("Send").click();
  await page.locator(".provenance").filter({ hasText: MODEL_B }).last().waitFor({ timeout: 90_000 });
  assert.equal(appProc.pid, pid);
  log(`Resolver switched ${MODEL_A} → ${MODEL_B} (${status.trim()}); same app process ${pid}; the next reply came from B`);

  // 5. Restart the app process.
  appProc.stop();
  await until(() => appProc.exitCode !== null || appProc.signalCode !== null, "the app to stop", 20_000);
  // The server itself (not npx) must be gone: it holds the environment's lock until it exits.
  await until(() => {
    try {
      execFileSync("pgrep", ["-f", `dev --port ${APP_PORT}`]);
      return false;
    } catch {
      return true;
    }
  }, "the old server process to exit", 30_000);
  appProc = await startApp();
  await page.goto(conversationUrl);
  const again = page.getByTestId("proposal").first();
  await again.waitFor({ timeout: 30_000 });
  assert.match(await again.innerText(), /Created: .*John[\s\S]*Done[\s\S]*receipt/i);
  await page.screenshot({ path: `${shots}/m1-4-after-restart.png` });
  log(`restart (new pid ${appProc.pid}): the conversation, the approved proposal and its receipt are still there`);

  // 6. Another person.
  const csrfOf = async (p) => (await p.evaluate(async () => (await (await fetch("/api/session", { headers: { "X-FeltKit-Session": "cookie" } })).json()).csrf));
  const adaActions = await page.evaluate(async () => (await (await fetch("/api/agent/actions", { headers: { "X-FeltKit-Session": "cookie" } })).json()).actions);
  const grace = await (await browser.newContext()).newPage();
  await grace.goto(URL_);
  await grace.getByLabel("Message").waitFor();
  await grace.evaluate(async () => {
    const s = await (await fetch("/api/session", { headers: { "X-FeltKit-Session": "cookie" } })).json();
    await fetch("/api/auth/dev", { method: "POST", headers: { "content-type": "application/json", "X-FeltKit-Session": "cookie", "X-FeltKit-CSRF": s.csrf }, body: JSON.stringify({ userId: "grace" }) });
  });
  await grace.reload();
  const csrf = await csrfOf(grace);
  const graceView = await grace.evaluate(async ({ csrf, target }) => {
    const h = { "content-type": "application/json", "X-FeltKit-Session": "cookie", "X-FeltKit-CSRF": csrf };
    const list = await (await fetch("/api/agent/actions", { headers: h })).json();
    const approve = await fetch("/api/agent/actions/approve", { method: "POST", headers: h, body: JSON.stringify(target) });
    const convo = await (await fetch("/api/query/conversations%3Alist", { method: "POST", headers: h, body: JSON.stringify({ args: {} }) })).json();
    return { actions: list.actions, approveStatus: approve.status, approveCode: (await approve.json()).error?.code, conversations: convo.value };
  }, { csrf, target: { taskId: adaActions[0].taskId, actionId: adaActions[0].actionId } });
  assert.deepEqual(graceView.actions, []);
  assert.deepEqual(graceView.conversations, []);
  assert.equal(graceView.approveStatus, 404);
  log(`isolation: Grace sees 0 actions and 0 conversations; approving Ada's action → HTTP ${graceView.approveStatus} ${graceView.approveCode}`);

  // 7. Model off: the deterministic assistant.
  await navTo(page, "Settings");
  await page.getByLabel(/Converse with the model/).click();
  await page.waitForFunction(() => ![...document.querySelectorAll(".toggle")].find((l) => l.textContent.includes("Converse"))?.querySelector("input")?.checked);
  await navTo(page, "Chat");
  await page.getByLabel("New conversation").click();
  await page.getByLabel("Message").fill("Remind me to call mom tomorrow at 9am");
  await page.getByLabel("Send").click();
  await page.getByText(/remind you to \*?\*?call mom|remind you to call mom/i).waitFor({ timeout: 30_000 });
  log("model off: the built-in assistant created the reminder deterministically");
  await page.screenshot({ path: `${shots}/m1-5-model-off.png` });
} catch (error) {
  failures.push(error);
} finally {
  await browser.close();
  for (const c of children) c.stop();
}
if (failures.length) {
  for (const c of children) console.error(`--- ${c.label} output (tail) ---\n${c.output().replace(new RegExp(KEY, "g"), "<key>").slice(-3000)}`);
  console.error(failures[0]);
  process.exit(1);
}
// The key never left Resolver's vault: no file in the app's state directory contains it.
let leaked = "";
try {
  leaked = execFileSync("grep", ["-rlF", KEY, join(root, ".feltkit/development")], { encoding: "utf8" }).trim();
} catch {
  leaked = ""; // grep exits 1 when nothing matches
}
assert.equal(leaked, "", `the key was found in: ${leaked}`);
log("the gateway key is in no file of the app's state (it lives in Resolver's vault)");
console.log("✓ done");
