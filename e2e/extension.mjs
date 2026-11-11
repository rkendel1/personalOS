/**
 * The browser extension, accepted in a real browser (Chromium, the extension loaded unpacked).
 *
 *   npm run extension:build && node e2e/extension.mjs <evidence-dir>
 *
 * Starts, as separate processes: a loopback OpenAI-compatible model that streams slowly, and
 * PersonalOS (`feltkit dev`, model pointed at it with the real CLI). Then drives the side panel
 * page (chrome-extension://<id>/sidepanel.html) through its UI:
 *
 *   install · connect · sign-in · rendering at side-panel width · capabilities (task via chat,
 *   Tasks tab) · unauthorized (read-only guest) · streaming · interrupted streaming (Stop, and the
 *   panel closed mid-reply) · close/reopen · revocation (operator revokes; the open panel signs
 *   out by itself, its streams close) · expiry · user isolation · the web app beside it ·
 *   extension update (runtime.reload) and browser restart (same profile) · no token in URLs,
 *   unreadable by content scripts.
 *
 * Two test-only differences from an installed extension, both outside the product code:
 *   - the host permission is granted in the manifest copy (automation cannot click Chrome's
 *     permission prompt; the product asks with chrome.permissions.request);
 *   - a probe content script is added, to show content scripts cannot read the session.
 * FELTKIT_SESSION_RECHECK_MS=1000 makes the server re-check open streams every second (default 15 s).
 */
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const { chromium } = createRequire(import.meta.url)("playwright");

const shots = resolve(process.argv[2] ?? ".");
mkdirSync(shots, { recursive: true });
const root = resolve(new URL("..", import.meta.url).pathname);
const APP_PORT = Number(process.env.APP_PORT ?? 5196);
const ORIGIN = `http://localhost:${APP_PORT}`;
const results = [];
const log = (...a) => console.log("✓", ...a);
const children = [];
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VITE_)?FELTDB_|^FELTKIT_CREDENTIAL_|^OPENAI_API_KEY$|^AI_GATEWAY_API_KEY$/.test(k)));

function run(cmd, args, env) {
  const child = spawn(cmd, args, { env, cwd: root, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  child.output = () => out;
  child.stop = () => { try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ } };
  children.push(child);
  return child;
}
async function until(check, what, ms = 60_000) {
  const start = Date.now();
  for (;;) {
    try { if (await check()) return; } catch { /* not yet */ }
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
const cli = (...args) => execFileSync("npx", ["feltkit", ...args], { cwd: root, env: cleanEnv, encoding: "utf8" });
async function scenario(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t0, detail: detail ?? "" });
    log(name, detail ? `— ${detail}` : "");
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - t0, detail: String(error?.message ?? error).split("\n")[0] });
    await page?.screenshot({ path: `${shots}/fail-${results.length}.png` }).catch(() => {});
    if (process.env.STOP_ON_FAIL) throw error;
    console.log("✗", name, "—", String(error?.message ?? error).split("\n")[0]);
  }
}

// ---- A model that streams, slowly enough to watch and to interrupt ------------------------------
let slow = false;
const modelCalls = [];
const model = createServer((req, res) => {
  modelCalls.push(`${req.method} ${req.url}`);
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const words = (slow ? "This is a deliberately slow reply so that it can be stopped before it finishes " : "Sure. Here is a streamed answer from the model, word by word, as it arrives ").split(" ").filter(Boolean);
    const n = slow ? 120 : 1;
    const parts = Array.from({ length: n }, () => words).flat();
    if (!JSON.parse(body || "{}").stream) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ id: "x", object: "chat.completion", model: "fake", choices: [{ index: 0, message: { role: "assistant", content: parts.join(" ") }, finish_reason: "stop" }] }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    let i = 0;
    const timer = setInterval(() => {
      if (res.destroyed) return clearInterval(timer);
      if (i < parts.length) {
        res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: (i ? " " : "") + parts[i] }, finish_reason: null }] })}\n\n`);
        i += 1;
      } else {
        clearInterval(timer);
        res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
        res.end();
      }
    }, slow ? 150 : 60);
    res.on("close", () => clearInterval(timer));
  });
});
await new Promise((r) => model.listen(0, "127.0.0.1", r));
const MODEL_ENDPOINT = `http://127.0.0.1:${model.address().port}/v1`;

