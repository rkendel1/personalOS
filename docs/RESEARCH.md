# Research: outcomes, not tool lists

Ask PersonalOS for an outcome: "Find potential customers for FeltKit", "Which companies would pay for
something like FeltKit?", or "Who are FeltKit's main competitors?". It plans the research, searches the web,
reads the most promising organizations' own sites, and assesses each one against the plan. It keeps every
quote with its link, separate from the assessment. It never contacts anyone.

## How a request runs

```
"Who are FeltKit's main competitors?"
   │  routing    with a model: the turn's model proposes research.start; PersonalOS checks research.run
   │             and starts it with the person's own words. Without a model: the rules recognize
   │             "find customers for X" (_research.ts outcomeOf); anything else needs the model.
   │  discovery  each need checked against FeltKit's catalog before anything runs (_capabilities.ts)
   ▼
research run (researchRuns), then one step per AppPort Services job (research.step → research:step).
Jobs are durable, leased, retried, and run as the run's owner. Each step commits through
researchstate.advance, which applies only if the run is still where the step found it.
   planning   model proposes kind, subject, criteria, ≤6 searches     → rules accept/reject (_researchmodel.ts)
   searching  one search per step, through whichever provider is ready → researchSources (search)
   selecting  model picks ≤8 organizations from the results, ≤2 refined searches (once) → rules check refs
   reading    one organization per step: ≤2 of its own pages            → researchSources (page, with status)
   assessing  one organization per step: model fit + quotes            → quotes checked verbatim; prospects
   finishing  ranked results and the reply in the conversation
```

A transient model refusal (a rate limit) is waited for: the same step runs again 15 s later, growing, up to 4 times; exhausted credit or a refused key is not. Without a model, or when the model's answer for a step is unusable, that step is done by the rules:
planned queries, keyword ranking, and keyword-matching sentences as quotes. The record says which was
used and why. An unusable plan for a request the rules don't recognize stops the run, and the run says why.

## What the model may and may not do

| The model proposes | The rules decide |
|---|---|
| kind (prospects / competitors / organizations), subject, criteria, searches | kind from a fixed set; ≤6 queries, no URLs, no duplicates; anything else rejected and listed in `plan.rejected` |
| which results to look at, and refined searches | only refs the search returned; the result must be the organization's **own site** (an organization named in someone else's article is not read there); never directories, encyclopedias or the subject's own site; ≤8; ≤2 refinements, once |
| whether it offers a product like the subject | a rule, not the model's fit: a vendor of something like the subject is never a prospect, and an organization offering nothing like it is never a competitor (`overruled` says so) |
| fit, quotes, reasons, open questions | a quote is kept only if it appears word for word (ignoring spacing and case) in a page that was **read**; never a search summary; reasons must cite evidence that exists; confidence is capped by the verified quotes (none: low; one: medium) |

The model never runs a search, reads a page, or writes state. Every model answer is a recorded FeltKit
generation on the run's agent task (`run.taskId`), and the plan, the selection and each assessment cite
their `generation`.

## Web search: one need, replaceable providers

`_search.ts` lists the providers in order of preference. Each is a FeltKit integration operation: its
endpoint and key live in configuration and credential custody, never in code. Discovery picks the first
one that is ready, before anything runs.

