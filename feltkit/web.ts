/**
 * Web search from the chat: the same providers research uses (feltkit/_search.ts), first one that
 * answers. A provider that isn't configured here is skipped, and if none is, the answer says so and
 * what enables one. Reading only; contacts no one.
 */
import { s } from "@feltdb/feltkit";
import type { ActionCtx } from "@feltdb/feltkit";
import { app } from "./app.js";
import { SEARCH_PROVIDERS, type SearchResult } from "./_search.js";

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
