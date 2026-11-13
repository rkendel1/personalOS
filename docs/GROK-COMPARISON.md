# PersonalOS compared with Grok: what it does, what it doesn't, what to build

Reviewed 2026-11-13 against the code in this repository (`feltkit/*.ts`, `src/`, `extension/`, `ios/`) and
the docs in `docs/`. **Grok's feature list is the overview you supplied.** I did not check it against xAI's
own pages. PersonalOS statements are from code I read; where I found no code path I say "none found".

> **Planning moved.** This is the feature review. The build order below is superseded by the production
> launch plan in [LAUNCH-ROADMAP.md](LAUNCH-ROADMAP.md).

## The short version

PersonalOS and Grok are built for different jobs.

- **Grok** is a broad, public-facing assistant: live search, X's real-time feed, image and video
  generation, voice, and an agent product (Grok Bot) with its own computers.
- **PersonalOS** is a private assistant of record. It holds your tasks, memory, projects and files, does
  work as *you* under a delegation, and proves every change (who proposed it, who approved it, the receipt).
  It is strong where Grok is thin (accountability, identity, durable work) and thin where Grok is strong
  (real-time information, creation, multimodal input, connectors, breadth).

## Feature matrix

| Grok capability (as you listed it) | PersonalOS today | Gap |
|---|---|---|
| Conversational help, reasoning | Streamed chat with any model via Resolver; threads persist; stop and edit a message (`turn.ts`). A built-in rules assistant works with no model | none, but quality = the model you point at |
| Multi-agent mode | Research runs as a durable pipeline of jobs: plan, search, select, read, assess (`research.ts`). One model per step, rules check its output | **no parallel agents**; steps run in sequence |
| Memory across chats | Yes, and stricter: *confirmed* vs *inferred*, with provenance (`memory.ts`) | recall is **keyword-only**, not semantic (`LIMITATIONS.md`) |
| Custom instructions and Skills | `settings` holds only a display name and a model-assist flag. The system prompt is fixed (`turn.ts`) | **none**: no standing instructions, no reusable skills |
| 30+ languages | Whatever the model supports. The built-in assistant's date and intent parsing is English | partial |
| Shareable threads | None found | **missing** |
| Web, iOS, Android, X | Web app, Chrome side panel, iOS share extension (share only), Multiplayer, X mentions | no Android, no full iOS app |
| Live web search with citations | Only through the `research` pipeline, and it handles three kinds only (prospects, competitors, organizations). `TOOLS` in `turn.ts` has no search tool | **no quick "search the web" in chat** |
| Live X integration (posts, trends, sentiment) | Reads **only the bot's own mentions** and replies to them. No search, no timelines | **missing** |
| Image generation and editing | None | **missing** |
| Text-to-video | None | **missing** |
| Code help | Model can write code in chat. No execution | no code execution |
| Voice mode | None | **missing** |
| File and document Q&A | Upload (10 MB), short-lived links, link to tasks (`documents.ts`). **Nothing reads file contents**: the model's only document tool is `documents.list` (names) | **uploads are stored, not understood** |
| Vision | None found | **missing** |
| Canvas (long-form editing) | Documents can be updated, but there's no drafting surface or inline suggestions | **missing** |
| Connectors, MCP | PersonalOS **is** an MCP server: 13 capabilities over AppPort and MCP, same permissions as the UI. As a client it has only the search, Resolver and X integrations | no email, calendar or messaging connectors (`LIMITATIONS.md`) |
| Automations, scheduled tasks | Reminders, daily check-in, weekly review, all real background jobs that run as you | can't schedule an arbitrary prompt ("research X every Monday") |
| Grok Bot: persistent agents on their own computers | Durable, leased, retried jobs; research and shared-link invocations run later, under your delegation, and the result waits in the app | **no computer-using or sandbox agents**; no agent-to-agent collaboration |

## What PersonalOS has that Grok's overview doesn't mention

1. **Approvals and receipts.** Changing actions are proposals; you approve; each change records who, how and the
   record it was verified against (`_ops.ts`, `actions.ts`). Deletes and forgetting always wait for you.
