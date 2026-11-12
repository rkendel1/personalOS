/**
 * Identity resolution through Resolver (@appport/resolver): an external identity (a sender on a
 * connected surface) → the canonical PersonalOS identity it was verifiably linked to.
 *
 * Resolver has no identity kind, so a link is what Resolver already models well: a typed `value`
 * reference with a fixed schema, revisions (actor, reason, time), total revocation and per-key grants.
 *
 *   ref://identity/personalos/<adapter>/<sha256(instance)>/<sha256(principal)>/<linkId>
 *     → { canonical: "personalos:account:<owner>", external: { adapter, instance, principalId },
 *         verification: { method, challengeId, verifiedAt }, linkedAt }
 *
 * One reference per link, never reused (Resolver never reuses a revoked name), so relinking after a
 * revocation is a new reference and the history of the old one stays. Each link is created with an
 * exact lookup entry for the external identity; resolution is one indexed `resolver.lookup` (no
 * listing), and requires exactly one active link whose stored external identity matches the sender
 * exactly: none is unresolved, more than one is ambiguous, and both fail closed.
 *
 * Who may do what, enforced twice, by FeltKit and by Resolver (a binding decides which account an
 * external sender acts as, so a write is an account-takeover path):
 *
 *   resolving   integration `identity` (feltkit/app.ts): `resolver.lookup` and `resolver.resolve`
 *               only, with a Resolver key that holds `read` on ref://identity/personalos/* and
 *               nothing else. Permission `identity.resolve`: the bridge (resolving senders) and the
 *               `identity` agent.
 *   linking     integration `identitylinks`: `resolver.put` that can only create (expectedRevision
 *               is 0 in its input schema, so it can never change an existing link) and
 *               `resolver.revoke`, with a key that holds `write` on that prefix and cannot read.
 *               Permission `identity.link`: only the `identity` agent's role (feltkit/links.ts),
 *               which writes only what the signed-in owner confirmed (links:confirm) or disconnected
 *               (links:revoke). No session holds it, so the integration's capability, which FeltKit
 *               also serves on /appport, is refused to every person and to the bridge.
 *
 * Both keys are FeltKit credential references (credential custody: `feltkit credential set
 * resolver-resolve` / `resolver-link`), resolved only for the call; this code never holds them.
 * Rotation is a new credential version; revocation is revoking the key in Resolver.
 *
 * Resolver resolves; it grants nothing. Whether the resolved account may do what it asks is
 * AuthBoundry's decision, and the adapter's authenticity is FeltKit's session. References are
 * written with ttlSeconds 0, and nothing here caches, so a revocation holds on the next request.
 */
import { fail } from "@feltdb/feltkit";

type IntegrationCtx = { integrations: { invoke(capability: string, input: Record<string, unknown>): Promise<unknown> } };

export const CANONICAL_PREFIX = "personalos:account:";
export const canonicalOf = (owner: string) => `${CANONICAL_PREFIX}${owner}`;
export const ownerOf = (canonical: string) => (canonical.startsWith(CANONICAL_PREFIX) ? canonical.slice(CANONICAL_PREFIX.length) : null);

const ROOT = "ref://identity/personalos";

/** The schema every link reference is created with (Resolver checks each binding against it). */
export const LINK_SCHEMA = {
  type: "object",
  required: ["canonical", "external", "verification", "linkedAt"],
  additionalProperties: false,
  properties: {
    canonical: { type: "string", pattern: "^personalos:account:.+" },
    external: {
      type: "object", required: ["adapter", "instance", "principalId"], additionalProperties: false,
      properties: { adapter: { type: "string" }, instance: { type: "string" }, principalId: { type: "string" } },
    },
    verification: {
      type: "object", required: ["method", "challengeId", "verifiedAt"], additionalProperties: false,
      properties: { method: { type: "string" }, challengeId: { type: "string" }, verifiedAt: { type: "string" } },
    },
    linkedAt: { type: "string" },
  },
};

