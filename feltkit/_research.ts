/**
 * Research outcomes, deterministically: what the person asked for (the outcome, not the method),
 * how to pursue it with web search, and how to turn what search returned into evidence-backed,
 * ranked prospects. Pure: no I/O, no model. feltkit/research.ts runs it.
 *
 * Evidence and assessment are kept apart on purpose:
 *   facts       what a source returned (its URL, title and text), each with the source's id
 *   assessment  what these rules conclude from those facts (fit, rationale, confidence), labelled
 *               with how it was reached; never presented as something a source said
 */

export interface ProspectOutcome {
  kind: "prospects";
  /** What the customers are for, as the person named it ("FeltKit"). */
  product: string;
  /** The outcome, in PersonalOS's words: what done looks like. */
  objective: string;
}

const AUDIENCE = "(?:new |more |some |potential |prospective |possible |good |a few |\\d+ )*(?:customers|clients|prospects|leads|buyers|users|companies)";

/** "Find me some new customers for FeltKit" → a prospect search for FeltKit. Null when it is not one. */
export function outcomeOf(text: string): ProspectOutcome | null {
  const t = text.trim().replace(/\s+/g, " ");
  const m =
    new RegExp(`\\b(?:find|get|identify|source|look for|search for|research|build|generate|dig up|hunt for)\\b(?: me| us)?(?: a list of)? ${AUDIENCE} (?:for|of|that (?:would|might|could) (?:buy|use|want|need)|who (?:would|might|could) (?:buy|use|want|need))\\s+(.+?)[.?!]*$`, "i").exec(t) ??
    new RegExp(`\\bwho (?:would|might|could) (?:buy|use|need|want)\\s+(.+?)[.?!]*$`, "i").exec(t);
  if (!m) return null;
  const product = m[1]!.replace(/^(?:my|our|the)\s+/i, "").replace(/\s+(?:please|for me|for us)$/i, "").trim();
  if (!product || product.length > 80) return null;
  return {
    kind: "prospects",
    product,
    objective: `Identify qualified potential customers for ${product}: research their business and likely needs, evaluate fit, and produce an evidence-backed, ranked prospect list with next actions.`,
  };
}

const STOP = new Set(
  "a an the and or but for to of in on at by with from into over under is are was were be been being it its this that these those as than then so such can could would should will may might must do does did have has had not no yes our your their my we you they he she them us i me also just very more most less few many much other own same only both each any all some about after before again against between during through until while what which who whom why how where when there here because if out up down off once further too can't won't don't isn't aren't wasn't weren't hasn't haven't hadn't doesn't didn't let lets get gets got make makes made use uses used using build builds built help helps want wants need needs like one two new way ways thing things lot lots".split(" "),
);
/** Words that describe any software and say nothing about who needs this one: never evidence of fit. */
const GENERIC = new Set(
  "building framework frameworks application applications app apps platform platforms software product products solution solutions service services system systems company companies tool based simple easy modern fast powerful best leading team teams".split(" "),
);

export interface ProductKnowledge {
  /** Verbatim statements the person saved about the product (memories), with their ids. */
  statements: Array<{ id: string; text: string }>;
  /** Keywords from those statements, most frequent first: what fit is judged on. */
  keywords: string[];
}

