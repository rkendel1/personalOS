/**
 * The canonical interaction contract, `personalos.interaction/1`: what any communication surface
 * (Multiplayer today; Slack, email, … later) hands PersonalOS when someone asks it for something.
 * It is independent of the surface that produced it. Documented in docs/INTERACTION-CONTRACT.md.
 *
 * Five identities are kept apart, and only one of them is authority:
 *
 *   adapter principal    who delivered the envelope: the FeltKit principal of the surface's bridge
 *                        session. Authenticated by FeltKit on the request; never read from the envelope.
 *   source identity      `sender.sourcePrincipalId`: the sender's principal *in the source system*.
 *                        The adapter vouches for it from its own authenticated session (never from a
 *                        message's text or a display name). Trusted only as far as the adapter is.
 *   PersonalOS account   resolved by PersonalOS from an active identity link the account's owner
 *                        created (feltkit/links.ts). Never supplied in the envelope.
 *   display name         `sender.displayName`, `handle`: presentation only.
 *   claimed identity     `sender.claimed`: anything the sender or metadata asserted (a signature
 *                        line, "I'm Ada", a forwarded header). Kept as provenance; never used.
 */
import { s } from "@feltdb/feltkit";

export const CONTRACT = "personalos.interaction/1" as const;

/** Lifecycle of one interaction, as every surface shows it. */
export const STATES = ["received", "understanding", "working", "awaiting_approval", "needs_clarification", "completed", "failed", "cancelled", "refused"] as const;
export type InteractionState = (typeof STATES)[number];
export const TERMINAL: ReadonlySet<InteractionState> = new Set(["completed", "failed", "cancelled", "refused"]);

/** Hard limits on the context an adapter may send (it should send less). */
export const LIMITS = { contextMessages: 60, contextChars: 1000, messageChars: 4000, attachments: 20 } as const;

const AttachmentRef = s.object({
  id: s.string({ maxLength: 200 }),
  name: s.string({ maxLength: 300 }),
  contentType: s.optional(s.string({ maxLength: 120 })),
  size: s.optional(s.number()),
  /** The source message the file was shared in (provenance). */
  messageId: s.optional(s.string({ maxLength: 200 })),
});

const ContextMessage = s.object({
  id: s.string({ maxLength: 200 }),
  /** The author's source principal, when the adapter knows it (absent for sample/system authors). */
  authorSourcePrincipalId: s.optional(s.string({ maxLength: 200 })),
  authorName: s.string({ maxLength: 120 }),
  authorKind: s.enum(["human", "agent"] as const),
  /** Whether the requester wrote it: the requester is distinguished from other participants. */
  isRequester: s.boolean(),
  text: s.string({ maxLength: LIMITS.contextChars }),
  at: s.number(),
  /** Thread root id when the message is a reply. */
  threadId: s.optional(s.string({ maxLength: 200 })),
  attachments: s.array(AttachmentRef, { maxItems: LIMITS.attachments }),
});

export const Envelope = s.object({
  contract: s.enum([CONTRACT] as const),
  /** Must equal the adapter principal that delivers it (checked, not trusted). */
  source: s.object({
    adapter: s.string({ minLength: 1, maxLength: 100 }),
    /** Which installation of the surface (a deployment or tenant of it). */
    instance: s.string({ minLength: 1, maxLength: 200 }),
    /** The source system's id for the triggering event (a message id). */
    eventId: s.string({ minLength: 1, maxLength: 200 }),
    /** The event's order in its conversation, when the source has one (detects out-of-order delivery). */
    sequence: s.optional(s.number()),
    /** When the source accepted the event (epoch ms, the source's clock). */
    receivedAt: s.number(),
  }),
  sender: s.object({
    sourcePrincipalId: s.string({ minLength: 1, maxLength: 200 }),
    displayName: s.string({ maxLength: 120 }),
    handle: s.optional(s.string({ maxLength: 64 })),
    /** Advisory, for dates only ("tomorrow"): never identity. */
    timeZone: s.optional(s.string({ maxLength: 64 })),
    claimed: s.optional(s.record(s.string({ maxLength: 300 }))),
  }),
  conversation: s.object({
    workspaceId: s.string({ maxLength: 200 }),
    workspaceName: s.optional(s.string({ maxLength: 120 })),
    conversationId: s.string({ maxLength: 200 }),
    kind: s.enum(["public", "private", "dm", "group"] as const),
    name: s.optional(s.string({ maxLength: 120 })),
    /** The thread the request was made in (its root message id), if any. */
    threadId: s.optional(s.string({ maxLength: 200 })),
    parentMessageId: s.optional(s.string({ maxLength: 200 })),
    /** People and agents in the conversation, the requester and PersonalOS included. */
    participantCount: s.number(),
    /** A direct conversation between the requester and PersonalOS only: nobody else can read the reply. */
    directWithAssistant: s.boolean(),
  }),
  message: s.object({
    id: s.string({ maxLength: 200 }),
    text: s.string({ minLength: 1, maxLength: LIMITS.messageChars }),
    mentions: s.object({ assistant: s.boolean(), handles: s.array(s.string({ maxLength: 64 }), { maxItems: 50 }) }),
    attachments: s.array(AttachmentRef, { maxItems: LIMITS.attachments }),
  }),
  context: s.object({
    scope: s.enum(["thread", "channel", "none"] as const),
    messages: s.array(ContextMessage, { maxItems: LIMITS.contextMessages }),
    /** What the adapter left out, so PersonalOS can say its view is partial. */
    limits: s.object({ maxMessages: s.number(), maxChars: s.number(), truncated: s.boolean() }),
  }),
  /** Where replies go: normally the originating conversation and thread. */
  respondTo: s.object({ conversationId: s.string({ maxLength: 200 }), threadId: s.optional(s.string({ maxLength: 200 })) }),
  /** Stable for every delivery of this event (retries, replays): one execution per key. */
  idempotencyKey: s.string({ minLength: 8, maxLength: 300 }),
});