export interface External { adapter: string; instance: string; principalId: string }
interface LinkValue { canonical: string; external: External; verification: { method: string; challengeId: string; verifiedAt: string }; linkedAt: string }

export type Resolution =
  | { status: "resolved"; canonical: string; owner: string; ref: string; revision: number; verifiedAt: string }
  | { status: "unresolved" }
  | { status: "ambiguous"; refs: string[] };

async function hex(text: string): Promise<string> {
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function prefixOf(e: External): Promise<string> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(e.adapter)) fail("INVALID_ARGUMENT", "Adapter ids are lowercase letters, digits and dashes.");
  return `${ROOT}/${e.adapter}/${await hex(e.instance)}/${await hex(e.principalId)}/`;
}

/** The AppPort request envelope Resolver's HTTP endpoint takes (`POST /appport`). */
const envelope = (name: string, input: Record<string, unknown>) => ({ protocol: "appport/1", type: "request", requestId: "personalos", capability: { name, version: 1 }, input });

interface ResolverFailure { status: number | null; reason?: string }

/**
 * One Resolver capability through a declared integration operation. Resolver answers a refusal with
 * its HTTP status (403 forbidden, 404 not-found or revoked, 409 stale revision); those come back as a
 * ResolverFailure for the caller to decide on. Unreachable or unconfigured: fail closed.
 */
async function call<T>(ctx: IntegrationCtx, operation: string, name: string, input: Record<string, unknown>): Promise<T | ResolverFailure & { failed: true }> {
  try {
    const out = (await ctx.integrations.invoke(operation, envelope(name, input))) as { ok?: boolean; output?: T };
    if (!out?.ok) fail("UNAVAILABLE", "Resolver answered without a result.");
    return out.output as T;
  } catch (error) {
    const e = error as { code?: string; message?: string; details?: { status?: number | null } };
    if (e.code === "UPSTREAM_REJECTED") {
      const reason = /resolver\.[a-z-]+/.exec(String(e.message))?.[0];
      return { failed: true, status: e.details?.status ?? null, ...(reason ? { reason } : {}) };
    }
    if (e.code === "FORBIDDEN" || e.code === "UNAUTHORIZED") throw error;
    fail("UNAVAILABLE", `Identity resolution is unavailable (Resolver through the \`${operation.split(".")[0]}\` integration): ${e.message ?? e.code}`);
  }
}
const failed = (v: unknown): v is ResolverFailure & { failed: true } => !!v && typeof v === "object" && (v as { failed?: boolean }).failed === true;

/** A Resolver refusal that is not an answer about this reference: the key, the grant, the request. */
function refused(f: ResolverFailure, what: string): never {
  fail(f.status === 403 ? "FORBIDDEN" : "UNAVAILABLE", `Resolver refused to ${what} (${f.status ?? "no status"}${f.reason ? `, ${f.reason}` : ""}).`);
}

const same = (a: External, b: External) => a.adapter === b.adapter && a.instance === b.instance && a.principalId === b.principalId;

/**
 * The lookup entry a link is created with (Resolver `PutInput.lookup`): the external identity, exact.
 * The key names the adapter and installation (hashed: installations are URLs), the value is the
 * principal id itself, so matching is exact and done by Resolver's index (`resolver.lookup`).
 */
export async function lookupEntry(e: External): Promise<{ key: string; value: string }> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(e.adapter)) fail("INVALID_ARGUMENT", "Adapter ids are lowercase letters, digits and dashes.");
  return { key: `identity.personalos:${e.adapter}:${(await hex(e.instance)).slice(0, 64)}`, value: e.principalId };
}

