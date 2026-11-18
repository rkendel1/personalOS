# What a person can delegate to PersonalOS: capabilities and roadmap

**Status:** research only. Nothing was implemented, versioned, deployed or published for this report.
**Dated:** 2026-11-18.
**Read at:**

| Repository | Commit or version |
| --- | --- |
| PersonalOS | `e471bde` (`@feltdb/feltkit` 0.3.33) |
| eve2 | `f8ce3d0` |
| FeltKit | main `c3bef54` |
| AppPort Services | 0.20.0, the published package (the `appport` checkout does not contain the services source) |
| FeltDB | `0f5049e` |
| AuthBoundry | `3945f49` |
| Resolver | 0.4.1 |

This complements [LAUNCH-ROADMAP.md](LAUNCH-ROADMAP.md), which covers surfaces, onboarding and billing. This document covers **what the agent can do for a person**. eve2's `research/runtime-dependency-resolution.md` stays proposed and unimplemented.

**Evidence conventions**
- **Paths** are relative to PersonalOS unless prefixed:
  - `eve:` is `rkendel1/eve2`;
  - `agent:` is `eve2/examples/appport-agent`;
  - `FK:` is `feltkit/packages/sdk`;
  - `SVC:` is the published `@appport/services` 0.20.0;
  - `AB:` is `authboundry`.
- **Test names** are quoted exactly.

**Test evidence run for this report (2026-11-18):**
- **PersonalOS `feltkit test`:** 166 tests, 166 passed, 0 skipped. A model key was present, so "real model: the acceptance conversation" ran against a live model.
- **eve agent suite against this PersonalOS:** 160 of 160 passed. `PERSONALOS_DIR` and `FELTKIT_SDK_DIR` were set.
- **Test names** quoted from eve and FeltKit were read from source, not run for this report.

---

## 1. The answer

**Today a person can delegate their personal organization and research to PersonalOS. They can trust what it did, because every change is authorized, approved where it matters, and recorded with evidence.** In practice, it:
- manages tasks, recurring tasks and reminders;
- remembers what it is told, and says how it knows;
- keeps projects and their files;
- researches a question with verified quotes;
- takes captures from the iPhone share sheet and Chrome;
- sends a daily check-in and a weekly review.

**Hand off and walk away, today, means Multiplayer or X.** From those two, a request becomes durable, multi-step eve work that:
- runs under the person's own grants;
- survives restarts;
- never performs the same write twice;
- ends only with evidence.

**Not yet possible:**
- handing work to eve **from the PersonalOS app itself**;
- reading what is **inside** documents;
- searching across everything;
- hearing back **outside** the app;
- using the person's **calendar or e-mail**;
- having the agent **keep working on its own** over days.

**The platform already holds most of the parts:**
- **eve:** durable questions and approvals that resume the same turn, cancel, steering, a resumable progress stream, per-user schedules and subagents.
- **FeltKit:** person-owned OAuth connections, server-side approval, file bytes, substring search.
- **AppPort Services:** an e-mail notification channel.

**The gaps are mostly wiring and a few small, correctly placed contracts, not new systems.**

**The smallest set of changes that gets there:**

| # | Change | Owner |
| --- | --- | --- |
| 1 | Make any conversation delegatable: the eve work channel exposes questions, answers and cancel; PersonalOS shows them | eve agent, PersonalOS |
| 2 | Let the agent read what the person has: document text and cross-collection search, as delegable capabilities | PersonalOS (search, text documents), AppPort Services Files (PDF and Office text) |
| 3 | Let it reach the person: notification channels and preferences | AppPort Services, FeltKit |
| 4 | Let it use the person's accounts: calendar and mail through FeltKit person-owned connections, with sends approved server-side | PersonalOS, FeltKit |
| 5 | Let it keep going: standing schedules and a durable principal for work while the person is away | eve, FeltKit |

---

## 2. How a request is handled today

| Entry point | Who answers | Durable after disconnect | Evidence |
| --- | --- | --- | --- |
| PersonalOS chat (web, iOS app, Chrome panel) | **PersonalOS's own assistant.** Rules first, then the model proposes and the person approves (`feltkit/turn.ts:89-134`) | **No.** The turn is request-scoped and a dropped stream is cancelled (`docs/LIMITATIONS.md:26-27`). Research it started continues as jobs. | "the acceptance conversation: reply streams, the reminder is proposed (approval required)…" |
| Today and Projects "ask" | The deterministic `assistant.send` (`src/App.tsx:139-142`) | Single transaction | "DoD 7-8: what needs attention today, from durable state" |
| iPhone share sheet and Chrome capture | The `invocations` job: save, research, answer or assistant (`feltkit/invocations.ts:47-83`) | **Yes** (job) | "recovery: processing interrupted after it began (a crash) finishes on the job's next run, once" |
| **Multiplayer** | **eve**, when `PERSONALOS_AGENT_URL` is set (`feltkit/interactions.ts:201-223`); otherwise PersonalOS | **Yes** (eve session plus the `anywhere.follow` job, up to 24 h; `feltkit/anywhere.ts:40`) | eve `agent:test/anywhere.test.mjs` |
| **X** | **eve**, when connected (`feltkit/xsurface.ts:371-385`) | Yes | same |
| External agent over delegated `/appport` | The agent itself, under the person's grants | The agent's | "an agent manages Ada's tasks, reminders and briefing only as each capability is delegated to it" |

**eve is reachable only from Multiplayer and X.** It is reached through the `agent` integration, a durable work channel: `POST /work`, `GET /work/{id}`, and a lookup (`feltkit/app.ts:185-231`; `agent:agent/channels/work.ts:114-231`).

**eve acts on PersonalOS only through delegated `/appport`.** It uses three tools: capabilities, contract and invoke. Each call is decided against the person's AuthBoundry grant for that exact capability, and checked against the PersonalOS handler's owner scope (`agent:agent/tools/*`; `FK:src/runtime/runtime.ts:813-846`).

---

## 3. The reported capabilities, checked

