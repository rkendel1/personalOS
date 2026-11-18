import { defineChannel, GET, POST } from "eve/channels";
import { jwtEcdsa, jwtHmac, routeAuth } from "eve/channels/auth";
import { call } from "eve/events";
import { toolResultFrom } from "eve/tools";

import { fault } from "../lib/faults";
import { invokeCallsOf, reconcileAll, reconcileWork, replyOf } from "../lib/recovery";
import { decideOutcome, readOperation, settleOperation } from "../lib/operations";
import {
  acceptWork,
  bindSession,
  citeNew,
  readCallLink,
  readSubmission,
  readWork,
  recordProgress,
  workIdFor,
} from "../lib/work";
import appportInvoke from "../tools/appport_invoke";

const MAX_OBJECTIVE_LENGTH = 4000;
const MAX_KEY_LENGTH = 200;

const auth = [
  jwtHmac({
    algorithm: "HS256",
    audiences: [process.env.AGENT_JWT_AUDIENCE ?? "appport-agent"],
    issuer: process.env.AGENT_JWT_ISSUER ?? "appport-agent-operator",
    secret: process.env.AGENT_JWT_SECRET ?? "",
  }),
];

export const IDENTITY_AUDIENCE = "appport-agent-identity";
const MAX_SURFACE_BYTES = 4096;
const PERSON = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,99}$/u;

const requesterIssuer = () => process.env.AGENT_JWT_ISSUER ?? "appport-agent-operator";

/**
 * The identity authority (Personal OS): it resolves who a surface's sender is and asserts that person here.
 * Only a token it signed (ES256, verified with its public key) may name a person; nobody else's can.
 */
function identityAuthority() {
  const publicKey = process.env.APPPORT_AGENT_IDENTITY_PUBLIC_KEY;
  const issuer = process.env.APPPORT_AGENT_IDENTITY_ISSUER;
  if (!publicKey || !issuer || issuer === requesterIssuer()) return null;
  return {
    auth: [jwtEcdsa({ algorithm: "ES256", audiences: [IDENTITY_AUDIENCE], issuer, publicKey })],
    asserts: (principalId: string | undefined) => principalId?.startsWith(`${issuer}:`) === true,
  };
}

function surfaceOf(
  value: unknown,
): Readonly<Record<string, string | number | boolean | null>> | null {
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (JSON.stringify(value).length > MAX_SURFACE_BYTES) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  const scalar = (entry: unknown) =>
    entry === null || ["string", "number", "boolean"].includes(typeof entry);
  return entries.every(([, entry]) => scalar(entry))
    ? (Object.fromEntries(entries) as Record<string, string | number | boolean | null>)
    : null;
}

export const SETTLEMENT_AUDIENCE = "appport-agent-settlement";
const MAX_SETTLEMENT_BYTES = 4096;

function operatorAuth() {
  const publicKey = process.env.APPPORT_AGENT_OPERATOR_PUBLIC_KEY;
  const issuer = process.env.APPPORT_AGENT_OPERATOR_ISSUER;
  if (!publicKey || !issuer) return null;
  return [jwtEcdsa({ algorithm: "ES256", audiences: [SETTLEMENT_AUDIENCE], issuer, publicKey })];
}

const problem = (status: number, code: string, message: string) =>
  Response.json({ code, message, ok: false }, { status });

type Operations = Parameters<typeof reconcileAll>[0];
let startupReconciliation: Promise<unknown> | undefined;

function reconcileOnce(ops: Operations) {
  startupReconciliation ??= reconcileAll(ops).catch((error: unknown) => {
    startupReconciliation = undefined;
    throw error;
  });
  return startupReconciliation;
}

