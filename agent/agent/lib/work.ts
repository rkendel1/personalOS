import { createHash } from "node:crypto";

import type { AuthResult } from "eve/channels/auth";
import {
  createFeltDB,
  openAgentState,
  type AgentCheckpoint,
  type AgentCheckpointInput,
  type AgentStateStore,
  type AgentTask,
} from "@feltdb/core";

export const AGENT_ID = "agent:appport-agent";
export const APPLICATION_SCOPE = "inventory";
export const SUBMISSIONS = "work_submissions";
export const SESSIONS = "work_sessions";
const MAX_HISTORY = 50;
const OPEN_ATTEMPTS = 50;
const OPEN_RETRY_MS = 200;
const WRITE_ATTEMPTS = 3;

type Database = ReturnType<typeof createFeltDB>;
let opened: Promise<{ db: Database; state: AgentStateStore }> | undefined;

async function openStore() {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const db = createFeltDB({
        namespace: "appport-agent-work",
        path: process.env.APPPORT_AGENT_WORK_DIR ?? ".appport-agent-work",
      });
      return { db, state: await openAgentState(db) };
    } catch (error) {
      const locked = (error as { code?: unknown }).code === "STATE_LOCKED";
      if (!locked || attempt === OPEN_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, OPEN_RETRY_MS));
    }
  }
}

export function workStore() {
  opened ??= openStore().catch((error: unknown) => {
    opened = undefined;
    throw error;
  });
  return opened;
}

export async function bindSession(sessionId: string, workId: string): Promise<void> {
  const { db } = await workStore();
  const sessions = db.collection<{ work_id: string }>(SESSIONS);
  const existing = await sessions.get(sessionId);
  if (existing !== null) {
    if (existing.work_id !== workId)
      throw new Error(`Session ${sessionId} already belongs to ${existing.work_id}.`);
    return;
  }
  await sessions.insert({ work_id: workId }, sessionId, { requireAbsent: true });
}

export async function workForSession(sessionId: string): Promise<string | null> {
  const { db } = await workStore();
  return (await db.collection<{ work_id: string }>(SESSIONS).get(sessionId))?.work_id ?? null;
}

export function workIdFor(requester: string, idempotencyKey: string): string {
  const digest = createHash("sha256").update(`${requester}\n${idempotencyKey}`).digest("hex");
  return `work_${digest.slice(0, 32)}`;
}

/** Where work submitted by the identity authority came from: what the surface delivered and how it was resolved. */
export type SurfaceProvenance = Readonly<Record<string, string | number | boolean | null>>;

export interface SubmissionRecord {
  readonly accepted_at: string;
  /** The identity authority that asserted who the requester is (its verified principal), if one did. */
  readonly asserted_by?: string | null;
  readonly auth: AuthResult;
  readonly objective: string;
  /** Submitted read-only by the requester: its operations may only observe. Fixed when accepted. */
  readonly read_only?: boolean;
  readonly requester: string;
  readonly surface?: SurfaceProvenance | null;
  readonly work_id: string;
}

export async function readSubmission(workId: string): Promise<SubmissionRecord | null> {
  const { db } = await workStore();
  return await db.collection<SubmissionRecord>(SUBMISSIONS).get(workId);
}

export type Acceptance =
  | { readonly outcome: "accepted" | "replayed"; readonly workId: string }
  | { readonly outcome: "conflict"; readonly workId: string };

export async function acceptWork(
  auth: AuthResult & { readonly principalId: string },
  idempotencyKey: string,
  objective: string,
  readOnly = false,
  assertion?: { readonly assertedBy: string; readonly surface: SurfaceProvenance },
): Promise<Acceptance> {
  const { db, state } = await workStore();
  const requester = auth.principalId;
  const workId = workIdFor(requester, idempotencyKey);
  let submission = await readSubmission(workId);
  if (submission === null) {
    try {
      await db.collection(SUBMISSIONS).insert(
        {
          accepted_at: new Date().toISOString(),
          asserted_by: assertion?.assertedBy ?? null,
          surface: assertion?.surface ?? null,
          auth,
          objective,
          read_only: readOnly,
          requester,
          work_id: workId,
        },
        workId,
        { requireAbsent: true },
      );
    } catch (error) {
      if ((await readSubmission(workId)) === null) throw error;
    }
    submission = await readSubmission(workId);
  }
  if (
    submission?.objective !== objective ||
    (submission.read_only === true) !== readOnly ||
    (submission.asserted_by ?? null) !== (assertion?.assertedBy ?? null)
  )
    return { outcome: "conflict", workId };
  if ((await state.getTask(workId)) !== null) return { outcome: "replayed", workId };
  try {
    await state.createTask({
      actor: AGENT_ID,
      objective,
      scope: { project: APPLICATION_SCOPE, workspace: requester },
      status: "ready",
      summary: `Accepted from ${requester}.`,
      taskId: workId,
    });
    return { outcome: "accepted", workId };
  } catch (error) {
    if ((await state.getTask(workId)) === null) throw error;
    return { outcome: "replayed", workId };
  }
}

