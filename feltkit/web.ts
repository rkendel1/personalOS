/**
 * The web, as capabilities the chat (the model and the built-in assistant) and the app share:
 *
 *   web.search   find pages: the same providers research uses (feltkit/_search.ts), first one that
 *                answers. One that isn't configured here is skipped; if none is, it says so.
 *   web.read     read one public page: research's own reader (feltkit/_pages.ts readPage), with its
 *                rules unchanged (public addresses only, robots.txt honoured, size and time limits) and
 *                its outcome recorded (pageReads), whether or not the page was read.
 *   web.outcomes how reading has gone in real use: chat reads and research reads, by outcome.
 *
 * The page the person is looking at is not read here: their browser reads it (the extension,
 * extension/public/content.js; the iOS share sheet) and sends it as context, with their own session and
 * nothing of theirs passing through this server. Interacting with sites is not a capability yet.
 * docs/WEB.md has the evidence for this split.
 *
 * Reading only; contacts no one.
 */
import { s } from "@feltdb/feltkit";
import type { ActionCtx } from "@feltdb/feltkit";
import { api } from "./_generated/api.js";
import { app, pageReads, researchSources } from "./app.js";
import { pageReader, type PageRead } from "./_pages.js";
import { SEARCH_PROVIDERS, type SearchResult } from "./_search.js";
import * as ops from "./_ops.js";

export type WebSearch =
  | { ok: true; provider: string; textKind: string; results: SearchResult[] }
  | { ok: false; reason: string };

/** Not this provider's fault, and nothing to retry: the next provider may be configured. */
const NOT_SET_UP = new Set(["CONFIGURATION", "FAILED_PRECONDITION", "NOT_FOUND", "CREDENTIAL_MISSING"]);

export async function searchWeb(ctx: ActionCtx, query: string, limit = 6): Promise<WebSearch> {
  const skipped: string[] = [];
  for (const p of SEARCH_PROVIDERS) {
    try {
      const results = p.results(await ctx.integrations.invoke(p.capability, p.input(query))).slice(0, limit);
      return { ok: true, provider: p.provider, textKind: p.textKind, results };
    } catch (error) {
      const e = error as { code?: string; message?: string };
      if (!NOT_SET_UP.has(e.code ?? "") && !/not configured|no credential|missing/i.test(e.message ?? "")) return { ok: false, reason: `${p.provider}: ${e.code ?? "error"}: ${String(e.message ?? error).slice(0, 200)}` };
      skipped.push(p.provider);
    }
  }
  return {
    ok: false,
    reason: `No web search provider is configured on this server (tried ${skipped.join(", ")}). An operator enables one: WEBSEARCH_URL with the credential websearch (Brave Search API), or OPENAISEARCH_URL with the credential openaisearch.`,
  };
}

export const search = app.action({
  access: "web.search",
  args: { query: s.string({ minLength: 1, maxLength: 400 }), limit: s.optional(s.integer({ minimum: 1, maximum: 10 })) },
  handler: (ctx, { query, limit }) => searchWeb(ctx, query, limit ?? 6),
});

/** What web.read returns: the reader's outcome, as recorded, with the record's id for provenance. */
export type WebRead = PageRead & { id: string; reader: string; retrievedAt: number };
const READER = "page-reader";

/** Read one page with the shared reader and record what happened. Never throws for the page's sake. */
export async function readWeb(ctx: ActionCtx, url: string, via: "chat" | "model" | "app", conversationId?: string): Promise<WebRead> {
  const page = await pageReader.read(url, { signal: ctx.signal });
  const retrievedAt = Date.now();
  const id = await ctx.runMutation(api.web.recordRead, {
    url: page.url.slice(0, 1000), finalUrl: page.finalUrl.slice(0, 1000), status: page.status, ...(page.httpStatus ? { httpStatus: page.httpStatus } : {}),
    detail: page.detail.slice(0, 500), title: page.title.slice(0, 300), text: page.text.slice(0, 20000), ms: page.ms, reader: READER, via, ...(conversationId ? { conversationId } : {}), retrievedAt,
  });
  return { ...page, id, reader: READER, retrievedAt };
}

export const read = app.action({
  access: "web.read",
  args: { url: s.string({ minLength: 1, maxLength: 1000 }) },
  handler: (ctx, { url }) => readWeb(ctx, url, "app"),
});

/** The record of one read. Only web.read writes it (through readWeb); it is the caller's own. */
export const recordRead = app.mutation({
  access: "web.read",
  args: {
    url: s.string({ maxLength: 1000 }), finalUrl: s.string({ maxLength: 1000 }),
    status: s.enum(["read", "unavailable", "extraction-failed", "not-allowed"] as const), httpStatus: s.optional(s.number()),
    detail: s.string({ maxLength: 500 }), title: s.string({ maxLength: 300 }), text: s.string({ maxLength: 20000 }),
    ms: s.number(), reader: s.string({ maxLength: 60 }), via: s.enum(["chat", "model", "app"] as const),
    conversationId: s.optional(s.string()), retrievedAt: s.number(),
  },
  returns: s.string(),
  handler: (ctx, r) => ctx.db.insert(pageReads, { owner: ops.me(ctx), ...r }),
});

/** Name the conversation a read was for, once it exists (a read that started a new conversation). Set once. */
export const attachRead = app.mutation({
  access: "web.read",
  args: { id: s.string(), conversationId: s.string() },
  handler: async (ctx, { id, conversationId }) => {
    const r = await ops.own<{ owner: string; conversationId?: string }>(ctx, pageReads, id, "page read");
    if (!r.conversationId) await ctx.db.patch(pageReads, id, { conversationId });
  },
});

/**
 * How reading the web has gone for this person: every chat read and every page research read, by
 * outcome, with the latest failures and why. Counts, not a success rate to quote: it covers only what
 * was asked for, by this person.
 */
export const outcomes = app.query({
  access: "web.read",
  args: {},
  handler: async (ctx) => {
    const owner = ops.me(ctx);
    const chat = await ctx.db.find(pageReads, { owner });
    const research = (await ctx.db.find(researchSources, { owner })).filter((x: any) => x.kind === "page" && x.status);
    const rows = [
      ...chat.map((r: any) => ({ source: "chat" as const, url: r.finalUrl as string, status: r.status as string, httpStatus: (r.httpStatus ?? null) as number | null, detail: r.detail as string, at: r.retrievedAt as number, conversationId: (r.conversationId ?? null) as string | null, runId: null as string | null })),
      ...research.map((r: any) => ({ source: "research" as const, url: r.url as string, status: r.status as string, httpStatus: (r.httpStatus ?? null) as number | null, detail: (r.detail ?? "") as string, at: r.retrievedAt as number, conversationId: null as string | null, runId: r.runId as string })),
    ];
    const count = (list: typeof rows) => list.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
    return {
      total: rows.length,
      byStatus: count(rows),
      bySource: { chat: count(rows.filter((r) => r.source === "chat")), research: count(rows.filter((r) => r.source === "research")) },
      recentFailures: rows.filter((r) => r.status !== "read").sort((a, b) => b.at - a.at).slice(0, 20),
    };
  },
});
