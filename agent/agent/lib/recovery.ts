import {
  callState,
  calls,
  emptySessionView,
  foldEvents,
  reply,
  runs,
  turns,
  waiting,
} from "eve/events";
import type { SessionView } from "eve/events";
import type { RouteHandlerArgs } from "eve/channels";
import { sessions } from "eve/server";

import { decideOutcome } from "./operations";

import {
  citeNew,
  lastDecision,
  OPERATIONS,
  readSubmission,
  recordedSession,
  recordProgress,
  unfinishedWork,
  workStore,
  type ObservedCall,
  type ProgressInput,
} from "./work";

const UNSETTLED_CALL_STATES = new Set(["requested", "approval", "running", "blocked"]);
const SUBMITTED = "recovered: submitted to eve after an interrupted submission";

export type Execution =
  | { readonly kind: "missing" }
  | { readonly kind: "not-started" }
  | { readonly kind: "running"; readonly lastActivityAt: number; readonly inFlight: boolean }
  | { readonly kind: "waiting" }
  | {
      readonly kind: "settled";
      readonly invokeCalls: readonly ObservedCall[];
      readonly outcome: string;
      readonly reply: string;
    };

export function observeExecution(view: SessionView): Execution {
  const all = turns(view);
  const last = all.at(-1);
  if (last === undefined) return { kind: "not-started" };
  if (last.status === "running") {
    if (waiting(view, last.turnId)?.on === "interaction") return { kind: "waiting" };
    // What eve recorded, never what the model says: the latest moment a turn, a model run or a call
    // started or ended; and whether an AppPort operation is outstanding (an appport_invoke call running).
    const times = [...all, ...runs(view), ...calls(view)].flatMap((entry) => [
      entry.startedAt,
      entry.endedAt,
    ]);
    const lastActivityAt = Math.max(0, ...times.flatMap((at) => (at ? [Date.parse(at)] : [])));
    const inFlight = invokeCallsOf(view).some((call) => !call.settled);
    return { inFlight, kind: "running", lastActivityAt };
  }
  return {
    invokeCalls: invokeCallsOf(view),
    kind: "settled",
    outcome: last.outcome ?? "unknown",
    reply: replyOf(view, last.turnId),
  };
}

export function invokeCallsOf(view: SessionView): ObservedCall[] {
  return calls(view, { name: "appport_invoke" }).map((entry) => ({
    callId: entry.callId,
    settled: !UNSETTLED_CALL_STATES.has(callState(view, entry.callId) ?? "requested"),
  }));
}

export function replyOf(view: SessionView, turnId: string): string {
  return reply(view, turnId)
    .map((part) => (part.kind === "text" ? String(part.value ?? "") : ""))
    .join("");
}

async function readExecution(sessionId: string): Promise<Execution> {
  const events = [];
  for await (const event of sessions.attach(sessionId).stream({ follow: false }))
    events.push(event);
  if (events.length === 0) return { kind: "missing" };
  return observeExecution(foldEvents(emptySessionView(), events));
}

type RouteOperations = Pick<RouteHandlerArgs, "from" | "resolveSession">;

export interface Reconciliation {
  readonly action: "unchanged" | "submitted" | "recorded";
  readonly decision: string | null;
  readonly observed: string;
  readonly workId: string;
}

async function mark(
  workId: string,
  observed: string,
  status: "blocked" | "running",
  decision: string | null,
  extra: object = {},
): Promise<Reconciliation> {
  const wrote = await recordProgress(workId, (current) => {
    const same =
      current.task.status === status &&
      (decision === null || lastDecision(current.checkpoint) === decision);
    if (same) return null;
    const progress: ProgressInput = {
      ...extra,
      status,
      summary:
        decision === null
          ? "Running in eve."
          : `${decision[0]?.toUpperCase()}${decision.slice(1)}.`,
    };
    if (decision !== null) progress.decisions = [decision];
    return progress;
  });
  return { action: wrote ? "recorded" : "unchanged", decision, observed, workId };
}

