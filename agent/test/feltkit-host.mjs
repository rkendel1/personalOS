import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
};
const sdk = required("FELTKIT_SDK_DIR");
const projectDir = required("FELTKIT_PROJECT_DIR");
const credentialFile = required("APPPORT_AGENT_CREDENTIAL_FILE");
const AGENT = "appport-agent";
const load = (path) => import(pathToFileURL(join(sdk, path)).href);

export const NOTES_APP = `import { feltkit, s } from ${JSON.stringify(join(sdk, "src/index.ts"))};

export const app = feltkit({
  name: "eve-notes",
  roles: { member: ["notes.*"], bot: ["bot.idle"], operator: ["feltkit.authority.agents"] },
  dev: { users: ["alice", "bob", "carol"].map((id) => ({ id, name: id, roles: ["member"] })) },
  authority: {
    local: true,
    application: "eve-notes",
    checkCredential: "credential-ref:authboundry-check",
    executor: { principal: "agent:eve-notes" },
    capabilities: ["notes.list", "notes.add"],
  },
});

export const notes = app.collection("notes", { owner: s.string(), token: s.string(), addedBy: s.optional(s.string()) });
`;

export const NOTES_FUNCTIONS = `import { s } from ${JSON.stringify(join(sdk, "src/index.ts"))};
import { app, notes } from "./app.ts";

export const list = app.query({
  access: "notes.read",
  capability: { name: "notes.list", description: "The caller's notes." },
  returns: s.unknown(),
  handler: async (ctx) => {
    const owner = ctx.auth.requirePrincipal().id;
    return { owner, agent: ctx.auth.delegation?.agent ?? null, notes: (await ctx.db.find(notes, {})).filter((n) => n.owner === owner).map((n) => n.token) };
  },
});

export const add = app.mutation({
  access: "notes.write",
  capability: { name: "notes.add", description: "Add a note for the caller." },
  args: { token: s.string() },
  returns: s.unknown(),
  handler: async (ctx, { token }) => {
    const owner = ctx.auth.requirePrincipal().id;
    const id = await ctx.db.insert(notes, { owner, token, ...(ctx.auth.delegation ? { addedBy: ctx.auth.delegation.agent } : {}) });
    return { id, owner, token };
  },
});

export const grant = app.action({ access: "notes.read", args: { capabilities: s.array(s.string()), agent: s.string() }, handler: async (ctx, a) => ctx.authority.grants.grant(a) });
export const grants = app.action({ access: "notes.read", handler: async (ctx) => ctx.authority.grants.list() });
export const revoke = app.action({ access: "notes.read", args: { id: s.string() }, handler: async (ctx, { id }) => ctx.authority.grants.revoke(id) });
export const registerAgent = app.action({ access: "authenticated", args: { id: s.string() }, handler: async (ctx, a) => ctx.authority.agents.register(a) });
`;

if (process.argv[2] === "--write-project") {
  mkdirSync(join(projectDir, "feltkit"), { recursive: true });
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify({ name: "eve-notes", private: true, type: "module" }),
  );
  writeFileSync(join(projectDir, "feltkit/app.ts"), NOTES_APP);
  writeFileSync(join(projectDir, "feltkit/notes.ts"), NOTES_FUNCTIONS);
  process.exit(0);
}

const { loadSources } = await load("src/runtime/loader.ts");
const { resolveEnvironment } = await load("src/runtime/environment.ts");
const { FeltKitRuntime, silentLogger } = await load("src/runtime/runtime.ts");
const { startServer } = await load("src/server/index.ts");

const project = await loadSources(projectDir);
const environment = resolveEnvironment({
  projectDir,
  appName: project.app.name,
  name: "development",
  env: {},
});
const runtime = await FeltKitRuntime.start({
  project,
  environment,
  logger: silentLogger,
  workerIntervalMs: 0,
});
const person = (id) => ({ id, type: "user", roles: ["member"] });
const call = async (who, name, args = {}) => {
  const result = await runtime.call(name, args, { principal: who, via: "test" });
  if (!result.ok) throw new Error(`${name}: ${result.error.code} ${result.error.message}`);
  return result.value;
};

if (process.argv[2] === "--report") {
  const audit = await runtime.auditTrail();
  const notes = {};
  for (const id of ["alice", "bob", "carol"])
    notes[id] = (await call(person(id), "notes:list")).notes;
  console.log(JSON.stringify({ audit, notes }));
  await runtime.close();
  process.exit(0);
}

await call({ id: "op", type: "user", roles: ["operator"] }, "notes:registerAgent", { id: AGENT });
if (!existsSync(credentialFile)) {
  const { token } = await runtime.issueSession(
    { id: AGENT, type: "agent", roles: ["bot"] },
    { kind: "agent", via: "cli" },
  );
  writeFileSync(credentialFile, `${token}\n`, { mode: 0o600 });
}
const tokensDir = process.env.FELTKIT_USER_TOKENS_DIR;
if (tokensDir && !existsSync(join(tokensDir, "alice"))) {
  mkdirSync(tokensDir, { recursive: true });
  for (const id of ["alice", "bob"])
    writeFileSync(
      join(tokensDir, id),
      (await runtime.issueSession(person(id), { kind: "dev", via: "cli" })).token,
      { mode: 0o600 },
    );
}
for (const entry of (process.env.FELTKIT_GRANTS ?? "").split(";").filter(Boolean)) {
  const [id, capabilities] = entry.split("=");
  await call(person(id), "notes:grant", { agent: AGENT, capabilities: capabilities.split("+") });
}
for (const id of (process.env.FELTKIT_REVOKE ?? "").split(",").filter(Boolean)) {
  for (const grant of await call(person(id), "notes:grants"))
    await call(person(id), "notes:revoke", { id: grant.id });
}

const server = await startServer({
  runtime,
  projectDir,
  port: Number(required("FELTKIT_PORT")),
  dashboard: { enabled: false, adminToken: `fka_${"x".repeat(43)}`, dir: null },
});
const authorityPids = readdirSync("/proc")
  .filter((entry) => /^\d+$/u.test(entry))
  .filter((pid) => {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return (
        Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) === process.pid &&
        readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("authboundry")
      );
    } catch {
      return false;
    }
  });
writeFileSync(`${projectDir}.authority-pids`, authorityPids.join("\n"));
console.log(`[feltkit-host] listening at ${server.url}`);
