# The web in Anywhere Aide: capabilities, not a browser dependency

Dated 2026-11-20. What Anywhere Aide does with the web, which code does it, and the evidence for not adding a
server-side browser or a hosted browser provider.

## The capabilities

Each one is a different job, run in a different place, under different authority. They are not one generic
"browser".

| Capability | What it does | Where it runs | Authority | Code |
|---|---|---|---|---|
| `web.search` | find pages for a query | server, through a search provider (Brave Search API, or OpenAI web search) | the person's account; the provider's key is held by FeltKit | `feltkit/web.ts`, `_search.ts` |
| `web.read` | read one public page: title, extracted text, or exactly why it couldn't be read | server, plain HTTP plus HTML extraction (`readPage`) | the person's account; public addresses only; robots.txt honoured | `feltkit/web.ts`, `_pages.ts` |
| read the page I'm viewing | the page as the person sees it, after scripts have run and while they're signed in | the person's own browser: the Chrome extension, or Safari through the iOS share sheet | their own browser session; no credential reaches the server | `extension/public/content.js`, `extension/src/pagebar.tsx`, `ios/ShareExtension/Preprocess.js` |
| interact with a site (click, fill, submit) | none | none | none | **not a capability**: not built, and nothing needs it yet |

The model is offered `web.search` and `web.read`. The built-in assistant, without a model, handles
"search the web for …", "read <url>" and a bare link. The app, the extension and the model all reach the same
functions. Research uses the same page reader (`pageReader` in `_pages.ts`), so fetching and extraction exist
once.

## What every read keeps

`web.read` records every outcome, whether or not the page was read, in `pageReads`. Each record holds:

- the URL asked for and the final URL after redirects;
- the status: `read`, `unavailable`, `extraction-failed` or `not-allowed`;
- the HTTP status and the reader's reason;
- the extracted text, which is what the person or the model was given;
- how long it took, which reader read it, who asked (`chat`, `model` or `app`), and the conversation.

Research already records the same fields for its pages, in `researchSources`. `web.outcomes` puts both
together, so how reading works out in real use is measured from records, not estimated.

A page that wasn't read reaches the model with no text, only the reason, so the model can say why but has
nothing to describe.

## Evidence, in the order the options were weighed

**1. Plain HTTP and HTML extraction: in production already.** The recorded live research run
(`docs/evidence/research-live-2026-11-12.json`) asked for 23 pages and read 17. The 6 failures:

| Outcome | Count |
|---|---|
| HTTP 403 | 3 |
| refused by robots.txt | 2 |
| HTTP 404 | 1 |
| no readable text (page needs scripts to render) | **0** |

**2. Browsing capabilities the app already has.** The extension reads the rendered page, signed in, in the
person's own Chrome. The iOS share sheet passes the page address and the person's selection from Safari. These
cover script-rendered pages and signed-in pages without the server holding anyone's credentials.

**3. Chromium run by us (Playwright).** It is in `e2e/` only. It isn't a dependency in the lockfile, and the
deployed image has no browser. On 2026-11-20 the three 403 pages were fetched again, both ways:

| Page | Plain HTTP | Local headless Chromium |
|---|---|---|
| Appian investors page | 200, about 35 KB of text | 403 |
| TeamAI page 1 | 403, a bot-check page | 403 |
| TeamAI page 2 | 403, a bot-check page | 403 |

The Appian 403 in the recorded run was transient or depended on the User-Agent. Headless Chromium did worse
than plain HTTP.

**4. A browser automation service we host ourselves.** It would fail the same way as option 3, with more
infrastructure to run.

**5. Hosted browser providers.** The one thing options 1–4 cannot do is get past a site's bot check. The
providers do it with challenge solving and residential IP addresses. That means overriding the site's stated
choice to keep automated readers out, which is the same kind of refusal as robots.txt, and Anywhere Aide
honours that. So it doesn't justify an external dependency.

**Limits of this evidence.** It is 23 pages from one research run, plus three URLs fetched again from this
development container, whose traffic goes through a proxy; Fly's network may get different answers. It
doesn't establish a general success rate. `web.outcomes` keeps the count as real use accumulates.

## What would change this

- **A server-side browser engine (option 3) is justified** if recorded outcomes show a meaningful share of
  `extraction-failed` pages ("only N characters of readable text": a page that needs scripts to render) that
  the person can't send from their own browser. It would sit behind the same `pageReader`, as a second reader
  that is tried only for those pages. Callers and records wouldn't change.
- **`web.interact` exists** once a real workflow needs a site to be clicked or filled in for the person. It
  would be a consequential capability: proposed, approved by the person, and recorded, like `email.send`.
- **Reading the current page from the chat.** Today the person sends it from their browser. The server can't
  pull it, and shouldn't: the browser is the person's, and so is the session in it.

## Not yet

- **External agents (AppPort / MCP) can't call `web.read` or `web.search` directly.** FeltKit doesn't allow
  an action as a capability: only a query or a mutation, and those can't make outbound requests. External
  agents get web reading through `research.start`. If they need a single page read, the FeltKit-shaped way is
  a mutation that queues the read and a query for its record.
- **`web.outcomes` is per person.** An operator-wide view isn't built.