| Reported capability | Classification | Evidence (code; test) |
| --- | --- | --- |
| Tasks and task management | **Implemented and tested** | `feltkit/tasks.ts:12-47`; "DoD 5-6…", "\"move that task to Friday\" uses the conversation's context…" |
| Reminders | **Implemented and tested** | `_ops.ts:110-113`, `reminders.ts:11-36`; "DoD 5-6: a reminder from chat becomes a task with evidence, and fires through a real job" |
| Recurring tasks (daily, weekdays, weekly, monthly) | **Implemented, partly tested** | `tasks.ts:18,38`, `_interpret.ts:18`; "…completing a recurring task schedules the next" covers one recurrence |
| Daily briefing and check-in | **Implemented and tested** | `briefing.ts`, `checkins.ts`; "scheduled check-in: a real job posts the briefing into its own thread, notifies, and re-arms for tomorrow" |
| Weekly review | **Implemented and tested** | `weekly.ts`; "weekly review: a real job posts the look back and ahead…" |
| Projects | **Implemented and tested** | `projects.ts:8-29`; "an agent works with Ada's projects and documents only as each is granted…" |
| Document storage and attachment | **Implemented and tested** | `documents.ts`; "Files: upload through a link, attach to a project, download, isolation, delete" |
| Confirmed and inferred memories | **Implemented and tested** | `memory.ts`, `app.ts:416-440`; "volunteered facts are stored as inferred, hedged on recall, and only confirmed by the user" |
| Memory provenance and correction | **Implemented and tested** | "DoD 3-4: …it remembers in a later conversation, with provenance"; "rejecting a proposal changes nothing; forgetting needs approval too" |
| Automatic contextual recall | **Partial: keyword only** | `turnstate.ts:59-67` (top 25 by `relevance()`); `docs/LIMITATIONS.md:7-10` |
| Multi-step cited research | **Implemented and tested** | `research.ts:1-23`; "ACCEPTANCE: \"Find me some new customers for FeltKit\" is discovered, authorized, executed, and saved with its evidence…" |
| Quote verification | **Implemented and tested** | "a quote counts only if it is in the page's text, ignoring spacing, case and typographic quotes" |
| Research cancel and retry | **Implemented and tested** | "cancellation stops between steps and keeps what was found; retry resumes the same objective" |
| iPhone share and Chrome capture | **Implemented and tested** | "iOS contract compatibility…", "ACCEPTANCE (in-process): a browser summon is accepted…" |
| eve delegated work through Multiplayer and X | **Implemented and tested in eve's suite; not tested in PersonalOS** | `anywhere.ts`; `agent:test/anywhere.test.mjs`. PersonalOS has no test that runs it |
| Durable delegated execution and recovery | **Implemented and tested** (eve agent) | `agent:agent/lib/operations.ts`, `work.ts`; the agent's work, idempotency, safety and replacement suites |
| Idempotent writes and evidence | **Implemented and tested** | `_ops.ts:83-88` read-back evidence; FeltKit durable replay (`FK:src/runtime/capabilities.ts:39-41`); "duplicate and replayed delivery execute once (also across a restart)" |
| Approval of model-directed changes | **Implemented and tested** (in-app) | `actions.ts:16-41`; "DoD 9: destructive requests are proposed, wait for approval, and the log shows every step" |
| Agent permissions and revocation | **Implemented and tested.** Settings covers surfaces; agent grants have no screen (`docs/AGENTS.md:98`) | "real AuthBoundry: revoking Ada's delegation stops the next operation"; "local authority: a grant with an end stops by itself" |
| Activity history | **Implemented, partly tested** | Activity screen `src/screens.tsx:429`; the action log is asserted in "DoD 9" |

**Two provenance weaknesses inside otherwise-working features:**
- An approved model proposal is logged as `via: "ui"`; `via: "model"` is never set. Provenance survives only in FeltKit's agent record.
- A share the model classifies as "save" is stored as a **confirmed** memory (`feltkit/invocationstate.ts:180`).

---

## 4. Capability matrix: what a person asks

**Status values:**
- **✔ works** · **◐ partial** · **✖ unavailable** · **?** unverified.

**Priority:**
- **P0** security, authority or integrity;
- **P1** needed for a dependable agent;
- **P2** important capability;
- **P3** enhancement.

### Personal organization

| User request | Today | Result | Path | Status | Gap | Owner | Pri | Acceptance |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| "Remind me to call the dentist Friday at 10." | Task with `remindAt`; a job fires it | Task, a reminder in the inbox | chat → rules or proposal → `_ops` → job | ✔ | Fires only if the person had a session in the last 7 days | FeltKit | P1 | A reminder fires 8 days after the last sign-in |
| "Pay rent on the first of every month." | A monthly recurring **task** and reminder. **No payment is made** | Recurring task | same | ✔ (reminder) / ✖ (payment) | Payment is a real-world action (§5H) | — | — | It never claims to have paid |
| "Organize everything I need to do before the move." | In chat: proposes tasks one at a time. Through eve (Multiplayer or X): creates a project and tasks | Proposals, or created records | turn, or eve `/work` | ◐ | Not delegatable from the app | eve agent + PersonalOS | P1 | From chat, becomes eve work that creates the project and tasks |
| "What's important today?" | Briefing from durable state | Ranked list | `briefing.today` | ✔ | — | — | — | "DoD 7-8" |
| "Review my overdue tasks and suggest what to do next." | With a model: reads `tasks.list` and suggests. Without one: briefing only | A suggestion in chat | turn (read tools run unapproved) | ◐ | No durable review; the suggestion is only text | PersonalOS | P2 | Suggestions become proposals the person can approve |

### Memory and context

| User request | Today | Path | Status | Gap | Owner | Pri |
| --- | --- | --- | --- | --- | --- | --- |
| "Remember my sister's birthday is June 3." | A confirmed memory with source | `memory.add` | ✔ | — | — | — |
| "What do you remember about my preferences?" | Keyword recall, inferred ones hedged | `turnstate.context`, `assistant.ts:178-194` | ◐ | No meaning-based recall | FeltDB (index), PersonalOS (use it) | P2 |
| "What did I decide about the kitchen remodel?" | Memories and project status by keyword. **Conversations are not searched** | `assistant.ts:315-331` | ◐ | No search over conversations or decisions | PersonalOS | P2 |
| "Correct what you remember about my project." | Edit makes it confirmed; forgetting from chat needs approval | `memory.update`, `_ops.ts:259-293` | ✔ | — | — | — |
| "Find everything I've told you about this." | Not available | — | ✖ | No cross-collection search; `ctx.db.search` exists but is not called | PersonalOS (wire), FeltDB (index) | P2 |