| Provider | Integration | Configuration | What its result text is |
|---|---|---|---|
| Brave Search | `websearch.search` | `WEBSEARCH_URL=https://api.search.brave.com`, credential `websearch` | `search-snippet` (the engine's extract) |
| OpenAI web search | `openaisearch.search` (Responses API, `web_search` tool) | `OPENAISEARCH_URL=https://api.openai.com` (or `https://ai-gateway.vercel.sh` with `OPENAISEARCH_MODEL=openai/gpt-4.1-mini`), credential `openaisearch` | `provider-summary` (a model's sentence: used to choose, never quoted) |

An OpenAI search result is a page the search itself returned (`web_search_call.action.sources`) or cited
(`url_citation`). A URL the model merely mentions is not a result. Tracking parameters are removed. The
operation's input admits only the `web_search` tool, so its key cannot be used for anything else. When no
provider is ready, the blocker lists what each one lacks. A provider error (401, 429, 5xx) is stored on
the query, with how many attempts were made.

## Page reading

`_pages.ts` reads public pages: http(s) on ports 80 and 443 only, resolving to public addresses only,
with every redirect hop checked. It honours `robots.txt`, has a 12 s timeout, and reads at most 1.5 MB and
20,000 characters of text. Each page is stored with what happened to it:

| status | meaning |
|---|---|
| read | readable text was extracted |
| unavailable | DNS, connection, timeout, or an HTTP error status (kept) |
| extraction-failed | it answered, but no readable text came out (script-rendered, PDF, image) |
| not-allowed | private or local address, another port, or robots.txt says no |

Only a page that was read can be quoted. If no page of an organization was read, the result says it
rests on search results alone. A "not a fit" verdict says what it rests on.

Reading the open web is application code, not a FeltKit integration, because an integration has one
fixed base URL. See "Platform gaps".

## Evidence and assessment

- **Sources** (`researchSources`): search results (provider, query, rank, text kind) and pages (status,
  HTTP status, detail, text). They are never edited.
- **Facts** on a result: `quote` (verbatim from a page that was read, with its source id and URL) or
  `search-result` (what a search returned, marked as such).
- **Assessment**: `basis` is `model` (with its generation, and how many offered quotes failed the check)
  or `rules`. It gives fit, confidence, a summary and reasons citing sources. Organizations ruled out are
  kept on the run (`candidates[].verdict`).
- **Usage** (`run.usage`): model generations and tokens, search calls, failures and the provider's own
  tokens, pages requested and read, quotes offered and verified. **Steps** (`run.steps`): one line per
  step with its time.

## Stop, retry, restart

- **Stop** ("stop research", or Stop on the Research tab): no step after it applies, and what was found is kept.
- **Retry**: re-discovers providers, re-runs failed searches and failed organizations, and continues
  from where the run stopped.
- **Restart**: a step interrupted by a crash is re-run by the jobs worker when its lease expires. Its
  commit is compare-and-set, so a duplicate step changes nothing.

## Live validation

`node scripts/research-live.mjs <outDir>` (with `OPENAI_API_KEY`) runs `feltkit dev` with the real
model, real OpenAI web search and the real web. It asks three requests in the conversation, kills and
restarts the server mid-run, stops and retries a run, and writes measurements to `research-live.json`.
The latest run's results are in `docs/RESEARCH-LIVE.md`.

## Tests

- `tests/research.test.ts`: the rules path end to end (Brave-shaped provider), page outcomes, missing,
  refused and failing providers, stop and retry, ownership, discovery, and the model's context.
- `tests/research-model.test.ts`: a differently phrased competitor request routed by a model, the model's
  plan and selection, OpenAI-shaped search, page reading, and assessment. It covers a fabricated quote
  that is dropped, an invented ref that is rejected, a negative finding, unusable model answers, and
  compare-and-set against duplicate or stopped steps. The model and providers are local stand-ins.
- `tests/pages.test.ts`: the real page reader against a local server (read, HTTP error, script-rendered,
  non-HTML, robots.txt, redirects, private addresses).
- `e2e/research.mjs`: the rules flow in Chromium against `feltkit dev`.

## Platform gaps (FeltKit)

- No open-web read capability: an integration has one fixed base URL, so page reading is PersonalOS code.
- `ctx.agent.catalog()` leaves out `expose: false` operations, so an app-only provider can't be
  discovered with its readiness. `openaisearch` is therefore a catalog capability, permission-scoped
  like Brave.
- Mutations have no model. Model steps run as actions, which jobs can call, so no workaround was needed.
