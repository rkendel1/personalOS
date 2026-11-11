#!/usr/bin/env node
// What you write vs what FeltKit gives you, measured from this repository (no network, no build).
//
//   node scripts/measure.mjs            prints a Markdown report
//   node scripts/measure.mjs --json     the same numbers as JSON
//   node scripts/measure.mjs --write    puts the report into docs/WHAT-FELTKIT-GIVES-YOU.md (between markers)
//   node scripts/measure.mjs --check    fails when that document no longer matches the code (CI)
//
// Counts are lines that are not blank and not only a comment. The FeltKit side is read from the
// app's own code: which platform capabilities it calls, and which it only configures. Nothing is
// estimated: the "what you'd otherwise assemble" column in docs/WHAT-FELTKIT-GIVES-YOU.md is a
// list of components, not a line count.
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (p) => readFileSync(join(root, p), "utf8");

function files(dir, exts) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(join(root, d))) {
      const p = join(d, name);
      if (["node_modules", "_generated", "dist", ".feltkit"].includes(name)) continue;
      if (statSync(join(root, p)).isDirectory()) walk(p);
      else if (exts.includes(extname(name))) out.push(p);
    }
  };
  if (existsSync(join(root, dir))) walk(dir);
  return out.sort();
}

/** Lines that are code: not blank, not only a comment (//, /* … *\/, * …, {/* … *\/}). */
function codeLines(text) {
  let n = 0;
  let inBlock = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (inBlock) {
      if (line.includes("*/")) inBlock = false;
      continue;
    }
    if (!line || line.startsWith("//")) continue;
    if (line.startsWith("/*") || line.startsWith("{/*")) {
      if (!line.includes("*/")) inBlock = true;
      continue;
    }
    if (line.startsWith("*")) continue;
    n += 1;
  }
  return n;
}

const area = (label, list) => ({ label, files: list.length, lines: list.reduce((sum, f) => sum + codeLines(read(f)), 0) });

const server = files("feltkit", [".ts"]);
const turn = server.filter((f) => /\/(turn|turnstate)\.ts$/.test(f));
const config = server.filter((f) => /\/app\.ts$/.test(f));
// The no-model assistant: a hand-written parser for sentences and dates, and the turn that uses it.
// Product logic, not plumbing: an app that always uses a model does not need it.
const rules = server.filter((f) => /\/(assistant|_interpret|_dates)\.ts$/.test(f));
const domain = server.filter((f) => !turn.includes(f) && !config.includes(f) && !rules.includes(f));
const ui = files("src", [".ts", ".tsx"]);
const styles = files("src", [".css"]);
const extension = [...files("extension/src", [".ts", ".tsx", ".css"]), ...files("extension/public", [".js", ".json"]), "extension/sidepanel.html"].filter((f) => existsSync(join(root, f)));
const tests = files("tests", [".ts"]);
const e2e = files("e2e", [".mjs"]);

const areas = {
  config: area("App definition (`feltkit/app.ts`: roles, services, model, the collection schemas)", config),
  domain: area("Domain operations (`feltkit/`: tasks, memory, reminders, briefing, files, action log)", domain),
  turn: area("Model turn (`feltkit/turn.ts`, `turnstate.ts`: streaming, tools, proposals)", turn),
  rules: area("Built-in assistant without a model (`assistant.ts`, `_interpret.ts`, `_dates.ts`)", rules),
  ui: area("Web UI (`src/*.tsx`)", ui),
  styles: area("Styles (`src/styles.css`)", styles),
  extension: area("Chrome extension (`extension/`)", extension),
  tests: area("Tests (`tests/`)", tests),
  e2e: area("Browser acceptance (`e2e/`)", e2e),
};
const APP = ["config", "domain", "turn", "rules", "ui", "styles", "extension"];
const app = APP.reduce((sum, k) => sum + areas[k].lines, 0);

