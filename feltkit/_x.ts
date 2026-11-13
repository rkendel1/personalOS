/**
 * X (formerly Twitter) as a PersonalOS surface: the pure parts (feltkit/xsurface.ts does the rest).
 *
 * Two identities, never confused:
 *   the bot     @anywhereaide, the account whose mentions are read and whose replies are posted.
 *               Its OAuth token (credential `x`) authorizes PersonalOS to act AS THE BOT. It proves
 *               nothing about anyone who mentions it.
 *   a person    the author of a mention, as X's API reports it (`author_id`). A person is a PersonalOS
 *               account only through a link they confirmed in PersonalOS (Resolver, adapter `x`).
 *               A username or id written in a post's text is never identity.
 *
 * Everything in a post is untrusted data: its text is what the person asked (when the author is linked),
 * and the posts it replies to or quotes are context, never instructions.
 *
 * Shapes are from X API v2 (docs.x.com: GET /2/users/:id/mentions, POST /2/tweets).
 */
import { createHash } from "node:crypto";
import { LINK_CODE } from "./_interaction.js";

export const X_ADAPTER = "x";
/** The identity namespace of X accounts (one per platform; the bot account is not part of a person's identity). */
export const X_INSTANCE = "x.com";
/** What a mentions request asks for (fields the adapter uses, nothing else). */
export const MENTION_FIELDS = {
  expansions: "author_id,referenced_tweets.id",
  "tweet.fields": "author_id,conversation_id,created_at,in_reply_to_user_id,referenced_tweets",
  "user.fields": "username",
} as const;
/** X's reply limit; replies are kept far shorter. */
export const POST_CHARS = 280;

export interface Mention {
  id: string;
  text: string;
  authorId: string;
  authorUsername?: string;
  conversationId?: string;
  inReplyToPostId?: string;
  createdAt?: string;
  referenced: Array<{ type: string; id: string; authorId?: string; text?: string }>;
}

const ID = /^[0-9]{1,19}$/;
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);

/** Post ids are 64-bit integers that grow over time: compare them as such, never as strings. */
export function newer(a: string, b: string | undefined): boolean {
  return b === undefined || BigInt(a) > BigInt(b);
}

/**
 * A mentions response → mentions oldest first (processing order), the newest id seen, and the next
 * page. Malformed entries are dropped, never guessed at.
 */
export function readMentions(body: unknown): { mentions: Mention[]; newestId?: string; nextToken?: string } {
  const b = (body ?? {}) as { data?: unknown[]; includes?: { users?: unknown[]; tweets?: unknown[] }; meta?: { newest_id?: unknown; next_token?: unknown } };
  const users = new Map<string, string>();
  for (const u of b.includes?.users ?? []) {
    const x = u as { id?: unknown; username?: unknown };
    if (typeof x.id === "string" && typeof x.username === "string") users.set(x.id, x.username.slice(0, 50));
  }
  const included = new Map<string, { authorId?: string; text?: string }>();
  for (const t of b.includes?.tweets ?? []) {
    const x = t as { id?: unknown; text?: unknown; author_id?: unknown };
    if (typeof x.id === "string" && ID.test(x.id)) included.set(x.id, { ...(typeof x.author_id === "string" && ID.test(x.author_id) ? { authorId: x.author_id } : {}), ...(typeof x.text === "string" ? { text: x.text.slice(0, 4000) } : {}) });
  }
  const mentions: Mention[] = [];
  for (const raw of b.data ?? []) {
    const p = raw as { id?: unknown; text?: unknown; author_id?: unknown; conversation_id?: unknown; created_at?: unknown; referenced_tweets?: unknown[] };
    if (typeof p.id !== "string" || !ID.test(p.id) || typeof p.author_id !== "string" || !ID.test(p.author_id) || typeof p.text !== "string") continue;
    const referenced = (Array.isArray(p.referenced_tweets) ? p.referenced_tweets : [])
      .map((r) => r as { type?: unknown; id?: unknown })
      .filter((r) => typeof r.id === "string" && ID.test(r.id) && typeof r.type === "string")
      .slice(0, 5)
      .map((r) => ({ type: String(r.type).slice(0, 20), id: String(r.id), ...included.get(String(r.id)) }));
    const replyTo = referenced.find((r) => r.type === "replied_to")?.id;
    mentions.push({
      id: p.id, text: p.text.slice(0, 4000), authorId: p.author_id,
      ...(users.get(p.author_id) ? { authorUsername: users.get(p.author_id) } : {}),
      ...(typeof p.conversation_id === "string" && ID.test(p.conversation_id) ? { conversationId: p.conversation_id } : {}),
      ...(replyTo ? { inReplyToPostId: replyTo } : {}),
      ...(str(p.created_at, 40) ? { createdAt: str(p.created_at, 40) } : {}),
      referenced,
    });
  }
  mentions.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0));
  const newestId = typeof b.meta?.newest_id === "string" && ID.test(b.meta.newest_id) ? b.meta.newest_id : mentions.at(-1)?.id;
  const nextToken = typeof b.meta?.next_token === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(b.meta.next_token) ? b.meta.next_token : undefined;
  return { mentions, ...(newestId ? { newestId } : {}), ...(nextToken ? { nextToken } : {}) };
}

