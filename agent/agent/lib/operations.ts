import { createHash, randomUUID } from "node:crypto";

import { canonicalize } from "@appport/protocol";
import type { CapabilityManifestEntry } from "@appport/protocol";

import {
  contractPin,
  loadManifest,
  resolveCapability,
  sendRequest,
  type Resolution,
  verifyContract,
  type Caller,
  type ContractPin,
  type ContractVerdict,
  type InvocationResult,
} from "./appport";
import type { AppPortManifest } from "@appport/protocol";
import { decide, type BusinessCheck, type DestinationStatus } from "./reconcile";
import { fault } from "./faults";
import {
  AGENT_ID,
  CALLS,
  OPERATIONS,
  callLinkId,
  readCallLink,
  workStore,
  type ObservedCall,
  type Outcome,
} from "./work";

const PROCESS_ID = randomUUID();
const OPERATION_KEY = /^[A-Za-z0-9._-]{1,64}$/u;
const NOT_EXECUTED = new Set([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "INVALID_INPUT",
  "INVALID_REQUEST",
  "NOT_FOUND",
  "UNKNOWN_CAPABILITY",
  "UNSUPPORTED_CAPABILITY_VERSION",
]);
const inFlight = new Map<string, Promise<OperationRecord>>();

export type OperationState = "prepared" | "executing" | "succeeded" | "failed" | "indeterminate";
export type RetrySafety = "idempotency-key" | "observation" | "none";

export interface OperationRecord {
  readonly __version?: number;
  readonly agent: string;
  readonly attempts: number;
  readonly capability: string;
  readonly capability_version: number;
  readonly created_at: string;
  readonly executor: string | null;
  readonly idempotency_key: string | null;
  readonly input_digest: string;
  readonly operation_id: string;
  readonly operation_key: string | null;
  readonly outcome: {
    readonly error: {
      readonly code: string;
      readonly message: string;
      readonly reason: string | null;
    } | null;
    readonly ok: boolean;
    readonly output: unknown;
    readonly output_digest: string | null;
    readonly reconciled_after_interruption: boolean;
    readonly request_id: string;
  } | null;
  readonly request_ids: readonly string[];
  readonly requester: string;
  readonly reconciliations?: readonly {
    readonly at: string;
    readonly finding: string;
    readonly reader: string;
    readonly reason: string | null;
    readonly request_id: string | null;
  }[];
  readonly resolution: string | null;
  /** The capability contract this operation was prepared against (AppPort `capabilityDigest`), never replaced. */
  readonly contract?: ContractPin;
  /** The implementation it was prepared against (Resolver reference, revision, origin), never replaced: every attempt goes there. */
  readonly implementation?: Resolution;
  /** The capability's declared effect when the operation was prepared. */
  readonly effect?: string | null;
  /** Each time the contract served before a dispatch differed from the pinned one, and what was decided. */
  readonly contract_checks?: readonly {
    readonly at: string;
    readonly verdict: ContractVerdict["kind"];
    readonly digest: string | null;
    readonly detail: readonly string[];
  }[];
  readonly retry_safety: RetrySafety;
  readonly settlement?: Settlement;
  readonly state: OperationState;
  readonly updated_at: string;
  readonly work_id: string;
}

