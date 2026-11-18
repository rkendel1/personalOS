import { defineTool } from "eve/tools";
import { z } from "zod";

import { resolveCapability, sendRequest } from "../lib/appport";
import { recordRefusedCall, runOperation } from "../lib/operations";
import { readSubmission, workForSession } from "../lib/work";

export default defineTool({
  description:
    "Invokes one AppPort capability as the current caller. Input must match the capability's input schema. Within accepted work every call is a durable operation: repeating the same capability with the same input (or the same operationKey) returns the recorded outcome instead of acting again, and an operation whose outcome is uncertain is never retried automatically. Pass operationKey (letters, digits, . _ -) only to tell two deliberately identical actions apart.",
  inputSchema: z.object({
    input: z.record(z.string(), z.unknown()),
    name: z.string().min(1),
    operationKey: z.string().min(1).max(64).optional(),
  }),
  async execute({ input, name, operationKey }, ctx) {
    const principalId = ctx.session.auth?.current?.principalId;
    if (principalId === undefined) return { error: "No authenticated caller." };
    const caller = { principalId };
    const workId = await workForSession(ctx.session.id);
    const resolved = await resolveCapability(caller, name);
    if (!resolved.ok) {
      if (workId !== null && !resolved.result.ok)
        await recordRefusedCall(workId, ctx.callId, resolved.result.error.code);
      return resolved.result;
    }
    if (workId === null) {
      if (resolved.entry.effect !== "observation") {
        return {
          error: {
            code: "NOT_EXPOSED",
            message: `${name} changes state; it is invoked only through a durable operation within accepted work.`,
          },
          ok: false,
        };
      }
      return await sendRequest(
        caller,
        resolved.entry,
        input,
        ctx.session.id,
        undefined,
        resolved.entry.latestVersion,
        resolved.resolution,
      );
    }

    const submission = await readSubmission(workId);
    const result = await runOperation({
      callId: ctx.callId,
      caller,
      entry: resolved.entry,
      input,
      manifest: resolved.manifest,
      resolution: resolved.resolution,
      objective: submission?.objective ?? "",
      operationKey,
      readOnly: submission?.read_only === true,
      workId,
    });
    if (result.kind === "refused") {
      return { error: { code: result.code, message: result.message }, ok: false };
    }
    if (result.kind === "conflict") {
      return {
        error: { code: "OPERATION_CONFLICT", message: result.message },
        ok: false,
        operationId: result.operationId,
      };
    }
    const { invoked, operation } = result;
    const recorded = {
      operationId: operation.operation_id,
      operationState: operation.state,
      replayedFromLedger: !invoked,
      requestId: operation.outcome?.request_id ?? null,
    };
    const { settlement } = operation;
    if (settlement !== undefined) {
      const attested = `An operator settled this operation as ${settlement.outcome}: ${settlement.reason}. It is not invoked again.`;
      if (operation.state === "succeeded")
        return { ...recorded, ok: true, output: null, settledByOperator: attested };
      return {
        ...recorded,
        error: { code: "OPERATION_SETTLED_FAILED", message: attested },
        ok: false,
      };
    }
    if (operation.state === "succeeded")
      return { ...recorded, ok: true, output: operation.outcome?.output };
    if (operation.state === "failed")
      return { ...recorded, error: operation.outcome?.error ?? null, ok: false };
    return {
      ...recorded,
      error: {
        code: "OPERATION_INDETERMINATE",
        message:
          operation.resolution ??
          "The outcome of this operation is not established. It is not retried automatically.",
      },
      ok: false,
    };
  },
});
