/**
 * The iPhone acceptance, server side (docs/IOS-SHARE.md): run this on the Mac, then share from the iPhone.
 *
 *   node --import tsx scripts/share-acceptance.mjs [--port 3000] [--email you@example.com] [--out dir]
 *
 * It starts the real AuthBoundry (tests/authboundry) and `feltkit dev` on your local network
 * (--host 0.0.0.0: reachable from your phone on the same Wi-Fi, not from the internet), creates the
 * PersonalOS account you sign in to on the phone, gives that account a delegation to PersonalOS for
 * research and notes, and then watches: every share that arrives from the phone is printed as it moves
 * (accepted → processing → completed / needs approval / failed), with the research's evidence. With
 * AI_GATEWAY_API_KEY set, the model is gpt-4.1-mini through Vercel AI Gateway; without it, rules.
 *
 * Nothing here pretends to be the phone: it only reports what the phone's shares did. Ctrl-C stops it
 * and writes <out>/share-acceptance.json.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startRealAuthority, authboundryInstalled } from "../tests/fixtures/anywhere.ts";
import { CAPABILITIES } from "../feltkit/_authority.ts";

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const PORT = arg("port", "3000");
const EMAIL = arg("email", `me+${Date.now()}@personalos.local`);
const PASSWORD = arg("password", randomBytes(9).toString("base64url"));
const OUT = arg("out", ".");
mkdirSync(OUT, { recursive: true });
if (!authboundryInstalled()) { console.error("AuthBoundry is not installed: npm ci --prefix tests/authboundry"); process.exit(2); }

const ab = await startRealAuthority({}, CAPABILITIES);
const state = mkdtempSync(join(tmpdir(), "pos-share-acceptance-"));
const MODEL = Boolean(process.env.AI_GATEWAY_API_KEY);
const env = { ...process.env, FELTKIT_STATE_DIR: state, NO_COLOR: "1", AUTHBOUNDRY_URL: ab.url, FELTKIT_CREDENTIAL_AUTHBOUNDRY_CHECK: ab.checkCredential, ...(MODEL ? { FELTKIT_CREDENTIAL_AI_GATEWAY: process.env.AI_GATEWAY_API_KEY } : {}) };
for (const k of ["PORT", "FELTKIT_PORT", "FELTDB_URL", "FELTDB_ENDPOINT"]) delete env[k];
if (MODEL) await new Promise((r) => spawn("npx", ["feltkit", "model", "set", "--provider", "custom", "--model", "openai/gpt-4.1-mini", "--endpoint", "https://ai-gateway.vercel.sh/v1", "--credential", "credential-ref:ai-gateway"], { env, stdio: "ignore" }).once("exit", r));

const dev = spawn("npx", ["feltkit", "dev", "--host", "0.0.0.0", "--port", PORT], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
let text = "";
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`feltkit dev did not start:\n${text}`)), 120_000);
  const look = (d) => { text += d; if (/App\s+http/.test(text)) { clearTimeout(timer); resolve(); } };
  dev.stdout.on("data", look); dev.stderr.on("data", look);
  dev.once("exit", (c) => reject(new Error(`feltkit dev exited ${c}:\n${text}`)));
});
dev.stdout.resume(); dev.stderr.resume();
const local = `http://127.0.0.1:${PORT}`;
const lan = Object.values(networkInterfaces()).flat().filter((a) => a && a.family === "IPv4" && !a.internal).map((a) => `http://${a.address}:${PORT}`);

const post = async (path, body, token) => {
  const r = await fetch(local + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  return r.json().catch(() => ({}));
};
let signed = await post("/api/auth/signup", { email: EMAIL, password: PASSWORD });
if (!signed.token) signed = await post("/api/auth/signin", { email: EMAIL, password: PASSWORD });
if (!signed.token) throw new Error(`Could not create or sign in to ${EMAIL}: ${JSON.stringify(signed)}`);
const account = signed.principal.id;
const token = signed.token;
await ab.control("/_authboundry/control-plane/applications/personalos/principals", { method: "POST", body: { id: `user:${account}`, kind: "human", claims: { role: "member" } } });
await ab.control("/_authboundry/policies", { method: "POST", body: { application: "personalos", principal_id: `user:${account}`, capabilities: [...CAPABILITIES] } });
await ab.delegate("iphone-acceptance", account, ["personalos.research.run", "personalos.memory.write", "personalos.tasks.create", "personalos.reminders.create", "personalos.assistant.converse"]);
await post("/api/mutation/memory:add", { args: { kind: "project", subject: "feltkit", content: "FeltKit is my product: a TypeScript framework for building internal tools and agent-ready applications on an embedded database, with auth, background jobs and integrations." } }, token);

console.log(`
PersonalOS is running for the iPhone acceptance (${MODEL ? "model: gpt-4.1-mini via AI Gateway" : "no model: rules"}).

  On the iPhone (same Wi-Fi), open the PersonalOS app and sign in:
    address   ${lan[0] ?? `http://${hostname()}.local:${PORT}`}${lan.length > 1 ? `   (or ${lan.slice(1).join(", ")})` : ""}
    email     ${EMAIL}
    password  ${PASSWORD}

  Then: Safari → a company's site → Share → PersonalOS →
    "Research this company and tell me whether it could be a customer for FeltKit." → Send.
  Close Safari. Watch here; then open the PersonalOS app (or ${lan[0] ?? local}) to see the result.

  The account's delegation to PersonalOS (AuthBoundry: iphone-acceptance) allows research, notes,
  tasks and reminders. Ctrl-C stops everything and writes ${join(OUT, "share-acceptance.json")}.
`);

const seen = new Map();
const evidence = { at: new Date().toISOString(), account, server: lan[0] ?? local, model: MODEL ? "openai/gpt-4.1-mini via AI Gateway" : "rules", invocations: {} };
const stamp = () => new Date().toISOString().slice(11, 19);
const timer = setInterval(async () => {
  const list = (await post("/api/query/invocationstate:list", { args: { limit: 20 } }, token)).value ?? [];
  for (const row of list) {
    const key = `${row.state}:${row.updates.length}`;
    if (seen.get(row.invocationId) === key) continue;
    seen.set(row.invocationId, key);
    const last = row.updates.at(-1);
    console.log(`${stamp()}  [${row.adapter}] ${row.invocationId}  ${row.state}  "${row.instruction}"  ${row.shared.map((x) => x.url ?? x.title ?? x.kind).join(", ")}\n          ${last?.text.split("\n")[0]}`);
    const detail = (await post("/api/query/invocationstate:get", { args: { invocationId: row.invocationId } }, token)).value;
    const inv = detail?.invocation;
    const research = inv?.work?.researchRunId ? (await post("/api/query/research:get", { args: { runId: inv.work.researchRunId } }, token)).value : null;
    evidence.invocations[row.invocationId] = {
      surface: inv?.surface, submittedAt: inv?.submittedAt, receivedAt: inv?.receivedAt, instruction: inv?.instruction, context: inv?.context?.map((c) => ({ kind: c.kind, url: c.url, title: c.title, chars: c.text?.length })),
      state: inv?.state, interpretation: inv?.interpretation, authority: inv?.authority, updates: inv?.updates, error: inv?.error,
      research: research && { status: research.run.status, plan: research.run.plan, steps: research.run.steps, pages: research.sources.filter((s) => s.kind === "page").map((s) => ({ url: s.url, status: s.status, detail: s.detail })), results: research.prospects, ruledOut: (research.run.candidates ?? []).filter((c) => c.state === "rejected") },
    };
  }
}, 2000);

const stop = async () => {
  clearInterval(timer);
  writeFileSync(join(OUT, "share-acceptance.json"), JSON.stringify(evidence, null, 2));
  console.log(`\nwrote ${join(OUT, "share-acceptance.json")}`);
  try { process.kill(-dev.pid, "SIGTERM"); } catch {}
  await ab.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