export interface Settlement {
  readonly at: string;
  readonly evidence: string;
  readonly operator: string;
  readonly outcome: "succeeded" | "failed";
  readonly prior_state: "indeterminate";
  readonly reason: string;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function digestOf(capability: string, version: number, input: unknown): string {
  return `sha256:${digest(canonicalize({ capability, input, version }))}`;
}

export function inputDigest(entry: CapabilityManifestEntry, input: unknown): string {
  return digestOf(entry.name, entry.latestVersion, input);
}

export function operationIdFor(
  workId: string,
  capability: string,
  operationKey: string | undefined,
  fingerprint: string,
): string {
  const identity = operationKey === undefined ? `input:${fingerprint}` : `key:${operationKey}`;
  return `op_${digest(`${workId}\n${capability}\n${identity}`).slice(0, 40)}`;
}

function retrySafetyOf(entry: CapabilityManifestEntry): RetrySafety {
  if (entry.idempotency === "supported") return "idempotency-key";
  if (entry.effect === "observation") return "observation";
  return "none";
}

export async function readOperation(operationId: string): Promise<OperationRecord | null> {
  const { db } = await workStore();
  const record = await db.collection<OperationRecord>(OPERATIONS).get(operationId);
  return record;
}

async function transition(
  current: OperationRecord,
  changes: Partial<OperationRecord>,
): Promise<OperationRecord> {
  const { db } = await workStore();
  const result = await db
    .collection<OperationRecord>(OPERATIONS)
    .updateIfVersion(current.operation_id, current.__version ?? 0, {
      ...changes,
      updated_at: new Date().toISOString(),
    });
  if (!result.updated || result.item === undefined) {
    throw new Error(`Operation ${current.operation_id} changed underneath this attempt.`);
  }
  return result.item;
}

export interface OperationRequest {
  readonly callId: string;
  readonly caller: Caller;
  readonly entry: CapabilityManifestEntry;
  readonly input: unknown;
  /** The manifest the entry was resolved from: what the contract is pinned to, and verified against. */
  readonly manifest: AppPortManifest;
  readonly objective: string;
  readonly operationKey: string | undefined;
  /** The work was submitted read-only (its durable submission): only observation capabilities may run. */
  readonly readOnly: boolean;
  readonly workId: string;
  /** The resolution the entry and manifest came from: where a new operation is prepared. */
  readonly resolution: Resolution;
}

export type OperationResult =
  | { readonly kind: "conflict"; readonly operationId: string; readonly message: string }
  | { readonly kind: "refused"; readonly code: string; readonly message: string }
  | { readonly kind: "recorded"; readonly invoked: boolean; readonly operation: OperationRecord };

export async function runOperation(request: OperationRequest): Promise<OperationResult> {
  const { db } = await workStore();
  if (request.operationKey !== undefined && !OPERATION_KEY.test(request.operationKey)) {
    await linkCall(request.workId, request.callId, null, "INVALID_OPERATION_KEY");
    return {
      kind: "conflict",
      message: "operationKey must be 1-64 characters of [A-Za-z0-9._-].",
      operationId: "",
    };
  }
  // Read-only work runs observations only: an effect that is anything else, or undeclared, is refused
  // before any operation is recorded or sent. The flag is the work's own durable submission.
  if (request.readOnly && request.entry.effect !== "observation") {
    const message = `This work was submitted read-only; ${request.entry.name} declares effect ${request.entry.effect ?? "(none)"}, not observation.`;
    await linkCall(request.workId, request.callId, null, "READ_ONLY_WORK", {
      capability: request.entry.name,
      effect: request.entry.effect ?? null,
      message,
    });
    return { code: "READ_ONLY_WORK", kind: "refused", message };
  }
  const pin = contractPin(request.manifest, request.entry.name, request.entry.latestVersion);
  const fingerprint = inputDigest(request.entry, request.input);
  const operationId = operationIdFor(
    request.workId,
    request.entry.name,
    request.operationKey,
    fingerprint,
  );

  const operations = db.collection<OperationRecord>(OPERATIONS);
  if ((await operations.get(operationId)) === null) {
    if (pin === null) {
      const message = `The contract of ${request.entry.name}@${request.entry.latestVersion} could not be established; nothing is prepared against an unknown contract.`;
      await linkCall(request.workId, request.callId, null, "CONTRACT_UNAVAILABLE", {
        capability: request.entry.name,
        message,
      });
      return { code: "CONTRACT_UNAVAILABLE", kind: "refused", message };
    }
    const now = new Date().toISOString();
    const safety = retrySafetyOf(request.entry);
    try {
      await operations.insert(
        {
          agent: AGENT_ID,
          attempts: 0,
          capability: request.entry.name,
          capability_version: request.entry.latestVersion,
          contract: pin,
          contract_checks: [],
          created_at: now,
          effect: request.entry.effect ?? null,
          executor: null,
          implementation: request.resolution,
          idempotency_key: safety === "idempotency-key" ? operationId : null,
          input_digest: fingerprint,
          operation_id: operationId,
          operation_key: request.operationKey ?? null,
          outcome: null,
          request_ids: [],
          requester: request.caller.principalId,
          resolution: null,
          retry_safety: safety,
          state: "prepared",
          updated_at: now,
          work_id: request.workId,
        },
        operationId,
        { requireAbsent: true },
      );
    } catch (error) {
      if ((await operations.get(operationId)) === null) throw error;
    }
  }
  const existing = await operations.get(operationId);
  if (existing === null) throw new Error(`Operation ${operationId} was not recorded.`);
  if (existing.capability !== request.entry.name || existing.input_digest !== fingerprint) {
    await linkCall(request.workId, request.callId, null, "OPERATION_CONFLICT");
    return {
      kind: "conflict",
      message: `Operation ${operationId} was recorded for ${existing.capability} with different input; it is never overwritten.`,
      operationId,
    };
  }

  await linkCall(request.workId, request.callId, operationId);
  const running = inFlight.get(operationId);
  if (running !== undefined) return { invoked: false, kind: "recorded", operation: await running };
  const attempt = attempt_(existing, request);
  inFlight.set(
    operationId,
    attempt.then((result) => result.operation),
  );
  try {
    return await attempt;
  } finally {
    inFlight.delete(operationId);
  }
}

async function attempt_(
  existing: OperationRecord,
  request: OperationRequest,
): Promise<{ kind: "recorded"; invoked: boolean; operation: OperationRecord }> {
  let current = existing;
  const settled = { invoked: false, kind: "recorded" as const };
  if (current.state === "succeeded" || current.state === "failed") {
    return { ...settled, operation: current };
  }
  if (current.state === "indeterminate") {
    return { ...settled, operation: await reconcileOperation(current) };
  }
  const reconciling = current.state === "executing";
  if (reconciling && reconcilerFor(current.capability) !== undefined) {
    return { ...settled, operation: await reconcileOperation(current) };
  }
  if (reconciling && current.retry_safety === "none") {
    return {
      ...settled,
      operation: await transition(current, {
        executor: null,
        resolution:
          "The attempt that started this operation stopped before its outcome was recorded, and the capability offers no idempotency key. It is not retried automatically; a person must establish whether it took effect.",
        state: "indeterminate",
      }),
    };
  }

  // The contract is verified before every dispatch, the first and any retry or recovery alike.
  // Against the implementation the operation was prepared against, whatever resolves now.
  const at = current.implementation ?? request.resolution;
  let served: AppPortManifest | null = request.manifest;
  if (at.endpoint !== request.resolution.endpoint)
    served = await loadManifest(request.caller, at).catch(() => null);
  const verdict: ContractVerdict = !current.contract
    ? { kind: "unavailable", reason: "the operation has no pinned contract" }
    : served === null
      ? {
          kind: "unavailable",
          reason: `${at.origin ?? at.endpoint}, where it was prepared, cannot be reached`,
        }
      : verifyContract(current.contract, served);
  if (verdict.kind !== "same") {
    const check = {
      at: new Date().toISOString(),
      detail: verdict.kind === "unavailable" ? [verdict.reason] : verdict.changes,
      digest: verdict.kind === "unavailable" ? null : verdict.digest,
      verdict: verdict.kind,
    };
    const checks = [...(current.contract_checks ?? []), check].slice(-20);
    if (verdict.kind === "compatible") {
      current = await transition(current, { contract_checks: checks });
    } else {
      const code = verdict.kind === "unavailable" ? "CONTRACT_UNAVAILABLE" : "CONTRACT_CHANGED";
      const why = `${current.capability}@${current.capability_version} ${verdict.kind === "unavailable" ? "cannot be verified" : "changed incompatibly"} since this operation was prepared (${check.detail.join("; ").slice(0, 400)}).`;
      // Never sent: it did not run, and is refused. Sent before (its outcome unknown): it is not sent again.
      const neverSent = current.request_ids.length === 0 && current.state === "prepared";
      const refusal = neverSent
        ? {
            outcome: {
              error: { code, message: why, reason: null },
              ok: false,
              output: null,
              output_digest: null,
              reconciled_after_interruption: false,
              request_id: "",
            },
            resolution: `Not sent: ${why}`,
            state: "failed" as const,
          }
        : {
            resolution: `Not sent again: ${why} Whether the earlier attempt took effect is not established.`,
            state: "indeterminate" as const,
          };
      return {
        ...settled,
        operation: await transition(current, {
          ...refusal,
          contract_checks: checks,
          executor: null,
        }),
      };
    }
  }

  await fault("operation.prepared", { objective: request.objective, workId: request.workId });
  current = await transition(current, {
    attempts: current.attempts + 1,
    executor: PROCESS_ID,
    state: "executing",
  });

  const result: InvocationResult = await sendRequest(
    request.caller,
    current.contract?.entry ?? request.entry,
    request.input,
    request.workId,
    current.idempotency_key ?? undefined,
    current.capability_version,
    at,
  );
  await fault("invocation.record", { objective: request.objective, workId: request.workId });

  const requestIds = [...current.request_ids, result.requestId];
  const outcome = {
    error: result.ok
      ? null
      : {
          code: result.error.code,
          message: result.error.message,
          reason: idempotencyReason(result) ?? null,
        },
    ok: result.ok,
    output: result.ok ? result.output : null,
    output_digest: result.ok ? `sha256:${digest(canonicalize(result.output ?? null))}` : null,
    reconciled_after_interruption: reconciling,
    request_id: result.requestId,
  };
  if (result.ok) {
    return {
      ...settled,
      invoked: true,
      operation: await transition(current, {
        executor: null,
        outcome,
        request_ids: requestIds,
        state: "succeeded",
      }),
    };
  }
  if (
    NOT_EXECUTED.has(result.error.code) ||
    idempotencyReason(result) === "IDEMPOTENCY_KEY_REUSED"
  ) {
    return {
      ...settled,
      invoked: true,
      operation: await transition(current, {
        executor: null,
        outcome,
        request_ids: requestIds,
        state: "failed",
      }),
    };
  }
  if (result.error.code === "UNAVAILABLE" && current.retry_safety !== "none") {
    return {
      ...settled,
      invoked: true,
      operation: await transition(current, {
        executor: null,
        outcome,
        request_ids: requestIds,
        resolution:
          "AppPort did not answer; a later attempt reconciles it with the same idempotency key or a repeated read.",
      }),
    };
  }
  return {
    ...settled,
    invoked: true,
    operation: await transition(current, {
      executor: null,
      outcome,
      request_ids: requestIds,
      resolution: `AppPort answered ${result.error.code}; whether the capability took effect is not established. It is not retried automatically.`,
      state: "indeterminate",
    }),
  };
}

function idempotencyReason(result: InvocationResult): string | undefined {
  if (result.ok) return undefined;
  const details = result.error.details as { reason?: unknown } | undefined;
  return typeof details?.reason === "string" ? details.reason : undefined;
}

export async function settleAbandoned(operationId: string): Promise<OperationRecord | null> {
  const current = await readOperation(operationId);
  if (current === null) return current;
  if (reconcilerFor(current.capability) !== undefined) return await reconcileOperation(current);
  if (current.state !== "executing" || current.retry_safety !== "none") return current;
  if (current.executor === PROCESS_ID || inFlight.has(operationId)) return current;
  return await transition(current, {
    executor: null,
    resolution:
      "The attempt that started this operation stopped before its outcome was recorded, and the capability offers no idempotency key. It is not retried automatically; a person must establish whether it took effect.",
    state: "indeterminate",
  });
}

function reconcilerFor(capability: string): string | undefined {
  for (const pair of (process.env.APPPORT_AGENT_RECONCILERS ?? "").split(",")) {
    const [target, reader] = pair.split("=").map((part) => part.trim());
    if (target === capability && reader) return reader;
  }
  return undefined;
}

function parseStatus(value: unknown, current: OperationRecord): DestinationStatus {
  const status = value as Record<string, unknown> | null | undefined;
  if (status?.kind === "committed") {
    const operation = status.operation as { key?: unknown; input?: unknown } | undefined;
    if (typeof operation?.key !== "string")
      return { kind: "unknown", reason: "the destination named no operation key" };
    return {
      kind: "committed",
      operation: {
        binding: digestOf(current.capability, current.capability_version, operation.input),
        key: operation.key,
      },
      receipt: typeof status.receipt === "string" ? status.receipt : null,
      reported: status.reported ?? null,
    };
  }
  if (status?.kind === "not_applied")
    return {
      barred: status.barred === true,
      basis: String(status.basis ?? ""),
      kind: "not_applied",
    };
  return {
    kind: "unknown",
    reason: `unrecognised destination status: ${JSON.stringify(value) ?? "none"}`,
  };
}

function parseCheck(value: unknown): BusinessCheck | undefined {
  const check = value as Record<string, unknown> | null | undefined;
  if (check?.kind === "present") return { evidence: String(check.evidence ?? ""), kind: "present" };
  if (check?.kind === "absent") return { evidence: String(check.evidence ?? ""), kind: "absent" };
  if (check?.kind === "unavailable")
    return { kind: "unavailable", reason: String(check.reason ?? "") };
  return undefined;
}

export async function reconcileOperation(current: OperationRecord): Promise<OperationRecord> {
  const reader = reconcilerFor(current.capability);
  const key = current.idempotency_key;
  const stale =
    current.state === "executing" &&
    current.executor !== PROCESS_ID &&
    !inFlight.has(current.operation_id);
  if (reader === undefined || key === null || !(stale || current.state === "indeterminate"))
    return current;

  const caller = { principalId: current.requester };
  let status: DestinationStatus;
  let check: BusinessCheck | undefined;
  let requestId: string | null = null;
  // Read where the operation was sent, never where the dependency resolves now.
  const resolved = await resolveCapability(caller, reader, current.implementation);
  if (!resolved.ok || resolved.entry.effect !== "observation") {
    status = {
      kind: "unknown",
      reason: resolved.ok
        ? `${reader} is not an exposed read-only capability`
        : `${reader}: ${resolved.result.ok ? "" : resolved.result.error.code}`,
    };
  } else {
    const answer = await sendRequest(
      caller,
      resolved.entry,
      { key },
      current.work_id,
      undefined,
      resolved.entry.latestVersion,
      resolved.resolution,
    );
    requestId = answer.requestId;
    if (!answer.ok) {
      status = { kind: "unknown", reason: `${reader} answered ${answer.error.code}` };
    } else {
      const output = answer.output as { status?: unknown; business?: unknown } | null;
      status = parseStatus(output?.status, current);
      check = parseCheck(output?.business);
    }
  }
  const finding = decide({ binding: current.input_digest, key }, status, check);
  const reconciliations = [
    ...(current.reconciliations ?? []),
    {
      at: new Date().toISOString(),
      finding: finding.kind,
      reader,
      reason: finding.kind === "indeterminate" ? finding.reason : null,
      request_id: requestId,
    },
  ];
  if (finding.kind === "completed") {
    return await transition(current, {
      executor: null,
      outcome: {
        error: null,
        ok: true,
        output: finding.reported,
        output_digest: `sha256:${digest(canonicalize(finding.reported ?? null))}`,
        reconciled_after_interruption: true,
        request_id: requestId ?? "",
      },
      reconciliations,
      resolution: `Established by ${reader}: the destination committed this operation (receipt ${finding.receipt ?? "none"}) and its effect is present.`,
      state: "succeeded",
    });
  }
  if (finding.kind === "not_executed") {
    return await transition(current, {
      executor: null,
      outcome: {
        error: { code: "NOT_EXECUTED", message: finding.basis, reason: null },
        ok: false,
        output: null,
        output_digest: null,
        reconciled_after_interruption: true,
        request_id: requestId ?? "",
      },
      reconciliations,
      resolution: `Established by ${reader}: not executed and barred (${finding.basis}).`,
      state: "failed",
    });
  }
  return await transition(current, {
    executor: null,
    reconciliations,
    resolution: `Not established by ${reader}: ${finding.reason}. It is not retried automatically.`,
    state: "indeterminate",
  });
}

const MAX_REASON = 1000;
const MAX_EVIDENCE = 512;
const SETTLEMENT_FIELDS = new Set(["evidence", "outcome", "reason"]);

export type SettlementResult =
  | { readonly kind: "settled"; readonly operation: OperationRecord }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "not_found" }
  | { readonly kind: "refused"; readonly operation: OperationRecord; readonly message: string };

