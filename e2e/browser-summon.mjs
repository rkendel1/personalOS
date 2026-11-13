/**
 * Browser summoning, accepted in a real browser against the real local stack:
 *
 *   npm run extension:build && node --import tsx e2e/browser-summon.mjs <evidenceDir> [pageUrl]
 *
 * Real: Chromium with the PersonalOS extension loaded unpacked; a real web page (default
 * https://www.thoughtworks.com/); `feltkit dev` (its own state); the real AuthBoundry (tests/authboundry)
 * with Ada's delegation; PersonalOS's page reader on the open web; and, with AI_GATEWAY_API_KEY set, the
 * model (gpt-4.1-mini via Vercel AI Gateway).
 *
 * The flow: open the page and select a paragraph · open the PersonalOS panel and connect (dev sign-in:
 * a FeltKit bearer session in the extension's locked storage) · Summon PersonalOS with the selection and
 * "Research this company…" · the receipt shows · close the page · kill the server (SIGKILL) while the
 * work runs and start it again · the panel shows the outcome · open the conversation: the result is
 * there · "Back to the page" reopens it · a second summon from the page continues the same conversation.
 *
 * Test-only differences from a person using it, all outside the product code:
 *   - the extension's host permissions are granted in the manifest copy (automation can't click
 *     Chrome's permission prompt, or the toolbar button that grants activeTab);
 *   - the panel opens as a tab (automation can't open Chrome's side panel), so "this page" is the last
 *     web page used, as the panel does when it is a tab;
 *   - the selection is made by script (window.getSelection on a paragraph), not by dragging the mouse.
 */
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startRealAuthority, authboundryInstalled } from "../tests/fixtures/anywhere.ts";
import { CAPABILITIES } from "../feltkit/_authority.ts";

const { chromium } = createRequire(import.meta.url)("playwright");
const out = process.argv[2] ?? ".";
const PAGE = process.argv[3] ?? "https://www.thoughtworks.com/";
mkdirSync(out, { recursive: true });
if (!authboundryInstalled()) { console.error("AuthBoundry is not installed (npm ci --prefix tests/authboundry). Nothing was run."); process.exit(2); }
const root = process.cwd();
const t0 = Date.now();
const log = (...a) => console.log(`${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s ✓`, ...a);
const evidence = { at: new Date().toISOString(), page: PAGE, steps: [] };
const note = (step, detail = {}) => { evidence.steps.push({ step, at: Date.now() - t0, ...detail }); log(step, JSON.stringify(detail).slice(0, 240)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 120_000) {
  const end = Date.now() + ms;
  for (;;) { const v = await check().catch(() => null); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(500); }
}

// ── The platform: AuthBoundry with Ada's delegation, and PersonalOS ───────────────────────────
const ab = await startRealAuthority({ ada: [...CAPABILITIES] }, CAPABILITIES);
await ab.delegate("browser-summon", "ada", ["personalos.research.run", "personalos.memory.write"]);
const state = mkdtempSync(join(tmpdir(), "pos-browser-summon-"));
const MODEL = Boolean(process.env.AI_GATEWAY_API_KEY);
const env = { ...process.env, FELTKIT_STATE_DIR: state, NO_COLOR: "1", AUTHBOUNDRY_URL: ab.url, FELTKIT_CREDENTIAL_AUTHBOUNDRY_CHECK: ab.checkCredential, ...(MODEL ? { FELTKIT_CREDENTIAL_AI_GATEWAY: process.env.AI_GATEWAY_API_KEY } : {}) };
for (const k of ["PORT", "FELTKIT_PORT", "FELTDB_URL", "FELTDB_ENDPOINT", "OPENAISEARCH_URL", "WEBSEARCH_URL"]) delete env[k];
if (MODEL) execFileSync("npx", ["feltkit", "model", "set", "--provider", "custom", "--model", "openai/gpt-4.1-mini", "--endpoint", "https://ai-gateway.vercel.sh/v1", "--credential", "credential-ref:ai-gateway"], { env, stdio: "ignore" });
const PORT = 3000 + Math.floor(Math.random() * 90) + 5;
const ORIGIN = `http://localhost:${PORT}`;
const serverOut = [];
let dev = null;
async function startServer() {
  dev = spawn("npx", ["feltkit", "dev", "--port", String(PORT)], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let text = "";
  dev.stdout.on("data", (d) => { text += d; serverOut.push(String(d)); });
  dev.stderr.on("data", (d) => { text += d; serverOut.push(String(d)); });
  await until(async () => /App\s+http/.test(text) || (/✗/.test(text) && Promise.reject(new Error(text))), "feltkit dev to start");
}
async function killServer(signal) {
  const exited = new Promise((r) => dev.once("exit", r));
  try { process.kill(-dev.pid, signal); } catch {}
  await exited;
  let holder = null;
  try { holder = JSON.parse(readFileSync(join(state, "owner.lock"), "utf8")).pid; } catch {}
  for (let i = 0; holder && i < 100; i++) { try { process.kill(holder, 0); } catch { break; } try { process.kill(holder, signal); } catch {} await sleep(200); }
}
await startServer();
note("platform", { personalos: ORIGIN, authboundry: "real (@authboundry/core)", delegation: "browser-summon: personalos.research.run, personalos.memory.write", model: MODEL ? "openai/gpt-4.1-mini via AI Gateway" : "none (rules)" });

// ── The extension, as built, with the test-only host permissions ───────────────────────────────
const ext = mkdtempSync(join(tmpdir(), "pos-ext-"));
cpSync(join(root, "extension/dist"), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
manifest.host_permissions = ["http://localhost/*", `${new URL(PAGE).origin}/*`];
writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest));
const profile = mkdtempSync(join(tmpdir(), "pos-profile-"));
const requests = [];
const ctx = await chromium.launchPersistentContext(profile, { headless: true, channel: "chromium", viewport: { width: 1200, height: 900 }, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] });
ctx.on("request", (r) => requests.push(r.url()));
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
const id = sw.url().split("/")[2];