export default defineChannel({
  routes: [
    POST("/work", async (request, { from, resolveSession }) => {
      const authority = identityAuthority();
      const caller = await routeAuth(request, [...auth, ...(authority?.auth ?? [])]);
      if (caller instanceof Response) return caller;
      if (caller.principalId === undefined) return problem(401, "UNAUTHENTICATED", "No principal.");
      const key = request.headers.get("idempotency-key") ?? "";
      if (key.length === 0 || key.length > MAX_KEY_LENGTH)
        return problem(400, "IDEMPOTENCY_KEY_REQUIRED", "Send an Idempotency-Key header.");
      const body = (await request.json().catch(() => null)) as {
        objective?: unknown;
        onBehalfOf?: unknown;
        readOnly?: unknown;
        surface?: unknown;
      } | null;
      const asserting = authority?.asserts(caller.principalId) === true;
      if (!asserting && (body?.onBehalfOf !== undefined || body?.surface !== undefined))
        return problem(
          403,
          "ON_BEHALF_OF_NOT_ALLOWED",
          "Only the identity authority may name the person work is for.",
        );
      if (asserting && (typeof body?.onBehalfOf !== "string" || !PERSON.test(body.onBehalfOf)))
        return problem(
          400,
          "INVALID_ON_BEHALF_OF",
          "The identity authority must name the person (onBehalfOf).",
        );
      const surface = asserting ? surfaceOf(body?.surface) : {};
      if (surface === null)
        return problem(
          400,
          "INVALID_SURFACE",
          "surface must be an object of scalar values, at most 4 KB.",
        );
      const principalId = asserting
        ? `${requesterIssuer()}:${String(body?.onBehalfOf)}`
        : caller.principalId;
      const requester = asserting
        ? {
            ...caller,
            attributes: { ...caller.attributes, assertedBy: caller.principalId },
            principalId,
          }
        : caller;
      const objective = body?.objective;
      if (body?.readOnly !== undefined && typeof body.readOnly !== "boolean")
        return problem(400, "INVALID_READ_ONLY", "readOnly must be a boolean.");
      if (
        typeof objective !== "string" ||
        objective.length === 0 ||
        objective.length > MAX_OBJECTIVE_LENGTH
      )
        return problem(400, "INVALID_OBJECTIVE", "objective must be a non-empty string.");
      await reconcileOnce({ from, resolveSession });

      const acceptance = await acceptWork(
        { ...requester, principalId },
        key,
        objective,
        body?.readOnly === true,
        asserting ? { assertedBy: caller.principalId, surface } : undefined,
      );
      if (acceptance.outcome === "conflict")
        return problem(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "This key was used for a different objective.",
        );
      const { workId } = acceptance;
      await fault("work.accepted", { objective, workId });
      const delivery = await from(workId).send(objective, {
        auth: { ...requester, principalId },
        idempotencyKey: `work:${workId}`,
      });
      return Response.json(
        { replayed: acceptance.outcome === "replayed", sessionId: delivery.sessionId, workId },
        { status: acceptance.outcome === "accepted" ? 201 : 200 },
      );
    }),

    GET("/work/:workId", async (request, { from, params, resolveSession }) => {
      const authority = identityAuthority();
      const caller = await routeAuth(request, [...auth, ...(authority?.auth ?? [])]);
      if (caller instanceof Response) return caller;
      await reconcileOnce({ from, resolveSession });
      const workId = params.workId ?? "";
      const submission = await readSubmission(workId);
      const reader =
        authority?.asserts(caller.principalId) === true
          ? submission?.asserted_by === caller.principalId
            ? submission.requester
            : undefined
          : caller.principalId;
      const work = reader === undefined ? null : await readWork(reader, workId);
      if (work === null) return problem(404, "WORK_NOT_FOUND", "No such work.");
      const live = await resolveSession(workId);
      return Response.json({ ...work, liveSessionId: live?.id ?? null });
    }),

    // The identity authority finds work it submitted by its own key (after a submission whose answer it
    // never got): an observation, so it never has to send again to learn whether the work exists.
    GET("/submissions/:person/:key", async (request, { params }) => {
      const authority = identityAuthority();
      const caller = authority === null ? null : await routeAuth(request, authority.auth);
      if (caller === null || caller instanceof Response || !authority?.asserts(caller.principalId))
        return problem(
          403,
          "FORBIDDEN",
          "Only the identity authority may look up its submissions.",
        );
      const person = params.person ?? "";
      if (!PERSON.test(person)) return problem(400, "INVALID_ON_BEHALF_OF", "Not a person.");
      const workId = workIdFor(`${requesterIssuer()}:${person}`, params.key ?? "");
      const submission = await readSubmission(workId);
      if (submission?.asserted_by !== caller.principalId)
        return problem(404, "WORK_NOT_FOUND", "No work was submitted with this key.");
      return Response.json({ workId });
    }),

    POST("/work/reconcile", async (request, { from, resolveSession }) => {
      const caller = await routeAuth(request, auth);
      if (caller instanceof Response) return caller;
      const operator = process.env.APPPORT_AGENT_OPERATOR;
      if (operator === undefined || caller.principalId !== operator)
        return problem(403, "FORBIDDEN", "Only the operator may reconcile work.");
      const results = await reconcileAll({ from, resolveSession });
      return Response.json({ results });
    }),

    POST("/operations/:operationId/settle", async (request, { from, params, resolveSession }) => {
      const operatorKey = operatorAuth();
      if (operatorKey === null)
        return problem(
          503,
          "SETTLEMENT_NOT_CONFIGURED",
          "Settlement needs APPPORT_AGENT_OPERATOR_PUBLIC_KEY and APPPORT_AGENT_OPERATOR_ISSUER.",
        );
      const operator = await routeAuth(request, operatorKey);
      if (operator instanceof Response) return operator;
      if (operator.principalId === undefined)
        return problem(401, "UNAUTHENTICATED", "No operator principal.");
      const text = await request.text();
      if (text.length > MAX_SETTLEMENT_BYTES)
        return problem(413, "SETTLEMENT_TOO_LARGE", "The settlement body is too large.");
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        return problem(400, "INVALID_SETTLEMENT", "The settlement must be JSON.");
      }
      const result = await settleOperation(params.operationId ?? "", operator.principalId, body);
      if (result.kind === "invalid") return problem(400, "INVALID_SETTLEMENT", result.message);
      if (result.kind === "not_found")
        return problem(404, "OPERATION_NOT_FOUND", "No such operation.");
      if (result.kind === "refused") return problem(409, "SETTLEMENT_REFUSED", result.message);
      const work = await reconcileWork({ from, resolveSession }, result.operation.work_id);
      return Response.json({ operation: result.operation, work }, { status: 201 });
    }),
  ],

  events: {
    async "turn.started"(_event, ctx) {
      const workId = ctx.channel.continuation?.token;
      if (workId === undefined) return;
      await bindSession(ctx.session.id, workId);
      await recordProgress(workId, (current) =>
        current.task.status === "running" &&
        current.checkpoint.execution?.conversation_id === ctx.session.id
          ? null
          : {
              execution: { adapter: "eve", conversation_id: ctx.session.id },
              status: "running",
              summary: `Running in eve session ${ctx.session.id}.`,
            },
      );
    },

    async "call.settled"(event, ctx) {
      const workId = ctx.channel.continuation?.token;
      if (workId === undefined) return;
      const result = toolResultFrom(call(ctx.view, event.data.callId), appportInvoke);
      if (result === undefined) return;
      const link = await readCallLink(workId, result.callId);
      if (link === null || link.operation_id === null) return;
      const operation = await readOperation(String(link.operation_id));
      if (operation === null || operation.work_id !== workId) return;
      if (operation.state !== "succeeded" && operation.state !== "failed") return;
      const outcome =
        operation.state === "succeeded"
          ? "succeeded"
          : `was rejected (${operation.outcome?.error?.code ?? "unknown"})`;
      await recordProgress(workId, (current) => {
        const evidence = citeNew(current.checkpoint, [operation.operation_id]);
        if (evidence.length === 0) return null;
        return {
          evidence,
          status: "running",
          summary: `AppPort ${operation.capability} ${outcome}.`,
        };
      });
    },

    async "turn.settled"(event, ctx) {
      const workId = ctx.channel.continuation?.token;
      if (workId === undefined) return;
      const outcome = await decideOutcome(
        workId,
        event.data.outcome,
        invokeCallsOf(ctx.view),
        replyOf(ctx.view, event.data.turnId),
      );
      const submission = await readSubmission(workId);
      await fault("checkpoint.final", { objective: submission?.objective ?? "", workId });
      await recordProgress(workId, (current) => ({
        decisions: [outcome.decision],
        evidence: citeNew(current.checkpoint, outcome.evidence),
        status: outcome.status,
        summary: outcome.summary,
      }));
    },
  },
});