/**
 * What the person asked: the post's text without the handles X puts in front of it (the bot's, and
 * those of everyone in the thread it replies to). Handles elsewhere in the text are left alone.
 */
export function instructionOf(text: string): string {
  return text.replace(/^(\s*@[A-Za-z0-9_]{1,15}\b[:,]?)+/, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

/** What the instruction asks of the X surface itself, before it is work. */
export type XCommand =
  | { kind: "link"; code: string }
  | { kind: "continue"; conversationId: string; rest: string }
  | { kind: "work"; text: string };

export function commandOf(instruction: string): XCommand {
  const code = LINK_CODE.exec(instruction);
  if (code && instruction.replace(LINK_CODE, "").trim().length <= 20) return { kind: "link", code: `${code[1]}${code[2]}`.toUpperCase() };
  const c = /^continue\s+(?:(?:the\s+)?conversation\s+)?([A-Za-z0-9_-]{12,64})(?=$|[\s:,.!?])[\s:,.!?]*([\s\S]*)$/i.exec(instruction);
  if (c && /\d/.test(c[1]!) && /[a-z]/i.test(c[1]!)) return { kind: "continue", conversationId: c[1]!, rest: c[2]!.trim() };
  return { kind: "work", text: instruction };
}

/** A post's public address (X redirects /i/web/status/<id> to the author's path). */
export const postUrl = (id: string) => `https://x.com/i/web/status/${id}`;

/** A short, stable reference for a post, so two acknowledgements are never identical text. */
export const refOf = (postId: string) => createHash("sha256").update(`x-post:${postId}`).digest("base64url").replace(/[-_]/g, "").slice(0, 6).toUpperCase();

/**
 * The bot's public replies. Generic by policy: they say that something was received and where to look,
 * never what was asked, what was found, or anything about the person's account.
 */
export function acknowledgement(kind: "invoked" | "link", postId: string): string {
  const ref = refOf(postId);
  // No link: X prices a post containing a URL far above one without (docs.x.com pricing).
  const where = " Open PersonalOS to see it.";
  const text = kind === "link"
    ? `Received (ref ${ref}). If you sent a link code, finish connecting in PersonalOS → Settings → Connected surfaces. Nothing else happens until you confirm there.`
    : `Received (ref ${ref}). It's in your PersonalOS, and the result stays private there; nothing about it is posted here.${where}`;
  return text.slice(0, POST_CHARS);
}

/** Text the owner explicitly publishes: within X's limit, nothing else added. */
export function publication(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) throw new Error("Nothing to publish.");
  if (t.length > POST_CHARS) throw new Error(`A post is limited to ${POST_CHARS} characters (this is ${t.length}).`);
  return t;
}