### Projects and documents

| User request | Today | Status | Gap | Owner | Pri |
| --- | --- | --- | --- | --- | --- |
| "Start a project for the kitchen remodel." | `projects.create` (proposal in chat, delegable to eve) | ✔ | — | — | — |
| "Read these contractor proposals and compare them." | **Files are stored, never read** (`turn.ts:51`; `documents.ts:16-23`) | ✖ | No text access. `ctx.services.files.read` returns bytes and `text()` (`FK:src/runtime/services.ts:88`), but there is no PDF or Office extraction anywhere | PersonalOS (`documents.read` for text types), AppPort Services Files (derived text for PDF and Office) | P2 |
| "Find all documents related to this project." | `documents.list` by project or task | ◐ | By attachment only, not by content | PersonalOS | P2 |
| "Create a project plan from these notes." | Can create tasks under a project. **Cannot write a document** | ◐ | No `documents.create` or write capability; FeltKit has `files.upload` | PersonalOS | P2 |
| "Update the project document with what we decided." | Only a document's note and attachment change (`documents.ts:55-75`: "Its file is unchanged") | ✖ | No content edits or versions | AppPort Services Files (versions), PersonalOS | P3 |

### Research and analysis

| User request | Today | Status | Gap | Owner | Pri |
| --- | --- | --- | --- | --- | --- |
| "Research heat pumps for a cold climate." | A durable research run with sources and verified quotes | ✔ | Owner-started runs have no budget; the model starts them without approval (`turn.ts:187-193`, `research.ts:270-278`) | PersonalOS | P2 |
| "Compare these three options; which claims are credible?" | Research assesses with checked quotes. Options given as **documents** can't be read | ◐ | Document text | as above | P2 |
| "Strongest evidence for and against this decision." | Possible as a research objective; there is no for/against structure | ◐ | A product shape, not a platform gap | PersonalOS | P3 |
| "Monitor this subject; tell me when something changes." | ✖ | ✖ | No standing research or schedule | eve (schedules), PersonalOS | P2 |

### Delegated execution

| User request | Today | Status | Gap | Owner | Pri |
| --- | --- | --- | --- | --- | --- |
| "Go through my tasks for the move, organize them, research movers." | Works from **Multiplayer or X** through eve. Not from the app | ◐ | In-app handoff | PersonalOS | P1 |
| "Work on this while I'm away; tell me when you finish." | Surfaces: yes, and the result lands in the PersonalOS conversation. Notification is in-app only | ◐ | In-app handoff, notification channels | PersonalOS; Services | P1 / P2 |
| "Ask me if you need a decision, then continue." | eve supports it; the work channel ignores it, so the work sits "running" | ✖ | Wire questions and answers through `/work` | eve agent + PersonalOS | P1 |
| "Stop that and resume it tomorrow." | Research only. Agent work cannot be cancelled. eve has no pause | ✖ | Cancel on `/work`. "Resume tomorrow" means a new request continuing the same work | eve agent + PersonalOS | P1 |

### Connected services and communication

| User request | Today | Status | Gap | Owner | Pri |
| --- | --- | --- | --- | --- | --- |
| "Check my calendar and find time for this." | ✖ | ✖ | No calendar integration. FeltKit person-owned OAuth connections exist and are tested, but are unused | PersonalOS (integration), FeltKit (connections) | P2 |
| "Look through my email for the contractor's proposal." | ✖ | ✖ | Same, for mail | same | P2 |
| "Email the contractor for an updated estimate." | ✖ | ✖ | Mail, plus a server-side approved send | PersonalOS, FeltKit | P2 (P0 constraint) |
| "Add this event to my calendar." | ✖ | ✖ | Calendar write, approved | same | P2 |
| "Notify me when the work is done." | In-app inbox only (`FK:src/runtime/services.ts:1459` hard-wires `in-app`) | ◐ | E-mail and push channels, preferences | AppPort Services, FeltKit | P2 |

### Proactive assistance

| User request | Today | Status | Gap | Owner | Pri |
| --- | --- | --- | --- | --- | --- |
| "Every morning, recommend what to focus on." | The daily check-in posts a deterministic briefing | ◐ | No model or agent review; no recommendations | eve (schedule), PersonalOS | P2 |
| "Watch this project; tell me when it needs attention." | ✖ | ✖ | No standing agent or watch | eve, PersonalOS | P2 |
| "Review my tasks every Friday and prepare a weekly review." | The weekly review exists, deterministic and fixed time | ◐ | The person can't choose the day; no agent analysis | PersonalOS | P3 |
| "Notice when something I committed to is overdue." | The briefing lists overdue items; no alert | ◐ | An overdue trigger and notification | PersonalOS | P3 |

### Advanced delegation and adaptation

| User request | Today | Status | Gap | Owner | Pri |
| --- | --- | --- | --- | --- | --- |
| "Research this, compare options, prepare a decision." | Research yes. A decision document no | ◐ | Document write | PersonalOS | P2 |
| "One agent on the technical side, another on costs." | eve subagents exist and are tested; the agent defines none | ✖ | Not justified until there are distinct toolsets (§5I) | eve agent | P3 |
| "Keep working on this project over several days." | eve sessions can park indefinitely. **PersonalOS stops following after 24 h**; durable work needs a session in the last 7 days | ✖ | Follow window, durable principal | PersonalOS, FeltKit | P1 |
| "Find a better implementation for this capability." | An **operator** re-binds the Resolver reference; the agent uses it without restart and keeps operations pinned (eve agent "replacement" suite, 13 tests) | ✔ (operator) | Not a user request. Resolver accepts a breaking re-pin; the agent refuses it at use | Resolver | P3 |
| "Switch the model without redeploying." | PersonalOS's own assistant: yes (`ref://prod/personalos/model`, `app.ts:113-116`). eve agent: a static model in configuration (`agent:agent/agent.ts:4-7`) | ◐ | eve `defineDynamic` model is public and tested; the agent doesn't use it | eve agent | P3 |

---

## 5. The important gaps, examined

### A. Universal delegation through eve (the first major improvement)

**Already exists:**
- **PersonalOS side:**
  - the `agent` integration, with idempotent submit and lookup verification (`app.ts:193-231`);
  - the durable follow job (`anywhere.ts`);
  - an `interactions` record that carries the agent's state, operations and summary.
