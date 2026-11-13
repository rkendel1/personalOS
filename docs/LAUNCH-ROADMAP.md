# PersonalOS production launch roadmap: summon your assistant from anywhere

Supersedes the build order in [GROK-COMPARISON.md](GROK-COMPARISON.md), which stays as the feature review.
FeltKit, Resolver and AuthBoundry changes are tracked in [FELTKIT-CHANGES.md](FELTKIT-CHANGES.md).
Dated 2026-11-13. Sizes are S, M or L, not dates.

## Positioning

Grok Bot is an agent you talk to inside its own products. PersonalOS is **your** assistant that you summon
from wherever you already are: X, email, a Slack thread, your editor's AI client, a share sheet. It does the
work as *you*, only with what you approved, keeps the result in your own account, and asks before it changes
anything. You can revoke it in one click, and you choose the model.

**Our bots never reply in public.** A summon from any surface is acknowledged privately and the result lives in
PersonalOS. That removes public-persona moderation, public-reply cost, and any risk of private data posted
publicly.

## The model: one person, many surfaces, one agent

- **Person:** one PersonalOS account that owns memory, tasks, conversations, files, keys and delegations.
- **Surface:** anywhere a person can summon it. A surface is a thin adapter: it proves who the sender is,
  passes context, and delivers the acknowledgement.
- **Agent:** `agent:personalos`, acting for the person under a delegation. It has no authority of its own.

```
summon ─► adapter ─► resolve sender ─► decide authority ─► run ─► private ack; result in PersonalOS
 one word   envelope   (Resolver)        (AuthBoundry)
```

### One way to summon, everywhere

Consistency is a product rule: **every user calls the same thing, on every surface.**

| Surface | How you summon it |
|---|---|
| X | mention the one shared handle: `@<handle> <request>` |
| Email | write to the one shared address: `<handle>@<our domain>` (forward a message to hand it context) |
| MCP and API | the tool is named `<handle>`; one personal token per client |
| Slack, Discord, Multiplayer (later) | `@<handle> <request>`, or `/<handle>` |
| Chrome panel, iOS share sheet | the same app, selected text or page passed as context |

`<handle>` is a single name we own on every platform. The current X account is `@considered_done`. It is not
a launch name. **Decision needed:** pick the handle, check it is free everywhere, and register it before
anything else is public. One word, one grammar: `@<handle> <request>`.

### Private delivery, since nothing is public

The acknowledgement reaches the person without a public post. In order of preference, per surface:
1. **In-app and push**: a notification and the conversation updated in PersonalOS (web, extension, mobile web push).
2. **Email**: a short note with a link, for email-first people, and a digest for the rest.
3. **A private channel on the surface** where it exists (an X direct message, a Slack ephemeral message).
   **Not verified:** X's direct-message pricing, permissions and who can be messaged. Check before relying on it.
   Without it, X users get the notification in PersonalOS, not on X.

## Onboarding: web-first, three steps, no operator

**Today:** about eleven steps, three of them ours (AuthBoundry principal, policy, delegation), plus a code posted
publicly.

**Target:**

| Step | What the user does | What happens behind it |
|---|---|---|
| 1. Sign up and subscribe | Email, Google or GitHub (all supported by FeltKit today), then checkout for a plan. There is no free plan | Account created, subscription active, entitlements set. No keys, no model choice, no other setup |
| 2. **Add a surface** | A gallery of cards: **X**, **Email**, **API / MCP**, with an "Add" button on each. One tap per surface | X: sign in with X, which proves the account and links it. Email: confirm an address. API: create a token. Each creates the Resolver link and, on the first surface, the AuthBoundry principal, policy and starter delegation |
| 3. Approve | One consent screen with three tiers (below) and a "Send me a test" button | A test summon runs end to end and lands in the app within seconds. This is the first win |