export async function reconcileWork(ops: RouteOperations, workId: string): Promise<Reconciliation> {
  const { state } = await workStore();
  const recorded = await recordedSession(workId);
  const live = await ops.resolveSession(workId);
  const sessionId = recorded ?? live?.id ?? null;

  if (sessionId === null) {
    const current = await state.getTask(workId);
    if (current?.task.status !== "ready") {
      return await mark(
        workId,
        "no session",
        "blocked",
        "indeterminate: no eve session is associated with this work",
      );
    }
    const submission = await readSubmission(workId);
    if (submission === null) {
      return await mark(
        workId,
        "no session",
        "blocked",
        "indeterminate: accepted without a durable submission context",
      );
    }
    const delivery = await ops.from(workId).send(submission.objective, {
      auth: submission.auth,
      idempotencyKey: `work:${workId}`,
    });
    await recordProgress(workId, (now) =>
      lastDecision(now.checkpoint) === SUBMITTED
        ? null
        : {
            decisions: [SUBMITTED],
            status: now.task.status,
            summary: `Submitted to eve session ${delivery.sessionId} by recovery.`,
          },
    );
    return { action: "submitted", decision: SUBMITTED, observed: "no session", workId };
  }

  let execution: Execution;
  try {
    execution = await readExecution(sessionId);
  } catch {
    execution = { kind: "missing" };
  }

  switch (execution.kind) {
    case "missing":
      return await mark(
        workId,
        "missing",
        "blocked",
        `indeterminate: eve session ${sessionId} could not be read`,
      );
    case "not-started":
      return { action: "unchanged", decision: null, observed: "not-started", workId };
    case "running": {
      // Stalled: nothing has happened for longer than allowed, with no AppPort operation outstanding and
      // no interaction awaited. An operation in flight is never stalled by age alone; nothing is re-sent.
      const lastProgressAt = Math.max(execution.lastActivityAt, await lastLedgerUpdate(workId));
      const idleMs = Date.now() - lastProgressAt;
      if (!execution.inFlight && idleMs > stallAfterMs()) {
        return await mark(
          workId,
          "stalled",
          "blocked",
          `stalled: no progress since ${new Date(lastProgressAt).toISOString()} (no AppPort operation in flight, no interaction awaited)`,
        );
      }
      return await mark(
        workId,
        "running",
        "running",
        null,
        recorded === null ? { execution: { adapter: "eve", conversation_id: sessionId } } : {},
      );
    }
    case "waiting":
      return await mark(
        workId,
        "waiting",
        "blocked",
        "waiting: the eve session is waiting for an interaction",
      );
    case "settled": {
      const outcome = await decideOutcome(
        workId,
        execution.outcome,
        execution.invokeCalls,
        execution.reply,
      );
      const wrote = await recordProgress(workId, (current) => {
        if (
          current.task.status === outcome.status &&
          lastDecision(current.checkpoint) === outcome.decision
        )
          return null;
        return {
          decisions: [
            `recovered: final state reconstructed from eve session ${sessionId}`,
            outcome.decision,
          ],
          evidence: citeNew(current.checkpoint, outcome.evidence),
          status: outcome.status,
          summary: outcome.summary,
        };
      });
      return {
        action: wrote ? "recorded" : "unchanged",
        decision: outcome.decision,
        observed: `settled ${execution.outcome}`,
        workId,
      };
    }
  }
}

function stallAfterMs(): number {
  const configured = Number(process.env.APPPORT_AGENT_STALL_AFTER_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : 15 * 60_000;
}

async function lastLedgerUpdate(workId: string): Promise<number> {
  const { db } = await workStore();
  const operations = await db
    .collection<{ updated_at: string; work_id: string }>(OPERATIONS)
    .find({ work_id: workId });
  return Math.max(0, ...operations.map((operation) => Date.parse(operation.updated_at)));
}

export async function reconcileAll(ops: RouteOperations): Promise<Reconciliation[]> {
  const results = [];
  for (const task of await unfinishedWork()) results.push(await reconcileWork(ops, task.task_id));
  return results;
}
