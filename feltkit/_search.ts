/**
 * Web search as a replaceable capability. Research asks for "web search"; which provider answers is
 * whichever declared one is ready here (discovery, before any call). Each provider is a FeltKit
 * integration operation (its endpoint and key in configuration and credential custody, never here)
 * plus the two things that differ between providers: the request it takes and how its answer reads
 * as results. Pure: no I/O.
 *
 * What a result's text is differs by provider, and is recorded with it:
 *   search-snippet    text the search engine extracted from the page (Brave)
 *   provider-summary  text a model wrote about the page while searching (OpenAI web search): useful to
 *                     find candidates, never quoted as what the page says
 */

export interface SearchResult {
  title: string;
  url: string;
  description: string;
  extra?: string[];
}

export type TextKind = "search-snippet" | "provider-summary";

export interface SearchProvider {
  /** The integration operation that performs it (feltkit/app.ts). */
  capability: string;
  /** Recorded on every source it returns. */
  provider: string;
  textKind: TextKind;
  input(query: string): Record<string, unknown>;
  results(output: unknown): SearchResult[];
}

/** In order of preference: the first one ready here is used. */
export const SEARCH_PROVIDERS: SearchProvider[] = [
  {
    capability: "websearch.search",
    provider: "brave",
    textKind: "search-snippet",
    input: (q) => ({ q, count: 10 }),
    results: braveResults,
  },
  {
    capability: "openaisearch.search",
    provider: "openai-web-search",
    textKind: "provider-summary",
    input: (q) => ({
      model: process.env.OPENAISEARCH_MODEL || "gpt-4.1-mini",
      tools: [{ type: "web_search" }],
      tool_choice: "required",
      include: ["web_search_call.action.sources"],
      max_output_tokens: 1200,
      input: `Search the web for: ${q}\nList the most relevant results. For each one, say in one sentence what the page is, and cite it.`,
    }),
    results: openAiResults,
  },
];

export const providerOf = (capability: string | null) => SEARCH_PROVIDERS.find((p) => p.capability === capability) ?? null;

const strip = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

/** Brave Search's web results (`web.results[]`: title, url, description, extra_snippets); anything else is ignored. */
export function braveResults(output: unknown): SearchResult[] {
  const results = (output as { web?: { results?: unknown[] } } | null)?.web?.results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((r) => {
    const x = r as { title?: unknown; url?: unknown; description?: unknown; extra_snippets?: unknown };
    if (typeof x.url !== "string" || !/^https?:\/\//.test(x.url)) return [];
    return [{
      title: typeof x.title === "string" ? strip(x.title).slice(0, 300) : x.url,
      url: x.url.slice(0, 1000),
      description: typeof x.description === "string" ? strip(x.description).slice(0, 2000) : "",
      ...(Array.isArray(x.extra_snippets) ? { extra: x.extra_snippets.filter((s): s is string => typeof s === "string").map((s) => strip(s).slice(0, 1000)).slice(0, 5) } : {}),
    }];
  });
}

/** A URL without the tracking parameters search providers add (utm_*). */
export function cleanUrl(url: string): string {
  try {
    const u = new URL(url);
    for (const key of [...u.searchParams.keys()]) if (/^utm_/i.test(key)) u.searchParams.delete(key);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * OpenAI Responses API with the web_search tool. A result is a page the search itself returned
 * (`web_search_call.action.sources`) or cited (`url_citation`): a URL the model mentions without the
 * search having returned it is not a result. Its description is the model's sentence that cites it.
 */
export function openAiResults(output: unknown): SearchResult[] {
  const items = (output as { output?: unknown[] } | null)?.output;
  if (!Array.isArray(items)) return [];
  const found = new Map<string, SearchResult>();
  const returned = new Set<string>();
  for (const item of items as Array<Record<string, any>>) {
    if (item?.type !== "web_search_call") continue;
    for (const s of item.action?.sources ?? []) if (typeof s?.url === "string" && /^https?:\/\//.test(s.url)) returned.add(cleanUrl(s.url));
  }
  for (const item of items as Array<Record<string, any>>) {
    if (item?.type !== "message") continue;
    for (const c of item.content ?? []) {
      const text: string = typeof c?.text === "string" ? c.text : "";
      for (const a of c.annotations ?? []) {
        if (a?.type !== "url_citation" || typeof a.url !== "string" || !/^https?:\/\//.test(a.url)) continue;
        const url = cleanUrl(a.url);
        returned.add(url);
        if (found.has(url)) continue;
        // The cited sentence: from the line (or sentence) start before the citation to its end.
        const start = Math.max(text.lastIndexOf("\n", a.start_index ?? 0), 0);
        const sentence = strip(text.slice(start, a.end_index ?? start).replace(/\(\[[^\]]*\]\([^)]*\)\)/g, "").replace(/\*\*/g, "")).replace(/^\d+\.\s*/, "");
        found.set(url, { title: typeof a.title === "string" && a.title ? strip(a.title).slice(0, 300) : url, url: url.slice(0, 1000), description: sentence.slice(0, 2000) });
      }
    }
  }
  for (const url of returned) if (!found.has(url)) found.set(url, { title: url, url: url.slice(0, 1000), description: "" });
  return [...found.values()];
}