/** The canonical identity a sender resolves to: exactly one active, exactly matching link, or none. */
export async function resolveExternal(ctx: IntegrationCtx, e: External): Promise<Resolution> {
  const entry = await lookupEntry(e);
  // One indexed lookup: the active link references for exactly this external identity the key may read.
  const found = await call<{ refs: Array<{ ref: string }> }>(ctx, "identity.lookup", "resolver.lookup", { key: entry.key, value: entry.value });
  if (failed(found)) refused(found, "look up the sender");
  const matches: Array<{ ref: string; value: LinkValue; revision: number }> = [];
  for (const s of found.refs) {
    const got = await call<{ revision: number; selected: { value: LinkValue } }>(ctx, "identity.resolve", "resolver.resolve", { ref: s.ref });
    // Revoked between lookup and resolve: no longer a link.
    if (failed(got)) { if (got.status === 404) continue; refused(got, "resolve a link"); }
    const value = got.selected.value;
    if (value && same(value.external, e) && ownerOf(value.canonical)) matches.push({ ref: s.ref, value, revision: got.revision });
  }
  if (!matches.length) return { status: "unresolved" as const };
  if (matches.length > 1) return { status: "ambiguous" as const, refs: matches.map((m) => m.ref) };
  const [m] = matches;
  return { status: "resolved" as const, canonical: m!.value.canonical, owner: ownerOf(m!.value.canonical)!, ref: m!.ref, revision: m!.revision, verifiedAt: m!.value.verification.verifiedAt };
}

/**
 * Record a link the owner confirmed. Named by the challenge that proved it, so a retried confirmation
 * writes the same reference (and finds it already there) instead of a second, ambiguous one. The
 * `identitylinks` operation can only create: an existing link is never changed through it.
 */
export async function linkExternal(ctx: IntegrationCtx, e: External, owner: string, challengeId: string, at: number): Promise<{ ref: string; revision: number }> {
  const ref = `${await prefixOf(e)}${challengeId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60)}`;
  const value: LinkValue = { canonical: canonicalOf(owner), external: { ...e }, verification: { method: "personalos.link-code/dm+owner-confirmed", challengeId, verifiedAt: new Date(at).toISOString() }, linkedAt: new Date(at).toISOString() };
  const w = await call<{ ref: string; revision: number }>(ctx, "identitylinks.put", "resolver.put", { ref, kind: "value", schema: LINK_SCHEMA, binding: { value }, expectedRevision: 0, ttlSeconds: 0, lookup: await lookupEntry(e), reason: `linked by ${canonicalOf(owner)} (challenge ${challengeId})` });
  if (!failed(w)) return { ref: w.ref, revision: w.revision };
  if (w.status !== 409) refused(w, "record the link");
  // Written by an earlier attempt of this same confirmation: accept it only if it is exactly this link.
  const got = await call<{ revision: number; selected: { value: LinkValue } }>(ctx, "identity.resolve", "resolver.resolve", { ref });
  if (failed(got)) refused(got, "read back the link");
  const v = got.selected.value;
  if (v.canonical !== value.canonical || !same(v.external, e)) fail("CONFLICT", "A different link already holds this name.");
  return { ref, revision: got.revision };
}

/** Revoke a link in Resolver. Every later resolution fails, pinned or not. Already revoked is fine. */
export async function revokeLink(ctx: IntegrationCtx, ref: string, reason: string): Promise<void> {
  const got = await call<{ revision: number }>(ctx, "identity.resolve", "resolver.resolve", { ref });
  if (failed(got)) { if (got.status === 404) return; refused(got, "read the link"); }
  const r = await call(ctx, "identitylinks.revoke", "resolver.revoke", { ref, expectedRevision: got.revision, reason });
  if (failed(r) && r.status !== 404) refused(r, "revoke the link");
}

/** Whether a link reference still resolves to `owner` (for work that continues after the request: status, reminders). */
export async function linkActive(ctx: IntegrationCtx, ref: string, owner: string): Promise<boolean> {
  const got = await call<{ selected: { value: LinkValue } }>(ctx, "identity.resolve", "resolver.resolve", { ref });
  if (failed(got)) { if (got.status === 404) return false; refused(got, "resolve a link"); }
  return got.selected.value.canonical === canonicalOf(owner);
}
