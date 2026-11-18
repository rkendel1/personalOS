import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { createClient } from "@appport/client";
import {
  canonicalize,
  capabilityDigest,
  compareManifests,
  getIntegration,
} from "@appport/protocol";
import type {
  AppPortManifest,
  AppRequest,
  AppResponse,
  CapabilityManifestEntry,
} from "@appport/protocol";
import { createHttpTransport } from "@appport/transport-http";

export interface Caller {
  readonly principalId: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is not set.`);
  return value;
}

function agentCredential(): string {
  return readFileSync(requireEnv("APPPORT_AGENT_CREDENTIAL_FILE"), "utf8").trim();
}

function onBehalfOf(caller: Caller): string {
  if (process.env.APPPORT_ON_BEHALF_OF !== "subject") return caller.principalId;
  const prefix = `${process.env.AGENT_JWT_ISSUER ?? "appport-agent-operator"}:`;
  if (!caller.principalId.startsWith(prefix))
    throw new Error(
      `${caller.principalId} was not issued by ${prefix.slice(0, -1)}; it names no person here.`,
    );
  return caller.principalId.slice(prefix.length);
}

/**
 * Which implementation satisfies this agent's AppPort dependency. With `APPPORT_AGENT_DEPENDENCY` (a
 * Resolver `agent` reference), Resolver says, and its binding pins the contract (`name@version` →
 * `capabilityDigest`) that Resolver verified the origin serves before storing it. Without it, the static
 * `APPPORT_URL`, unverified, as before. An operation records the resolution it was prepared against
 * and is only ever sent there.
 */
export interface Resolution {
  readonly endpoint: string;
  readonly ref: string | null;
  readonly revision: number | null;
  readonly origin: string | null;
  readonly application: string | null;
  readonly pinned: Readonly<Record<string, string>>;
}

export class DependencyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function resolverClient() {
  return createClient({
    transport: createHttpTransport({
      headers: { authorization: `Bearer ${requireEnv("RESOLVER_API_KEY")}` },
      url: new URL("/appport", requireEnv("RESOLVER_URL")).href,
    }),
  });
}

/** The current resolution. A dependency that cannot be resolved fails closed: there is no fallback. */
export async function currentResolution(): Promise<Resolution> {
  const ref = process.env.APPPORT_AGENT_DEPENDENCY;
  if (!ref) {
    return {
      application: null,
      endpoint: requireEnv("APPPORT_URL"),
      origin: null,
      pinned: {},
      ref: null,
      revision: null,
    };
  }
  let response: AppResponse;
  try {
    response = await resolverClient().send({
      capability: { name: "resolver.resolve", version: 1 },
      input: { ref },
      protocol: "appport/1",
      requestId: `eve_${randomUUID()}`,
      type: "request",
    });
  } catch (error) {
    throw new DependencyError(
      "DEPENDENCY_UNRESOLVED",
      `Resolver could not be reached for ${ref}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (response.type !== "response" || !response.ok)
    throw new DependencyError(
      "DEPENDENCY_UNRESOLVED",
      `Resolver did not resolve ${ref}${response.type === "response" && !response.ok ? ` (${response.error.code}: ${response.error.message})` : ""}.`,
    );
  const output = response.output as {
    revision?: number;
    selected?: {
      value?: { origin?: string; application?: string; capabilities?: Record<string, string> };
    };
  };
  const target = output.selected?.value;
  if (typeof target?.origin !== "string")
    throw new DependencyError("DEPENDENCY_UNRESOLVED", `${ref} is not an AppPort agent reference.`);
  let endpoint: string;
  try {
    const discovery = await fetch(new URL("/.well-known/appport", target.origin), {
      signal: AbortSignal.timeout(5000),
    });
    const document = (await discovery.json()) as { endpoint?: string };
    endpoint = new URL(document.endpoint ?? "/appport", target.origin).href;
  } catch (error) {
    throw new DependencyError(
      "DEPENDENCY_UNAVAILABLE",
      `${target.origin} (${ref} at revision ${output.revision}) could not be discovered: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    application: target.application ?? null,
    endpoint,
    origin: target.origin,
    pinned: { ...target.capabilities },
    ref,
    revision: typeof output.revision === "number" ? output.revision : null,
  };
}

function clientFor(caller: Caller, endpoint: string) {
  return createClient({
    transport: createHttpTransport({
      headers: {
        authorization: `Bearer ${agentCredential()}`,
        "x-appport-on-behalf-of": onBehalfOf(caller),
      },
      url: endpoint,
    }),
  });
}

/** The manifest served at one resolution's endpoint. */
export async function loadManifest(
  caller: Caller,
  resolution: Resolution,
): Promise<AppPortManifest> {
  return (await clientFor(caller, resolution.endpoint).load()) as AppPortManifest;
}

function allowedCapabilities(): ReadonlySet<string> {
  return new Set(
    (process.env.APPPORT_AGENT_CAPABILITIES ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

export interface CapabilitySummary {
  readonly authorization: readonly string[];
  readonly idempotency: string;
  readonly description?: string;
  readonly effect?: string;
  readonly invocable: boolean;
  readonly name: string;
  readonly version: number;
}

export async function listCapabilities(caller: Caller): Promise<CapabilitySummary[]> {
  const manifest = await loadManifest(caller, await currentResolution());
  const allowed = allowedCapabilities();
  return manifest.capabilities
    .filter((entry) => !entry.name.startsWith("appport."))
    .map((entry) => ({
      authorization: entry.authorization,
      description: entry.description,
      effect: entry.effect,
      idempotency: entry.idempotency ?? "unsupported",
      invocable: allowed.has(entry.name),
      name: entry.name,
      version: entry.latestVersion,
    }));
}

export async function readContract(caller: Caller, name: string) {
  const manifest = await loadManifest(caller, await currentResolution());
  const entry = manifest.capabilities.find((candidate) => candidate.name === name);
  if (entry === undefined) return { found: false as const, name };
  return {
    authorization: entry.authorization,
    description: entry.description,
    effect: entry.effect,
    found: true as const,
    inputSchema: entry.inputSchema,
    name: entry.name,
    outputSchema: entry.outputSchema,
    version: entry.latestVersion,
  };
}

export type InvocationResult =
  | {
      readonly authorizationDecision?: unknown;
      readonly ok: true;
      readonly output: unknown;
      readonly requestId: string;
    }
  | {
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details?: unknown;
      };
      readonly ok: false;
      readonly requestId: string;
    };

export type ResolvedCapability =
  | {
      readonly ok: true;
      readonly entry: CapabilityManifestEntry;
      readonly manifest: AppPortManifest;
      readonly resolution: Resolution;
    }
  | { readonly ok: false; readonly result: InvocationResult };

/**
 * One capability version's contract as AppPort defines it: `capabilityDigest` (its definition and its
 * integration declaration, independent of every other capability), with the entry and declaration it
 * was computed from, so a later contract can be compared with AppPort's own rules.
 */
export interface ContractPin {
  readonly digest: string;
  readonly version: number;
  readonly entry: CapabilityManifestEntry;
  readonly integration: unknown;
}

export function contractPin(
  manifest: AppPortManifest,
  name: string,
  version: number,
): ContractPin | null {
  const digest = capabilityDigest(manifest, name, version);
  const entry = manifest.capabilities.find((candidate) => candidate.name === name);
  if (digest === undefined || entry === undefined) return null;
  const integration = getIntegration(manifest)?.capabilities[`${name}@${version}`] ?? null;
  return {
    digest,
    entry: JSON.parse(JSON.stringify(entry)) as CapabilityManifestEntry,
    integration,
    version,
  };
}

export type ContractVerdict =
  | { readonly kind: "same" }
  | { readonly kind: "compatible"; readonly changes: readonly string[]; readonly digest: string }
  | { readonly kind: "breaking"; readonly changes: readonly string[]; readonly digest: string }
  | { readonly kind: "unavailable"; readonly reason: string };

/**
 * The capability contract an operation was prepared against, compared with the one served now, by
 * AppPort's own compatibility rules (`compareManifests`, specification §43) applied to that capability
 * alone. A contract that cannot be found, or an integration declaration that changed (which those rules
 * do not compare here), is never taken as unchanged.
 */
export function verifyContract(pinned: ContractPin, manifest: AppPortManifest): ContractVerdict {
  const current = contractPin(manifest, pinned.entry.name, pinned.version);
  if (current === null)
    return {
      kind: "unavailable",
      reason: `${pinned.entry.name}@${pinned.version} is no longer in the manifest`,
    };
  if (current.digest === pinned.digest) return { kind: "same" };
  if (canonicalize(current.integration ?? null) !== canonicalize(pinned.integration ?? null))
    return {
      changes: ["integration declaration changed (compatibility not established)"],
      digest: current.digest,
      kind: "breaking",
    };
  const report = compareManifests(
    { ...manifest, capabilities: [pinned.entry] },
    { ...manifest, capabilities: [current.entry] },
  );
  const changes = [...report.breaking, ...report.nonBreaking].map(
    (change) => `${change.severity}: ${change.kind} ${change.target}`,
  );
  return { changes, digest: current.digest, kind: report.compatible ? "compatible" : "breaking" };
}

function refused(requestId: string, code: string, message: string): InvocationResult {
  return { error: { code, message }, ok: false, requestId };
}

function unavailable(requestId: string, error: unknown): InvocationResult {
  return refused(
    requestId,
    "UNAVAILABLE",
    `AppPort did not answer: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * The capability as the dependency serves it now (or, with `at`, as one recorded resolution serves it).
 * Through Resolver, it is used only if the served contract is exactly the one the binding pins: a
 * resolution is not proof of compatibility, and an origin that changed behind an unchanged binding is refused.
 */
export async function resolveCapability(
  caller: Caller,
  name: string,
  at?: Resolution,
): Promise<ResolvedCapability> {
  const requestId = `eve_${randomUUID()}`;
  let entry;
  let manifest;
  let resolution: Resolution;
  try {
    resolution = at ?? (await currentResolution());
  } catch (error) {
    if (error instanceof DependencyError)
      return { ok: false, result: refused(requestId, error.code, error.message) };
    throw error;
  }
  try {
    manifest = await loadManifest(caller, resolution);
    entry = manifest.capabilities.find((candidate) => candidate.name === name);
  } catch (error) {
    return { ok: false, result: unavailable(requestId, error) };
  }
  if (entry === undefined || !allowedCapabilities().has(name)) {
    return {
      ok: false,
      result: refused(
        requestId,
        "NOT_EXPOSED",
        `This agent may only invoke capabilities its operator allows; ${name} is not one of them.`,
      ),
    };
  }
  if (resolution.ref !== null) {
    if (resolution.application !== null && manifest.application.id !== resolution.application)
      return {
        ok: false,
        result: refused(
          requestId,
          "DEPENDENCY_MISMATCH",
          `${resolution.origin} serves ${manifest.application.id}, not ${resolution.application} (${resolution.ref} at revision ${resolution.revision}).`,
        ),
      };
    const reference = `${name}@${entry.latestVersion}`;
    const pinned = resolution.pinned[reference];
    const served = capabilityDigest(manifest, name, entry.latestVersion);
    if (pinned === undefined)
      return {
        ok: false,
        result: refused(
          requestId,
          "CONTRACT_NOT_PINNED",
          `${resolution.ref} at revision ${resolution.revision} pins no contract for ${reference}; it is not used unverified.`,
        ),
      };
    if (served !== pinned)
      return {
        ok: false,
        result: refused(
          requestId,
          "CONTRACT_MISMATCH",
          `${resolution.origin} serves ${reference} as ${served ?? "nothing"}, not the pinned ${pinned} (${resolution.ref} at revision ${resolution.revision}).`,
        ),
      };
  }
  return { entry, manifest, ok: true, resolution };
}

export async function sendRequest(
  caller: Caller,
  entry: CapabilityManifestEntry,
  input: unknown,
  traceId: string | undefined,
  idempotencyKey: string | undefined,
  version: number = entry.latestVersion,
  resolution?: Resolution,
): Promise<InvocationResult> {
  const requestId = `eve_${randomUUID()}`;
  const request: AppRequest = {
    capability: { name: entry.name, version },
    input,
    protocol: "appport/1",
    requestId,
    type: "request",
  };
  if (traceId !== undefined) request.traceId = traceId;
  if (idempotencyKey !== undefined) request.idempotencyKey = idempotencyKey;
  let response: AppResponse;
  try {
    response = await clientFor(caller, (resolution ?? (await currentResolution())).endpoint).send(
      request,
    );
  } catch (error) {
    if (error instanceof DependencyError) return refused(requestId, error.code, error.message);
    return unavailable(requestId, error);
  }
  if (response.type !== "response")
    return refused(requestId, "UNEXPECTED_RESPONSE", "AppPort returned a non-response envelope.");
  return response.ok
    ? {
        authorizationDecision: response.authorizationDecision,
        ok: true,
        output: response.output,
        requestId,
      }
    : { error: response.error, ok: false, requestId };
}

export async function invokeCapability(
  caller: Caller,
  name: string,
  input: unknown,
  traceId: string | undefined,
): Promise<InvocationResult> {
  const resolved = await resolveCapability(caller, name);
  if (!resolved.ok) return resolved.result;
  if (resolved.entry.effect !== "observation") {
    return refused(
      `eve_${randomUUID()}`,
      "NOT_EXPOSED",
      `${name} changes state; it is invoked only through a durable operation within accepted work.`,
    );
  }
  return await sendRequest(
    caller,
    resolved.entry,
    input,
    traceId,
    undefined,
    resolved.entry.latestVersion,
    resolved.resolution,
  );
}