- **eve side:**
  - durable sessions;
  - **questions and approvals that pause the turn and resume the same `turnId`** (`eve:docs/tools/human-in-the-loop.md:375-383`), stored as `interaction.opened` / `turn.paused` / `interaction.settled` events (`eve:packages/eve/src/protocol/session-events/families/interaction.ts:101-128`);
  - answers that are re-authorized before an approved call runs ("admits a human-approved workflow call only after rechecking it");
  - stale answers that never authorize ("converts a stale approval into a non-authorizing user message");
  - parked approvals that survive a restart ("renders parked approvals' tools again in the fresh process…");
  - cancel (`POST /eve/v1/session/:id/cancel`; "cancels this session's turn by session id");
  - a resumable progress stream.
- **A custom channel can use all of it:** route handlers get `attachSession(id)` with `respond(answers,{auth})` and `cancel({turnId})` (`eve:packages/eve/src/channel/session.ts:43-48`).

**Missing:**

| What | Owner |
| --- | --- |
| `work.ts` handles no `interaction.opened` or `turn.paused`. A paused turn never settles, so the work stays `running` and the question is invisible | eve agent: `agent:agent/channels/work.ts` |
| No `POST /work/{id}/answers` and no `POST /work/{id}/cancel`. Each should authorize the requester exactly as `GET /work/{id}` does, then call `respond` or `cancel` on the live session | eve agent |
| `GET /work/{id}` exposes no open question and no step progress beyond AppPort operations | eve agent |
| Chat cannot hand off. The `agent` integration has no `answer` or `cancel` operation. Questions are not shown in the conversation. The 24 h follow window (`anywhere.ts:40`) | PersonalOS |
| eve has no "pause". Do not add one: "resume tomorrow" is a new message to the same work, which eve already models as steering or queueing | — |

**Ownership.**
- **eve** owns the lifecycle: parking, resuming the exact operation, cancelling, recording.
- **PersonalOS** owns the experience: what becomes eve work, showing progress and questions, collecting the answer, and where the result lands.
- The answer must travel PersonalOS → `/work/{id}/answers` → `respond` on the **same session**. That is how it resumes the original operation.

**Security constraint (P0 for this slice).**
- eve's own `/eve/v1` session routes do not check session ownership (`eve:docs/guides/auth-and-route-protection.md:323`).
- So **chat delegation must go through `/work`**, whose records check the requester, and never through `/eve/v1`, which stays operator-only.

### B. Long-running and continuous work

**Exists:**
- **eve:**
  - durable `sleep`, hooks and webhooks: "finishes a spec 9 turn that was sleeping when `eve start` was killed";
  - static schedules, tested;
  - **experimental per-user dynamic schedules**, owned by their creator and re-authorized on every firing (`eve:docs/experimental/dynamic-schedules.mdx`);
  - a self-hosted durable provider: "fires a one-time schedule that came due while the server was down, exactly once", "keeps schedule management state across a restart and isolates principals".
- **PersonalOS:** person-owned job chains (reminders, check-ins, weekly review).

**What is not true:** there is no agent that reviews someone's situation and proposes work. The daily check-in is a deterministic summary.

**Blockers:**
1. **FeltKit re-authorizes durable work as its creator's latest active session.** With none (sessions last 7 days and are not refreshed: `FK:src/runtime/sessions.ts:51`; `docs/LIMITATIONS.md`), the work is refused (`FK:src/runtime/runtime.ts:990-1006`; test "a signed-out enqueuer's work is refused").
   - Declared app agents are exempt but act with **their own** roles.
   - AppPort Services jobs accept a `delegationId` that AuthBoundry rechecks every run, **but FeltKit's `enqueue` doesn't expose it.**
   - **Owner: FeltKit.** Expose delegation-bound durable work, so work runs under the person's revocable grant, not their login.
2. **An agent-initiated result has no way into PersonalOS.** eve scheduled runs deliver through a channel (`to(...).send()`). PersonalOS has no delegable capability like "post to my conversation" or "notify me".
   - **Owner: PersonalOS.** A small capability, `conversations.post` / `inbox.notify` for the agent, owner-scoped and delegable.
3. **Scheduled eve turns cannot ask questions** (`ask` returns `unavailable`). Proactive work must therefore end in **proposals**, not actions. That is also the right product rule.

**Ownership.** General scheduling and durable execution belong to **eve**. PersonalOS owns the person's standing instructions and settings, and the experience around results.

### C. Document intelligence

| Piece | Reality | Owner |
| --- | --- | --- |
| Bytes | `ctx.services.files.read(id)` → `{file, bytes, text()}` (`FK:src/runtime/services.ts:88`); hashed and verified on read | FeltKit, exists |
| Plain text and Markdown | Readable today through `text()` | **PersonalOS**: a `documents.read` capability (text types), owner-scoped and delegable |
| PDF, Office and OCR | **None anywhere** (grep of FeltKit and AppPort Services) | **AppPort Services Files**: a derived "text" representation, stored and checksummed beside the file, like FeltKit's image variants. Reusable by every app, so not built in PersonalOS |
| Indexing and search | See D | FeltDB |
| Summaries and comparison | Model work over `documents.read` output, in eve or in the turn, citing document id and version | eve / PersonalOS |
| Creation | `files.upload` exists; PersonalOS has no `documents.create` | PersonalOS |
| Versioning | None (`__version` is concurrency only) | AppPort Services Files |
| Provenance | A document's sha256 and version are available; outputs should cite them | PersonalOS |

### D. Search across personal information

- **Exists:** `ctx.db.search(collection, {text, where, limit ≤ 100})` (`FK:src/runtime/search.ts`).
  - Matching: Unicode-normalized substring terms. No ranking. A scan of at most 50,000 records.
  - Tests: "search: tenant isolation" and others in `FK:test/search.test.ts`.
- PersonalOS declares `search:` fields on five collections and **never calls it**.

**What is possible now (PersonalOS):**
- One owner-scoped `search` capability that fans out over tasks, projects, memories, conversations, research and the action log.
- Results return `{collection, id, version, snippet}`, so every hit is a citable record.
- It answers "find everything I told you about X" by keyword.

