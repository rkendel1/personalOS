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
 * Resolver resolves; it grants nothing. Whether the resolved account may do what it asks is
 * AuthBoundry's decision (feltkit/_authority.ts), and the adapter's authenticity is FeltKit's session.
 * References are written with ttlSeconds 0, so no client serves a link after Resolver revoked it.
 *
 * Configuration: RESOLVER_URL and RESOLVER_API_KEY (the same names FeltKit uses for model references).
 * The key needs read and write on ref://identity/personalos/* and nothing else.
 */
import { fail } from "@feltdb/feltkit";
import { ResolverClient } from "@appport/resolver-client";

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

/** Resolver, connected for one operation. Unconfigured or unreachable: fail closed. */
async function withResolver<T>(use: (r: ResolverClient) => Promise<T>): Promise<T> {
  const url = process.env.RESOLVER_URL;
  const apiKey = process.env.RESOLVER_API_KEY;
  if (!url || !apiKey) fail("UNAVAILABLE", "Identity resolution is not configured (RESOLVER_URL, RESOLVER_API_KEY), so no surface identity can be resolved.");
  let client: ResolverClient;
  try {
    client = await ResolverClient.connect({ url, apiKey, live: false, maxStaleSeconds: 0, timeoutMs: 5000 });
  } catch (error) {
    fail("UNAVAILABLE", `Resolver is unreachable: ${(error as Error).message}`);
  }
  try {
    return await use(client);
  } catch (error) {
    const e = error as { code?: string; reason?: string; message?: string };
    if (e.code === "NOT_FOUND" || e.code === "CONFLICT" || e.code === "INVALID_INPUT") throw error;
    fail("UNAVAILABLE", `Resolver could not answer: ${e.message ?? e.code}`);
  } finally {
    client.close();
  }
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
export async function resolveExternal(e: External): Promise<Resolution> {
  const entry = await lookupEntry(e);
  return withResolver(async (r) => {
    // One indexed lookup: the active link references for exactly this external identity that this key may read.
    const { refs } = await r.lookup(entry.key, entry.value);
    const matches: Array<{ ref: string; value: LinkValue; revision: number }> = [];
    for (const s of refs) {
      try {
        const got = await r.resolve(s.ref);
        const value = got.selected.value as unknown as LinkValue;
        if (value && same(value.external, e) && ownerOf(value.canonical)) matches.push({ ref: s.ref, value, revision: got.revision });
      } catch (error) {
        // Revoked between lookup and resolve: no longer a link.
        if ((error as { reason?: string }).reason !== "resolver.revoked") throw error;
      }
    }
    if (!matches.length) return { status: "unresolved" as const };
    if (matches.length > 1) return { status: "ambiguous" as const, refs: matches.map((m) => m.ref) };
    const [m] = matches;
    return { status: "resolved" as const, canonical: m!.value.canonical, owner: ownerOf(m!.value.canonical)!, ref: m!.ref, revision: m!.revision, verifiedAt: m!.value.verification.verifiedAt };
  });
}

/**
 * Record a verified link. Named by the challenge that proved it, so a retried transaction writes the
 * same reference (and finds it already there) instead of a second, ambiguous one.
 */
export async function linkExternal(e: External, owner: string, challengeId: string, at: number): Promise<{ ref: string; revision: number }> {
  const ref = `${await prefixOf(e)}${challengeId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60)}`;
  const value: LinkValue = { canonical: canonicalOf(owner), external: { ...e }, verification: { method: "personalos.link-code/dm", challengeId, verifiedAt: new Date(at).toISOString() }, linkedAt: new Date(at).toISOString() };
  return withResolver(async (r) => {
    try {
      const w = await r.put({ ref, kind: "value", schema: LINK_SCHEMA as any, binding: { value: value as any }, expectedRevision: 0, ttlSeconds: 0, lookup: await lookupEntry(e), reason: `linked by ${canonicalOf(owner)} (challenge ${challengeId})` } as any);
      return { ref: w.ref, revision: w.revision };
    } catch (error) {
      if ((error as { code?: string }).code !== "CONFLICT") throw error;
      // Written by an earlier attempt of this same transaction: accept it only if it is exactly this link.
      const got = await r.resolve(ref);
      const v = got.selected.value as unknown as LinkValue;
      if (v.canonical !== value.canonical || !same(v.external, e)) fail("CONFLICT", "A different link already holds this name.");
      return { ref, revision: got.revision };
    }
  });
}

/** Revoke a link in Resolver. Every later resolution fails, pinned or not. Already revoked is fine. */
export async function revokeLink(ref: string, reason: string): Promise<void> {
  await withResolver(async (r) => {
    try {
      const { revision } = await r.resolve(ref);
      await r.revoke(ref, revision, reason);
    } catch (error) {
      if ((error as { reason?: string }).reason !== "resolver.revoked") throw error;
    }
  });
}

/** Whether a link reference still resolves to `owner` (for work that continues after the request: status, reminders). */
export async function linkActive(ref: string, owner: string): Promise<boolean> {
  return withResolver(async (r) => {
    try {
      const got = await r.resolve(ref);
      return (got.selected.value as unknown as LinkValue).canonical === canonicalOf(owner);
    } catch (error) {
      const reason = (error as { reason?: string }).reason;
      if (reason === "resolver.revoked" || reason === "resolver.not-found") return false;
      throw error;
    }
  });
}
