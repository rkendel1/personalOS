/**
 * An agent outside Anywhere Aide works with a person's projects and documents over /appport, under their
 * grants to it (FeltKit's delegated execution, the REAL private AuthBoundry, real HTTP, real Files).
 * Project and document authority are separate grants; a document's bytes, its download link and its
 * removal never pass through an agent.
 *
 * Skipped, saying why, unless the installed FeltKit has delegated /appport and @authboundry/local has
 * per-agent delegation.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createTestApp, type TestApp } from "@feltdb/feltkit/testing";
import { startServer } from "@feltdb/feltkit/server";
import { api } from "../feltkit/_generated/api.js";

function skipReason(): string | false {
  const require = createRequire(import.meta.url);
  const feltkit = dirname(require.resolve("@feltdb/feltkit/package.json"));
  if (!existsSync(join(feltkit, "dist/runtime/delegation.js"))) return "the installed @feltdb/feltkit has no delegated /appport (needs a release after 0.3.32)";
  try {
    if ((require(require.resolve("@authboundry/local/package.json")).version as string) === "0.1.0") return "@authboundry/local 0.1.0 has no per-agent delegation";
  } catch { return "@authboundry/local is not installed"; }
  return false;
}
const SKIP = skipReason();
const EVE = { id: "eve", type: "agent" as const, roles: ["agent"] };

let t: TestApp;
let server: { url: string; close(): unknown };
let token = "";
let n = 0;

before(async () => {
  if (SKIP) return;
  delete process.env.AUTHBOUNDRY_URL;
  delete process.env.FELTKIT_CREDENTIAL_AUTHBOUNDRY_CHECK;
  t = await createTestApp();
  server = await startServer({ runtime: t.runtime as never, projectDir: process.cwd(), port: 0, dashboard: { enabled: false, adminToken: `fka_${"x".repeat(43)}`, dir: null } });
  token = (await (t.runtime as any).issueSession(EVE, { kind: "agent", via: "cli" })).token;
});
after(async () => {
  await server?.close();
  await t?.close();
});

async function appport(capability: string, input: unknown, onBehalfOf: string, idempotencyKey?: string) {
  const res = await fetch(`${server.url}/appport`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-appport-on-behalf-of": onBehalfOf },
    body: JSON.stringify({ protocol: "appport/1", type: "request", requestId: `r_${++n}`, capability: { name: capability, version: 1 }, input, ...(idempotencyKey ? { idempotencyKey } : {}) }),
  });
  return (await res.json()) as any;
}
const grantEve = (who: string, capabilities: string[]) => t.as(who).action(api.delegation.set, { agent: "eve", capabilities });
const state = async (who: string) => ({
  projects: await t.as(who).query(api.projects.list, {}),
  documents: await t.as(who).query(api.documents.list, {}),
  actions: await t.as(who).query(api.actions.list, {}),
});

/** A refusal leaves the person's projects, documents and action log exactly as they were. */
async function refused(attempt: Promise<any>, owner: string, why: string, code = "FORBIDDEN") {
  const before = await state(owner);
  const r = await attempt;
  assert.equal(r.ok, false, `${why}: ${JSON.stringify(r)}`);
  assert.equal(r.error.code, code, `${why}: ${JSON.stringify(r.error)}`);
  assert.deepEqual(await state(owner), before, `${why}: nothing changed`);
}

/** A document saved the way the Documents screen saves one: an upload link, the bytes, then attach. */
async function upload(who: string, name: string, text: string, projectId?: string) {
  const target = await t.as(who).mutation(api.documents.prepareUpload, { name, contentType: "text/plain" });
  const { id: fileId } = await t.runtime.services.redeemUpload(target.url.split("/").pop()!, async () => new TextEncoder().encode(text), { name, contentType: "text/plain" });
  return t.as(who).mutation(api.documents.attach, { fileId, ...(projectId ? { projectId } : {}) });
}