- **Request a surface.** Every gallery has "Request a surface" (name, a link, what you'd use it for). It
  writes to a `surfaceRequests` collection with votes, so people can back an existing request. The backlog is
  public inside the app and drives which connector we build next.
- **Delegation tiers (starter templates, applied by name):**
  - *Ask only*: read tasks, conversations, search and research.
  - *Assist*: also create tasks, reminders and memory. Deletes and forgetting still wait for approval.
  - *Full*: also publish to X as you, each time with its own approval.
- **Progressive consent.** A request needing more than the delegation allows gets a one-tap approve link in
  the private acknowledgement. Nothing widens silently.
- **Fully idempotent.** Adding the same surface twice ends in one link.
- Unknown senders on any surface get **no reply and nothing done** (as today). They are logged, so we can see
  demand.

## Authority: delegation × surface ceiling

- **Delegation:** what the person allows overall.
- **Surface ceiling:** what is allowed *from that surface*. For example, email can't publish to X even under
  *Full*, and an API token can be limited to read-only.
- **Audience:** the existing rule that shared conversations never see private data (Slack, Multiplayer).

The effective permission is the intersection. AuthBoundry decides each piece of work when it runs.

## Models and keys

There is no free plan. Every account pays. Two ways to run the model, set by plan:

| Mode | What you get |
|---|---|
| **Included** | The platform model, no setup, metered by the plan's quota |
| **Bring your own keys** | Your provider key, stored as your own secret; choose the model; use an OpenAI-compatible or local endpoint; Test button. Your model usage is yours, so the plan's model quota doesn't apply (rate limits still do). Optional fallback to the platform model within the plan's quota |

Resolution at run time: the person's own model reference if their plan includes bring-your-own keys and it is
set, otherwise the platform default. Tool keys (search, image, voice) follow the same pattern. If a BYO key fails, the
acknowledgement says so and names the fix. It never fails silently.

**Resolver is the home for this.** It keeps secrets write-only. It needs **per-person namespaces**
(`ref://users/<id>/…`), and a PersonalOS service key limited to read and reveal inside them. Which limits
apply to each plan, how bring-your-own keys are priced against Included, and whether there is a trial are
pricing decisions, not decided here.

## Launch bar (a release is blocked until all hold)

1. **Zero operator steps per user.** A new person signs up, subscribes and adds a surface, and nobody touches
   a console.
2. **Time to the first test result under 60 seconds** from a completed checkout.
3. **Consent is plain and revocable**: one screen, one revoke button, per surface and overall.
4. **Costs are capped per person and sit below what they pay** (X reads, model, search), so no loop can make an
   account lose money. Billing works: charge, renew, fail, cancel, refund.
5. **Nothing private is ever posted publicly**, because nothing is posted publicly.
6. **The service survives a restart and a bad day:** the adapter identity doesn't expire, state is backed up,
   failures are visible.

## Phases

### Phase 0: foundations
| Work | Where | Size |
|---|---|---|
| FELTKIT-CHANGES items 1 to 7 (production credentials, connect, durable adapter session, `feltkit call`, status, vault dir, configurable application id) | FeltKit | M |
| X API credit plan and spend alerts. Reading mentions is billed per call | Ops | S |
| AuthBoundry portal deploy and Services bridge fixed; check-credentials panel live | AuthBoundry | M |
| Backups and a restore drill (Fly volume, Resolver and AuthBoundry hosts); monitoring | Ops | M |
| Prove the poll chain survives the adapter session expiring and a restart | PersonalOS | S |
| Pick and register the handle everywhere | You | S |
| Choose the billing provider and plan structure | You | S |

Exit: the X test passes by hand once, and token renewal is confirmed.

### Phase 1: onboarding and the three launch surfaces
| Work | Where | Size |
|---|---|---|
| **External identity provider** for sign-in and linking: generic OAuth 2.0 + PKCE that accepts a provider user id instead of a verified email. X is configuration | FeltKit | M |
| **AuthBoundry provisioning API**: an application-scoped service credential that creates principals, policies and delegations and revokes them. Today only a signed-in owner can | AuthBoundry | M |
| **Delegation templates** and **surface ceilings** applied by name | AuthBoundry, PersonalOS | S |
| **Add a surface** gallery, link and unlink, and "Send me a test" | PersonalOS | M |
| **Request a surface** with votes | PersonalOS | S |
| **X adapter**: read-only mentions, summon by the shared handle, private delivery | PersonalOS | exists (polling); drop the public reply |
| **Email adapter**: inbound address, sender verification, forwarded context, private reply | PersonalOS | M |
| **MCP and API surface**: per-person scoped tokens that act as the person under their delegation, an MCP server named for the handle | PersonalOS, FeltKit | M |
| **Notifications**: in-app, push, email | PersonalOS, FeltKit | M |
| Adapter contract written down as a small SDK, so a new surface is days, not weeks | PersonalOS | S |
| **Billing and entitlements**: checkout, subscription state, plan limits (surfaces, quotas, bring-your-own keys), renewals and failed-payment handling, cancellation and refunds, invoices and tax. Enforced in the app, not only at the door | PersonalOS (plus provider) | L |
| **Lapsed accounts**: a clear state when payment fails or ends. Surfaces pause, nothing is deleted, data stays exportable, and one click reactivates | PersonalOS | S |
| Onboarding analytics: sign-up → checkout → add surface → test → first real summon | PersonalOS | S |

Existing and unchanged: Multiplayer (signed bridge), the posted-code link as a fallback, Chrome panel, iOS share.

Exit: the zero-operator acceptance test passes on a fresh account for all three surfaces, repeatedly, in CI
against real AuthBoundry and Resolver and a stand-in X.

### Phase 2: things people try first
| Work | Notes | Size |
|---|---|---|
| Cited `web.search` tool in chat | Uses the existing search integrations. Most-used gap | S |
| X search and user lookup as tools and research sources | Billed per call, so it follows Phase 3 quotas | M |
| Understand uploaded files (text, PDF; images with a vision model) | Today uploads are stored only | M |
| Custom instructions and skills | Add `instructions` to settings and the system prompt | S |
| **Bring-your-own keys** and the model settings screen | Needs per-person Resolver namespaces | M |
| Image generation, then voice | Provider integrations, saved as files | M each |

Exit: a scripted run of twenty everyday requests, scored, with parity on the information ones.

### Phase 3: safety, cost and scale
- **Plan limits and budgets** per person and per surface: summons per hour, model and search spend, X spend,
  set from the plan. Visible usage meter; a plain "limit reached" note with an upgrade option.
- **Abuse defences:** content from a surface is data, never instructions (prompt injection); per-sender
  rate limits; kill switch per user, surface and global.
- **Platform compliance:** read X's current automation and developer policy, and each future surface's.
  Not verified here; required before launch.
- **Latency:** polling is two minutes. Evaluate X's push options once a public HTTPS endpoint exists, keeping
  polling as the fallback. Email and API are already immediate.
- **Scale:** one Fly machine on one volume today. Define the ceiling, then the move to managed FeltDB and more
  machines. Move the X poller to its own worker if volume grows.
- **Data rights:** export, delete my account and data, revoke everything. Terms and privacy text.
- **Observability:** per-user and global dashboards for errors, spend, queue depth, time to first result.

Exit: a load and abuse test with caps holding and alerts firing.

### Phase 4: launch
1. **Private beta**, invite only, a few hundred accounts, spend caps on, feedback channel. Billing is live
   from day one: invited accounts are either paying or explicitly comped by us (a flag, not a free plan).
2. **Public beta**, open sign-up behind a waitlist, everyone paying.
3. **General availability** with the final plan structure.

### Phase 5: growth through connectors
Build the top-voted surface requests (Slack, Discord, SMS or WhatsApp, calendar and email as *tools* with
approval-gated sends). Then scheduled prompts, shareable read-only threads (after a privacy review), parallel
research, Canvas, and code execution in a sandbox. Compete on trust and reach, not generation features.

## Dependencies by package

| Package | Needed for launch |
|---|---|
| **FeltKit** | FELTKIT-CHANGES 1 to 7; **generic external identity provider**; service principals independent of a human's sign-in; push and email notifications; usage metering hooks |
| **AuthBoundry** | **Provisioning API** with scoped service credential; delegation templates and surface ceilings; revoke-all per person; portal deploy fixed |
| **Resolver** | **Per-person namespaces and scoped service key**; CLI symlink fix; self-hosting docs |
| **PersonalOS** | Everything under Phases 1 to 3 |

## Risks and open decisions

- **The handle and brand.** One name everywhere is a promise. If it is not available on a platform, we need a
  fallback rule before launch.
- **X delivery without public replies.** The summon is received with no feedback on X unless direct messages
  are usable. The notification must arrive fast, or people will think it did nothing. Decide whether to test X
  direct messages or accept in-app notification only.
- **No free plan means payment comes before the first win.** That works against the 60-second test. Options:
  checkout first (simplest, lowest abuse, highest drop-off); a short card-required trial; or a read-only demo
  conversation shown before checkout. Pick one before building onboarding. A trial or demo is a free tier by
  another name, so it is your call.
- **Plan boundaries.** How many surfaces each plan allows, its quotas, and the price relationship between
  Included and bring-your-own keys are not decided.
- **Unit economics.** Cost per active user must stay under the price. Measure it in the private beta before
  fixing prices and limits.
- **Per-surface ceilings.** Fixed defaults or configurable per person? Fixed is simpler to launch.
- **Single points of failure today:** one Fly machine, one X token, one poller, one Resolver, one AuthBoundry
  host. Each needs a recovery story before public beta.

## Launch gates

| Gate | Measure |
|---|---|
| Private beta | Zero-operator test green for all three surfaces; billing working end to end; first test result under 60 s for 90% of completed checkouts; no private data in anything posted publicly (nothing should be) |
| Public beta | Checkout and add-a-surface completion rates set from the beta funnel; spend per active user known and capped; error rate and alerts live; surface requests flowing |
| General availability | Backup restore drilled; abuse test passed; terms and privacy live; bring-your-own keys working end to end; refunds, tax and failed-payment handling verified |
