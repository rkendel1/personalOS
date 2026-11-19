/**
 * The outbox: what the person approved to be sent or added in a connected account, from approval to
 * Google's answer.
 *
 *   email.send / calendar.create (mutations, the approvable capabilities)
 *        │ queue(): the item, exactly as approved, and its delivery job, in one transaction
 *   outbox.deliver (job, runs as the person)
 *        │ claim(): queued → sending (one delivery only)
 *        │ ctx.integrations.invoke(...) with the person's own connection; AuthBoundry decides on their behalf
 *        │ settle(): sent | failed | unknown, and its Activity row, in one transaction
 *
 * One attempt. An answer that never came is `unknown` and is never sent again on its own: Gmail takes no
 * idempotency key, so a resend could send it twice. The person sees which, and can send it again.
 */
import { fail, s } from "@feltdb/feltkit";
import type { MutationCtx } from "@feltdb/feltkit";
import { api } from "./_generated/api.js";
import { app, outbox } from "./app.js";
import { rawMessage, type Draft } from "./_google.js";
import * as ops from "./_ops.js";

export type Kind = "email.send" | "calendar.create";
const JOB = "outbox.deliver";

/** Record what was approved and queue its delivery. Called inside the capability's own mutation. */
export async function queue(ctx: MutationCtx, kind: Kind, summary: string, payload: Record<string, unknown>, proposedBy: { model: string; messageId: string } | undefined) {
  if (proposedBy) await ops.originOf(ctx, proposedBy, { via: "ui" }); // must name one of the owner's own messages
  const now = Date.now();
  const id = await ctx.db.insert(outbox, { owner: ops.me(ctx), kind, summary: summary.slice(0, 500), payload, status: "queued", ...(proposedBy ? { proposedBy } : {}), createdAt: now, updatedAt: now });
  ctx.afterCommit.jobs.enqueue(JOB, { id }, { maxAttempts: 1 });
  return (await ctx.db.get(outbox, id))!;
}

export const list = app.query({
  access: "outbox.read",
  args: { limit: s.optional(s.integer({ minimum: 1, maximum: 100 })) },
  returns: s.array(s.doc(outbox)),
  handler: (ctx, { limit }) => ctx.db.find(outbox, { owner: ops.me(ctx) }, { orderBy: [{ field: "createdAt", direction: "desc" }], limit: limit ?? 20 }),
});

/** queued → sending, once. Anything else: not this delivery's to make. */
export const claim = app.mutation({
  access: "outbox.deliver",
  args: { id: s.string() },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { id }) => {
    const item = await ops.own<{ owner: string; status: string; kind: Kind; payload: Record<string, unknown> }>(ctx, outbox, id, "outbox item");
    if (item.status !== "queued") return null;
    await ctx.db.patch(outbox, id, { status: "sending", updatedAt: Date.now() });
    return { kind: item.kind, payload: item.payload };
  },
});

/** The outcome, and its row in Activity, together. A failure also notifies the person. */
export const settle = app.mutation({
  access: "outbox.deliver",
  args: {
    id: s.string(),
    status: s.enum(["sent", "failed", "unknown"] as const),
    externalId: s.optional(s.string({ maxLength: 200 })),
    link: s.optional(s.string({ maxLength: 1000 })),
    error: s.optional(s.object({ code: s.string({ maxLength: 60 }), message: s.string({ maxLength: 500 }) })),
  },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, a) => {
    const item = await ops.own<{ owner: string; status: string; kind: Kind; summary: string; payload: Record<string, unknown>; proposedBy?: { model: string; messageId: string } }>(ctx, outbox, a.id, "outbox item");
    if (item.status !== "sending") fail("FAILED_PRECONDITION", `This item is ${item.status}, not being delivered.`);
    const meta = await ops.originOf(ctx, item.proposedBy, { via: "ui" });
    const { text: _body, ...shown } = item.payload as { text?: string };
    const actionId = await ops.record(ctx, {
      kind: item.kind,
      summary: `${item.summary}${a.status === "sent" ? "" : a.status === "unknown" ? " (no answer from Google: it may or may not have happened)" : " (failed)"}`,
      status: a.status === "sent" ? "succeeded" : "failed",
      approval: item.proposedBy ? "required" : "none",
      input: { outboxId: a.id, ...shown },
      // Google's own id for it: its answer, not a read-back, so not marked verified.
      ...(a.externalId ? { evidence: { collection: item.kind === "email.send" ? "gmail.messages" : "calendar.events", id: a.externalId, version: 0, verified: false } } : {}),
      ...(a.error ? { error: a.error } : {}),
    }, meta);
    await ctx.db.patch(outbox, a.id, { status: a.status, actionId, updatedAt: Date.now(), ...(a.externalId ? { externalId: a.externalId } : {}), ...(a.link ? { link: a.link } : {}), ...(a.error ? { error: a.error } : {}) });
    if (a.status !== "sent")
      ctx.afterCommit.notifications.send({ recipient: ops.me(ctx), type: "outbox.result", title: a.status === "unknown" ? "Not sure it went through" : "Couldn't do that", body: `${item.summary}: ${a.error?.message ?? a.status}`.slice(0, 300), data: { outboxId: a.id }, idempotencyKey: `outbox:${a.id}` });
    return { status: a.status, actionId };
  },
});

/** The job: deliver one queued item as its owner, with their own connection. */
export const deliver = app.action({
  access: "outbox.deliver",
  args: { id: s.string() },
  handler: async (ctx, { id }) => {
    const claimed = await ctx.runMutation(api.outbox.claim, { id });
    if (!claimed) return { delivered: false };
    try {
      if (claimed.kind === "email.send") {
        const sent = (await ctx.integrations.invoke("mail.send", { raw: rawMessage(claimed.payload as unknown as Draft) })) as { id?: unknown };
        await ctx.runMutation(api.outbox.settle, { id, status: "sent", ...(typeof sent?.id === "string" ? { externalId: sent.id } : {}) });
      } else {
        const p = claimed.payload as { title: string; notes?: string; location?: string; start: string; end: string; timeZone: string; attendees?: string[] };
        const made = (await ctx.integrations.invoke("calendar.insert", {
          summary: p.title,
          ...(p.notes ? { description: p.notes } : {}),
          ...(p.location ? { location: p.location } : {}),
          start: { dateTime: p.start, timeZone: p.timeZone },
          end: { dateTime: p.end, timeZone: p.timeZone },
          ...(p.attendees?.length ? { attendees: p.attendees.map((email) => ({ email })) } : {}),
        })) as { id?: unknown; htmlLink?: unknown };
        await ctx.runMutation(api.outbox.settle, { id, status: "sent", ...(typeof made?.id === "string" ? { externalId: made.id } : {}), ...(typeof made?.htmlLink === "string" && /^https:\/\//.test(made.htmlLink) ? { link: made.htmlLink } : {}) });
      }
      return { delivered: true };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      const status = e.code === "OUTCOME_UNKNOWN" || e.code === "DEADLINE_EXCEEDED" ? "unknown" : "failed";
      await ctx.runMutation(api.outbox.settle, { id, status, error: { code: (e.code ?? "ERROR").slice(0, 60), message: String(e.message ?? error).slice(0, 500) } });
      return { delivered: false, status };
    }
  },
});
