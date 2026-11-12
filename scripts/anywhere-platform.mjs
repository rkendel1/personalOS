#!/usr/bin/env node
/**
 * PersonalOS Anywhere needs platform changes that are committed on branches of their own
 * repositories but not yet released on npm (docs/ANYWHERE-M3-REGISTER.md). This script makes that
 * state reproducible from a clean checkout, and says plainly what it installed:
 *
 *   node scripts/anywhere-platform.mjs build              clone each platform repository at its
 *                                                          pinned commit, build it, pack it
 *   node scripts/anywhere-platform.mjs install <app>...    install the packed platform into apps
 *                                                          (--no-save: package.json and the lockfile
 *                                                          keep the published versions)
 *   node scripts/anywhere-platform.mjs authboundry         the AuthBoundry server binary path
 *
 * Every install writes `.anywhere/installed.json` in the app: package, version, repository and
 * commit. The packed tarballs carry the published version numbers (version numbers are each
 * owner's release decision), so the commit is the identity of what runs. When the owners release
 * these changes, replace this step with ordinary version bumps.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORK = resolve(process.env.ANYWHERE_PLATFORM_DIR ?? join(ROOT, ".anywhere"));

/** The platform this milestone runs on: repository, the commit, what to build and pack. */
export const PLATFORM = {
  // AppPort Services before FeltKit: FeltKit runs on it (webhook delivery and inbound verification).
  "appport-services": { repo: "https://github.com/rkendel1/appport-services", commit: process.env.APPPORT_SERVICES_COMMIT ?? "7de1de2", build: [["npm", ["ci", "--no-audit", "--no-fund"]], ["npm", ["run", "build"]]], pack: ["."] },
  feltkit: { repo: "https://github.com/rkendel1/feltkit", commit: process.env.FELTKIT_COMMIT ?? "70b38e0", build: [["npm", ["ci", "--no-audit", "--no-fund"]], ["npm", ["run", "build", "-w", "@feltdb/feltkit"]]], pack: ["packages/sdk"] },
  resolver: { repo: "https://github.com/rkendel1/resolver", commit: process.env.RESOLVER_COMMIT ?? "f2b29e7", build: [["npm", ["ci", "--no-audit", "--no-fund"]], ["npm", ["run", "build"]]], pack: ["packages/core", "packages/client", "packages/server"] },
  authboundry: { repo: "https://github.com/rkendel1/authboundry", commit: process.env.AUTHBOUNDRY_COMMIT ?? "9feca56", build: [["npm", ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]], ["cargo", ["build", "--release", "--bin", "authboundry"]]], pack: [] },
};

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, FELTDB_URL: "", FELTDB_ENDPOINT: "" } });
const out = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();

function checkout(name) {
  const { repo, commit } = PLATFORM[name];
  const dir = join(WORK, "src", name);
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(dir, { recursive: true });
    run("git", ["init", "-q"], dir);
    // FeltKit and AuthBoundry are private repositories: CI reads them with PLATFORM_REPOS_TOKEN (read access).
    const token = process.env.PLATFORM_REPOS_TOKEN;
    run("git", ["remote", "add", "origin", token ? repo.replace("https://", `https://x-access-token:${token}@`) : repo], dir);
  }
  let current = "";
  try { current = out("git", ["rev-parse", "HEAD"], dir); } catch { /* a fresh repository has no HEAD yet */ }
  if (!current.startsWith(commit)) {
    // A pinned commit on the milestone branch (GitHub fetches branches, not abbreviated ids).
    run("git", ["fetch", "-q", "--depth", "50", "origin", PLATFORM[name].branch ?? "claude/affectionate-bardeen-o1xu78"], dir);
    run("git", ["checkout", "-q", "--force", commit], dir);
  }
  const head = out("git", ["rev-parse", "HEAD"], dir);
  if (!head.startsWith(commit)) throw new Error(`${name}: checked out ${head}, expected ${commit}`);
  return { dir, head };
}

function build() {
  const tarballs = join(WORK, "tarballs");
  mkdirSync(tarballs, { recursive: true });
  const manifest = [];
  for (const name of Object.keys(PLATFORM)) {
    const { dir, head } = checkout(name);
    for (const [cmd, args] of PLATFORM[name].build) run(cmd, args, dir);
    for (const pkg of PLATFORM[name].pack) {
      const file = out("npm", ["pack", "--pack-destination", tarballs, "--silent"], join(dir, pkg)).split("\n").pop();
      const json = JSON.parse(out("node", ["-p", "JSON.stringify(require('./package.json'))"], join(dir, pkg)));
      manifest.push({ package: json.name, version: json.version, repository: PLATFORM[name].repo, commit: head, tarball: file });
    }
    if (name === "authboundry") manifest.push({ package: "authboundry (server)", repository: PLATFORM[name].repo, commit: head, binary: join(dir, "target", "release", "authboundry") });
  }
  writeFileSync(join(WORK, "platform.json"), JSON.stringify({ builtAt: new Date().toISOString(), packages: manifest }, null, 2));
  console.log(`platform built: ${manifest.map((m) => `${m.package}@${m.commit.slice(0, 7)}`).join(", ")}`);
}

function install(apps) {
  const platform = JSON.parse(readFileSync(join(WORK, "platform.json"), "utf8"));
  const tarballs = platform.packages.filter((p) => p.tarball).map((p) => join(WORK, "tarballs", p.tarball));
  for (const app of apps) {
    const dir = resolve(app);
    // Only the platform packages each app already depends on, directly or through FeltKit.
    const wanted = tarballs.filter((t) => !/appport-resolver-[0-9]/.test(t) || existsSync(join(dir, "node_modules", "@appport", "resolver")));
    run("npm", ["install", "--no-save", "--no-audit", "--no-fund", ...wanted], dir);
    mkdirSync(join(dir, ".anywhere"), { recursive: true });
    writeFileSync(join(dir, ".anywhere", "installed.json"), JSON.stringify({ installedAt: new Date().toISOString(), packages: platform.packages.filter((p) => !p.tarball || wanted.some((w) => w.endsWith(p.tarball))) }, null, 2));
    console.log(`${app}: installed ${wanted.length} platform packages from pinned commits`);
  }
}

const [command, ...rest] = process.argv.slice(2);
if (command === "build") build();
else if (command === "install") install(rest.length ? rest : ["."]);
else if (command === "authboundry") console.log(join(WORK, "src", "authboundry", "target", "release", "authboundry"));
else {
  console.error("usage: anywhere-platform.mjs build | install <app dir>... | authboundry");
  process.exit(2);
}