// ---- PersonalOS ---------------------------------------------------------------------------------
rmSync(join(root, ".feltkit/development/state"), { recursive: true, force: true });
const appEnv = { ...cleanEnv, FELTKIT_SESSION_RECHECK_MS: "1000" };
let app;
for (let attempt = 0; attempt < 30 && !app; attempt += 1) {
  const p = run("npx", ["feltkit", "dev", "--port", String(APP_PORT)], appEnv);
  await until(() => /Ready in|already running/.test(p.output()), "the app to start or refuse");
  if (/Ready in/.test(p.output())) app = p;
  else await new Promise((r) => setTimeout(r, 1000));
}
cli("model", "set", "--provider", "ollama", "--model", "fake-stream", "--endpoint", MODEL_ENDPOINT);
log(`PersonalOS at ${ORIGIN}; model → loopback streaming server`);

// ---- The extension, as built, plus the two test-only manifest additions ------------------------
const ext = mkdtempSync(join(tmpdir(), "personalos-ext-"));
cpSync(join(root, "extension/dist"), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
manifest.host_permissions = [`http://localhost/*`];
manifest.content_scripts = [...(manifest.content_scripts ?? []), { matches: ["http://localhost/*"], js: ["probe-cs.js"], run_at: "document_idle" }];
writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest));
writeFileSync(join(ext, "probe-cs.js"), `(async()=>{const r={};for(const a of ["local","session"]){try{r[a]=await chrome.storage[a].get(null)}catch(e){r[a]="ERR "+e.message}}document.documentElement.dataset.probe=JSON.stringify(r)})();`);