function oneLine(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text.length === 0 || text.length > max || /\p{Cc}/u.test(text)) return null;
  return text;
}

export async function settleOperation(
  operationId: string,
  operator: string,
  request: unknown,
): Promise<SettlementResult> {
  const body = request as Record<string, unknown> | null;
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return { kind: "invalid", message: "The settlement must be a JSON object." };
  const unknown = Object.keys(body).filter((field) => !SETTLEMENT_FIELDS.has(field));
  if (unknown.length > 0)
    return { kind: "invalid", message: `Unknown settlement fields: ${unknown.join(", ")}.` };
  const outcome = body.outcome;
  if (outcome !== "succeeded" && outcome !== "failed")
    return { kind: "invalid", message: 'outcome must be "succeeded" or "failed".' };
  const reason = oneLine(body.reason, MAX_REASON);
  if (reason === null)
    return {
      kind: "invalid",
      message: `reason must be 1 to ${MAX_REASON} characters on one line.`,
    };
  const evidence = oneLine(body.evidence, MAX_EVIDENCE);
  if (evidence === null)
    return {
      kind: "invalid",
      message: `evidence must be 1 to ${MAX_EVIDENCE} characters on one line, referencing what the conclusion rests on.`,
    };

  const current = await readOperation(operationId);
  if (current === null) return { kind: "not_found" };
  if (current.settlement !== undefined)
    return {
      kind: "refused",
      message: `Operation ${operationId} was already settled as ${current.settlement.outcome} by ${current.settlement.operator}; a settlement is written once.`,
      operation: current,
    };
  if (current.state !== "indeterminate")
    return {
      kind: "refused",
      message: `Operation ${operationId} is ${current.state}; only an indeterminate operation can be settled.`,
      operation: current,
    };
  const settlement: Settlement = {
    at: new Date().toISOString(),
    evidence,
    operator,
    outcome,
    prior_state: "indeterminate",
    reason,
  };
  try {
    return {
      kind: "settled",
      operation: await transition(current, { settlement, state: outcome }),
    };
  } catch (error) {
    const now = await readOperation(operationId);
    if (now === null || now.__version === current.__version) throw error;
    return {
      kind: "refused",
      message: `Operation ${operationId} changed while it was being settled; it is now ${now.state}.`,
      operation: now,
    };
  }
}

