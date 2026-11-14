# M4 (Anywhere Invocation): gap register

This register was written before any M4 code changed. Every row cites what was read, so it can be
checked against the source. Status values:

- **Exists**: implemented and tested.
- **Partial**: implemented, but with the gap named in the row.
- **Missing**: not implemented.
- **Blocked**: needs something outside this repository and this container.

The baseline is PersonalOS `cba6c4f` (main) and FeltKit `1788e47` (main).

## Blocking now: unpublished releases

| # | Gap | Status | Evidence |
|---|---|---|---|
| G0 | **PersonalOS main depends on unpublished packages.** `package.json` names `@feltdb/feltkit` 0.3.30 and `@authboundry/local` 0.1.0. npm has FeltKit 0.3.29, no `@authboundry/local`, and `@authboundry/core` 1.17.3, so `npm ci` and main's CI fail until they are released. FeltKit main also lacks its 0.3.30 version commit (`db25bcc`, still on `claude/affectionate-bardeen-o1xu78`: PR #121 was merged before it was pushed). Releases are the owner's to publish. They are not worked around here, and nothing is published to make CI green. | Open (owner: you) | `npm view` on 2026-11-13; `package.json` lines 25-26 |

## Ownership (decided 2026-11-13)

Per-person connections, credential custody and renewal, connector manifests and connector execution
belong to AppPort Services and AppPort, not to FeltKit or AnywhereAide. Delegated authority belongs to
AuthBoundry. The surface contract, registry, invocation lifecycle and continuity belong to FeltKit. The
product experience belongs to AnywhereAide.

The test for every piece of M4: could another FeltKit application use it without importing
AnywhereAide?

One finding against that split:

- AppPort's own documented boundary (`@appport/services` 0.17.0, `docs/credentials.md`) says AppPort
  contains no secret store, encryption, provider adapter or policy engine. AppPort Services owns how a
  credential is collected (authorized, audited, versioned); the **host** owns where it lives
  (`SecretCustody`, implemented by FeltKit's vault).
- The OAuth renewal lifecycle and integration execution live in FeltKit today
  (`runtime/oauth-credentials.ts`, `runtime/integrations.ts`).
- So moving connections into AppPort Services means either:
  - (a) AppPort Services defines the connection contract and FeltKit implements it as host, as
    `SecretCustody` works today; or
  - (b) AppPort Services gains an implementation: OAuth lifecycle, provider adapters, execution.
    That changes its stated boundary and moves code out of FeltKit.

**Decided (2026-11-13): (a).** AppPort Services defines the portable user-owned connection
contract; FeltKit implements it as host; AuthBoundry decides every use; AnywhereAide consumes.

The working FeltKit implementation is preserved as evidence, not as the specification:

- branch `claude/per-person-connections-reference` in FeltKit, `cc468b3`;
- results in `docs/CONNECTIONS-EVIDENCE.md`;
- full suite before its doc fix: 640 pass, 1 fail, 3 skipped; after: 641 pass, 0 fail, 3 skipped.

**Progress (FeltKit `claude/affectionate-bardeen-o1xu78`, `157c567` + `6f563df`):**

- the surface registry declaration: `app.surface`, which grants nothing;
- `feltkit.invocation/1` (`normalizeInvocation`);
- the lifecycle transition table, with `cancelled`.

Full suite: 644 tests, 642 pass, 0 fail, 2 skipped.

**The invocation platform store (decided A, 2026-11-14; FeltKit `e1ab984`).**

- **What it is.** `ctx.invocations`: accept, get, list, cancel, start, resume and transition, plus
  recovery in the services worker. Documented in `docs/INVOCATIONS.md`.
- **The invariant.** An accepted invocation always has durable evidence of pending dispatch, active
  execution, or a terminal outcome. The record and its dispatch (the existing after-commit outbox)
  commit in one transaction.
- **Acceptance.** `test/invocations.test.ts` 9/9, in three consecutive runs, using two independent
  fixture applications. Each requirement has its own test:
  - persist without an application collection;
  - cross-application reuse;
  - isolation by application, person and deliverer;
  - a crash between accept and dispatch, recreated from the durable state, recovered once;
  - no duplicate work;
  - a deterministic cancellation race;
  - final terminal states;
  - a real dispatch failure, re-dispatched then failed with evidence;
  - observable recovery.
- **Full suite:** 653 tests, 651 pass, 0 fail, 2 skipped.

**Known limits** (in the doc):

- live queries aren't notified of invocation changes;
- lifecycle moves inside a mutation commit on their own;
- registry availability is the last delivery, with no active probe;
- AppBoundry artifacts don't host the store yet.

**Placement-neutral execution (FeltKit `156df2c`; `docs/EXECUTION.md`).** The control plane keeps an
invocation's identity, lifecycle, authority and evidence wherever its work runs.

| Status | What |
|---|---|
| Implemented and tested | `feltkit.execution/1` (invocation / execution / attempt identities, work, input references, authority, requirements, placement constraints). The adapter boundary: an environment descriptor and a dispatch that stages one after-commit effect, so there is one outbox. The `managed` adapter is the existing path. A deterministic, replaceable placement resolver with the operator's versioned policy and a structured `UNPLACEABLE`. Authority is checked before and independently of placement. Decisions are durable across restarts. Attempts record their environment and worker. Fencing, recovery by a replacement worker under the same identity, `unknown` for abandoned attempts and ambiguous outcomes. |
| Implemented, not under production conditions | A second environment exists only as a controlled in-process fixture (`fixture-remote`): it proves the contract, not remote execution. |
| Designed, not implemented | A remote worker protocol; re-placement; preemptive cancellation; versioned operations; environment health beyond `available`. |
| Blocked | AppBoundry artifacts don't host the invocation store. AuthBoundry has no agent-credential proof for a remote worker (R9). |

- **Evidence.** `test/execution.test.ts`, 9 tests covering criteria 1-9, 11 and 12 (criterion 10 is
  the full suite). The execution, invocation and surface tests passed 25/25 in three runs.
- **Full FeltKit suite:** 662 tests, 660 pass, 0 fail, 2 skipped; conformance 50/50.
- **Size:** source +504 −38, tests and fixtures +321 −7, docs +236; no configuration.
- **Behavior change:** `accept` refuses a job type with no handler up front.

**Agent capability infrastructure review (2026-11-14; FeltKit `e8c669c`, `fe965ac`;
`feltkit/docs/AGENT-CAPABILITY-INFRASTRUCTURE.md`).** An evidence review across FeltKit, AppPort,
AppPort Services, AuthBoundry, Resolver and PersonalOS.

- **Ownership.** The matrix, the lifecycle, and inference placement versus execution placement are
  in the document. Inference and execution are independent in the code: no model, provider or host
  appears in the invocation or execution contracts.
- **Execution review, corrected in FeltKit:**
  - Q2: the dispatch authority no longer reads like delegated authority
    (`requestedBy` / `runAs` / `onBehalfOf` / `checked` / `delegation`).
  - Q3: decisions snapshot the policy order and the environment descriptors.
  - Q4: each execution keeps its own dispatch evidence.
- **Tests and size.** 3 new tests. Full suite: 665 tests, 663 pass, 0 fail, 2 skipped. Source +37 −13,
  tests +55 −5, docs: a 212-line review plus EXECUTION.md corrections.
- **Correction to the M3 register, R9.** AuthBoundry's check endpoint **does** accept an agent
  credential (`x-authboundry-agent-credential`; tests in `crates/server/tests/agent_credentials.rs`),
  and FeltKit sends it with `authority.executor.credential`. What remains (A1-A5) is narrower:
  - `on_behalf_of` with an agent credential is untested;
  - the response doesn't say whether the executor was proven;
  - a worker can't call alone;
  - delegations can't be scoped to resources over HTTP.
- **Open, not implemented here** (ordered in §9 of the document):
  - AuthBoundry A1-A5;
  - proven executor per attempt;
  - per-caller MCP `tools/list` filtering;
  - the AppPort connection contract;
  - Resolver gaps R-1 to R-7 (per-person model key, failover and options, the PersonalOS search model
    hardcoded to OpenAI);
  - a remote-worker control-plane API.

**Revised priorities (decided 2026-11-14).** We are closer to agent capability infrastructure than
assumed. What's missing is making the existing capabilities accessible, correctly authorized, and
portable across ownership boundaries.

| Milestone | Scope | Depends on |
|---|---|---|
| **M1 — Authority correctness** (next) | AuthBoundry A1 (tests: agent credential with `on_behalf_of`); A2 (expose whether the executor was proven); record the authenticated executor on every execution attempt; resolve asserted versus proven environment and worker attribution | — |
| **M2 — Capability discoverability** | filter agent tool discovery by the caller's permissions; discovery stays separate from authorization; investigate wiring AppPort's cross-application registry; preserve provenance and capability ownership | M1 |
| **M3 — Bring your own inference** | per-person model bindings and credentials (R-1, R-3); failover and options (R-4); remove paths that bypass Resolver (R-6); safe inference placement and credential custody (R-7) | M1 |
| **M4 — Bring your own execution** | AuthBoundry agent-only authentication (A3); an authenticated remote worker API (claim, progress, completion, cancellation); a customer-owned execution adapter; recovery, then re-placement | M1 (no remote worker protocol before executor identity and attribution are resolved) |

M1 must make each of these distinguishable when an agent acts for someone:

- who requested it;
- whom it was for;
- which agent executed it;
- which authority permitted it;
- which environment ran it;
- what happened.

**Strategic gap: cross-application discovery.**

- AppPort core has a cross-application registry (`ApplicationRegistry.findByCapability` /
  `findByRequirement`, canonical contracts; tests in `appport/packages/core/test`), and nothing uses
  it. Without it, individual applications become agent-capable. With it, capabilities become
  discoverable across an ecosystem: more applications exposing capabilities makes agents more useful,
  without each application rebuilding discovery and integration.
- Constraints: discovery stays separate from authorization, and the registry must not become an
  uncontrolled global tool list.
- Status: a strategic gap, not an immediate task. It is investigated in M2.

**Next, after review:** migrate PersonalOS surface by surface, keeping existing behavior until each
migration passes acceptance. Multiplayer stays a bridge delivery.

## What exists today

| Surface | Contract | Who submits | Record | Result goes back to | Evidence |
|---|---|---|---|---|---|
| Website (PersonalOS app) | none needed: the person's own session calls the app | the person | conversations, actions, tasks… | the app | `src/`, `tests/*.test.ts`, `e2e/ui.mjs` |
| Chrome extension | `personalos.invocation/1` (adapter `browser`) | the person's session (bearer) | `invocations` | the side panel, plus a link back to the page (`returnTo: page`) | `extension/src/summon.ts`, `tests/browser-summon.test.ts`, `e2e/extension.mjs` |
| iOS share sheet | `personalos.invocation/1` (adapter `ios-share`) | the person's session (Keychain) | `invocations` | the app's list of shares; opening one goes to PersonalOS | `ios/`, `tests/invocations*.test.ts`, `e2e/share-invocation.mjs` |
| X (@anywhereaide) | the X adapter writes `invocations` records itself (`feltkit/xsurface.ts:339`) | the bot's poller; the person is resolved by a Resolver link | `invocations` + `xPosts` | a generic acknowledgement on X, never the result (public; `xsurface.ts:30`); the result is in PersonalOS | `tests/x.test.ts`, `tests/x-authboundry-real.test.ts` |
| Multiplayer | `personalos.interaction/1` | Multiplayer's bridge service, vouching for its user; the person is resolved by Resolver | `interactions` | signed `interaction.updated` events into Multiplayer | `feltkit/interactions.ts`, `tests/interactions.test.ts`, Multiplayer e2e |

These already hold across every surface:

- **Identity.**
  - The person is never an envelope field. It comes from their session, or from Resolver for bridged
    surfaces.
- **Authority.**
  - Every delegated action asks AuthBoundry on behalf of the person.
  - Revocation stops the next operation.
  - People grant in Settings (`feltkit/delegation.ts`).
- **Context.**
  - Shared context is data, never instructions.
  - It is kept apart from what PersonalOS inferred (`docs/INVOCATION-CONTRACT.md` "Kept apart").
- **Continuity.**
  - One conversation spans surfaces (`docs/CONTINUITY.md`).
  - Multiplayer can `continue <conversation>`.
  - Chrome and iOS pass `correlation.conversationId`.
- **Idempotency.**
  - Invocations: (owner, invocationId) is unique, a replay returns the stored receipt, and the same id
    with different content is refused.
  - Interactions: `adapter:idempotencyKey`.

## Gaps

### Part 1: universal invocation contract

| # | Gap | Status | Evidence |
|---|---|---|---|
| G1 | **Two contracts, not one.** Multiplayer uses `interaction/1` and records `interactions`; the other surfaces use `invocation/1` and record `invocations`. They differ in a real way: who vouches for the person (a bridge service plus Resolver, versus the person's own session). That difference should stay as a *delivery* mode of one contract, not as two contracts. | Partial | `docs/INVOCATION-CONTRACT.md` table "interaction/1 vs invocation/1" |
| G2 | **The lifecycle has fewer states than M4 asks for.** Invocations have `accepted, processing, needs_approval, completed, failed`. M4 asks for `received, validating, accepted, running, awaiting approval, completed, failed, cancelled`. `received` and `validating` happen inside one transaction today, so they are never observable; mapping them is honest, recording them as separate writes isn't. **`cancelled` is missing**: a person can't cancel an invocation. | Partial | `feltkit/invocationstate.ts` |
| G3 | **The envelope lacks fields M4 lists.** It has no requested capabilities and no granted authority (authority is decided at execution and recorded afterwards, which is correct; the envelope must never *carry* authority). It has no attachments beyond text documents, and no continuity reference beyond `correlation.conversationId`. | Partial | `feltkit/_invocation.ts` |

### Part 2: surface adapters and registry

| # | Gap | Status | Evidence |
|---|---|---|---|
| G4 | **No surface registry.** `surface.adapter` is any string matching `^[a-z0-9][a-z0-9.-]*$`. Nothing lists adapters, versions, modes, context types, return capabilities, authentication or health. | Missing | `_invocation.ts:62` |
| G5 | **No written adapter contract.** What an adapter must do (identity, context, progress, approvals, result delivery, retry) is implied by three implementations, not stated once. | Missing | — |

### Part 3: mobile

| # | Gap | Status | Evidence |
|---|---|---|---|
| G6 | **The iOS app had never been compiled.** CI now compiles the app and the share extension on macOS: Xcode 16.4, iOS Simulator SDK, unsigned. It passes with no Swift errors or warnings (run 43525529526, commit `9d9491f`). That proves it compiles. It doesn't prove it runs, signs or installs. | Done (compile) | `.github/workflows/ios.yml`; https://github.com/rkendel1/personalOS/actions/runs/43525529526 |
| G7 | **No real-device acceptance.** It needs your Mac (signing, with your Apple team) and iPhone. The procedure and the harness exist (`scripts/share-acceptance.mjs`). | Blocked (owner: you) | `docs/IOS-SHARE.md` |
| G8 | **No approvals on mobile.** The iOS app shows `needs_approval` but can't approve; it opens PersonalOS. Part 6.4 asks for the approval request on mobile. | Missing | `ios/App/ContentView.swift:66` |
| G9 | **Mobile has no notifications.** Progress shows only when the app is opened. Push would need APNs: an Apple key, plus a server capability FeltKit doesn't have. | Missing | — |
| G10 | **Only text attachments.** PDFs and images are refused by contract (`UNSUPPORTED_CONTEXT`). Allowing them needs file storage per invocation; AppPort Files already exists (`feltkit/documents.ts`). | Partial | `_invocation.ts` |

### Parts 4 and 5: connectors

| # | Gap | Status | Evidence |
|---|---|---|---|
| G11 | **No per-person connector credentials. This is the central gap.** *Owner (decided): AppPort Services; see "Ownership".* A FeltKit integration holds one OAuth grant (`credential.ref`), connected by someone holding `credential.store` (an admin). Gmail has to be *Ada's* mailbox and Grace's has to be Grace's. FeltKit needs grants owned by a person: connected by that person, used only for work done as or on behalf of that person (after AuthBoundry allows it), and revocable by that person. That belongs in FeltKit, which already has the OAuth lifecycle (renewal, rotation, failure classes, disconnect). It doesn't belong in PersonalOS. | Missing (FeltKit) | `feltkit/packages/sdk/src/runtime/oauth-credentials.ts:313-366` (connect is gated on `credential.store`; one `client.ref` per integration) |
| G12 | **No connector manifest.** A FeltKit integration declaration already has most of one: operations with input/output schemas, `effect: observation \| consequential`, `access`, an OAuth credential with scopes, and failure classes. It lacks: provider identity, rate limits as data, a `destructive` class distinct from `consequential`, provenance requirements, and a way to list connectors at runtime. Extend the declaration rather than invent a second format. | Partial | `feltkit/app.ts:152-276` (identity, websearch, x integrations) |
| G13 | **No connector authority at AuthBoundry.** Connector capabilities (e.g. `gmail.send`) aren't AuthBoundry capabilities, so they can't be granted or revoked per connector. The fix fits the existing model: add them to the contract, and they appear in Settings. | Missing | `feltkit/_authority.ts` |
| G14 | **Approvals aren't bound to parameters for connector actions.** FeltKit agent proposals are already approved as one exact action with its arguments (`ctx.agent`, `actions.approve`), so this mechanism can be reused. | Exists (mechanism) | `src/chat.tsx:88`, FeltKit agent actions |
| G15 | **No MCP client.** FeltKit *serves* MCP (`/mcp`). It can't *consume* an external MCP server as a connector. | Missing (FeltKit) | — |
| G16 | **Gmail, Calendar and Drive need a Google OAuth client.** That means a Google Cloud project, a consent screen, and Gmail's restricted scopes (`gmail.send`, `gmail.readonly`), which need verification before anyone but test users can connect. The APIs are reachable from here. | Blocked (owner: you) | probe: `gmail.googleapis.com` reachable |
| G17 | **GitHub needs a GitHub OAuth app (or GitHub App) of yours.** This session's own GitHub token is the agent's, not a person's linked account, so it can't count as acceptance. | Blocked (owner: you) | — |

### Part 6: continuity

| # | Gap | Status | Evidence |
|---|---|---|---|
| G18 | **Continuing from X.** You can't continue an existing conversation from X, for privacy: X is public. Starting there works, and continuing it from the website, Chrome or Multiplayer works. | Partial, by design | `xsurface.ts:318` (the continue path), `docs/X.md` |
| G19 | **The result back on X.** "Final result in the original surface" conflicts with X being public. PersonalOS posts only an acknowledgement, and the result stays in PersonalOS (the M4 rule "retain the result and expose it through another authorized surface" applies). An X DM is possible but costs X API spend; it's your call. | Partial, by design | `xsurface.ts:30` |
| G20 | **Approval on mobile.** See G8. | Missing | — |

### Part 7: security

Most of the required tests exist: forged identity, injection in context, replay and idempotency
(including concurrent), revocation, unavailable authority, cross-user isolation.

| # | Gap | Status | Evidence |
|---|---|---|---|
| G21 | **Connector-specific tests.** Unauthorized connector calls, one person's connector used for another person, and scope least-privilege can't be tested until G11 and G13 exist. | Missing | — |

## Order of work

1. ~~**G6.** Compile iOS in CI.~~ Done: it compiled with no errors.
2. **G11 + G13 (FeltKit).** Per-person OAuth connections:
   - `credential: { perPrincipal: true, oauth2 }` on an integration;
   - connect, status and disconnect for the signed-in person;
   - `ctx.integrations` uses the grant of the person the work is for, and only after AuthBoundry allows
     that connector capability;
   - tested against the simulated OAuth provider, as the OAuth lifecycle already is.
3. **G12.** The connector manifest as an extension of `app.integration`, plus a runtime listing.
4. **G4, G5, G1, G2, G3.** The surface registry and the single contract:
   - `interaction/1` becomes a bridged delivery of the one contract, with both records exposed
     through one invocation view;
   - add the `cancelled` state.
5. **The first connectors in PersonalOS:** Gmail and Calendar (Google), and GitHub. Each is its own
   integration with its own capabilities, independently revocable, and consequential operations
   (send, create event, write) go through the existing approval flow.
6. **G8.** Approve from the iOS app, using the same `actions.approve`.
7. **Real acceptance:**
   - Google and GitHub with your OAuth apps (G16, G17);
   - iPhone on your device (G7);
   - an evidence report.

## Needed from you

- **iPhone acceptance (G7).** Your Mac with Xcode and your iPhone.
- **Google (G16).** A Google Cloud OAuth client: client id and secret, with redirect
  `<PersonalOS URL>/api/integrations/<name>/oauth/callback`, and you added as a test user.
- **GitHub (G17).** A GitHub OAuth app: client id and secret, with the same redirect form.
- **X results (G19).** Decide whether the result should go back by X DM (it costs X API spend), or
  stay in PersonalOS behind the public acknowledgement.
