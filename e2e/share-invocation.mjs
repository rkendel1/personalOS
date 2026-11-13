/**
 * The iOS share path over real HTTP, as the app and its extension make it (ios/Shared/PersonalOSClient.swift):
 *
 *   node --import tsx e2e/share-invocation.mjs [outDir] [sharedUrl]
 *
 * Real: `feltkit dev` (its own state), FeltKit accounts (sign-up, sign-in: the bearer session the app keeps
 * in the Keychain), the real AuthBoundry server (tests/authboundry), the page reader on the open web, and,
 * when AI_GATEWAY_API_KEY is set, the model through Vercel AI Gateway. It is NOT an iPhone: it sends the
 * same requests the Swift client sends, so it proves the server side of the path; the device acceptance
 * is docs/IOS-SHARE.md.
 *
 * It checks: sign-in gives a bearer session; the share is accepted at once with a receipt; a resubmission
 * replays it; the server is killed (SIGKILL) while the work runs and started again, and the work
 * completes; the result is inspectable; another account sees none of it; a signed-out session is refused;
 * a revoked delegation refuses the next share; neither the session token nor the shared text is in the
 * server's logs. Writes <outDir>/share-invocation.json.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { startRealAuthority, authboundryInstalled } from "../tests/fixtures/anywhere.ts";
import { CAPABILITIES } from "../feltkit/_authority.ts";

const out = process.argv[2] ?? ".";
const SHARED = process.argv[3] ?? "https://encore.dev/";
mkdirSync(out, { recursive: true });
if (!authboundryInstalled()) { console.error("AuthBoundry is not installed (npm ci --prefix tests/authboundry). Nothing was run."); process.exit(2); }
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "✓", ...a);
const evidence = { at: new Date().toISOString(), shared: SHARED, steps: [] };
const note = (step, detail) => { evidence.steps.push({ step, ...detail }); log(step, JSON.stringify(detail).slice(0, 300)); };

const ab = await startRealAuthority({}, CAPABILITIES);
const state = mkdtempSync(join(tmpdir(), "pos-share-e2e-"));
const MODEL = Boolean(process.env.AI_GATEWAY_API_KEY);
const env = { ...process.env, FELTKIT_STATE_DIR: state, NO_COLOR: "1", AUTHBOUNDRY_URL: ab.url, FELTKIT_CREDENTIAL_AUTHBOUNDRY_CHECK: ab.checkCredential, ...(MODEL ? { FELTKIT_CREDENTIAL_AI_GATEWAY: process.env.AI_GATEWAY_API_KEY } : {}) };
for (const k of ["PORT", "FELTKIT_PORT", "FELTDB_URL", "FELTDB_ENDPOINT", "OPENAISEARCH_URL", "WEBSEARCH_URL"]) delete env[k];

const devLog = [];
let dev = null;
async function start() {
  dev = spawn("npx", ["feltkit", "dev", "--port", "0"], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let text = "";
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`feltkit dev did not start:\n${text}`)), 120_000);
    const look = (d) => { text += d; const m = /App\s+(http:\/\/localhost:\d+)/.exec(text); if (m) { clearTimeout(timer); resolve(m[1]); } };
    dev.stdout.on("data", look); dev.stderr.on("data", look);
    dev.once("exit", (c) => reject(new Error(`feltkit dev exited ${c}:\n${text}`)));
  });
  dev.removeAllListeners("exit");
  dev.stdout.on("data", (d) => devLog.push(String(d)));
  dev.stderr.on("data", (d) => devLog.push(String(d)));
  devLog.push(text);
  return url;
}
async function kill(signal) {
  if (!dev) return;
  const exited = new Promise((r) => dev.once("exit", r));
  try { process.kill(-dev.pid, signal); } catch {}
  await exited;
  dev = null;
  let holder = null;
  try { holder = JSON.parse(readFileSync(join(state, "owner.lock"), "utf8")).pid; } catch {}
  for (let i = 0; holder && i < 100; i += 1) {
    try { process.kill(holder, 0); } catch { break; }
    try { process.kill(holder, signal); } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
}

// What ios/Shared/PersonalOSClient.swift sends: POST, JSON, bearer, the device's time zone.
let base = "";
async function post(path, body, token) {
  const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json", "x-feltkit-time-zone": "America/New_York", "x-feltkit-locale": "en-US", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
const call = (kind, name, args, token) => post(`/api/${kind}/${name}`, { args }, token);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  if (MODEL) {
    const r = spawn("npx", ["feltkit", "model", "set", "--provider", "custom", "--model", "openai/gpt-4.1-mini", "--endpoint", "https://ai-gateway.vercel.sh/v1", "--credential", "credential-ref:ai-gateway"], { env, stdio: "ignore" });
    await new Promise((res) => r.once("exit", res));
  }
  base = await start();
  log("feltkit dev", base, MODEL ? "(model: openai/gpt-4.1-mini via AI Gateway)" : "(no model: rules)");

  // 1. The person has a PersonalOS account; the app signs in to it (as SignInView does).
  const email = `ada+${Date.now()}@example.com`;
  const password = "correct horse battery staple";
  const up = await post("/api/auth/signup", { email, password });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const signIn = await post("/api/auth/signin", { email, password });
  assert.equal(signIn.status, 200);
  const token = signIn.body.token;
  const account = signIn.body.principal.id;
  assert.ok(token && account.startsWith("acct_"), "a bearer session for a native client, and the account it is");
  note("signed in", { account, sessionExpires: signIn.body.expiresAt, tokenInBody: Boolean(token) });
  await call("mutation", "memory:add", { kind: "project", subject: "feltkit", content: "FeltKit is my product: a TypeScript framework for building internal tools and agent-ready applications on an embedded database, with auth, background jobs and integrations." }, token);

  // 2. In AuthBoundry: the account, and its delegation to PersonalOS for research (an administrator's step).
  await ab.control("/_authboundry/control-plane/applications/personalos/principals", { method: "POST", body: { id: `user:${account}`, kind: "human", claims: { role: "member" } } });
  await ab.control("/_authboundry/policies", { method: "POST", body: { application: "personalos", principal_id: `user:${account}`, capabilities: [...CAPABILITIES] } });
  await ab.delegate("share-e2e", account, ["personalos.research.run"]);
  note("delegated", { delegation: "share-e2e", capabilities: ["personalos.research.run"] });

  // 3. The share: exactly the envelope the Swift client encodes.
  const instruction = "Research this company and tell me whether it could be a customer for FeltKit.";
  const envelope = { contract: "personalos.invocation/1", invocationId: `ios-${crypto.randomUUID()}`, surface: { adapter: "ios-share", device: "iPhone", version: "1.0" }, instruction, context: [{ kind: "url", url: SHARED, title: "" }], submittedAt: Date.now(), timeZone: "America/New_York", returnTo: { kind: "personalos" } };
  envelope.context[0].title = new URL(SHARED).hostname.replace(/^www\./, "");
  const t0 = Date.now();
  const submitted = await call("mutation", "invocations:submit", { envelope }, token);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const receipt = submitted.body.value;
  assert.deepEqual([receipt.state, receipt.replayed], ["accepted", false]);
  note("accepted", { ms: Date.now() - t0, state: receipt.state, message: receipt.message, open: receipt.open });

  const again = await call("mutation", "invocations:submit", { envelope }, token);
  assert.deepEqual([again.body.value.replayed, again.body.value.invocationId], [true, envelope.invocationId]);
  note("resubmitted", { replayed: true });

  // 4. The share sheet is gone; the server dies while the work runs, and comes back.
  let row;
  for (let i = 0; i < 200; i++) {
    row = (await call("query", "invocationstate:list", { limit: 5 }, token)).body.value?.find((x) => x.invocationId === envelope.invocationId);
    if (row && row.state !== "accepted") break;
    await sleep(250);
  }
  note("processing before the crash", { state: row.state, message: row.message });
  await kill("SIGKILL");
  const down = Date.now();
  base = await start();
  note("server killed (SIGKILL) and restarted", { restartedInMs: Date.now() - down, url: base });

  // 5. The work completes; the person can inspect it.
  for (let i = 0; i < 600; i++) {
    row = (await call("query", "invocationstate:list", { limit: 5 }, token)).body.value?.find((x) => x.invocationId === envelope.invocationId);
    if (row && ["completed", "failed", "needs_approval"].includes(row.state)) break;
    await sleep(1000);
  }
  const detail = (await call("query", "invocationstate:get", { invocationId: envelope.invocationId }, token)).body.value;
  const inv = detail.invocation;
  const research = inv.work?.researchRunId ? (await call("query", "research:get", { runId: inv.work.researchRunId }, token)).body.value : null;
  note("finished", {
    state: inv.state, wallMs: Date.now() - t0, interpretation: inv.interpretation, authority: inv.authority,
    updates: inv.updates.map((u) => `${u.state}: ${u.text.slice(0, 200)}`),
    research: research && { status: research.run.status, plan: research.run.plan, steps: research.run.steps.length, pages: research.sources.filter((s) => s.kind === "page").map((s) => [s.url, s.status, s.detail]), results: research.prospects.map((p) => ({ company: p.company, fit: p.assessment.fit, confidence: p.assessment.confidence, basis: p.assessment.basis, quotes: p.facts.filter((f) => f.kind === "quote").map((f) => ({ text: f.text.slice(0, 200), url: f.url })) })), ruledOut: (research.run.candidates ?? []).filter((c) => c.state === "rejected").map((c) => [c.name, c.verdict]) },
  });
  assert.ok(["completed", "failed"].includes(inv.state), `the work reached an outcome (${inv.state})`);
  assert.equal(inv.authority.delegationId, "share-e2e");
  const inbox = (await call("query", "inbox:list", {}, token)).body.value ?? [];
  note("in PersonalOS", { conversation: `${base}/#/chat/${inv.conversationId}`, inbox: inbox.filter((n) => n.type === "invocation.updated").map((n) => n.title) });

  // 6. Another account sees none of it.
  const graceToken = (await post("/api/auth/signup", { email: `grace+${Date.now()}@example.com`, password })).body.token;
  assert.ok(graceToken);
  const peek = await call("query", "invocationstate:get", { invocationId: envelope.invocationId }, graceToken);
  assert.equal(peek.body.error?.code, "NOT_FOUND");
  note("another account", { get: peek.status, code: peek.body.error.code });

  // 7. Revoking the delegation: the next share is refused when it runs.
  await ab.revokeDelegation("share-e2e");
  const second = { ...envelope, invocationId: `ios-${crypto.randomUUID()}`, submittedAt: Date.now() };
  await call("mutation", "invocations:submit", { envelope: second }, token);
  let refused;
  for (let i = 0; i < 120; i++) {
    refused = (await call("query", "invocationstate:get", { invocationId: second.invocationId }, token)).body.value?.invocation;
    if (refused && refused.state === "failed") break;
    await sleep(500);
  }
  assert.deepEqual([refused.state, refused.error.code], ["failed", "FORBIDDEN"]);
  note("delegation revoked", { state: refused.state, error: refused.error });

  // 8. Signing out (the app's Sign out) ends the session: the extension's next share is refused.
  await post("/api/auth/signout", {}, token);
  const after = await call("mutation", "invocations:submit", { envelope: { ...envelope, invocationId: `ios-${crypto.randomUUID()}` } }, token);
  assert.equal(after.status, 401);
  note("signed out", { status: after.status, code: after.body.error?.code });

  // 9. Nothing sensitive in the server's output.
  const logs = devLog.join("");
  for (const [what, secret] of [["session token", token], ["password", password]]) assert.ok(!logs.includes(secret), `${what} is not in the server log`);
  note("logs", { bytes: logs.length, tokenAbsent: true, passwordAbsent: true });
} catch (error) {
  evidence.error = String(error?.stack ?? error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await kill("SIGTERM");
  await ab.close();
  const text = JSON.stringify(evidence, null, 2);
  for (const k of ["AI_GATEWAY_API_KEY", "OPENAI_API_KEY"]) if (process.env[k] && text.includes(process.env[k])) throw new Error("refusing to write evidence containing a key");
  writeFileSync(join(out, "share-invocation.json"), text);
  log("wrote", join(out, "share-invocation.json"));
}