/** What PersonalOS knows about the product, from the person's own memories that mention it. */
export function productKnowledge(product: string, memories: Array<{ id: string; content: string; status?: string }>): ProductKnowledge {
  const name = product.toLowerCase();
  const statements = memories.filter((m) => m.content.toLowerCase().includes(name)).map((m) => ({ id: m.id, text: m.content }));
  const counts = new Map<string, number>();
  for (const s of statements) {
    for (const raw of s.text.toLowerCase().split(/[^a-z0-9+#.-]+/)) {
      const word = raw.replace(/^[.-]+|[.-]+$/g, "");
      if (word.length < 3 || STOP.has(word) || GENERIC.has(word) || word === name || name.split(/\s+/).includes(word) || /^\d+$/.test(word)) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const keywords = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([w]) => w).slice(0, 12);
  return { statements, keywords };
}

/** The searches to run: from what is known about the product, else from its name alone. At most 5. */
export function planQueries(product: string, knowledge: ProductKnowledge): string[] {
  const k = knowledge.keywords;
  const queries = k.length >= 2
    ? [`companies building ${k[0]} ${k[1]}`, `startups ${k[0]} ${k[1]} ${k[2] ?? "platform"}`, `${k[0]} ${k[1]} teams hiring`, `${product} alternatives`, `${product} competitors`]
    : [`${product} alternatives`, `${product} competitors`, `companies that use tools like ${product}`];
  return [...new Set(queries)].slice(0, 5);
}

export interface SearchResult { title: string; url: string; description: string; extra?: string[] }

/** Brave Search's web results (`web.results[]`: title, url, description, extra_snippets); anything else is ignored. */
export function searchResults(output: unknown): SearchResult[] {
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
const strip = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

/** Sites that are about companies, not companies to sell to (directories, forums, social, encyclopedias). */
const NOT_A_PROSPECT = new Set([
  "wikipedia.org", "github.com", "gitlab.com", "linkedin.com", "medium.com", "reddit.com", "youtube.com", "twitter.com", "x.com", "facebook.com",
  "instagram.com", "ycombinator.com", "stackoverflow.com", "stackexchange.com", "quora.com", "crunchbase.com", "g2.com", "capterra.com",
  "producthunt.com", "dev.to", "npmjs.com", "substack.com", "techcrunch.com", "forbes.com", "glassdoor.com", "indeed.com", "wellfound.com", "slashdot.org", "alternativeto.net", "stackshare.io",
]);

/** The registrable domain of a URL (example.co.uk, example.com), lowercased. */
export function domainOf(url: string): string | null {
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  host = host.replace(/^www\./, "");
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  const [second, top] = parts.slice(-2) as [string, string];
  return top.length === 2 && second.length <= 3 ? parts.slice(-3).join(".") : parts.slice(-2).join(".");
}

/** A company's name from a page title and its domain: the title part that matches the domain, else the domain. */
export function companyName(title: string, domain: string): string {
  const label = domain.split(".")[0]!;
  const parts = title.split(/\s+[|\-–—·]\s+|:\s+/).map((p) => p.trim()).filter(Boolean);
  const match = parts.find((p) => p.toLowerCase().replace(/[^a-z0-9]/g, "").includes(label.replace(/[^a-z0-9]/g, "")));
  if (match && match.length <= 60) return match;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export interface StoredSource { id: string; url: string; title: string; text: string; query: string }

export interface ProspectDraft {
  company: string;
  domain: string;
  website: string;
  /** Facts: what sources said, verbatim, each citing its source. */
  facts: Array<{ sourceId: string; url: string; text: string }>;
  assessment: {
    basis: "rules";
    method: string;
    fit: "high" | "medium" | "low";
    score: number;
    whyFeltKit: string;
    rationale: Array<{ text: string; sourceIds: string[] }>;
    confidence: "high" | "medium" | "low";
  };
  openQuestions: string[];
  nextAction: string;
}

/**
 * Prospects from stored sources: one per company domain (never the product's own, never a directory or
 * forum), with facts quoted from the sources and a rule-based fit assessment that cites them.
 */
export function prospectsFrom(product: string, knowledge: ProductKnowledge, sources: StoredSource[], options: { ownDomains?: string[]; pagesRead: boolean }): ProspectDraft[] {
  const own = new Set((options.ownDomains ?? []).map((d) => d.toLowerCase()));
  const byDomain = new Map<string, StoredSource[]>();
  for (const s of sources) {
    const d = domainOf(s.url);
    if (!d || NOT_A_PROSPECT.has(d) || own.has(d) || d.split(".")[0] === product.toLowerCase().replace(/[^a-z0-9]/g, "")) continue;
    (byDomain.get(d) ?? byDomain.set(d, []).get(d)!).push(s);
  }
  const drafts: ProspectDraft[] = [];
  for (const [domain, list] of byDomain) {
    // One fact per page: a page several searches returned is one piece of evidence (its first stored copy).
    const pages = [...new Map(list.map((s) => [s.url, s])).values()];
    const facts = pages.map((s) => ({ sourceId: s.id, url: s.url, text: s.text ? `${s.title}: ${s.text}` : s.title }));
    const rationale: ProspectDraft["assessment"]["rationale"] = [];
    for (const keyword of knowledge.keywords) {
      const cited = list.filter((s) => `${s.title} ${s.text}`.toLowerCase().includes(keyword)).map((s) => s.id);
      if (cited.length) rationale.push({ text: `Its own pages, as found, mention "${keyword}", which is how ${product} is described.`, sourceIds: cited });
    }
    const queries = new Set(list.map((s) => s.query));
    // Matching evidence decides; how many searches found it only separates companies that have some.
    const score = Math.round((rationale.length + (rationale.length ? 0.25 * (queries.size - 1) : 0)) * 100) / 100;
    const fit = rationale.length >= 3 ? "high" : rationale.length >= 1 ? "medium" : "low";
    const confidence = !options.pagesRead ? (pages.length >= 2 ? "medium" : "low") : pages.length >= 3 ? "high" : "medium";
    const matched = rationale.map((r) => r.text.match(/"([^"]+)"/)![1]!);
    drafts.push({
      company: companyName(list[0]!.title, domain),
      domain,
      website: `https://${domain}`,
      facts,
      assessment: {
        basis: "rules",
        method: `Keyword match between what you saved about ${product} and the search results that cite this company; ${queries.size} search${queries.size === 1 ? "" : "es"} found it.`,
        fit,
        score,
        whyFeltKit: matched.length
          ? `Works in the same space ${product} serves (${matched.slice(0, 4).join(", ")}), so it may need it.`
          : `Found by searches about ${product}'s space, but nothing in its results matches how ${product} is described: a weak lead.`,
        rationale,
        confidence,
      },
      openQuestions: [
        ...(options.pagesRead ? [] : ["Only search-result text was read; its own pages were not."]),
        "Company size, stage and current stack are not verified.",
        "Who decides on tools like this there is unknown (no contact research was done).",
      ],
      nextAction: `Review the evidence. If it fits, I can draft an introduction to ${list[0] ? companyName(list[0].title, domain) : domain}, but nothing is sent without your approval.`,
    });
  }
  return drafts.sort((a, b) => b.assessment.score - a.assessment.score || b.facts.length - a.facts.length || a.domain.localeCompare(b.domain));
}