2. **Delegated authority.** AuthBoundry decides each piece of work under *your* delegation to
   `agent:personalos`. Revoke it and the next request is refused. No shared "bot account" has your power.
3. **Identity separation.** The bot's X token proves nothing about who mentions it. Each author resolves
   only through a link they confirmed (Resolver). Shared conversations never get your private data.
4. **Evidence-first research.** Quotes are kept only if they appear word for word in a page that was read.
   Rules overrule the model (a vendor of the subject is never a prospect).
5. **Model independence.** The model is a Resolver reference. Switch provider with no redeploy, and your
   data and permissions are unchanged.
6. **Many surfaces, one account.** Web, Chrome, iOS share sheet, Multiplayer and X all reach the same
   conversations and tasks.

## Where X differs from Grok on X

Grok answers anyone, in public. PersonalOS on X answers only **linked** authors, replies in public with a
**generic acknowledgement**, and puts the actual result only inside PersonalOS. Posting anything real is
the owner's explicit `publish` act under its own delegation. This is deliberate. It means the bot can't act
as a public Q&A account today.

## Recommended build order

Chosen for impact against effort, using pieces already in the repo.

### Do first
1. **A `web.search` chat tool** that returns cited results, as a read-only tool in `TOOLS`
   (`turn.ts`), backed by the existing `websearch`/`openaisearch` integrations. Closes the biggest
   everyday gap. Keep `research.start` for outcome-style requests.
2. **Understand uploaded files.** A `documents.read` tool (text extraction for PDF and text; image
   input for a vision-capable model). Q&A, summaries and "attach this to the task" all depend on it.
3. **Custom instructions and skills.** Add `instructions` to `settings`, inject it into `systemPrompt`.
   A skill is a named saved prompt the person can invoke. Small, and visible immediately.
4. **Semantic memory recall.** Blocked on a FeltDB text or vector index (already noted in `LIMITATIONS.md`).
   Until then, add embeddings through the model provider, held in a collection.

### Next
5. **Read-side X integration:** `x.search` and a user lookup, as research sources and as chat tools.
   It costs money per call (X pay-per-use), so add per-person limits and show cost.
6. **Scheduled prompts.** Generalize check-ins into "run this request on a schedule", under the
   owner's delegation.
7. **Email and calendar connectors** as `app.integration`s with approvals: reads run at once, sends and
   invites become proposals. This fits the existing approval design better than anything else Grok does.
8. **Shareable read-only conversation links**, owner-controlled and revocable. Needs a privacy review
   first, because answers can quote private memory.

### Later, and bigger
9. **Image generation** through a provider integration, saved as files with provenance.
10. **Voice** (speech in and out) in the web app and the Chrome panel.
11. **Canvas** drafting surface over `documents.update`, with proposals as inline suggestions.
12. **Parallel research agents.** Research is already one job per step, so fan-out plus a merge step is
    a modest change. Add a visible reasoning and sources trail.
13. **Code execution** in a sandbox service, behind an approval.
14. **Video, Android, a full iOS app, persistent computer-using agents.** These are products on their own.
    I'd decide whether PersonalOS should compete here at all.

## Open decisions for you

- **Public or private on X?** Should @considered_done ever answer public, non-private questions (search
  results, public research) as Grok does, or stay a private channel into your own PersonalOS? That decides
  whether items 1, 5 and a "public persona" mode matter for X.
- **Breadth or depth?** Grok's list is wide. PersonalOS's advantage is trust: approvals, delegation, evidence.
  I'd close the *information* gaps (1, 2, 5) and the *personalization* gaps (3, 4) before adding creation
  features (9, 10, 14).
- **FeltKit dependencies.** Items 4 and 10 need FeltKit or FeltDB work (vector index, voice); items 2, 7 and
  9 lean on `app.integration` and files. Tie them to the FeltKit release plan in
  [FELTKIT-CHANGES.md](FELTKIT-CHANGES.md).

## Existing doc to fix

`docs/LIMITATIONS.md` says there is "no web research", but `research.ts`, `websearch` and `openaisearch` exist.
The accurate statement is "research is limited to three outcome kinds, and chat has no search tool".
