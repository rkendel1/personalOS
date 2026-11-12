/**
 * What PersonalOS Anywhere needs around it in tests:
 *
 * - a real Resolver (@appport/resolver, the published server, in a child process with its own state),
 *   initialised with an admin key, and PersonalOS's two least-privilege keys on
 *   ref://identity/personalos/*: `read` only (credential resolver-resolve) and `write` only
 *   (credential resolver-link), given to FeltKit as FELTKIT_CREDENTIAL_RESOLVER_RESOLVE / _LINK;
 * - an authority speaking AuthBoundry's check contract (POST /_authboundry/authorize/check, with
 *   on_behalf_of) from a delegation table the test controls. It establishes PersonalOS's behavior
 *   *given* a decision, nothing about AuthBoundry: the real AuthBoundry's delegation decisions are
 *   tested against the real server in tests/authboundry-real.test.ts (built from source in CI).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
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

export interface TestResolver {
  url: string; admin: ResolverClient; adminKey: string;
  /** PersonalOS's keys (the tests use them directly to show what Resolver itself refuses). */
  keys: { read: { secret: string; id: string }; write: { secret: string; id: string } };
  /** Issue a new key for a credential and make it the one FeltKit uses (rotation); returns the old one. */
  rotate(which: "read" | "write"): Promise<{ secret: string; id: string }>;
  close(): Promise<void>;
}

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
  // PersonalOS's keys, identity references only: one that can only read, one that can only write.
  const issue = async (which: "read" | "write") => {
    const k = await admin.createKey(`personalos-${which === "read" ? "resolve" : "link"}`);
    await admin.grant(k.principal, [which], "ref://identity/personalos/*");
    process.env[which === "read" ? "FELTKIT_CREDENTIAL_RESOLVER_RESOLVE" : "FELTKIT_CREDENTIAL_RESOLVER_LINK"] = k.secret;
    return { secret: k.secret, id: k.id };
  };
  const keys = { read: await issue("read"), write: await issue("write") };
  process.env.RESOLVER_URL = url;
  delete process.env.RESOLVER_API_KEY;
  return {
    url, admin, adminKey, keys,
    rotate: async (which) => { const old = keys[which]; keys[which] = await issue(which); return old; },
    close: async () => { admin.close(); child.kill(); await new Promise((r) => child.once("exit", r)); },
  };
}

export interface TestAuthority {
  /** principal → capabilities it holds. A principal not in the table is unknown (404, as AuthBoundry answers). */
  /** requester (user:<owner>) → capabilities delegated to agent:personalos. */
  policy: Map<string, Set<string>>;
  /** Principals the authority knows (a requester without any delegation is still known). */
  known: Set<string>;
  decisions: Array<{ principal: string; onBehalfOf: string | null; capability: string; decision: string; decisionId: string; delegationId: string | null; context: unknown }>;
  /** "down": 503; "malformed": an allow for a different capability; "no-echo": an allow that does not name the requester and delegation. */
  mode: "up" | "down" | "malformed" | "no-echo";
  grant(owner: string, ...capabilities: string[]): void;
  revoke(owner: string): void;
  close(): Promise<void>;
}

const ALL = ["personalos.assistant.converse", "personalos.conversation.read", "personalos.tasks.read", "personalos.tasks.create", "personalos.tasks.update", "personalos.tasks.delete", "personalos.reminders.create", "personalos.memory.read", "personalos.memory.write", "personalos.memory.delete", "personalos.projects.create"];