async function history(state: AgentStateStore, task: AgentTask): Promise<AgentCheckpoint[]> {
  const entries: AgentCheckpoint[] = [];
  const first = Math.max(1, task.checkpoint_version - MAX_HISTORY + 1);
  for (let version = first; version <= task.checkpoint_version; version += 1) {
    const checkpoint = await state.getCheckpoint(task.task_id, version);
    if (checkpoint !== null) entries.push(checkpoint);
  }
  return entries;
}

export async function recordedSession(workId: string): Promise<string | null> {
  const { state } = await workStore();
  const current = await state.getTask(workId);
  if (current === null) return null;
  const entries = await history(state, current.task);
  return (
    [...entries].reverse().find((entry) => entry.execution?.conversation_id)?.execution
      ?.conversation_id ?? null
  );
}

export async function readWork(requester: string, workId: string) {
  const { db, state } = await workStore();
  const current = await state.getTask(workId);
  if (current === null || current.task.scope.workspace !== requester) return null;
  const entries = await history(state, current.task);
  const operations = [];
  for (const entry of current.checkpoint.evidence) {
    if (entry.kind !== "record" || entry.collection !== OPERATIONS) continue;
    const record = await readOperationRecord(entry.id);
    const outcome = record?.outcome as
      | { ok?: boolean; error?: { code?: string } | null; request_id?: string }
      | null
      | undefined;
    operations.push({
      capability: record?.capability ?? null,
      errorCode: outcome?.error?.code ?? null,
      ok: record?.state === "succeeded",
      operationId: entry.id,
      requestIds: record?.request_ids ?? [],
      settlement: record?.settlement ?? null,
      state: record?.state ?? null,
    });
  }
  // Every operation the work recorded (cited or not), with the contract it was pinned to and any drift,
  // and every call refused before an operation existed (read-only work, an unknown contract, …).
  const ledger = (await db.collection<Record<string, any>>(OPERATIONS).find({ work_id: workId }))
    .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))
    .map((record) => ({
      capability: record.capability,
      contractChecks: record.contract_checks ?? [],
      contractDigest: record.contract?.digest ?? null,
      effect: record.effect ?? null,
      errorCode: record.outcome?.error?.code ?? null,
      operationId: record.operation_id,
      implementation: record.implementation
        ? {
            origin: record.implementation.origin,
            ref: record.implementation.ref,
            revision: record.implementation.revision,
          }
        : null,
      requestIds: record.request_ids ?? [],
      resolution: record.resolution ?? null,
      settlement: record.settlement ?? null,
      state: record.state,
    }));
  const refusals = (await db.collection<Record<string, any>>(CALLS).find({ work_id: workId }))
    .filter((link) => link.refusal)
    .map((link) => ({
      callId: link.call_id,
      detail: link.detail ?? null,
      recordedAt: link.recorded_at,
      refusal: link.refusal,
    }));
  const submission = await readSubmission(workId);
  return {
    agent: current.task.owner,
    assertedBy: submission?.asserted_by ?? null,
    createdAt: current.task.created_at,
    decisions: current.checkpoint.decisions,
    ledger,
    readOnly: submission?.read_only === true,
    surface: submission?.surface ?? null,
    refusals,
    evidence: current.checkpoint.evidence,
    history: entries.map((entry) => ({
      at: entry.created_at,
      decisions: entry.decisions,
      status: entry.status,
      summary: entry.summary,
      version: entry.version,
    })),
    operations,
    objective: current.task.objective,
    requester: current.task.scope.workspace,
    scope: current.task.scope,
    sessionId:
      [...entries].reverse().find((entry) => entry.execution?.conversation_id)?.execution
        ?.conversation_id ?? null,
    status: current.task.status,
    summary: current.checkpoint.summary,
    updatedAt: current.task.updated_at,
    workId,
  };
}

export type ProgressInput = Omit<AgentCheckpointInput, "actor" | "expectedVersion">;

interface LedgerOperation {
  readonly operation_id: string;
  readonly work_id: string;
  readonly requester: string;
  readonly state: string;
  readonly outcome?: {
    readonly ok?: boolean;
    readonly output_digest?: string | null;
    readonly request_id?: string;
  } | null;
  readonly settlement?: { readonly outcome?: string } | null;
}

/**
 * Why this work may not be recorded completed, or null. Completion rests on the ledger, never on the
 * agent's reply: every operation the work recorded has a final state (none prepared, executing or
 * indeterminate), each was the requester's own, at least one succeeded, each success has its result
 * recorded (or an operator's settlement), and the checkpoint cites it.
 */