test("an agent works with Ada's projects and documents only as each is granted, and never with Grace's", { skip: SKIP }, async () => {
  await t.as("ada").action(api.delegation.registerAgent, { id: "eve" });
  const taxes = await t.as("ada").mutation(api.projects.create, { name: "Taxes" });
  const w2 = await upload("ada", "w2.txt", "wages 100", taxes.id);
  const lease = await upload("ada", "lease.txt", "rent 900");
  const garden = await t.as("grace").mutation(api.projects.create, { name: "Garden" });
  const seeds = await upload("grace", "seeds.txt", "tomatoes", garden.id);

  // Project reads: their own grant, Ada's projects only, and no documents with them.
  await refused(appport("projects.list", {}, "ada"), "ada", "no grant");
  await grantEve("ada", ["projects.list"]);
  const projects = await appport("projects.list", {}, "ada");
  assert.equal(projects.ok, true, JSON.stringify(projects));
  assert.deepEqual(projects.output.map((p: any) => [p.owner, p.name]), [["ada", "Taxes"]]);
  await refused(appport("documents.list", {}, "ada"), "ada", "project reads do not expose documents");
  await refused(appport("documents.list", { projectId: taxes.id }, "ada"), "ada", "not even that project's documents");

  // Project writes: create and update each need their own grant.
  await refused(appport("projects.create", { name: "Kitchen" }, "ada"), "ada", "create not granted");
  await grantEve("ada", ["projects.list", "projects.create"]);
  const kitchen = await appport("projects.create", { name: "Kitchen", description: "Redo the counters" }, "ada", "eve-p1");
  assert.equal(kitchen.ok, true, JSON.stringify(kitchen));
  assert.deepEqual([kitchen.output.owner, kitchen.output.status], ["ada", "active"]);
  const again = await appport("projects.create", { name: "Kitchen", description: "Redo the counters" }, "ada", "eve-p1");
  assert.deepEqual(again.output, kitchen.output, "the same key replays");
  const named = await appport("projects.create", { name: "kitchen" }, "ada", "eve-p2");
  assert.equal(named.error.code, "feltkit.FAILED_PRECONDITION", "Anywhere Aide's own rule: one project per name");
  assert.equal((await t.as("ada").query(api.projects.list, {})).filter((p) => p.name === "Kitchen").length, 1);
  const created = (await t.as("ada").query(api.actions.list, {})).find((a) => a.kind === "project.create" && a.evidence?.id === kitchen.output.id)!;
  assert.deepEqual([created.via, created.delegation?.agent, created.delegation?.capability], ["agent", "eve", "projects.create"]);
  const audit = (await (t.runtime as any).auditTrail()).find((r: any) => r.authority.delegation?.decisionId === created.delegation!.decisionId);
  assert.deepEqual([audit.function, audit.principal.id, audit.authority.delegation.delegationId], ["projects:create", "ada", created.delegation!.delegationId]);

  await refused(appport("projects.update", { id: kitchen.output.id, status: "paused" }, "ada"), "ada", "update not granted");
  await grantEve("ada", ["projects.list", "projects.create", "projects.update"]);
  const paused = await appport("projects.update", { id: kitchen.output.id, status: "paused" }, "ada", "eve-p3");
  assert.deepEqual([paused.ok, paused.output.status], [true, "paused"]);
  const updated = (await t.as("ada").query(api.actions.list, {})).find((a) => a.kind === "project.update")!;
  assert.deepEqual([updated.via, updated.input.status, updated.evidence?.verified, updated.delegation?.capability], ["agent", "paused", true, "projects.update"]);
  await refused(appport("projects.update", { id: garden.id, status: "done" }, "ada"), "grace", "Grace's project does not exist for Ada", "NOT_FOUND");

  // Document reads: their own grant; Ada's documents only; names and notes, never contents or links.
  await grantEve("ada", ["projects.list", "projects.create", "projects.update", "documents.list"]);
  const docs = await appport("documents.list", {}, "ada");
  assert.deepEqual(docs.output.map((d: any) => [d.owner, d.name]).sort(), [["ada", "lease.txt"], ["ada", "w2.txt"]]);
  assert.deepEqual((await appport("documents.list", { projectId: taxes.id }, "ada")).output.map((d: any) => d.id), [w2.id], "the project relation holds");
  assert.deepEqual((await appport("documents.list", { projectId: garden.id }, "ada")).output, [], "Grace's project has nothing of Ada's");
  assert.ok(docs.output.every((d: any) => !("url" in d) && !("content" in d)));

  // Document updates: their own grant; only Ada's documents, only to Ada's projects.
  await refused(appport("documents.update", { id: lease.id, projectId: kitchen.output.id }, "ada"), "ada", "documents.update not granted");
  await grantEve("ada", ["projects.list", "projects.create", "projects.update", "documents.list", "documents.update"]);
  const moved = await appport("documents.update", { id: lease.id, projectId: kitchen.output.id, note: "for the contractor" }, "ada", "eve-d1");
  assert.deepEqual([moved.ok, moved.output.projectId, moved.output.note], [true, kitchen.output.id, "for the contractor"]);
  assert.deepEqual((await t.as("ada").query(api.documents.list, { projectId: kitchen.output.id })).map((d) => d.id), [lease.id], "visible on Anywhere Aide's own read");
  const docAction = (await t.as("ada").query(api.actions.list, {})).find((a) => a.kind === "document.update")!;
  assert.deepEqual([docAction.via, docAction.evidence?.id, docAction.evidence?.verified, docAction.delegation?.capability], ["agent", lease.id, true, "documents.update"]);
  await refused(appport("documents.update", { id: lease.id, projectId: garden.id }, "ada"), "ada", "not to Grace's project", "NOT_FOUND");
  await refused(appport("documents.update", { id: seeds.id, note: "mine now" }, "ada"), "grace", "not Grace's document", "NOT_FOUND");

  // Never through an agent: uploads, download links, removal. Not capabilities, and not grantable.
  for (const capability of ["documents.link", "documents.remove", "documents.upload", "documents.attach"]) {
    await refused(appport(capability, { id: w2.id }, "ada"), "ada", capability, "UNKNOWN_CAPABILITY");
    await assert.rejects(grantEve("ada", [capability]), /Not something an agent can be given/, capability);
  }
  await refused(appport("projects.list", {}, "grace"), "grace", "Grace granted nothing");

  // Revoking stops the next call; Ada's own use is unchanged and names no agent.
  await grantEve("ada", []);
  await refused(appport("documents.list", {}, "ada"), "ada", "revoked");
  await refused(appport("projects.update", { id: kitchen.output.id, status: "active" }, "ada"), "ada", "revoked");
  const mine = await t.as("ada").mutation(api.projects.update, { id: kitchen.output.id, status: "active" });
  assert.equal(mine.status, "active");
  const own = (await t.as("ada").query(api.actions.list, {})).find((a) => a.kind === "project.update" && a.input.status === "active")!;
  assert.deepEqual([own.via, own.delegation], ["ui", undefined]);
  await t.as("ada").mutation(api.documents.remove, { id: w2.id });
  assert.deepEqual((await t.as("ada").query(api.documents.list, {})).map((d) => d.id), [lease.id]);
});
