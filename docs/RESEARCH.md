# Research: outcomes, not tool lists

Ask PersonalOS for an outcome, such as "Find me some new customers for FeltKit." It pursues the outcome
with what the platform can actually do. It does not limit itself to the tools a model turn happens to be
given, and it does not turn the request into tasks for you.

## How a request runs

```
"Find me some new customers for FeltKit"
   │  outcome  (_research.ts outcomeOf): a prospect search for FeltKit, not "create tasks"
   │  discover (_capabilities.ts): each need checked against the platform's catalog
   │           (ctx.agent.catalog: what exists, whether you may use it, whether it is configured)
   ▼
research run (researchRuns): the objective, plan, discovery and status, in the conversation
   │  research agent (research.ts): one step at a time, durable; you can stop and retry between steps
   │    search ──► websearch integration (FeltKit; key in credential custody) ──► researchSources
   │    …
   │    prospects ◄── built from the stored sources only (_research.ts prospectsFrom)
   ▼
prospects: facts (what each source said, with its link) apart from the assessment (how it was reached)
```

The model never decides what PersonalOS can do. With a model, its context is the discovered landscape
and the old fixed list of limits is gone. Without a model, the same research runs. "Can you search the
web?" is answered from discovery in both modes.

## What a need can be

| State | Meaning | What you see |
|---|---|---|
| available | in the catalog, permitted, configured | it runs |
| needs-configuration | declared, but its endpoint or key is missing | the exact setting to add; the request is kept as the objective |
| needs-authorization | declared, but your account may not use it | who can grant it |
| connectable | no provider declared; an HTTP API can be connected (Studio → Integrations) | how |

A missing optional need, such as page retrieval or contact research, limits the result instead of
blocking it. Each prospect says what was not verified.

On a FeltKit without `ctx.agent.catalog` (0.3.26 and earlier), PersonalOS discovers from its own
declarations (`app.integrations`). It says "declared; checked on first use", and the first call
establishes configuration and permission. The outcome is the same either way: it runs, or stops with
the exact blocker.

## Web search

Web search is the `websearch` integration (`feltkit/app.ts`). It calls the Brave Search API's web search,
`GET /res/v1/web/search?q=&count=`, with the key in `X-Subscription-Token`. Results are read from
`web.results[]`, using each result's title, url, description and extra_snippets. The provider is
configuration:

- `WEBSEARCH_URL`: `https://api.search.brave.com`, or any service that answers the same request.
- The credential `websearch`: `feltkit credential set websearch`, or `FELTKIT_CREDENTIAL_WEBSEARCH`.

Until both are set, research says web search is "declared, not configured" and names what is missing.

## Evidence and assessment

- **Sources** (`researchSources`) are what the provider returned for each search: URL, title and text,
  with the query and the time. They are never edited.
- A prospect's **facts** quote its sources, one per page, each with its source id and link.
- A prospect's **assessment** is labelled `basis: "rules"`. It is a match between your own saved
  statements about the product and the cited sources. Generic words never count. It gives a fit,
  confidence and rationale, and each rationale line cites its sources. It is not a judgment of the
  company, and it says what was not verified (only search-result text was read; size, stage and stack
  are unknown; nobody was contacted).
- The profile it works from is your own memories that mention the product. With none, it searches
  from the name and says so.

## What it never does

It never contacts anyone. Outreach is a recommended next action, and a consequential capability would
wait for your approval. A provider is never connected by itself, and no key is created for one. It never
shows results it did not get: a run that found nothing says so, and a stopped run keeps only what it
found.

## Tests

- `tests/research.test.ts` covers:
  - the acceptance scenario;
  - the missing provider;
  - a refused key;
  - transient and persistent provider failures;
  - cancellation and retry;
  - ownership;
  - the model's context;
  - the no-model answer.

  It runs on both kinds of FeltKit. The search provider is a local server answering Brave's request
  and response shape. It stands in for the external provider only.
- `e2e/research.mjs` is the same flow in Chromium against `feltkit dev`.
