import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const required = (name) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set.`);
  return value;
};
const source = required("PERSONALOS_DIR");
const projectDir = required("PERSONALOS_PROJECT_DIR");
const credentialFile = required("APPPORT_AGENT_CREDENTIAL_FILE");
const AGENT = "appport-agent";
const ADMIN = { id: "ada", type: "user", roles: ["owner", "admin"] };
const person = (id) => ({ id, type: "user", roles: ["owner"] });

if (process.argv[2] === "--copy-project") {
  rmSync(projectDir, { force: true, recursive: true });
  mkdirSync(projectDir, { recursive: true });
  cpSync(join(source, "feltkit"), join(projectDir, "feltkit"), { recursive: true });
  cpSync(join(source, "package.json"), join(projectDir, "package.json"));
  symlinkSync(join(source, "node_modules"), join(projectDir, "node_modules"), "dir");
  process.exit(0);
}

const feltkit = (path) =>
  import(pathToFileURL(join(source, "node_modules/@feltdb/feltkit/dist", path)).href);
const { FeltKitRuntime, loadSources, resolveEnvironment, startServer } =
  await feltkit("server/public.js");
const { silentLogger } = await feltkit("runtime/runtime.js");
const project = await loadSources(projectDir);
const environment = resolveEnvironment({
  projectDir,
  appName: project.app.name,
  name: "development",
  env: {},
});
if (process.env.PERSONALOS_PAGE_STUB === "1")
  // Research reads pages through its page-reader seam; the test supplies the page instead of the web.
  globalThis[Symbol.for("personalos.research.pageReader")] = async (url) => ({
    detail: "",
    finalUrl: url,
    httpStatus: 200,
    ms: 1,
    status: "read",
    text: "Acme Ops builds internal tools in TypeScript for operations teams.",
    title: "Acme Ops",
    url,
  });
const runtime = await FeltKitRuntime.start({
  environment,
  logger: silentLogger,
  project,
  workerIntervalMs: Number(process.env.PERSONALOS_WORKER_MS ?? 0),
});
const call = async (who, name, args = {}) => {
  const result = await runtime.call(name, args, { principal: who, via: "test" });
  if (!result.ok) throw new Error(`${name}: ${result.error.code} ${result.error.message}`);
  return result.value;
};

if (process.argv[2] === "--report") {
  const jobs = (await runtime.services.jobs.listJobs("personalos")).filter(
    (job) => job.type === "reminder.fire",
  );
  if (process.env.PERSONALOS_FIRE_REMINDERS === "1") {
    for (const job of jobs.filter((entry) => entry.status === "scheduled"))
      await runtime.services.jobs.executeJob("personalos", job.id, "report-worker");
    await runtime.runServices();
  }
  const people = {};
  for (const id of ["ada", "grace"]) {
    people[id] = {
      actions: await call(person(id), "actions:list"),
      briefing: await call(person(id), "briefing:today", { today: process.env.PERSONALOS_TODAY }),
      inbox: await call(person(id), "inbox:list"),
      documents: await call(person(id), "documents:list"),
      memories: await call(person(id), "memory:list"),
      projects: await call(person(id), "projects:list"),
      research: await call(person(id), "research:list"),
      tasks: await call(person(id), "tasks:list"),
    };
  }
  const audit = (await runtime.auditTrail()).filter((entry) =>
    /^(tasks|memory|projects|documents|researchstate|research):/u.test(entry.function),
  );
  const raw = (name) => runtime.instance.handle("app").collection(name).find({});
  const surfaces = {
    actions: await raw("actions"),
    interactions: await raw("interactions"),
    invocations: await raw("invocations"),
    xPosts: await raw("xPosts"),
  };
  const fullAudit = await runtime.auditTrail();
  const reminders = (await runtime.services.jobs.listJobs("personalos"))
    .filter((job) => job.type === "reminder.fire")
    .map((job) => ({
      principal: job.principal.principalId,
      status: job.status,
      taskId: job.payload.taskId,
    }));
  console.log(JSON.stringify({ audit, fullAudit, people, reminders, surfaces }));
  await runtime.close();
  process.exit(0);
}

await call(ADMIN, "delegation:registerAgent", { id: AGENT });
if (!existsSync(credentialFile)) {
  const { token } = await runtime.issueSession(
    { id: AGENT, roles: ["agent"], type: "agent" },
    { kind: "agent", via: "cli" },
  );
  writeFileSync(credentialFile, `${token}\n`, { mode: 0o600 });
}
for (const id of (process.env.PERSONALOS_SIGNED_IN ?? "").split(",").filter(Boolean)) {
  const { token } = await runtime.issueSession(person(id), { kind: "dev", via: "cli" });
  mkdirSync(`${projectDir}.tokens`, { recursive: true });
  writeFileSync(join(`${projectDir}.tokens`, id), token, { mode: 0o600 });
}
// Operator-issued service sessions (`feltkit session create --type service --id <id> --role <role>`):
// the surfaces' bridge and X adapter, as `id=role;…`.
for (const entry of (process.env.PERSONALOS_SERVICE_SESSIONS ?? "").split(";").filter(Boolean)) {
  const [id, role] = entry.split("=");
  const { token } = await runtime.issueSession(
    { id, roles: [role], type: "service" },
    { kind: "service", via: "cli" },
  );
  mkdirSync(`${projectDir}.tokens`, { recursive: true });
  writeFileSync(join(`${projectDir}.tokens`, id), token, { mode: 0o600 });
}
// What each person lets PersonalOS's own executor do for them (Settings), as `person=cap+cap;…`.
for (const entry of (process.env.PERSONALOS_EXECUTOR_GRANTS ?? "").split(";").filter(Boolean)) {
  const [id, capabilities] = entry.split("=");
  await call(person(id), "delegation:set", {
    capabilities: capabilities ? capabilities.split("+") : [],
  });
}
for (const entry of (process.env.PERSONALOS_GRANTS ?? "").split(";").filter(Boolean)) {
  const [id, capabilities] = entry.split("=");
  await call(person(id), "delegation:set", {
    agent: AGENT,
    capabilities: capabilities ? capabilities.split("+") : [],
  });
}

for (const entry of (process.env.PERSONALOS_RESEARCH_BUDGET ?? "").split(";").filter(Boolean)) {
  const [id, calls] = entry.split("=");
  await call(person(id), "delegation:setResearchBudget", { agent: AGENT, calls: Number(calls) });
}

const crashPlan = process.env.PERSONALOS_CRASH_FILE;
if (crashPlan) {
  const set = runtime.idempotency.set.bind(runtime.idempotency);
  runtime.idempotency.set = async (record) => {
    if (existsSync(crashPlan)) {
      rmSync(crashPlan);
      process.kill(process.pid, "SIGKILL");
    }
    return await set(record);
  };
}

const server = await startServer({
  dashboard: { adminToken: `fka_${"x".repeat(43)}`, dir: null, enabled: false },
  port: Number(required("PERSONALOS_PORT")),
  projectDir,
  runtime,
});
// The private AuthBoundry FeltKit started runs in its own process group: record it, so a test that kills
// this process (a crash) can stop it too.
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
console.log(`[personalos-host] listening at ${server.url}`);