const profile = mkdtempSync(join(tmpdir(), "personalos-profile-"));
const urls = [];
const consoleLines = [];
async function launch() {
  const ctx = await chromium.launchPersistentContext(profile, { headless: true, channel: "chromium", viewport: { width: 400, height: 820 }, deviceScaleFactor: 2, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
  ctx.on("request", (r) => urls.push(r.url()));
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  return { ctx, sw, id: sw.url().split("/")[2] };
}
let { ctx, sw, id } = await launch();
const PANEL = () => `chrome-extension://${id}/sidepanel.html`;
async function openPanel() {
  const page = await ctx.newPage();
  page.on("console", (m) => consoleLines.push(m.text()));
  await page.goto(PANEL());
  return page;
}
// Read through the panel when one is open (a trusted extension page), else through the service worker.
const stored = async () => (page && !page.isClosed() ? page : sw).evaluate(() => chrome.storage.local.get(null));
/** What a content script on an ordinary page can read of the extension's storage. */
async function probe() {
  const web = await ctx.newPage();
  await web.goto(`${ORIGIN}/`);
  await web.waitForFunction(() => document.documentElement.dataset.probe, null, { timeout: 15_000 });
  const seen = await web.evaluate(() => document.documentElement.dataset.probe);
  await web.close();
  return seen;
}
const tab = (page, name) => page.locator(".tabbar").getByRole("button", { name, exact: true }).click();
async function say(page, text) {
  await page.getByLabel("Message").fill(text);
  await page.getByLabel("Send").click();
  await page.waitForFunction((t) => {
    const msgs = [...document.querySelectorAll(".messages .msg:not(.superseded)")];
    const mine = msgs.map((m) => m.classList.contains("user") && m.querySelector(".bubble")?.textContent?.trim() === t).lastIndexOf(true);
    const lastMsg = msgs.at(-1);
    return mine >= 0 && mine < msgs.length - 1 && lastMsg?.classList.contains("assistant") && !lastMsg.querySelector(".typing") && !lastMsg.querySelector(".streaming");
  }, text, { timeout: 60_000 });
  const bubble = page.locator(".msg.assistant .bubble").last();
  await until(async () => (await bubble.innerText()).trim().length > 0, "the reply text");
  return (await bubble.innerText()).trim();
}
async function setModel(page, on) {
  await tab(page, "More");
  await page.locator(".more-sheet").getByRole("button", { name: "Settings" }).click();
  const toggle = page.getByLabel(/Converse with the model/);
  await toggle.waitFor();
  if ((await toggle.isChecked()) !== on) await toggle.click();
  await until(async () => (await toggle.isChecked()) === on, "the model setting");
  await tab(page, "Chat");
}
async function switchUser(page, id) {
  await tab(page, "More");
  await page.locator(".more-sheet").getByRole("button", { name: "Settings" }).click();
  const select = page.locator("select").filter({ has: page.locator(`option[value="${id}"]`) }).last();
  await select.selectOption(id);
  await until(async () => (await select.inputValue()) === id, `signed in as ${id}`);
  await page.waitForTimeout(500);
}

let page;
try {
  await scenario("install: service worker registers; the panel opens on the Connect screen", async () => {
    page = await openPanel();
    await page.getByRole("button", { name: "Connect" }).waitFor();
    await page.screenshot({ path: `${shots}/01-connect.png` });
    return `extension id ${id}`;
  });

  await scenario("connect + sign-in: the instance is checked, the dev identity signs in, a bearer session is stored", async () => {
    await page.locator("input").first().fill(`localhost:${APP_PORT}`);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByLabel("Message").waitFor({ timeout: 30_000 });
    await until(async () => String((await stored())["personalos:token"] ?? "").startsWith("fks_"), "the token to be stored");
    return "token stored as fks_… in chrome.storage.local (locked to trusted contexts)";
  });

  await scenario("rendering: the same App at side-panel width (bottom tab bar, More sheet)", async () => {
    await page.locator(".tabbar").waitFor();
    assert.equal(await page.locator(".rail").isVisible().catch(() => false), false, "no desktop rail at 400px");
    await page.screenshot({ path: `${shots}/02-panel-chat.png` });
    await tab(page, "More");
    await page.locator(".more-sheet").waitFor();
    await page.screenshot({ path: `${shots}/03-panel-more.png` });
    await tab(page, "More");
    return "tabbar + More sheet";
  });

  await scenario("capabilities: chat creates a task through the app's functions; the Tasks tab shows it", async () => {
    await setModel(page, false); // the deterministic assistant (no model): the app's own functions do the work
    const r = await say(page, "add renew passport to my list, it's urgent");
    assert.match(r, /Renew passport/);
    await tab(page, "Tasks");
    await page.getByText("Renew passport").waitFor();
    await tab(page, "Chat");
    return r.split("\n")[0];
  });

  await scenario("streaming: a model reply grows in the panel as it arrives", async () => {
    await setModel(page, true);
    await page.getByLabel("New conversation").click().catch(() => {});
    await page.getByLabel("Message").fill("tell me something");
    await page.getByLabel("Send").click();
    const stream = page.getByTestId("streaming");
    await stream.waitFor({ timeout: 30_000 });
    const seen = new Set();
    for (let i = 0; i < 100 && (await stream.count()); i++) {
      seen.add((await stream.innerText().catch(() => "")).length);
      await page.waitForTimeout(40);
    }
    assert.ok(seen.size >= 3, `grew through ${seen.size} lengths`);
    await page.locator(".msg.assistant .bubble").last().getByText(/word by word/).waitFor({ timeout: 30_000 });
    return `the reply grew through ${seen.size} lengths before it finished`;
  });

  await scenario("interrupted streaming (Stop): the reply stops and the panel stays usable", async () => {
    slow = true;
    await page.getByLabel("Message").fill("a long answer please");
    await page.getByLabel("Send").click();
    await page.getByTestId("streaming").waitFor({ timeout: 30_000 });
    await page.waitForTimeout(800);
    await page.getByLabel("Stop").click();
    await page.getByTestId("streaming").waitFor({ state: "detached", timeout: 15_000 });
    slow = false;
    await page.screenshot({ path: `${shots}/04-stopped.png` });
    const r = await say(page, "and now a short one");
    assert.match(r, /word by word/);
    return "stopped mid-reply; the next message streamed and finished normally";
  });

  await scenario("interrupted streaming (panel closed mid-reply), then reopened: still signed in, history intact", async () => {
    slow = true;
    await page.getByLabel("Message").fill("another long answer");
    await page.getByLabel("Send").click();
    await page.getByTestId("streaming").waitFor({ timeout: 30_000 });
    await page.waitForTimeout(600);
    await page.close();
    slow = false;
    page = await openPanel();
    await page.getByLabel("Message").waitFor({ timeout: 30_000 });
    await page.getByLabel("Conversations").click();
    await page.locator(".thread").first().click();
    await page.getByText("another long answer").waitFor({ timeout: 15_000 });
    await page.screenshot({ path: `${shots}/05-reopened.png` });
    await tab(page, "Tasks");
    await page.getByText("Renew passport").waitFor();
    await tab(page, "Chat");
    return "the interrupted turn is in the conversation; tasks intact";
  });

  await scenario("no credentials in URLs; content scripts cannot read the session", async () => {
    const leaked = urls.filter((u) => /fks_|token=/.test(u));
    assert.deepEqual(leaked, []);
    const seen = await probe();
    assert.ok(!seen.includes("fks_"), seen);
    assert.match(seen, /not allowed/);
    assert.ok(!consoleLines.some((l) => l.includes("fks_")), "no token in console output");
    return `${urls.length} requests checked; probe: ${JSON.parse(seen).local}`;
  });

  await scenario("web app unchanged: the same instance in a tab (cookie session) shows the same data", async () => {
    const web = await ctx.newPage();
    await web.setViewportSize({ width: 1280, height: 820 });
    await web.goto(`${ORIGIN}/#/tasks`);
    await web.getByText("Renew passport").waitFor({ timeout: 30_000 });
    await web.screenshot({ path: `${shots}/06-web.png` });
    const session = await web.evaluate(async () => (await (await fetch("/api/session", { headers: { "X-FeltKit-Session": "cookie" } })).json()));
    await web.close();
    assert.equal(session.principal?.id, "ada");
    assert.notEqual(session.transport, "bearer", "the tab does not use the extension's bearer token");
    return `web app renders the same data with its own session (transport: ${session.transport})`;
  });

  await scenario("unauthorized: a read-only guest cannot create tasks", async () => {
    await switchUser(page, "guest");
    await tab(page, "Tasks");
    const before = await page.locator("text=Renew passport").count();
    await page.getByLabel("New task").fill("guest task");
    await page.getByRole("button", { name: "Add" }).click();
    const refusal = (await page.getByText(/Missing permission/).first().innerText({ timeout: 10_000 })).trim();
    await page.screenshot({ path: `${shots}/07-guest.png` });
    assert.equal(await page.getByText("guest task").count(), 0);
    return `refused by the server: "${refusal}"; the guest sees ${before} of Ada's tasks`;
  });

  await scenario("user isolation: Grace sees none of Ada's tasks or conversations", async () => {
    await switchUser(page, "grace");
    await tab(page, "Tasks");
    await page.waitForTimeout(1500);
    assert.equal(await page.getByText("Renew passport").count(), 0);
    await tab(page, "Chat");
    await page.getByLabel("Conversations").click();
    await page.waitForTimeout(500);
    assert.equal(await page.getByText("another long answer").count(), 0);
    await page.reload(); // close the drawer the simple way (same panel, same session)
    await page.getByLabel("Message").waitFor();
    await switchUser(page, "ada");
    await tab(page, "Tasks");
    await page.getByText("Renew passport").waitFor();
    await tab(page, "Chat");
    return "Grace: 0 of Ada's items; back to Ada";
  });

  await scenario("extension update + browser restart (same profile): new version, same session, still locked", async () => {
    const tokenBefore = (await stored())["personalos:token"];
    await ctx.close();
    // The update: a new version of the extension in place (what Chrome does when it installs one).
    const m = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
    const from = m.version;
    m.version = from.split(".").map((n, i, a) => (i === a.length - 1 ? String(Number(n) + 1) : n)).join(".");
    writeFileSync(join(ext, "manifest.json"), JSON.stringify(m));
    ({ ctx, sw, id } = await launch());
    page = await openPanel();
    await page.getByLabel("Message").waitFor({ timeout: 30_000 });
    const version = await page.evaluate(() => chrome.runtime.getManifest().version);
    assert.equal(version, m.version);
    assert.equal((await stored())["personalos:token"], tokenBefore, "the same session");
    await tab(page, "Tasks");
    await page.getByText("Renew passport").waitFor();
    await tab(page, "Chat");
    const seen = await probe();
    assert.match(seen, /not allowed/, "still locked after the update");
    return `${from} → ${version} across a browser restart; signed in with the same session; data present; content scripts refused`;
  });

  await scenario("revocation: the operator revokes the panel's session; the open panel signs out by itself and its token is cleared", async () => {
    const token = (await stored())["personalos:token"];
    // Find this session among Ada's by asking the server which ref the token has (its own /api/auth/sessions).
    const list = await (await fetch(`${ORIGIN}/api/auth/sessions`, { headers: { Authorization: `Bearer ${token}` } })).json();
    const current = (list.sessions ?? []).find((s) => s.current);
    assert.ok(current?.ref, `the session lists itself (${JSON.stringify(list).slice(0, 200)})`);
    let streamEnded = false;
    page.on("requestfinished", (r) => { if (r.url().endsWith("/api/events")) streamEnded = true; });
    page.on("requestfailed", (r) => { if (r.url().endsWith("/api/events")) streamEnded = true; });
    const t0 = Date.now();
    const revoked = cli("session", "revoke", current.ref).trim();
    const after = await (await fetch(`${ORIGIN}/api/session`, { headers: { Authorization: `Bearer ${token}` } })).json();
    assert.equal(after.principal ?? null, null, `the server no longer accepts the token (CLI said: ${revoked}; /api/session: ${JSON.stringify(after).slice(0, 160)})`);
    // The panel must notice by itself (no click, no request of its own): its streams end, the client
    // clears the token. In development the App then signs the first dev user in again (a new session).
    await until(async () => (await stored())["personalos:token"] !== token, "the revoked token to leave storage", 30_000);
    const ms = Date.now() - t0;
    const now = (await stored())["personalos:token"];
    await page.screenshot({ path: `${shots}/08-revoked.png` });
    return `the panel dropped the revoked token ${ms} ms after revocation, without any user action (${now ? "dev auto sign-in issued a new session" : "signed out"}); change stream ${streamEnded ? "closed" : "state unknown"}`;
  });

  await scenario("expiry: a session that expires while the panel is open ends the same way", async () => {
    const out = cli("session", "create", "--id", "ada", "--role", "owner", "--ttl", "0.002");
    const token = /fks_[\w-]+/.exec(out)?.[0];
    assert.ok(token, "an operator-issued session");
    await page.evaluate((t) => chrome.storage.local.set({ "personalos:token": t }), token);
    await page.close();
    page = await openPanel();
    await page.getByLabel("Message").waitFor({ timeout: 30_000 });
    const t0 = Date.now();
    await until(async () => (await stored())["personalos:token"] !== token, "the expired token to leave storage", 40_000);
    return `the operator-issued session (~7 s TTL) was dropped ${Date.now() - t0} ms after the panel opened, without any user action`;
  });
} finally {
  await ctx.close().catch(() => {});
  writeFileSync(join(shots, "app.log"), (app?.output() ?? "").replace(/(fk[asf]_)[\w-]+/g, "$1…"));
  writeFileSync(join(shots, "diagnostics.json"), JSON.stringify({ modelCalls, console: consoleLines.map((l) => l.replace(/(fk[asf]_)[\w-]+/g, "$1…")).slice(-80), requests: urls.filter((u) => u.includes(String(APP_PORT))).slice(-60) }, null, 1));
  for (const c of children) c.stop();
  model.close();
  writeFileSync(join(shots, "results.json"), JSON.stringify({ when: new Date().toISOString(), results }, null, 1));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} scenarios passed`);
  process.exitCode = failed.length ? 1 : 0;
}