async function completionRefusal(
  workId: string,
  checkpoint: AgentCheckpoint,
  input: ProgressInput,
): Promise<string | null> {
  const { db } = await workStore();
  const submission = await readSubmission(workId);
  if (submission === null) return "the work has no durable submission";
  const operations = await db.collection<LedgerOperation>(OPERATIONS).find({ work_id: workId });
  if (operations.length === 0)
    return "no AppPort operation was recorded for it; a reply is not evidence";
  for (const operation of operations) {
    if (operation.state !== "succeeded" && operation.state !== "failed")
      return `operation ${operation.operation_id} is ${operation.state}`;
    if (operation.requester !== submission.requester)
      return `operation ${operation.operation_id} was made for another requester`;
    if (operation.settlement && operation.settlement.outcome !== operation.state)
      return `operation ${operation.operation_id} contradicts its settlement`;
  }
  const succeeded = operations.filter((operation) => operation.state === "succeeded");
  if (succeeded.length === 0) return "no operation succeeded";
  const cited = new Set(
    [...checkpoint.evidence, ...(input.evidence ?? [])].flatMap((entry) =>
      entry.kind === "record" && entry.collection === OPERATIONS ? [entry.id] : [],
    ),
  );
  for (const operation of succeeded) {
    const recorded =
      operation.settlement?.outcome === "succeeded" ||
      (operation.outcome?.ok === true &&
        typeof operation.outcome.output_digest === "string" &&
        Boolean(operation.outcome.request_id));
    if (!recorded) return `operation ${operation.operation_id} has no recorded result`;
    if (!cited.has(operation.operation_id))
      return `operation ${operation.operation_id} is not cited as evidence`;
  }
  return null;
}

export async function recordProgress(
  workId: string,
  build: (current: { task: AgentTask; checkpoint: AgentCheckpoint }) => ProgressInput | null,
): Promise<boolean> {
  const { state } = await workStore();
  for (let attempt = 1; ; attempt += 1) {
    const current = await state.getTask(workId);
    if (current === null) return false;
    if (current.task.status === "completed" || current.task.status === "cancelled") return false;
    let input = build(current);
    if (input === null) return false;
    // The one place work becomes completed: every path (a turn, recovery, settlement) passes this gate.
    if (input.status === "completed") {
      const refusal = await completionRefusal(workId, current.checkpoint, input);
      if (refusal !== null) {
        const decision = `blocked: not completed: ${refusal}`;
        if (current.task.status === "blocked" && lastDecision(current.checkpoint) === decision)
          return false;
        input = {
          ...input,
          decisions: [decision],
          status: "blocked",
          summary: `Blocked: ${refusal}.`,
        };
      }
    }
    try {
      await state.checkpoint(workId, {
        ...input,
        actor: AGENT_ID,
        expectedVersion: current.task.checkpoint_version,
      });
      return true;
    } catch (error) {
      const conflict = (error as { code?: unknown }).code === "VERSION_CONFLICT";
      if (!conflict || attempt === WRITE_ATTEMPTS) throw error;
    }
  }
}

export async function unfinishedWork(): Promise<AgentTask[]> {
  const { state } = await workStore();
  const found: AgentTask[] = [];
  for (const status of ["ready", "running", "blocked"] as const) {
    let cursor: string | undefined;
    do {
      const query: Parameters<AgentStateStore["listTasks"]>[0] = {
        limit: 100,
        project: APPLICATION_SCOPE,
        status,
      };
      if (cursor !== undefined) query.cursor = cursor;
      const page = await state.listTasks(query);
      found.push(...page.tasks.filter((task) => task.owner === AGENT_ID));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
  }
  return found;
}

export const OPERATIONS = "appport_operations";
export const CALLS = "appport_invocations";
const CITABLE_ID = /^[A-Za-z0-9._-]{1,80}$/u;

export function callLinkId(workId: string, callId: string): string {
  const call = CITABLE_ID.test(callId)
    ? callId
    : createHash("sha256").update(callId).digest("hex").slice(0, 40);
  return `${workId}.${call}`;
}

export async function readCallLink(workId: string, callId: string) {
  const { db } = await workStore();
  const link = await db.collection<Record<string, unknown>>(CALLS).get(callLinkId(workId, callId));
  return link !== null && link.work_id === workId && link.call_id === callId ? link : null;
}

export async function readOperationRecord(operationId: string) {
  const { db } = await workStore();
  return await db.collection<Record<string, unknown>>(OPERATIONS).get(operationId);
}

export interface ObservedCall {
  readonly callId: string;
  readonly settled: boolean;
}

export interface Outcome {
  readonly decision: string;
  readonly evidence: readonly string[];
  readonly status: "blocked" | "completed";
  readonly summary: string;
}

export function citeNew(current: AgentCheckpoint, operationIds: readonly string[]) {
  const cited = new Set(
    current.evidence.flatMap((entry) => (entry.kind === "record" ? [entry.id] : [])),
  );
  return [...new Set(operationIds)]
    .filter((id) => !cited.has(id))
    .map((id) => ({ collection: OPERATIONS, id, kind: "record" as const }));
}

export function lastDecision(checkpoint: AgentCheckpoint): string | undefined {
  return checkpoint.decisions.at(-1);
}