**What needs the platform:**
- Ranking and scale need FeltDB's text index. It is tracked as F23 "Open" (`feltkit/docs/UPSTREAM-GAPS.md:79`); the planner's `contains` and `text` index are internal (`flow_db/packages/core/src/index-types.ts`).
- Meaning-based retrieval needs vector search. **None exists** in TypeScript; the Rust vector module is a demo with random embeddings.
- **Owner: FeltDB.**

### E. Communication and notifications

- **Exists:**
  - AppPort Services notifications: durable records, per-channel delivery, retries.
  - An `EmailNotificationChannel` over Mailerport (`SVC:dist/src/notifications/email.d.ts`).
  - FeltKit uses e-mail only for account mail, and **hard-wires app notifications to `in-app`** (`FK:src/runtime/services.ts:1459`).
  - "browser" is an in-page event, not OS push.
- **Missing:**
  - App-selectable channels: **FeltKit**.
  - Push and SMS adapters, plus a preferences and quiet-hours resource: **AppPort Services**. Its docs say there is no preference resource yet.
  - PersonalOS settings for those preferences: **PersonalOS**.
- **The approval request is the most important notification** ("PersonalOS needs a decision"). It should use the same channel as completion.

### F. Human interaction during delegated work

- **Mechanics:** see A. eve already gives:
  - resumption of the exact turn;
  - requester-only answers by default;
  - re-checked policies;
  - withdrawal on cancel;
  - restart survival.
- **Timeouts are not built in.** Race `ctx.ask` against `sleep`.
- **Two kinds of approval must stay distinct:**
  1. **Intent check:** "is this what you meant?" An eve question or tool approval. It is good for steering, **but it is a decision inside the agent, not an authority boundary.**
  2. **Authority check:** "may this happen?" Deterministic and server-side. In FeltKit that means `approval: "required"` mutations, which agents may only *propose*, and which an approved proposal runs as the proposer with no widened rights (tests: "…cannot run it directly on any interface", "approval never widens authority", "approving with the digest of something else approves nothing").
- **Missing contract (FeltKit, P0 before any external send):**
  - Delegated `/appport` **refuses** approval-required capabilities outright (`FK:src/runtime/runtime.ts:821`).
  - An agent acting for a person therefore cannot *propose* such an action for that person's approval.
  - FeltKit needs a **delegated proposal**: the agent proposes under the person's grant; the person approves in PersonalOS, bound to the input digest; it runs once.
  - FeltKit's invocations already have `awaiting_approval` and `resume()` (`FK:src/runtime/invocations.ts:434-476`) to build on.
  - **This, not an eve prompt, is what must guard sending e-mail or changing a calendar.**

### G. Connected accounts

- **Exists (FeltKit, published in 0.3.33, tested):** integrations with `credential: {oauth2, owner: "person"}`. The person connects their own account:
  - PKCE;
  - state that is single-use and bound to the person;
  - refresh with rotation;
  - RFC 7009 revoke on disconnect;
  - per-person custody;
  - the app never sees a token.
  - Tests: `FK:test/connections.test.ts` "two people connect the same integration…", renewal, revocation, cross-user isolation, real local AuthBoundry.
- **Status:** "reference implementation". Pending connections live in memory, and there is no background renewal (`feltkit/docs/CONNECTIONS.md:3-11`).
- **Missing:**
  - Calendar and mail **integrations**: none exist in any repository; Google appears only as a sign-in provider. **Owner: PersonalOS** (which operations it offers).
  - Durable pending connections and background renewal. **Owner: FeltKit.**
- **Do not** use eve's own per-user connections for these accounts. eve does not store tokens (`eve:docs/connections/index.mdx:301`), and a second custody location would split authority.
- eve should reach the person's calendar **through PersonalOS capabilities** that call `ctx.integrations.invoke(op, input, {onBehalfOf})`, decided by AuthBoundry on every call.

### H. Real-world actions

| Action | Prepare (standing grant) | Execute |
| --- | --- | --- |
| Draft an e-mail, propose a time, fill a form | ✔ | — |
| Send an e-mail, create or move a calendar event | — | **Per-action approval, server-side** (F). A standing grant may later cover low-risk cases, such as accepting from known senders, by explicit person setting |
| Book an appointment, update an external record | — | Per-action approval |
| Make a purchase, pay a bill | — | **Never automated.** PersonalOS prepares; the person acts in the provider's own app |

**Rule:** the agent's report is not evidence that an action happened. Each executed action needs the provider's response stored as evidence, as PersonalOS already does for its own records (`_ops.ts:83-88`).

### I. Specialist delegation

- **eve subagents are implemented and tested.** Each has its own tools, connections and model, inherits nothing, runs in parallel as tasks, and surfaces approvals on the parent (`eve:docs/subagents/index.mdx`; e2e `agent-subagents/*`).
- **The agent uses none.** PersonalOS's research is already a deterministic pipeline.
- Subagents earn their place only once there are **different toolsets with different authority**, for example a mail-reading specialist without write access.
- **Recommendation:** not now (P3).

### J. Runtime replacement

| Question | Answer |
| --- | --- |
| AppPort replacement | Works, but example-only (`agent:agent/lib/appport.ts:44-139`). Operations stay pinned to the implementation they first used (`operations.ts` `implementation`), and the binding change takes effect without restart (13 tests, 7 of 7 mutations caught) |
| General eve resolution | **Not implemented.** That is `research/runtime-dependency-resolution.md` (proposed) |
| Model replacement | PersonalOS's own assistant: yes, through a Resolver reference. eve: `defineDynamic` for the model is public and tested ("agent-dynamic-model-session"), unused by the agent |
| Model recorded in evidence | eve records `model.started.data.modelId` in session events. The agent's ledger does not copy it |
| Compatibility enforced | eve refuses a drifted contract at use. **Resolver accepts a breaking re-pin** (no comparison with the previous binding: `resolver/server/src/targets.ts:100-126`) |
| Safe rollback | Resolver re-verifies on rollback |

---

## 6. Scenarios (24)

"Blocks deploy" means it blocks deploying what exists (§8), not this roadmap.