let failed = null;
try {
  // 1. A real page, and a paragraph selected on it.
  const site = await ctx.newPage();
  await site.goto(PAGE, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await site.waitForTimeout(2500);
  const selected = await site.evaluate(() => {
    const p = [...document.querySelectorAll("p, h2, h3")].find((x) => (x.textContent ?? "").trim().length > 60 && x.getBoundingClientRect().height > 0);
    if (!p) return "";
    const range = document.createRange();
    range.selectNodeContents(p);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    return String(getSelection()).trim();
  });
  assert.ok(selected.length > 20, "a paragraph is selected");
  note("page open, text selected", { url: site.url(), title: await site.title(), selection: `${selected.slice(0, 80)}… (${selected.length} chars)` });

  // 2. The panel: connect and sign in (dev identity).
  const panel = await ctx.newPage();
  await panel.setViewportSize({ width: 420, height: 900 });
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await panel.locator("input").first().fill(`localhost:${PORT}`);
  await panel.getByRole("button", { name: "Connect" }).click();
  await panel.getByLabel("Message").waitFor({ timeout: 60_000 });
  note("panel connected and signed in", { session: "bearer, in chrome.storage.local (trusted contexts only)" });
  // What Ada has told PersonalOS about her product (as she would in chat): what research compares against.
  const sessionToken = (await panel.evaluate(() => chrome.storage.local.get("personalos:token")))["personalos:token"];
  await fetch(`${ORIGIN}/api/mutation/memory:add`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${sessionToken}` }, body: JSON.stringify({ args: { kind: "project", subject: "feltkit", content: "FeltKit is my product: a TypeScript framework for building internal tools and agent-ready applications on an embedded database, with auth, background jobs and integrations." } }) });
  await panel.screenshot({ path: join(out, "1-panel.png") });

  // 3. Summon PersonalOS with this page.
  await panel.getByRole("button", { name: "Summon PersonalOS" }).click();
  const form = panel.getByTestId("summon");
  await form.waitFor();
  const include = form.getByText(/Include the text you selected \(/);
  await include.waitFor({ timeout: 20_000 });
  note("summon form", { reads: await form.innerText().then((t) => t.split("\n").slice(0, 3).join(" | ")) });
  const instruction = "Research this company and tell me whether it could be a customer for FeltKit.";
  await form.getByLabel("What should PersonalOS do?").fill(instruction);
  await panel.screenshot({ path: join(out, "2-summon-form.png") });
  await form.getByRole("button", { name: "Send" }).click();
  const status = panel.getByTestId("summon-status");
  await status.waitFor({ timeout: 30_000 });
  const accepted = await status.innerText();
  note("receipt", { shown: accepted.replace(/\s+/g, " ").slice(0, 300) });
  await panel.screenshot({ path: join(out, "3-receipt.png") });

  // 4. The person leaves: the page is closed. The server dies mid-work and comes back.
  await site.close();
  note("originating page closed");
  const token = (await panel.evaluate(() => chrome.storage.local.get("personalos:token")))["personalos:token"];
  const api = async (name, args) => (await (await fetch(`${ORIGIN}/api/query/${name}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ args }) })).json()).value;
  const invocationId = (await api("invocationstate:list", { limit: 1 }))[0].invocationId;
  await until(async () => (await api("invocationstate:get", { invocationId }))?.invocation.state === "processing", "processing to start", 60_000);
  await killServer("SIGKILL");
  const down = Date.now();
  await startServer();
  note("server killed (SIGKILL) during processing and restarted", { downMs: Date.now() - down });

  // 5. The outcome reaches the panel (live, after reconnecting); the conversation has the result.
  const final = await until(async () => { const s = await status.getAttribute("data-state"); return ["completed", "failed", "needs_approval"].includes(s) ? s : null; }, "the outcome in the panel", 240_000);
  const shown = await status.innerText();
  note("outcome in the panel", { state: final, shown: shown.replace(/\s+/g, " ").slice(0, 400) });
  await panel.screenshot({ path: join(out, "4-outcome.png") });
  await status.getByRole("button", { name: "Open conversation" }).click();
  const bubbles = panel.locator(".msg .bubble");
  await until(async () => (await bubbles.count()) >= 3, "the conversation to show");
  const conversation = await bubbles.allInnerTexts();
  note("conversation", { messages: conversation.map((m) => m.replace(/\s+/g, " ").slice(0, 160)) });
  await panel.screenshot({ path: join(out, "5-conversation.png"), fullPage: true });

  // 6. The way back: the page reopens.
  await panel.getByRole("button", { name: "Back to the page" }).click().catch(async () => {
    // The status sits above the app; after opening the conversation it is still there.
    await panel.getByTestId("summon-status").getByRole("button", { name: "Back to the page" }).click();
  });
  const reopened = await until(async () => ctx.pages().find((p) => p.url().startsWith(new URL(PAGE).origin)), "the page to reopen", 30_000);
  note("back to the page", { reopened: reopened.url() });

  // 7. The durable record, read with the same session.
  const { invocation: inv } = await api("invocationstate:get", { invocationId });
  const research = inv.work?.researchRunId ? await api("research:get", { runId: inv.work.researchRunId }) : null;
  evidence.invocation = {
    who: inv.owner, where: inv.surface, shared: inv.context.map((c) => ({ kind: c.kind, url: c.url, title: c.title, chars: c.text?.length })), asked: inv.instruction,
    interpreted: inv.interpretation, authority: inv.authority, work: inv.work, returnTo: { kind: inv.returnTo, url: inv.returnUrl }, state: inv.state, updates: inv.updates.map((u) => `${u.state}: ${u.text.slice(0, 300)}`),
    research: research && { status: research.run.status, plan: research.run.plan, pages: research.sources.filter((s) => s.kind === "page").map((s) => [s.url, s.status]), results: research.prospects.map((p) => ({ company: p.company, fit: p.assessment.fit, confidence: p.assessment.confidence, basis: p.assessment.basis, quotes: p.facts.filter((f) => f.kind === "quote" || f.kind === "shared").map((f) => `${f.kind}: ${f.text.slice(0, 160)}`) })), ruledOut: (research.run.candidates ?? []).filter((c) => c.state === "rejected").map((c) => [c.name, c.verdict]) },
  };
  assert.deepEqual([inv.owner, inv.surface.adapter, inv.returnUrl, inv.authority.delegationId], ["ada", "browser", PAGE, "browser-summon"]);
  assert.ok(inv.context.some((c) => c.kind === "selection" && c.text === selected.slice(0, 20000)), "the selection, as selected");
  note("durable record", { state: inv.state, authority: `${inv.authority.capability} ${inv.authority.outcome} (delegation ${inv.authority.delegationId}, decision ${inv.authority.decisionId})` });

  // 8. Summon again from the page: the same conversation continues.
  await panel.bringToFront();
  await panel.getByRole("button", { name: "Close" }).click().catch(() => {});
  await panel.getByRole("button", { name: "Summon PersonalOS" }).click();
  const again = panel.getByTestId("summon");
  await again.getByText(/Continue the conversation from your last summon on this page/).waitFor({ timeout: 20_000 });
  await again.getByLabel("What should PersonalOS do?").fill("Remember this");
  await again.getByRole("button", { name: "Send" }).click();
  await panel.getByTestId("summon-status").waitFor();
  const second = await until(async () => { const rows = await api("invocationstate:list", { limit: 2 }); return rows.length === 2 && rows[0].state === "completed" ? rows : null; }, "the second summon to finish", 60_000);
  assert.equal(second[0].conversationId, second[1].conversationId, "one conversation");
  note("second summon continued the conversation", { conversationId: second[0].conversationId, message: second[0].message.slice(0, 160) });

  // 9. Nothing private where it shouldn't be.
  const logs = serverOut.join("");
  const fragment = selected.slice(0, 40);
  assert.ok(!logs.includes(fragment), "the selection is not in the server's output");
  assert.ok(!logs.includes(token), "the session is not in the server's output");
  assert.ok(!requests.some((u) => u.includes(encodeURIComponent(fragment).slice(0, 30)) || u.includes(token)), "neither the selection nor the session is in any request URL");
  note("privacy", { serverLogBytes: logs.length, requestsChecked: requests.length });
} catch (error) {
  failed = error;
  evidence.error = String(error?.stack ?? error);
  console.error(error);
  for (const p of ctx.pages()) await p.screenshot({ path: join(out, `error-${ctx.pages().indexOf(p)}.png`) }).catch(() => {});
} finally {
  await ctx.close().catch(() => {});
  await killServer("SIGTERM").catch(() => {});
  await ab.close();
  const text = JSON.stringify(evidence, null, 2);
  if (process.env.AI_GATEWAY_API_KEY && text.includes(process.env.AI_GATEWAY_API_KEY)) throw new Error("refusing to write evidence containing a key");
  writeFileSync(join(out, "browser-summon.json"), text);
  log("wrote", join(out, "browser-summon.json"));
  process.exitCode = failed ? 1 : 0;
}
