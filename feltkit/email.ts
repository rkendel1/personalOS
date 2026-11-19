/**
 * Email: the person's own Gmail, connected in Settings → Connections (feltkit/connections.ts).
 *
 *   recent   reads headers and snippets (never bodies). The chat runs it for the person; no approval.
 *   send     sends as the person. From the chat the model can only PROPOSE it; the person approves exactly
 *            the draft shown, which is then queued and delivered as them (feltkit/outbox.ts).
 *
 * Every call also passes AuthBoundry on the person's behalf (mail.read / mail.send), and FeltKit records
 * it (integrations.calls). A delivered send leaves its row in Activity with Gmail's message id.
 */
import { fail, s } from "@feltdb/feltkit";
import type { ActionCtx } from "@feltdb/feltkit";
import { app, outbox, PROPOSED_BY } from "./app.js";
import { draftProblem, mailSummary, messageIds, type MailSummary } from "./_google.js";
import { queue } from "./outbox.js";

const Address = s.string({ minLength: 3, maxLength: 254 });

/** The person's recent mail matching a Gmail search (e.g. "is:unread", "from:sam"), newest first. */
export async function recentMail(ctx: ActionCtx, query: string | undefined, limit: number): Promise<MailSummary[]> {
  const list = await ctx.integrations.invoke("mail.list", { ...(query ? { q: query } : {}), maxResults: limit });
  const out: MailSummary[] = [];
  for (const id of messageIds(list).slice(0, limit)) {
    const summary = mailSummary(await ctx.integrations.invoke("mail.get", { id, format: "metadata" }));
    if (summary) out.push(summary);
  }
  return out;
}

export const recent = app.action({
  access: "email.read",
  args: { query: s.optional(s.string({ maxLength: 300 })), limit: s.optional(s.integer({ minimum: 1, maximum: 20 })) },
  handler: async (ctx, { query, limit }) => recentMail(ctx, query, limit ?? 10),
});

export const send = app.mutation({
  access: "email.send",
  args: {
    to: s.array(Address, { minItems: 1, maxItems: 20 }),
    cc: s.optional(s.array(Address, { maxItems: 20 })),
    subject: s.string({ maxLength: 300 }),
    text: s.string({ minLength: 1, maxLength: 20000 }),
    proposedBy: PROPOSED_BY,
  },
  returns: s.doc(outbox),
  capability: { name: "email.send", description: "Send an email as the user from their connected Gmail. Plain text. Always waits for the user's approval of this exact draft; once approved it is queued and sent as them." },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { proposedBy, ...draft }) => {
    const problem = draftProblem(draft);
    if (problem) fail("INVALID_ARGUMENT", problem);
    const payload = { to: draft.to, ...(draft.cc?.length ? { cc: draft.cc } : {}), subject: draft.subject, text: draft.text };
    return queue(ctx, "email.send", `Email to ${draft.to.join(", ")}: ${draft.subject || "(no subject)"}`, payload, proposedBy);
  },
});
