/**
 * What a model contributes to research, and the rules that decide what of it is accepted. Pure: the
 * prompts it is given and the validation of what it answers. feltkit/research.ts calls the model.
 *
 * The model proposes; these rules accept or reject:
 *   plan        what is being asked for, the criteria, and the searches (bounded, deduplicated)
 *   selection   which search results are organizations worth a closer look, and at most two refined
 *               searches; it can only name results the search returned
 *   assessment  fit, with facts that must be verbatim quotes from pages that were actually read
 *               (checked here, character for character), and reasons that cite those pages
 *
 * The model never runs a search, reads a page, or writes anything: research does, as the person.
 */
import { quoted } from "./_pages.js";
import { domainOf, notAProspect } from "./_research.js";

export const LIMITS = { queries: 6, refinements: 2, candidates: 8, criteria: 6, pageChars: 7000 };

export type Kind = "prospects" | "competitors" | "organizations";
const KINDS: Kind[] = ["prospects", "competitors", "organizations"];

export interface Generation { generationId: string; memoryId: string; model: string }

/** The JSON object in a model's answer (it may wrap it in a code fence or a sentence). */
export function jsonOf(text: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const body = fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    const v = JSON.parse(body);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const list = (v: unknown) => (Array.isArray(v) ? v : []);

// ── Plan ────────────────────────────────────────────────────────────────────────────────────────

export function planPrompt(input: { request: string; statements: string[]; landscape: string; today: string }) {
  return {
    system: [
      "You plan web research for PersonalOS, a personal assistant. You do not search or browse; you propose a plan and PersonalOS runs it.",
      "Work out what the person actually wants as an outcome, what it is about (the subject: a product, company or field), and what a good result looks like.",
      "Customers and competitors are different: a prospect is an organization that has the problem the subject solves and would BUY or USE it; an organization that SELLS something similar is a competitor, never a prospect. For prospects, write criteria about the buyer (who they are, what they build, what they struggle with), not about the subject's features, and search for buyers (teams, companies, roles, hiring, case studies), not for similar products.",
      `kind is one of: "prospects" (organizations that might buy or use the subject), "competitors" (organizations offering something that competes with the subject), "organizations" (organizations matching some other description).`,
      `Propose up to ${LIMITS.queries} web search queries that would surface specific organizations (their own sites, or pages listing them), not generic articles. Vary the angle: who has the problem the subject solves, who builds in that space, who is hiring for it, alternatives and comparisons. Write queries as a person would type them into a search engine.`,
      `Criteria: up to ${LIMITS.criteria} concrete things that make an organization a good match, checkable from its own pages.`,
      "Use only what the request and the person's notes say about the subject. If they say nothing about what it does, say so in subjectSummary instead of guessing.",
      'Answer with JSON only: {"kind": "...", "subject": "...", "subjectSummary": "...", "objective": "one sentence: what done looks like", "criteria": ["..."], "queries": ["..."]}',
    ].join("\n"),
    user: [
      `Today: ${input.today}`,
      `Request: ${input.request}`,
      `The person's own notes that may be about the subject:\n${input.statements.length ? input.statements.map((s) => `- ${s}`).join("\n") : "(none)"}`,
      `What PersonalOS can use for this:\n${input.landscape}`,
    ].join("\n\n"),
  };
}

export interface Plan { kind: Kind; subject: string; subjectSummary: string; objective: string; criteria: string[]; queries: string[]; rejected: string[] }

export function acceptPlan(raw: Record<string, unknown> | null): Plan | { error: string } {
  if (!raw) return { error: "the answer was not a JSON object" };
  const rejected: string[] = [];
  const kind = KINDS.includes(raw.kind as Kind) ? (raw.kind as Kind) : null;
  if (!kind) return { error: `kind "${String(raw.kind)}" is not one of ${KINDS.join(", ")}` };
  const subject = str(raw.subject, 80);
  if (!subject) return { error: "no subject" };
  const queries: string[] = [];
  for (const q of list(raw.queries)) {
    const text = str(q, 200);
    if (text.length < 3) { rejected.push(`query ${JSON.stringify(q)}: empty`); continue; }
    if (/https?:\/\//i.test(text)) { rejected.push(`query "${text}": contains a URL`); continue; }
    if (queries.some((x) => x.toLowerCase() === text.toLowerCase())) continue;
    if (queries.length >= LIMITS.queries) { rejected.push(`query "${text}": over the limit of ${LIMITS.queries}`); continue; }
    queries.push(text);
  }
  if (!queries.length) return { error: "no usable search queries" };
  const criteria = list(raw.criteria).map((c) => str(c, 300)).filter(Boolean).slice(0, LIMITS.criteria);
  return { kind, subject, subjectSummary: str(raw.subjectSummary, 600), objective: str(raw.objective, 600) || `Find ${kind} for ${subject}.`, criteria, queries, rejected };
}

// ── Selection ───────────────────────────────────────────────────────────────────────────────────

export interface ResultRef { ref: string; sourceId: string; url: string; title: string; text: string; query: string }

export function selectionPrompt(input: { kind: Kind; subject: string; objective: string; criteria: string[]; results: ResultRef[]; mayRefine: boolean; searched: string[] }) {
  return {
    system: [
      "You choose which web search results deserve a closer look for PersonalOS research. You do not browse; PersonalOS will read the chosen organizations' own pages next.",
      `Choose up to ${LIMITS.candidates} distinct organizations that plausibly match the objective. Use only the results given, by their ref, and choose the result that is the organization's OWN site: an organization that appears only in someone else's article or list cannot be chosen through that page. Skip directories, forums, encyclopedias, research papers, news and the subject itself.`,
      input.kind === "prospects" ? "Looking for buyers: skip organizations that sell a product like the subject (they are competitors)." : "",
      input.mayRefine
        ? `If the results are thin or off-target, propose up to ${LIMITS.refinements} better search queries in "refine" (different from those already run); otherwise leave it empty.`
        : 'Leave "refine" empty: no more searches will run.',
      'Answer with JSON only: {"candidates": [{"ref": "R3", "name": "Organization name", "why": "one sentence, from the result"}], "refine": ["..."]}',
    ].join("\n"),
    user: [
      `Looking for: ${input.kind} — ${input.objective}`,
      `Subject: ${input.subject}`,
      input.criteria.length ? `Criteria:\n${input.criteria.map((c) => `- ${c}`).join("\n")}` : "",
      `Searches already run: ${input.searched.map((q) => `"${q}"`).join(", ")}`,
      `Results:\n${input.results.map((r) => `${r.ref} ${r.url}\n   ${r.title}${r.text ? `: ${r.text.slice(0, 280)}` : ""}`).join("\n")}`,
    ].filter(Boolean).join("\n\n"),
  };
}

export interface Selected { domain: string; name: string; sourceIds: string[]; why: string }

/**
 * Whether a result's domain is plausibly the named organization's own site: the domain's name and the
 * organization's name share their letters ("Encore.ts" encore.dev, "Sourcetool" trysourcetool.com).
 * An organization named on someone else's page (a list, an article) is not given that page's site.
 */
export function ownSite(name: string, domain: string): boolean {
  const label = domain.split(".")[0]!.toLowerCase().replace(/[^a-z0-9]/g, "");
  const words = name.toLowerCase().replace(/\(.*?\)/g, " ").split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  const joined = words.join("");
  if (label.length < 3 || !joined) return false;
  return joined.includes(label) || label.includes(joined) || words.some((w) => label.includes(w) && w.length >= 4);
}

export function acceptSelection(raw: Record<string, unknown> | null, results: ResultRef[], options: { mayRefine: boolean; searched: string[]; excludeDomains: string[] }): { candidates: Selected[]; refine: string[]; rejected: string[] } | { error: string } {
  if (!raw) return { error: "the answer was not a JSON object" };
  const byRef = new Map(results.map((r) => [r.ref, r]));
  const exclude = new Set(options.excludeDomains);
  const rejected: string[] = [];
  const candidates: Selected[] = [];
  for (const c of list(raw.candidates)) {
    const x = c as { ref?: unknown; name?: unknown; why?: unknown };
    const r = byRef.get(String(x.ref));
    if (!r) { rejected.push(`candidate ref ${JSON.stringify(x.ref)}: not one of the results`); continue; }
    const domain = domainOf(r.url);
    if (!domain || notAProspect(domain) || exclude.has(domain)) { rejected.push(`${r.url}: a directory, forum or the subject's own site`); continue; }
    const named = str(x.name, 200) || domain;
    if (!ownSite(named, domain)) { rejected.push(`${named}: named on ${domain}, which is not its own site (its site was not among the results)`); continue; }
    const existing = candidates.find((k) => k.domain === domain);
    if (existing) { if (!existing.sourceIds.includes(r.sourceId)) existing.sourceIds.push(r.sourceId); continue; }
    if (candidates.length >= LIMITS.candidates) { rejected.push(`${domain}: over the limit of ${LIMITS.candidates}`); continue; }
    candidates.push({ domain, name: named, sourceIds: [r.sourceId], why: str(x.why, 500) });
  }
  // Every other result from a chosen organization's domain is its evidence too.
  for (const r of results) {
    const k = candidates.find((c) => c.domain === domainOf(r.url));
    if (k && !k.sourceIds.includes(r.sourceId)) k.sourceIds.push(r.sourceId);
  }
  const refine: string[] = [];
  if (options.mayRefine) {
    for (const q of list(raw.refine)) {
      const text = str(q, 200);
      if (text.length < 3 || /https?:\/\//i.test(text) || options.searched.some((s) => s.toLowerCase() === text.toLowerCase()) || refine.includes(text)) continue;
      if (refine.length >= LIMITS.refinements) { rejected.push(`refinement "${text}": over the limit of ${LIMITS.refinements}`); continue; }
      refine.push(text);
    }
  }
  return { candidates, refine, rejected };
}

// ── Assessment ──────────────────────────────────────────────────────────────────────────────────

export interface Evidence { ref: string; sourceId: string; url: string; kind: "page" | "search"; status?: string; textKind?: string; title: string; text: string }

export function assessmentPrompt(input: { kind: Kind; subject: string; subjectSummary: string; objective: string; criteria: string[]; candidate: { name: string; domain: string; why: string }; evidence: Evidence[] }) {
  const pages = input.evidence.filter((e) => e.kind === "page");
  return {
    system: [
      "You assess one organization for PersonalOS research, from the evidence given and nothing else. You have not browsed; do not use outside knowledge about the organization.",
      `fit: "high" | "medium" | "low" | "not-a-fit". confidence: "high" | "medium" | "low".`,
      input.kind === "prospects" ? "Looking for buyers: an organization that sells a product like the subject is a competitor, so its fit is not-a-fit (say so in fitSummary)." : input.kind === "competitors" ? "Looking for competitors: an organization that does not offer a product like the subject is not-a-fit." : "",
      "facts: what the organization's own pages say that bears on the objective, as EXACT quotes copied character for character from a page (refs starting with P whose status is read), each 1-2 sentences. Quotes are checked against the page text and any that do not match are thrown away. Never quote search results (refs starting with R): they are summaries, not the page.",
      "rationale: why it is or is not a match, each line citing the refs it rests on.",
      "openQuestions: what the evidence does not establish (for example size, budget, who decides). If a page could not be read, say so instead of guessing what it says.",
      `fitSummary: one sentence: why it fits the objective, or why not.`,
      "offersSimilarProduct: does this organization itself sell or offer a product or platform that does what the subject does (one a buyer would choose instead of the subject)? true or false, from the evidence.",
      'Answer with JSON only: {"offersSimilarProduct": false, "fit": "...", "confidence": "...", "fitSummary": "...", "facts": [{"ref": "P1", "quote": "..."}], "rationale": [{"text": "...", "refs": ["P1"]}], "openQuestions": ["..."]}',
    ].join("\n"),
    user: [
      `Looking for: ${input.kind} — ${input.objective}`,
      `Subject: ${input.subject}${input.subjectSummary ? ` (${input.subjectSummary})` : ""}`,
      input.criteria.length ? `Criteria:\n${input.criteria.map((c) => `- ${c}`).join("\n")}` : "",
      `Organization: ${input.candidate.name} (${input.candidate.domain}). Chosen because: ${input.candidate.why}`,
      pages.length ? "" : "None of its pages could be read.",
      ...input.evidence.map((e) => e.kind === "page"
        ? `${e.ref} page ${e.url} — status: ${e.status}${e.status === "read" ? `\n${e.title ? `Title: ${e.title}\n` : ""}${e.text.slice(0, LIMITS.pageChars)}` : ` (${e.text || "no text"})`}`
        : `${e.ref} search result ${e.url} (${e.textKind === "provider-summary" ? "a search model's summary, not the page" : "the search engine's snippet"}): ${e.title}${e.text ? `: ${e.text.slice(0, 400)}` : ""}`),
    ].filter(Boolean).join("\n\n"),
  };
}

export interface Assessment {
  fit: "high" | "medium" | "low" | "not-a-fit";
  /** The model's reading of the evidence: whether it sells something that competes with the subject. */
  offersSimilarProduct: boolean | null;
  /** Set when the rules overruled the model's fit, and why. */
  overruled?: string;
  confidence: "high" | "medium" | "low";
  fitSummary: string;
  facts: Array<{ sourceId: string; url: string; text: string; kind: "quote" }>;
  rationale: Array<{ text: string; sourceIds: string[] }>;
  openQuestions: string[];
  offered: number;
  rejectedQuotes: number;
}

const FITS = ["high", "medium", "low", "not-a-fit"] as const;
const LEVELS = ["low", "medium", "high"] as const;

/**
 * Accept an assessment: quotes only if verbatim in a page that was read; reasons only with refs that
 * exist; confidence never above what the verified evidence supports (no quote: low; one: medium).
 */
export function acceptAssessment(raw: Record<string, unknown> | null, evidence: Evidence[], kind: Kind = "organizations"): Assessment | { error: string } {
  if (!raw) return { error: "the answer was not a JSON object" };
  const fit = FITS.includes(raw.fit as never) ? (raw.fit as Assessment["fit"]) : null;
  if (!fit) return { error: `fit "${String(raw.fit)}" is not one of ${FITS.join(", ")}` };
  const byRef = new Map(evidence.map((e) => [e.ref, e]));
  const facts: Assessment["facts"] = [];
  let offered = 0;
  for (const f of list(raw.facts)) {
    const x = f as { ref?: unknown; quote?: unknown };
    offered += 1;
    const e = byRef.get(String(x.ref));
    const quote = str(x.quote, 600);
    if (!e || e.kind !== "page" || e.status !== "read" || !quoted(quote, e.text)) continue;
    if (!facts.some((k) => k.text === quote)) facts.push({ sourceId: e.sourceId, url: e.url, text: quote, kind: "quote" });
  }
  const rationale = list(raw.rationale).flatMap((r) => {
    const x = r as { text?: unknown; refs?: unknown };
    const ids = [...new Set(list(x.refs).map((ref) => byRef.get(String(ref))?.sourceId).filter((id): id is string => Boolean(id)))];
    const text = str(x.text, 500);
    return text && ids.length ? [{ text, sourceIds: ids }] : [];
  });
  const claimed = LEVELS.includes(raw.confidence as never) ? (raw.confidence as Assessment["confidence"]) : "low";
  const cap: Assessment["confidence"] = facts.length >= 2 ? "high" : facts.length === 1 ? "medium" : "low";
  const confidence = LEVELS[Math.min(LEVELS.indexOf(claimed), LEVELS.indexOf(cap))]!;
  // What is being looked for decides, by rule, what a competing product means: a vendor of something
  // like the subject is never a prospect, and an organization offering nothing like it is never a competitor.
  const offersSimilarProduct = typeof raw.offersSimilarProduct === "boolean" ? raw.offersSimilarProduct : null;
  let decided = fit;
  let overruled: string | undefined;
  if (kind === "prospects" && offersSimilarProduct === true && fit !== "not-a-fit") { decided = "not-a-fit"; overruled = "it offers a product like the subject: a competitor, not a prospect"; }
  if (kind === "competitors" && offersSimilarProduct === false && fit !== "not-a-fit") { decided = "not-a-fit"; overruled = "it offers nothing like the subject: not a competitor"; }
  return {
    fit: decided, offersSimilarProduct, ...(overruled ? { overruled } : {}), confidence, facts, rationale,
    fitSummary: overruled ? `Ruled out: ${overruled}. (${str(raw.fitSummary, 800)})` : str(raw.fitSummary, 1000),
    openQuestions: list(raw.openQuestions).map((q) => str(q, 300)).filter(Boolean).slice(0, 6),
    offered, rejectedQuotes: offered - facts.length,
  };
}