| # | Group | The person asks | Today | Intended | Missing | Owner | Blocks deploy |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Organization | "Remind me to renew my passport in March, and every year." | A yearly recurrence is not offered; the monthly/weekly/daily enum only | Yearly recurrence | Recurrence value | PersonalOS | No |
| 2 | Organization | "What's important today?" | Briefing | Same, plus agent suggestions as proposals | Suggestions | PersonalOS + eve | No |
| 3 | Organization | "Turn this list into tasks under the move project." | In chat: proposals, approved one by one. From Multiplayer: eve creates them | One approval for a batch, or eve work | Batch proposal; chat handoff | PersonalOS | No |
| 4 | Memory | "Remember I'm vegetarian." Later: "plan dinner" | Confirmed memory, recalled by keyword ("vegetarian" must match) | Recalled by meaning | Index | FeltDB, PersonalOS | No |
| 5 | Memory | "What did we decide about the contractor?" | Memories and projects by keyword; conversations not searched | Search across conversations with citations | Search capability | PersonalOS | No |
| 6 | Memory | "Forget what you know about my old job." | Proposal; the person approves the forget | Same | — | — | No |
| 7 | Documents | "Read the three quotes I uploaded and compare them." | Stored only | Text read and compared, citing document version | Text extraction; `documents.read` | AppPort Services Files; PersonalOS | No |
| 8 | Documents | "Write up the plan as a document in the project." | Cannot create documents | A document created and versioned | `documents.create`; versions | PersonalOS; Services | No |
| 9 | Research | "Research heat pumps for a cold climate." | ✔ with sources and verified quotes | Same, with a spend limit | Owner budget | PersonalOS | No |
| 10 | Research | "Keep an eye on heat-pump rebates and tell me if they change." | ✖ | A weekly standing research run that notifies | Schedule, notification | eve, Services | No |
| 11 | Long-running | (Chat) "Organize the move, research movers, tell me when done." I close the laptop | The turn is cancelled when I disconnect; research continues | eve work; the result in the conversation; a notification | Chat handoff; channels | PersonalOS + eve agent; Services | No |
| 12 | Long-running | (Multiplayer) the same | ✔ eve does it durably | Same | — | — | No |
| 13 | Long-running | "Ask me before you pick a mover." | eve can ask; nothing shows the question; the work looks "running" | Question in PersonalOS; the answer resumes the same work | `/work` question and answer wiring | eve agent + PersonalOS | No |
| 14 | Long-running | "Stop the move work." | ✖ (research only) | Cancelled; ledger consistent | `/work` cancel | eve agent + PersonalOS | No |
| 15 | Long-running | "Keep working on this over the next week." | Follow stops at 24 h; durable work needs a recent sign-in | Weeks, under the grant | Follow window; delegation-bound work | PersonalOS; FeltKit | No |
| 16 | Communication | "Text me when it's done." | In-app only | E-mail or push by preference | Channels, preferences | Services, FeltKit | No |
| 17 | Integrations | "Find a free hour Thursday for the contractor call." | ✖ | Calendar read through a person-owned connection | Calendar integration | PersonalOS (+ FeltKit connections) | No |
| 18 | Integrations | "Find the contractor's proposal in my email." | ✖ | Mail search, then saved as a document | Mail integration; documents | PersonalOS | No |
| 19 | Proactive | "Every morning tell me what to focus on." | A deterministic check-in | An agent review that ends in proposals | Schedule; agent result capability; durable principal | eve, PersonalOS, FeltKit | No |
| 20 | Proactive | "Tell me when something I promised is overdue." | Listed in the briefing | A notification on becoming overdue | Trigger, channel | PersonalOS, Services | No |
| 21 | Real-world | "Email the contractor asking for an updated estimate." | ✖ | Drafted; the person approves; sent once; provider response stored | Mail plus delegated proposal | PersonalOS, FeltKit | No (P0 before enabling) |
| 22 | Real-world | "Pay the plumber." | ✖ (correctly) | It prepares the payment details; the person pays | — (by design) | — | No |
| 23 | Multi-agent | "Have one look at the technical side and one at costs." | A single agent | Subagents only if toolsets differ | — | eve agent | No |
| 24 | Adaptation | "Use a different model." (operator) | PersonalOS assistant: a Resolver reference, no redeploy. eve agent: a configuration change | Both by reference, recorded per turn | `defineDynamic` in the agent | eve agent | No |

---

## 7. Layer ownership

| Capability | Primary owner | Consumers (do not reimplement) |
| --- | --- | --- |
| Tasks, projects, memory, documents, research, conversations, briefing | PersonalOS | eve, through delegated `/appport` |
| What becomes agent work; progress, question and approval UX; where results land | PersonalOS | — |
| Durable execution, parking and resuming, cancel, steering, schedules, subagents, model selection | eve | The PersonalOS agent |
| The PersonalOS agent's work channel and ledger (questions, answers, cancel) | eve agent (`examples/appport-agent` today) | PersonalOS |
| Per-person OAuth connections and token custody | FeltKit | PersonalOS integrations; eve via PersonalOS |
| Server-side approval, including **delegated proposals** | FeltKit | PersonalOS, eve |
| Delegation-bound durable work (beyond session lifetime) | FeltKit (with the AppPort Services `delegationId`) | PersonalOS jobs |
| App-selectable notification channels | FeltKit | PersonalOS |
| Channels (e-mail, push), preferences, quiet hours | AppPort Services | FeltKit |
| File text representations and versions | AppPort Services Files | FeltKit, PersonalOS |
| Text and semantic index | FeltDB | FeltKit search, PersonalOS |
| Grants, revocation, agent identity | AuthBoundry | All |
| Capability contracts and versions | AppPort | eve agent, PersonalOS |
| Implementation bindings, re-pin compatibility | Resolver | eve agent, PersonalOS model |

**Hypotheses that the code changed:**
- **Durable approval holding is FeltKit's.** AuthBoundry is allow/deny only, with no pending or step-up outcome (`AB:crates/authz/src/policy.rs:35,198`).
- **Token custody is FeltKit's, not eve's or AuthBoundry's.** AuthBoundry's credential broker explicitly excludes OAuth flows (`AB:docs/CREDENTIAL-BOUNDARY.md:271-275`).

---

## 8. Gap register