async function linkCall(
  workId: string,
  callId: string,
  operationId: string | null,
  refusal?: string,
  detail?: Record<string, unknown>,
) {
  const { db } = await workStore();
  const calls = db.collection<Record<string, unknown>>(CALLS);
  const id = callLinkId(workId, callId);
  if ((await calls.get(id)) !== null) return;
  await calls.insert(
    {
      call_id: callId,
      operation_id: operationId,
      recorded_at: new Date().toISOString(),
      refusal: refusal ?? null,
      detail: detail ?? null,
      work_id: workId,
    },
    id,
    { requireAbsent: true },
  );
}

export async function recordRefusedCall(workId: string, callId: string, code: string) {
  await linkCall(workId, callId, null, code);
}

export async function decideOutcome(
  workId: string,
  turnOutcome: string,
  invokeCalls: readonly ObservedCall[],
  reply: string,
): Promise<Outcome> {
  const said = reply.length > 0 ? ` Agent reply: ${reply.slice(0, 2000)}` : "";
  const resolved = new Map<string, boolean>();
  const settledByOperator = new Set<string>();
  const unresolved = new Set<string>();
  let refused = 0;
  for (const call of invokeCalls) {
    const link = await readCallLink(workId, call.callId);
    if (link === null) {
      if (call.settled) unresolved.add(`call:${call.callId}`);
      continue;
    }
    if (link.operation_id === null) {
      refused += 1;
      continue;
    }
    const operation = await settleAbandoned(String(link.operation_id));
    if (operation?.settlement !== undefined && operation.work_id === workId)
      settledByOperator.add(operation.operation_id);
    if (operation === null || operation.work_id !== workId) unresolved.add(`call:${call.callId}`);
    else if (operation.state === "succeeded") resolved.set(operation.operation_id, true);
    else if (operation.state === "failed") resolved.set(operation.operation_id, false);
    else if (call.settled || operation.state === "indeterminate")
      unresolved.add(operation.operation_id);
  }
  for (const id of resolved.keys()) unresolved.delete(id);
  const evidence = [...resolved.keys()];
  const succeeded = [...resolved.values()].filter(Boolean).length;
  const attested =
    settledByOperator.size > 0 ? `; ${settledByOperator.size} settled by an operator` : "";
  if (turnOutcome !== "completed") {
    return {
      decision: `failed: the eve turn ended ${turnOutcome}`,
      evidence,
      status: "blocked",
      summary: `Failed: the eve turn ended ${turnOutcome}.`,
    };
  }
  if (unresolved.size > 0) {
    return {
      decision: `indeterminate: ${unresolved.size} AppPort operation(s) without an established outcome: ${[...unresolved].join(", ")}`,
      evidence,
      status: "blocked",
      summary: `Indeterminate: ${unresolved.size} AppPort operation(s) have no established outcome and are not retried automatically.`,
    };
  }
  if (resolved.size + refused > 0 && succeeded === 0) {
    return {
      decision: `waiting: every AppPort invocation was rejected${attested}`,
      evidence,
      status: "blocked",
      summary: `Blocked: no capability invocation was authorized.${said}`,
    };
  }
  return {
    decision: `completed after ${succeeded} authorized invocation(s)${attested}`,
    evidence,
    status: "completed",
    summary: `Completed after ${succeeded} authorized invocation(s).${said}`,
  };
}