/** An authority speaking AuthBoundry's enforcement check contract, from a policy table. */
export async function startAuthority(): Promise<TestAuthority> {
  const credential = "abc_test.check-credential";
  const state: TestAuthority = {
    policy: new Map(), known: new Set(), decisions: [], mode: "up",
    grant: (owner, ...caps) => { state.known.add(`user:${owner}`); state.policy.set(`user:${owner}`, new Set(caps.length ? caps : ALL)); },
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
      // The executor asks on behalf of a requester; the table holds each requester's delegation to it.
      if (b.principal_id !== "agent:personalos") return send(404, { error: "denied", reason: "unknown_principal" });
      const requester = b.on_behalf_of;
      const caps = requester ? state.policy.get(requester) : undefined;
      if (requester && !state.known.has(requester)) return send(404, { error: "denied", reason: "unknown_principal" });
      const decisionId = `test-decision-${++n}`;
      const decision = caps?.has(b.capability) ? "allow" : "deny";
      const delegationId = decision === "allow" ? `delegation-${requester}` : null;
      state.decisions.push({ principal: b.principal_id, onBehalfOf: requester ?? null, capability: b.capability, decision, decisionId, delegationId, context: b.context });
      const capability = state.mode === "malformed" ? "personalos.everything" : b.capability;
      const echo = state.mode === "no-echo" ? {} : { on_behalf_of: requester ?? null, delegation_id: delegationId };
      send(200, { decision, decision_id: decisionId, application_id: b.application_id, principal_id: b.principal_id, capability, mode: b.mode, decision_source: "test_policy_table", ...echo, ...(decision === "deny" ? { reason: requester ? "delegation_missing" : "capability_not_granted" } : {}) });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as net.AddressInfo;
  // feltkit({ authority }) in feltkit/app.ts: the URL from AUTHBOUNDRY_URL, the check credential from custody.
  process.env.AUTHBOUNDRY_URL = `http://127.0.0.1:${port}`;
  process.env.FELTKIT_CREDENTIAL_AUTHBOUNDRY_CHECK = credential;
  state.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  return state;
}

// ── The real AuthBoundry ──────────────────────────────────────────────────────

export interface RealAuthority {
  url: string;
  checkCredential: string;
  /** Owner-session control API (administration, as an operator would). */
  control(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: any }>;
  delegate(id: string, owner: string, capabilities: string[], expiresAt?: number): Promise<void>;
  revokeDelegation(id: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Where the real server is: the published `@authboundry/core` installed apart from the app in
 * tests/authboundry (exact version, its own lockfile: `npm ci --prefix tests/authboundry`). Its
 * `authboundry` command runs the native server for this platform. AUTHBOUNDRY_CLI_PATH, the
 * package's own override, points it at another build for local development only.
 */
const AUTHBOUNDRY_HOME = join(process.cwd(), "tests", "authboundry");
const AUTHBOUNDRY_PACKAGE = join(AUTHBOUNDRY_HOME, "node_modules", "@authboundry", "core");
export function authboundryInstalled(): string | null {
  return existsSync(join(AUTHBOUNDRY_PACKAGE, "bin", "authboundry.js")) ? AUTHBOUNDRY_PACKAGE : null;
}
/**
 * The package's native server, resolved as its own `bin/authboundry.js` does (AUTHBOUNDRY_CLI_PATH,
 * then `@authboundry/core-<platform>`, then the bundled copy). Run directly, not through that wrapper:
 * the wrapper waits on a child it does not forward signals to, so stopping it would orphan the server.
 */
function authboundryExecutable(pkg: string): string {
  if (process.env.AUTHBOUNDRY_CLI_PATH) return process.env.AUTHBOUNDRY_CLI_PATH;
  const platform = `${process.platform}-${process.arch}`;
  const optional = join(AUTHBOUNDRY_HOME, "node_modules", "@authboundry", `core-${platform}`, "bin", "authboundry");
  return existsSync(optional) ? optional : join(pkg, "native", platform, "authboundry");
}
/** The installed server's version (what the tests ran against). */
export function authboundryVersion(): string | null {
  const pkg = authboundryInstalled();
  return pkg ? (JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version as string) : null;
}

/**
 * The real AuthBoundry server, fresh, bootstrapped through its own control API: the PersonalOS
 * application and capability contract, people as principals with their own policies, PersonalOS's
 * executor as an agent principal, and an application check credential. Delegations are created by
 * the test as each case needs them.
 */
export async function startRealAuthority(people: Record<string, string[]>, capabilities: readonly string[]): Promise<RealAuthority> {
  const pkg = authboundryInstalled();
  if (!pkg) throw new Error("AuthBoundry is not installed: npm ci --prefix tests/authboundry");
  const data = mkdtempSync(join(tmpdir(), "pos-authboundry-"));
  const port = await freePort();
  const grants = ["identity.read", "identity.write", "principal.read", "principal.write", "policy.read", "policy.write", "agent.read", "agent.write", "delegation.read", "delegation.create", "delegation.revoke", "audit.read", "evidence.read", "authorization.read", "session.admin"].flatMap((g) => ["--grant", `authority.${g}=role:owner`]);
  const child = spawn(authboundryExecutable(pkg), ["serve", join(AUTHBOUNDRY_HOME, "authboundry.flow"), "--addr", `127.0.0.1:${port}`, "--tenant", "reference", "--account", "owner:local-password:role=owner@reference", ...grants], {
    cwd: data, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, FELTDB_URL: "", FELTDB_ENDPOINT: "", AUTHBOUNDRY_PORTAL_ORIGIN: "http://localhost:3001", AUTHBOUNDRY_FELTDB_PATH: data, AUTHBOUNDRY_FELTDB_BRIDGE: join(pkg, "bridge", "feltdb-store.cjs"), AUTHBOUNDRY_APPPORT_SERVICES_BRIDGE: join(pkg, "bridge", "appport-services.cjs"), AUTHBOUNDRY_NODE: process.execPath },
  });
  let log = "";
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${url}/health`)).ok) break; } catch { /* not yet */ }
    if (i > 150) throw new Error(`AuthBoundry did not start: ${log.slice(-600)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  const raw = async (path: string, init: { method?: string; body?: unknown; session?: string } = {}) => {
    const u = new URL(path, url);
    if (!u.searchParams.has("tenant")) u.searchParams.set("tenant", "reference");
    const r = await fetch(u, { method: init.method ?? "GET", headers: { accept: "application/json", ...(init.body !== undefined ? { "content-type": "application/json" } : {}), ...(init.session ? { "x-authboundry-session": init.session } : {}) }, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  const signIn = await raw("/_authboundry/browser/credentials", { method: "POST", body: { application: "portal", connector: "local", tenant: "reference", return_to: "/", username: "owner", password: "local-password" } });
  const session = signIn.body.credential as string;
  const control = async (path: string, init: { method?: string; body?: unknown } = {}) => {
    const r = await raw(path, { ...init, session });
    if (r.status >= 400) throw new Error(`${init.method ?? "GET"} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r;
  };
  await control("/_authboundry/control-plane/organizations", { method: "POST", body: { id: "personalos", name: "PersonalOS", authority_tenant_id: "reference" } });
  await control("/_authboundry/control-plane/applications", { method: "POST", body: { id: "personalos", project_id: "personalos", name: "PersonalOS", production_url: "http://localhost", environment: "production" } });
  await control("/_authboundry/control-plane/applications/personalos/contracts", { method: "POST", body: { authority_source: "external", version: "1.0.0", capabilities } });
  for (const [owner, caps] of Object.entries(people)) {
    await control("/_authboundry/control-plane/applications/personalos/principals", { method: "POST", body: { id: `user:${owner}`, kind: "human", claims: { role: "member" } } });
    await control("/_authboundry/policies", { method: "POST", body: { application: "personalos", principal_id: `user:${owner}`, capabilities: caps } });
  }
  await control("/_authboundry/agents", { method: "POST", body: { id: "agent:personalos", name: "PersonalOS", application: "personalos" } });
  const issued = await control("/_authboundry/control-plane/applications/personalos/check-credentials", { method: "POST", body: { label: "personalos tests" } });
  const checkCredential = issued.body.secret as string;
  process.env.AUTHBOUNDRY_URL = url;
  process.env.FELTKIT_CREDENTIAL_AUTHBOUNDRY_CHECK = checkCredential;
  return {
    url, checkCredential,
    control: (path, init) => control(path, init),
    delegate: async (id, owner, caps, expiresAt) => {
      await control("/_authboundry/delegations", { method: "POST", body: { id, delegator: `user:${owner}`, delegate: "agent:personalos", capabilities: caps.join(","), application: "personalos", ...(expiresAt ? { expires_at: expiresAt } : {}) } });
    },
    revokeDelegation: async (id) => { await control(`/_authboundry/delegations/${id}/revoke`, { method: "POST", body: {} }); },
    close: async () => { child.kill(); await new Promise((r) => child.once("exit", r)); },
  };
}
