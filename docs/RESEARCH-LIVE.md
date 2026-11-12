# Research against the real world: measured results (2026-11-12)

These are live results from `node scripts/research-live.mjs`. The raw data is
`docs/evidence/research-live-2026-11-12.json`. Nothing here is a stand-in:

- **Model:** `openai/gpt-4.1-mini` through Vercel AI Gateway (FeltKit's `custom` provider). The key was
  in FeltKit credential custody, set in the server's environment only.
- **Web search:** OpenAI's web search (Responses API `web_search` tool) through the same gateway, via
  the `openaisearch` integration. Brave was **not** exercised live: no Brave key was available.
- **Pages:** real company sites, read by `feltkit/_pages.ts`.
- **Server:** a real `feltkit dev` process, driven over HTTP as the owner. Requests went in through the
  conversation (`turn:turn`), as a person's would.

The OpenAI account itself had no credit left (every endpoint answered 429 `insufficient_quota`). The run
before the gateway switch showed research degrading correctly: the plan fell back to the rules, with the
provider's error recorded as evidence, and the searches still ran.

## The three requests

| | Request | Routed by | Kind (model's plan) | Status | Results |
|---|---|---|---|---|---|
| 1 | "Find potential customers for FeltKit" | rules (the phrase is recognized); model planned | prospects | completed (after a SIGKILL restart) | 2 |
| 2 | "Which companies would actually pay for something like FeltKit? I want a short list worth reaching out to." | the model's `research.start` proposal | prospects | completed (after stop and retry) | 1 |
| 3 | "Who are FeltKit's main competitors?" | the model's `research.start` proposal | competitors | completed | 5 |

## Measurements (final run)

| | Customers | Customers, rephrased | Competitors |
|---|---|---|---|
| Searches ok / made | 6 / 6 | 6 / 6 | 6 / 6 |
| Search results | 73 | 74 | 74 |
| Organizations chosen / rejected by rules | 4 / 4 | 4 / 4 | 5 / 3 |
| Pages read / requested | 6 / 8 | 4 / 8 | 7 / 7 |
| Page failures | 2 × HTTP 403 | 2 × robots.txt, 2 × HTTP 403 | none |
| Quotes verified / offered by the model | 12 / 18 | 9 / 11 | 19 / 39 |
| Ruled out after reading | 2 (competitors) | 3 (competitors) | 0 |
| Model calls, tokens in / out | 6, 15.7k / 2.9k | 6, 13.2k / 2.3k | 7, 17.3k / 4.4k |
| Search tokens in / out | 45.9k / 3.7k | 40.9k / 3.8k | 43.4k / 4.0k |
| Model cost reported by the gateway | $0.011 | $0.009 | $0.014 |
| Estimated total (search at an assumed $0.01/call) | ~$0.10 | ~$0.09 | ~$0.10 |
| Wall time | 107 s | 101 s | 95 s |
| Time searching / assessing | 30 s / 20 s | 42 s / 17 s | 36 s / 31 s |

Across the three complete live scripts through the gateway (9 research runs; the first two scripts
came before the fixes below), 57 searches were made. 3 hit transient errors (gateway rate limits) and
succeeded on a later attempt. Of the quotes the model offered, 88 of 259 (34%) were not found word for
word in the page they cited, and were dropped.

## Restart, stop, retry

- **Restart:** during run 1, `feltkit dev` was killed (SIGKILL, the whole process group) in the reading
  phase, and started again on the same state. The run continued from the same step, and its next step
  committed 32.7 s after the kill, once the job's lease expired. In an earlier run this took 5.6 s. It
  completed with no duplicate steps (each commit is compare-and-set).
- **Stop:** run 2 was stopped after 1 of 6 searches. 15 seconds later it had taken no further steps (2
  before, 2 after), and 5 searches were still pending. **Retry** ran the 5 remaining searches and finished
  the run.

## Example output, with provenance

**Competitors** (run 3), rank 1: **Appwrite** (https://appwrite.io). Fit high, confidence high, model
assessment, cites its generation.

> "Appwrite is an open-source developer platform with Auth, Databases, Storage, Functions, Messaging,
> and Sites. The open-source cloud for agents and developers." (https://appwrite.io/home, read 200,
> quote verified against the stored page text)

The rest of run 3: Wasp, AxioDB, Appsmith and Stacks, all high fit and each with verified quotes from its
own site. Rejected by the rules before reading: AWS Blocks (named on amazon.com) and Trigger.dev (named
on agentindex.app), because neither page was the organization's own site, and a GitHub repository.

**Customers** (run 1), rank 1: **ICF** (https://icf-c.com). Fit high, confidence high.

> "Internal CLIs and developer tools Kubernetes controllers and operators GitHub Actions and Terraform
> helpers Automation for the steps nobody documents" (https://icf-c.com/services/internal-tooling)

Ruled out after reading: Microsoft Teams platform and Jinba. Each offers a product like FeltKit, so it is
a competitor and not a prospect.

## Quality: honest assessment

My own review of the results:

- **Competitor research is useful.** All five results are real, relevant products: TypeScript full-stack
  or backend platforms, embedded databases for agents, internal-tool builders. Each is evidenced from its
  own site.
- **Customer research is precise but thin.** The two fixes below removed the false positives, but what
  is left is small and partly weak:
  - ICF is a plausible prospect.
  - TeamAI and BuildPiper rest on unread pages or no quotes, and say so with low confidence.

  Web search for "who needs X" mostly returns vendors and articles, not buyers. Better customer discovery
  needs different sources, such as hiring data, company databases and case studies. That is a capability
  to connect, not a prompt.

## What the live runs found, and what was fixed

Each fix has a test (`tests/research-model.test.ts`, `tests/research.test.ts`):

1. **A long provider error made the planning step fail validation and retry forever.** The rejection
   reason was longer than its field. Recorded reasons are now bounded, and the run degrades to the rules.
2. **Organizations named in someone else's article were read on that site.** For example, NocoBase was
   read on libhunt.com and Nimbl on tooljet.com. Selection now requires the chosen result to be the
   organization's own site.
3. **Customer research returned vendors of similar products**: Windmill, Ciao, Relpin and Sourcetool,
   all rated high-fit. The model now reports whether the organization offers a product like the subject,
   and a rule decides: a vendor is never a prospect, and a non-vendor is never a competitor.
4. **A gateway rate limit (5 requests/min) made a step fall back to rules.** A transient model refusal
   now waits and retries (15 s, growing, up to 4 times). Exhausted credit does not wait. Transient search
   failures back off too.
5. **Rules and model scores were ranked on different scales.** All results are now ranked by fit, then
   confidence, then verified quotes.

## Not verified live

- Brave Search: no key. It is covered against a local server answering Brave's shape.
- OpenAI directly: the account had no credit. The same integration works against the gateway, the same
  Responses API.
- Production (`feltkit start`) and multiple users: the live run was one owner on `feltkit dev`.