export type EnvelopeT = {
  contract: typeof CONTRACT;
  source: { adapter: string; instance: string; eventId: string; sequence?: number; receivedAt: number };
  sender: { sourcePrincipalId: string; displayName: string; handle?: string; timeZone?: string; claimed?: Record<string, string> };
  conversation: { workspaceId: string; workspaceName?: string; conversationId: string; kind: "public" | "private" | "dm" | "group"; name?: string; threadId?: string; parentMessageId?: string; participantCount: number; directWithAssistant: boolean };
  message: { id: string; text: string; mentions: { assistant: boolean; handles: string[] }; attachments: Array<{ id: string; name: string; contentType?: string; size?: number; messageId?: string }> };
  context: { scope: "thread" | "channel" | "none"; messages: Array<{ id: string; authorSourcePrincipalId?: string; authorName: string; authorKind: "human" | "agent"; isRequester: boolean; text: string; at: number; threadId?: string; attachments: Array<{ id: string; name: string; contentType?: string; size?: number; messageId?: string }> }>; limits: { maxMessages: number; maxChars: number; truncated: boolean } };
  respondTo: { conversationId: string; threadId?: string };
  idempotencyKey: string;
};

/**
 * Who can read the reply. Only a direct conversation between the requester and PersonalOS is
 * private; everything else (a channel, a group, a DM with another person) is shared, and a shared
 * reply never carries the owner's private data (memory, task lists, briefings, other conversations).
 */
export function audienceOf(e: Pick<EnvelopeT, "conversation">): "private" | "shared" {
  return e.conversation.directWithAssistant && e.conversation.kind === "dm" && e.conversation.participantCount <= 2 ? "private" : "shared";
}

/** One PersonalOS conversation per source thread (or per source conversation, outside threads). */
export function threadKey(adapter: string, e: Pick<EnvelopeT, "source" | "conversation">): string {
  return [adapter, e.source.instance, e.conversation.workspaceId, e.conversation.conversationId, e.conversation.threadId ?? "-"].join("|");
}

/** "Multiplayer · #general" — what the PersonalOS conversation is called. */
export function conversationTitle(adapterLabel: string, e: Pick<EnvelopeT, "conversation">): string {
  const c = e.conversation;
  const where = c.kind === "public" || c.kind === "private" ? `#${c.name ?? "channel"}` : c.directWithAssistant ? "direct message" : c.kind === "group" ? "group" : "DM";
  return `${adapterLabel} · ${where}${c.threadId ? " (thread)" : ""}`.slice(0, 120);
}

/** A link code as people type it: 8 characters from an unambiguous alphabet, shown as XXXX-XXXX. */
export const LINK_CODE = /\blink\s+([A-HJ-NP-Z2-9]{4})-?([A-HJ-NP-Z2-9]{4})\b/i;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function linkCodeFrom(token: string): string {
  // `token` is base64url randomness from ctx.crypto.token(); map 8 of its bytes onto the alphabet.
  const bytes = Array.from(token).map((c) => c.charCodeAt(0));
  let out = "";
  for (let i = 0; out.length < 8; i++) out += ALPHABET[bytes[i % bytes.length]! % ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

export async function digest(text: string): Promise<string> {
  const data = new TextEncoder().encode(text.toUpperCase().replace(/-/g, ""));
  const hash = await globalThis.crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}
