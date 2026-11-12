/**
 * What PersonalOS Anywhere needs around it in tests:
 *
 * - a real Resolver (@appport/resolver, the published server, in a child process with its own state),
 *   initialised with an admin key, and a least-privilege key for PersonalOS (read, write on
 *   ref://identity/personalos/* only), exported as RESOLVER_URL / RESOLVER_API_KEY;
 * - an authority speaking AuthBoundry's check contract (POST /_authboundry/authorize/check) from a
 *   policy table the test controls. The real AuthBoundry server is exercised by the end-to-end
 *   acceptance (e2e/anywhere/); its server is not on npm under a usable license, so CI uses this.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResolverClient } from "@appport/resolver-client";

/** The package's own bin (`resolver`): its exports name only the library entry. */
const CLI = join(process.cwd(), "node_modules", "@appport", "resolver", "dist", "cli.js");

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address() as net.AddressInfo; s.close(() => resolve(port)); });
  });
}

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`resolver ${args[0]} failed: ${out}`))));
  });
}

export interface TestResolver { url: string; admin: ResolverClient; adminKey: string; close(): Promise<void> }

/** A real Resolver server for this test file. */
export async function startResolver(): Promise<TestResolver> {
  const dir = mkdtempSync(join(tmpdir(), "pos-resolver-"));
  const init = await run(["init", "--dir", dir, "--tenant", "personalos"]);
  const adminKey = init.split(/\s+/).find((w) => w.startsWith("app_live_"));
  if (!adminKey) throw new Error(`resolver init printed no key: ${init}`);
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [CLI, "serve", "--dir", dir, "--port", String(port), "--host", "127.0.0.1"], { stdio: ["ignore", "pipe", "pipe"] });
  const url = `http://127.0.0.1:${port}`;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("resolver did not start")), 15000);
    const ready = (d: Buffer) => { if (String(d).includes("listening")) { clearTimeout(timer); resolve(); } };
    child.stdout!.on("data", ready);
    child.stderr!.on("data", ready);
    child.on("exit", (code) => reject(new Error(`resolver exited ${code}`)));
  });
  const admin = await ResolverClient.connect({ url, apiKey: adminKey, live: false, maxStaleSeconds: 0 });
  // PersonalOS's own key: identity references only.
  const key = await admin.createKey("personalos");
  await admin.grant(key.principal, ["read", "write"], "ref://identity/personalos/*");
  process.env.RESOLVER_URL = url;
  process.env.RESOLVER_API_KEY = key.secret;
  return {
    url, admin, adminKey,
    close: async () => { admin.close(); child.kill(); await new Promise((r) => child.once("exit", r)); },
  };
}

export interface TestAuthority {
  /** principal → capabilities it holds. A principal not in the table is unknown (404, as AuthBoundry answers). */
  policy: Map<string, Set<string>>;
  decisions: Array<{ principal: string; capability: string; decision: string; decisionId: string; context: unknown }>;
  /** "down": refuse connections' answers with 503; "malformed": an allow for a different capability. */
  mode: "up" | "down" | "malformed";
  grant(owner: string, ...capabilities: string[]): void;
  revoke(owner: string): void;
  close(): Promise<void>;
}

const ALL = ["personalos.assistant.converse", "personalos.conversation.read", "personalos.tasks.read", "personalos.tasks.create", "personalos.tasks.update", "personalos.tasks.delete", "personalos.reminders.create", "personalos.memory.read", "personalos.memory.write", "personalos.memory.delete", "personalos.projects.create"];

/** An authority speaking AuthBoundry's enforcement check contract, from a policy table. */
export async function startAuthority(): Promise<TestAuthority> {
  const credential = "abc_test.check-credential";
  const state: TestAuthority = {
    policy: new Map(), decisions: [], mode: "up",
    grant: (owner, ...caps) => state.policy.set(`user:${owner}`, new Set(caps.length ? caps : ALL)),
    revoke: (owner) => { state.policy.delete(`user:${owner}`); },
    close: async () => undefined,
  };
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const send = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
      if (state.mode === "down") return send(503, { error: "unavailable" });
      if (req.headers["x-authboundry-check-credential"] !== credential) return send(401, { error: "unauthenticated", reason: "invalid_check_credential" });
      const b = JSON.parse(body);
      const caps = state.policy.get(b.principal_id);
      if (!caps) return send(404, { error: "denied", reason: "unknown_principal" });
      const decisionId = `test-decision-${++n}`;
      const decision = caps.has(b.capability) ? "allow" : "deny";
      state.decisions.push({ principal: b.principal_id, capability: b.capability, decision, decisionId, context: b.context });
      const capability = state.mode === "malformed" ? "personalos.everything" : b.capability;
      send(200, { decision, decision_id: decisionId, application_id: b.application_id, principal_id: b.principal_id, capability, mode: b.mode, decision_source: "test_policy_table", ...(decision === "deny" ? { reason: "capability_not_granted" } : {}) });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  process.env.FELTKIT_AUTHBOUNDRY_URL = `http://127.0.0.1:${port}`;
  process.env.FELTKIT_AUTHBOUNDRY_APPLICATION = "personalos";
  process.env.FELTKIT_AUTHBOUNDRY_CHECK_CREDENTIAL = credential;
  state.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  return state;
}