| ID | Pri | Type | Gap | Evidence | Owner | Change | Size | Acceptance and tests | Blocks deploy |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| U1 | P1 | Not connected | Questions, answers and cancel are not on `/work` | `agent:agent/channels/work.ts` handles no `interaction.*`; `eve:packages/eve/src/channel/session.ts:43-48` | eve agent | Handle `interaction.opened` / `turn.paused` / `interaction.settled`; add `answers` and `cancel`, authorized as the requester | S | A question appears in `GET /work`; an answer resumes the same `turnId`; a non-requester is refused; a restart while waiting keeps it | No |
| U2 | P1 | Missing | Chat cannot hand work to eve | `interactions.ts:201`, `xsurface.ts:371` only | PersonalOS | A conversation handoff using the existing `agent.submit` and follow; show progress, questions and answer in chat; follow longer than 24 h | M | Hand off, disconnect, result lands in the conversation; question answered in chat; cancel from chat | No |
| U3 | P0 | Security constraint | Delegation must not use eve's `/eve/v1` | `eve:docs/guides/auth-and-route-protection.md:323` | eve agent, PersonalOS | Only `/work` is reachable for people's work; `/eve/v1` stays operator-only | S | Route test: another person's work id is refused on every `/work` route | **Yes** (keep it so) |
| U4 | P1 | Missing contract | Durable work stops once the session lapses | `FK:src/runtime/runtime.ts:990-1006`; `sessions.ts:51` | FeltKit | Delegation-bound jobs (expose `delegationId`) | M | A reminder fires 8 days after the last sign-in; a revoked grant stops it | No |
| U5 | P1 | Missing | No delegable way for the agent to report into the person's conversation or inbox | `_authority.ts:75` (agent capability list) | PersonalOS | `conversations.post` / `inbox.notify` for agents, owner-scoped | S | A scheduled eve review posts into a conversation under the grant | No |
| U6 | P1 | Missing | Provenance of model actions | `invocationstate.ts:180`; `via: "ui"` on approved model proposals | PersonalOS | Model saves stored as inferred; carry `proposedBy` into the action log | S | Tests on the action log and memory status | No |
| U7 | P0 | Missing contract | No delegated proposal for approval-required actions | `FK:src/runtime/runtime.ts:821` | FeltKit | The agent proposes under a grant; the person approves (digest-bound); it runs once | M | Agent proposes, person approves, runs once; reject changes nothing; digest mismatch approves nothing | No (blocks external sends) |
| U8 | P2 | Not connected | Search unused | `search:` declared; no `.search(` call | PersonalOS | A cross-collection `search` capability with citations | S | Finds by keyword across six collections, owner-scoped | No |
| U9 | P2 | Missing | Document text | `files.read` exists; no `documents.read` | PersonalOS | `documents.read` for text types, delegable | S | eve reads a text document under its grant | No |
| U10 | P2 | Missing | PDF and Office text | None anywhere | AppPort Services Files | A derived text representation | M | A PDF's text, stored with checksum and source version | No |
| U11 | P2 | Missing | Notification channels and preferences | `FK:src/runtime/services.ts:1459`; SVC notifications docs | AppPort Services + FeltKit | App-selectable channels; preferences; push adapter | M | A completion and an approval request reach e-mail by preference; quiet hours hold | No |
| U12 | P2 | Not connected | Calendar and mail | FeltKit person-owned connections exist, unused | PersonalOS (+ FeltKit durable pending connections) | Calendar and mail integrations with `owner: "person"`; read first | M | Connect, read free time, disconnect revokes; another person's never used | No |
| U13 | P2 | Missing | Standing agent review | eve dynamic schedules (experimental) | eve agent + PersonalOS | A per-person schedule ending in proposals (U5) | M | Runs while the person is away; produces proposals only | No |
| U14 | P2 | Missing | Owner research spend | `research.ts:270-278`; `turn.ts:187-193` | PersonalOS | Owner budget or confirmation | S | Refuses above budget | No |
| U15 | P2 | Missing | Document creation and versions | `documents.ts:55-75` | PersonalOS; Services | `documents.create`; versions | M | A plan document created, edited, history kept | No |
| U16 | P3 | Missing | Semantic recall | No vector search | FeltDB | A text and vector index | L | Recall by meaning, citing records | No |
| U17 | P3 | Not connected | eve agent model by reference | `agent:agent/agent.ts:4-7` | eve agent | `defineDynamic` model; record it in the ledger | S | Model changed without rebuild; the ledger shows it | No |
| U18 | P3 | Missing | Resolver re-pin compatibility | `resolver/server/src/targets.ts:100-126` | Resolver | Compare with the previous binding | M | A breaking re-pin needs explicit acceptance | No |
| U19 | P3 | Partial | Recurrence gaps (yearly), personal schedule choice for reviews | `tasks.ts` `RECURRENCE` | PersonalOS | Extend the enum; a review-day setting | S | Unit tests | No |

---

## 9. What deploying what exists requires

Only what keeps the **current** capabilities working (details in eve2 `audits/appport-foundation/PERSONALOS-DEPLOYED-AGENT-ASSESSMENT.md`):

1. **PersonalOS's delegation authority must persist.**
   - The local AuthBoundry's grants and agent registrations live in `FELTKIT_AUTHORITY_DIR`. That needs a persistent volume and one instance.
   - Without it, every eve call to PersonalOS is refused after a restart.
   - Hosted AuthBoundry cannot be used for delegation yet (`feltkit/docs/LOCAL-AUTHORITY.md:145-146`).
2. **The eve agent runs as its own process**, with persistent storage for its sessions and work ledger. `PERSONALOS_AGENT_URL` and the identity key pair are needed only if surfaces hand work to it.
3. **A writable credential vault** if X stays enabled (rotating grant).
4. **U3 stays true:** `/eve/v1` operator-only.
5. **Model access:**
   - PersonalOS through its Resolver reference.
   - The eve agent through its provider key.
   - Search credentials if research is to search the web.

Nothing in the roadmap below is a prerequisite.

---

## 10. Slices

### Slice A: deploy and use what exists

| | |
| --- | --- |
| **Outcome** | Everything in §3 works for real people |
| **Repositories** | Deployment configuration; FeltKit only if the hosted contract must list the authority and vault variables |
| **Tests** | PersonalOS 166, the eve agent's 160 against the deployed processes; restart keeps grants and work |
| **Scope** | S |

### Slice B: every conversation can be delegated

| | |
| --- | --- |
| **Outcome** | From the app: "work on this", walk away, see progress, answer its questions, stop it, and get the result in the same conversation, with every action and its evidence visible |
| **Changes** | eve agent: U1 (questions, answers, cancel on `/work`, U3 preserved). PersonalOS: U2, U6 |
| **Depends on** | Nothing new in the platform: eve's interaction model and FeltKit's integration and jobs already exist |
| **Tests** | Handoff and disconnect; a question and answer resuming the same turn across a restart; cancel; a non-requester refused; evidence visible |
| **Scope** | M |
| **Deploy impact** | Additive |