// Functions the app defines (FeltKit makes each one an HTTP endpoint, an AppPort capability, and
// an MCP tool where exposed, with authorization).
const serverText = server.map(read).join("\n");
const count = (re, text = serverText) => (text.match(re) ?? []).length;
const functions = {
  collections: count(/\bapp\.collection\(/g),
  queries: count(/\bapp\.query\(/g),
  mutations: count(/\bapp\.mutation\(/g),
  actions: count(/\bapp\.action\(/g),
  events: count(/\bapp\.event\(/g),
  // Functions that also publish themselves as a named capability: AppPort and MCP (agent) tools.
  published: count(/\bcapability:\s*\{\s*name:/g),
};

// Platform capabilities: where the app calls them, and what it only configures.
const appTs = read("feltkit/app.ts");
const uiText = [...ui, ...files("extension/src", [".ts", ".tsx"])].map(read).join("\n");
const capabilities = [
  ["Database: transactions, schema, indexes", count(/\bctx\.db\.\w+/g), "ctx.db.*"],
  ["Auth: accounts, sessions, roles, dev users", count(/\bctx\.auth\.\w+/g) + (/\bauth:\s*\{/.test(appTs) ? 1 : 0), "ctx.auth.*, auth: { accounts }"],
  ["Live queries to the browser", count(/\buseQuery\(/g, uiText), "useQuery"],
  ["Background jobs (run as the person)", count(/jobs\.enqueue/g), "ctx.afterCommit.jobs.enqueue"],
  ["Notifications", count(/notifications\.(send|list|markRead)/g), "ctx.afterCommit.notifications / ctx.services.notifications"],
  ["Files (upload, short-lived links)", count(/services\.files\.\w+/g) + count(/client\.(uploadFile|fileUrl)/g, uiText), "ctx.services.files, client.uploadFile"],
  ["Signed outbound webhooks", count(/webhooks\.emit/g), "ctx.afterCommit.webhooks.emit"],
  ["Model: generate, stream, status", count(/\bctx\.model\.\w+/g), "ctx.model.*"],
  ["Agent: tasks, tools, proposals, approvals", count(/\bctx\.agent\.\w+/g) + count(/\buseOwnActions\(/g, uiText), "ctx.agent.*, useOwnActions"],
  ["Streaming actions to the UI (SSE, cancellable)", count(/\buseAction\(/g, uiText), "app.action + useAction"],
  ["Live events", count(/\bctx\.emit\(/g), "ctx.emit"],
];
const configured = [
  ["Schedules (operator-managed)", /schedules:\s*true/.test(appTs)],
  ["Configuration service", /configuration:\s*true/.test(appTs)],
  ["Intelligence (model selection in Studio, credential custody)", /intelligence:\s*true/.test(appTs)],
  ["Model by reference (Resolver)", /ref:\/\//.test(appTs)],
];

// What the app does NOT contain.
const all = [...server, ...ui, ...extension.filter((f) => /\.(ts|tsx)$/.test(f))].map(read).join("\n");
const pkg = JSON.parse(read("package.json"));
const absent = {
  "SQL or migration files": files(".", [".sql"]).length,
  "Server bootstrap (express/fastify/http.createServer)": count(/from ["'](express|fastify|koa|hono)["']|createServer\(/g, all),
  "Dockerfiles": existsSync(join(root, "Dockerfile")) ? 1 : 0,
  "WebSocket/SSE server code": count(/new WebSocketServer|text\/event-stream/g, [...server].map(read).join("\n")),
  "Model SDK imports (openai, @anthropic-ai, ai)": count(/from ["'](openai|@anthropic-ai\/[\w-]+|ai)["']/g, all),
  "Queue/cron libraries": count(/from ["'](bullmq|node-cron|agenda|bree)["']/g, all),
};
const deps = Object.keys(pkg.dependencies ?? {});

const report = { appLines: app, areas, functions, capabilities, configured, absent, dependencies: deps };

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const rows = (pairs) => pairs.map((r) => `| ${r.join(" | ")} |`).join("\n");
  const markdown = `## What you write (measured: \`npm run measure\`)

| Area | Files | Lines of code |
|---|---:|---:|
${rows(APP.map((k) => [areas[k].label, areas[k].files, areas[k].lines]))}
| **The whole app** | | **${app}** |
${rows(["tests", "e2e"].map((k) => [areas[k].label, areas[k].files, areas[k].lines]))}

Lines of code are lines that are not blank and not only a comment.

The app defines ${functions.collections} collections, ${functions.queries} queries, ${functions.mutations} mutations and ${functions.actions} streaming actions. FeltKit makes every function an authorized HTTP endpoint with a typed client, which the web app and the extension call. The ${functions.published} that declare a \`capability\` are also published over AppPort and as MCP tools for agents, with the same authorization. The app has ${deps.length} runtime dependencies: ${deps.map((d) => `\`${d}\``).join(", ")}.

## What FeltKit gives it

| Capability | Call sites in this app | API |
|---|---:|---|
${rows(capabilities.map(([name, n, api]) => [name, n, `\`${api}\``]))}

Configured in \`feltkit/app.ts\`, with no code: ${configured.filter(([, on]) => on).map(([name]) => name).join("; ")}.

## What the app does not contain

| Thing you'd usually write or assemble | In this repo |
|---|---:|
${rows(Object.entries(absent).map(([k, v]) => [k, v]))}
`;
  const DOC = join(root, "docs/WHAT-FELTKIT-GIVES-YOU.md");
  const START = "<!-- measure:start (generated by npm run measure -- --write; do not edit) -->";
  const END = "<!-- measure:end -->";
  if (process.argv.includes("--write") || process.argv.includes("--check")) {
    const doc = readFileSync(DOC, "utf8");
    const a = doc.indexOf(START), b = doc.indexOf(END);
    if (a < 0 || b < a) throw new Error(`${relative(root, DOC)} has no measure markers`);
    const next = `${doc.slice(0, a + START.length)}\n${markdown.trim()}\n${doc.slice(b)}`;
    if (process.argv.includes("--check")) {
      if (next !== doc) {
        console.error(`${relative(root, DOC)} is out of date with the code: run npm run measure -- --write`);
        process.exit(1);
      }
      console.log(`${relative(root, DOC)} matches the code (${app} lines of app code)`);
    } else {
      writeFileSync(DOC, next);
      console.log(`updated ${relative(root, DOC)}`);
    }
  } else {
    console.log(markdown);
  }
}