### Slice C: the agent can use what the person has

| | |
| --- | --- |
| **Outcome** | "Find everything about X", "read and compare these documents", "write the plan" |
| **Changes** | PersonalOS: U8, U9, U15 (create). AppPort Services Files: U10. FeltDB: U16 later |
| **Tests** | Owner-scoped search with citations; text and PDF read with source version; document created and versioned |
| **Scope** | M (L with U16) |

### Slice D: the agent can reach the person and their accounts

| | |
| --- | --- |
| **Outcome** | Hears back by e-mail or push; the agent reads the person's calendar and mail; drafts are approved, then sent once |
| **Changes** | AppPort Services and FeltKit: U11, U7 (delegated proposals). PersonalOS: U12. FeltKit: durable pending connections |
| **Order** | **U7 before any send is enabled.** Reads can ship first |
| **Tests** | Channel delivery by preference; connect and disconnect; a send only after a digest-bound approval, executed once, provider response stored |
| **Scope** | L |

### Slice E: the agent keeps going

| | |
| --- | --- |
| **Outcome** | "Every morning…", "keep an eye on…", "work on this over the week" |
| **Changes** | FeltKit: U4. PersonalOS: U5 and standing-instruction settings. eve agent: U13 on eve dynamic schedules |
| **Tests** | A schedule runs while the person is away for more than 7 days, ends only in proposals or posts, stops on revocation, and survives restart |
| **Scope** | M |

### Slice F: expand safe execution

| | |
| --- | --- |
| **Outcome** | More external actions under per-action approval; specialists where toolsets differ; operator-controlled replacement of models and capabilities |
| **Changes** | PersonalOS integrations; eve agent subagents (only if justified); U17; Resolver U18; framework dependency resolution only if the research proposal is approved |
| **Scope** | L |

**Why this order.**
- B makes the existing agent reachable from where people already are, and adds no platform work.
- C gives it something to work with.
- D lets it reach the person and their accounts, and must not start sending before U7.
- E depends on B's channel and on U4.

---

## 11. Open questions

1. **What should chat hand to eve?**
   - Everything?
   - Only what the person marks "work on this"?
   - Only what the rules or the model judge to be multi-step?
   - PersonalOS must keep working without eve and without a model.
2. **Standing approval for low-risk external actions** (for example accepting a meeting from a known contact): ever, or always per action?
3. **Which provider first: Google or Microsoft?** Should mail be read-only at first?
4. **Push channel:** web push, the iOS app (APNs) or e-mail first?
5. **Should proactive reviews ever act**, or always end in proposals? This report assumes proposals.
6. **Where should the PersonalOS eve agent live?** In this repository or its own. Today it is an eve2 example.
7. **Should owner-started research have a budget**, and should model-classified saves be inferred (U6, U14)?

---

## 12. Summary

**Top five capabilities to add**

| # | Capability | Changes |
| --- | --- | --- |
| 1 | Delegate any conversation, with progress, questions, cancel and evidence | U1, U2 |
| 2 | Search everything the person has | U8 |
| 3 | Read and write documents | U9, U10, U15 |
| 4 | Hear back outside the app | U11 |
| 5 | Use the person's calendar and mail, sends approved | U12 + U7 |

**Top five gaps to close**

| # | Gap | Change |
| --- | --- | --- |
| 1 | The questions and answers wiring on `/work` | U1 |
| 2 | Delegated proposals, the server-side approval boundary for any external action | U7 |
| 3 | Durable work bound to the person's grant, not their login | U4 |
| 4 | A delegable way for the agent to report into PersonalOS | U5 |
| 5 | Provenance of model-originated changes | U6 |

**Already working: do not rebuild**
- **PersonalOS:**
  - tasks, recurrence, reminders, briefing, check-ins and weekly review;
  - projects and files;
  - confirmed and inferred memory with provenance;
  - cited research with verified quotes, budgets for agents, cancel and retry;
  - share-sheet and Chrome capture;
  - Multiplayer and X surfaces;
  - identity linking through Resolver;
  - model-as-proposer with digest-bound approval;
  - the owner-scoped action log with read-back evidence;
  - continuity across surfaces;
  - the `agent` integration and follow job.
- **eve:**
  - durable sessions;
  - questions and approvals that resume the same turn;
  - cancel and steering;
  - progress stream;
  - `sleep`, hooks and webhooks;
  - static and dynamic schedules;
  - subagents;
  - `defineDynamic` model;
  - memory, state and tasks.
- **The PersonalOS eve agent:**
  - operation ledger with exactly-once sends;
  - completion gate;
  - stall detection and reconciliation;
  - operator settlement;
  - identity-authority assertion;
  - Resolver-bound, contract-pinned capabilities.
- **FeltKit:**
  - delegated `/appport` with per-capability grants and durable idempotency;
  - `approval: "required"` and digest-bound proposals;
  - person-owned OAuth connections;
  - file bytes and image variants;
  - `ctx.db.search`;
  - jobs re-authorized per run;
  - credential custody.
- **AppPort Services:** notification records and delivery, with its e-mail channel.
- **AuthBoundry:** grants, expiry, revocation and agent credentials.
- **Resolver:** references, revisions, verified rollback, `model` and `agent` kinds.

**What PersonalOS can become with the platform already built.** A personal agent a person can hand real work to from anywhere, the app included. It:
- works through their tasks, projects, documents, memory and research;
- asks when it needs a decision, and resumes exactly where it stopped;
- reports back wherever they prefer;
- reads their calendar and mail under their own revocable grants;
- prepares outside actions that run only after they approve each one;
- keeps a standing eye on what they asked it to watch.

Every change stays in records they own, attributed and verified. It keeps working, minus the reasoning, with no model at all.

**Most of that is wiring of existing parts.** Only five genuinely new contracts are needed:

| Contract | Owner |
| --- | --- |
| Delegated proposals | FeltKit |
| Delegation-bound durable work | FeltKit |
| Notification channels and preferences | AppPort Services and FeltKit |
| Derived document text | AppPort Services Files |
| A text index | FeltDB |
