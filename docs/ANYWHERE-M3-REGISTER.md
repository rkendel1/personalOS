# PersonalOS Anywhere M3: issue register

Verified against source on 2026-11-12. The baseline is Milestone 2:

| Repository | Commit |
|---|---|
| PersonalOS | `cea4411` |
| Multiplayer | `1daf528` |
| FeltKit | `8826fdf` (= npm 0.3.25) |
| AuthBoundry | `b041a6c` |
| Resolver | `38cfec6` (npm 0.3.3) |
| AppPort | `e91fd39` |
| AppPort Services | npm 0.16.2 (as installed) |

Each row was checked in the code, not taken from the M2 report. **Before** is what the code does at
the baseline. **After** is filled in as work lands (see the end of this file).

## R1. Delegation is not bound to whom the agent acts for (AuthBoundry)

**Where.**
- `crates/runtime/src/mesh.rs:1333`: `authorize_from_snapshot` calls `pick_delegation(delegations, capability, now, None, None)`.
- `crates/server/src/control_routes.rs:1561` (`fast_authorization_check`) and `:1760` (`decide_application_capability`).

**Actual behavior.**
- The check endpoint (`POST /_authboundry/authorize/check`) evaluates the asking principal's live delegations.
- It takes the **first** valid delegation granting the capability, from **any** delegator.
- With `request = None`, `resource_scope` is never compared (`mesh.rs:2351`, `unwrap_or(true)`).
- An agent's **own** policy rule is evaluated before delegations (`crates/authz/src/evaluator.rs:170`), so an on-behalf request can be allowed without any delegation.
- The compact decision returns neither the delegation nor the delegator. They are only in the persisted evidence (`control_routes.rs:2160`).

**Existing contract (sound, reused).**
- Delegations `{delegator, delegate, capabilities, resource_scope, expires_at, revoked_at, chain}` (`crates/contract/src/delegation.rs:69`).
- Creation is bounded by the delegator's authority (`DelegationExceedsAuthority`, `mesh.rs:777`).
- Delegations are re-bounded by the delegator's *current* authority when decided (`live_delegations`, `mesh.rs:903`).
- Agent principals and short-lived rotating agent credentials (`agent_credentials.rs`).
- On-behalf creation needs `authority.policy.write` (`control_routes.rs:5576`).

**Missing.** A way to say **on whose behalf** the agent acts, so the decision can only use that
person's delegation. Also:
- Resource-scope matching on the check path.
- No fallback to the agent's own rules for on-behalf requests.
- The delegation and delegator in the decision.

**Smallest change.** In the check body, accept `on_behalf_of` (a principal id) and use the existing
`resource`. When `on_behalf_of` is present:
- Select only live delegations with that delegator and a matching resource scope.
- Evaluate through delegation only. Otherwise deny with the evaluator's own reason (`delegation_missing`, `expired_delegation`, `revoked_delegation`).
- Echo `on_behalf_of`, `delegation_id` and `delegator` in the decision and the evidence.

Without `on_behalf_of`, behavior is unchanged.

**Tests.** In `crates/server/tests` (real server):
- Allow through Ada's delegation.
- Deny when only Grace delegated.
- Deny after revocation.
- Deny when expired.
- Deny when the capability is outside the delegation.
- Deny when the delegator lost the capability.
- Deny when the resource is out of scope.
- The agent's own rule does not satisfy an on-behalf request.
- The decision echoes the delegation.

**Owner.** AuthBoundry.

## R2. FeltKit's AuthBoundry adapter is unreachable from application code (FeltKit)

**Where.** `packages/sdk/src/runtime/authboundry.ts`. Its only caller is
`packages/sdk/src/platform/platform.ts:106`. It is not in `exports`. PersonalOS duplicated it as
`feltkit/_authority.ts` (84 lines).

**Actual behavior.** Application calls are never sent to AuthBoundry.

**Missing.**
- An application-facing decision through the same implementation.
- `on_behalf_of` and resource fields.
- The agent credential, resolved server-side.

**Smallest change.**
- `ctx.authority.decide({ capability, onBehalfOf?, resource?, context? })` in mutation, action and agent contexts, backed by `authBoundryAuthority`, the same one the platform uses.
- Configured by the same `FELTKIT_AUTHBOUNDRY_*` environment variables, plus an optional agent credential **reference** resolved through FeltKit's credential custody.
- The decision returns `{ allowed, outcome, decisionId, reason, delegationId, delegator, onBehalfOf }`.

**Tests.** In FeltKit's own suite, against an HTTP authority:
- Allow.
- Deny.
- 404 unknown principal.
- Timeout.
- Unreachable.
- Malformed / non-exact allow.
- Delegation fields echoed.
- Credential never in the result, the activity or errors.
- Unconfigured: an explicit `unavailable`, never an allow.

**Owner.** FeltKit.

## R3. No push delivery into a FeltKit application (FeltKit, AppPort Services)

**Where.**
- AppPort Services has inbound webhooks (`WebhookService.receiveWebhook`, `registerInboundHandler`, `FeltDbInboundWebhookReplayStore`; `dist/src/webhooks/service.js:316`), with signature verification through custody, a tolerance window, replay refusal, audit, and principal `integration:<provider>`.
- FeltKit reserves the `inbound_webhook_events` collection (`src/app.ts:57`), but exposes no route, no configuration and no handler.

**Actual behavior.** Multiplayer pulls (`personalos:sync`) only while a browser shows the
conversation.

**Missing.**
- A FeltKit route to `receiveWebhook`.
- Application-declared inbound providers whose handler is an application mutation run as `integration:<provider>`.

**Smallest change.**
- `services.webhooks.inbound: { <provider>: "<module>:<mutation>" }` in `feltkit()`.
- `POST /webhooks/inbound/<integrationId>` passes the exact raw body and headers to `receiveWebhook`.
- The handler runs the declared mutation as `integration:<provider>` with the verified event.
- Integrations are registered like endpoints (`webhooks.integrations.register`).

**Tests.**
- A signed delivery runs once.
- A bad signature or stale timestamp is refused.
- A replay is refused.
- A handler failure is recoverable (see R4).
- No browser is involved.

**Owner.** FeltKit.

## R4. Inbound replay record is committed before the handler (AppPort Services)

**Where.** `dist/src/webhooks/service.js:348` (`replay.accept` in its own transaction), then the
handler at `:366`.

**Actual behavior.** If the handler throws, the event id is already consumed. The sender's retry is
refused as `replayed` and the event is lost.

**Smallest change.** On a handler failure (not on a signature, staleness or replay refusal), release
the replay record. This mirrors AppPort's idempotency claim/release. Alternatively, FeltKit's handler
records the event in the application's own transaction and cannot fail after acceptance.

**Tests.** The handler throws once, the retry with the same event id is processed once, and a
second retry after success is refused.

**Owner.** AppPort Services (`rkendel1/appport-services`). FeltKit mitigates on its side.

## R5. Application code cannot use a stored credential (FeltKit)

**Where.**
- `packages/sdk/src/runtime/context.ts`: `ConfigurationReader` has `get` and `list` only.
- `IntegrationHost.invoke` (`src/runtime/integrations.ts:223`) resolves credentials server-side with call evidence, but no `ctx` path reaches it.

**Actual behavior.** Multiplayer reads `PERSONALOS_BRIDGE_TOKEN` from `process.env`
(`multiplayer/feltkit/_personalos.ts`).

**Smallest change.** `ctx.integrations.invoke("<integration>.<operation>", input, { idempotencyKey })`
from mutation and agent contexts.
- It runs `IntegrationHost.invoke` as the caller (the operation's `access` applies).
- The credential stays a reference resolved only for the request.
- Results and errors are redacted, and the call record is the audit.
- Rotation is `feltkit credential set` (a new version); revocation is `credential remove`.

**Tests.**
- The call succeeds with the stored credential.
- The value never appears in the result, the call record, activity or errors.
- Rotation takes effect on the next call.
- A removed or invalid credential fails the call.
- A caller without the operation's permission is refused.

**Owner.** FeltKit.

## R6. Identity resolution scans every reference (Resolver)

**Where.** `packages/server/src/resolver.ts:149` (`list` loads all tenant references and filters by
prefix in memory). PersonalOS `feltkit/_resolver.ts` then resolves each candidate.

**Missing.** Exact lookup by a declared, indexed value, filtered by the caller's grants and by
revocation.

**Smallest change (a general primitive).**
- A reference may declare `lookup: { key, value }` at creation; the value is immutable for that reference.
- It is stored in an indexed `lookups` collection.
- `resolver.lookup({ key, value })` returns the active references with that exact key and value that the caller may read.

Identity uses `key = "identity:<adapter>:<instance>"`, `value = <principal id>`.

**Tests.**
- An exact match.
- No match.
- Two matches (the caller decides ambiguity).
- A revoked reference is excluded.
- A reference outside the caller's grants is invisible.
- Another tenant is invisible.
- The value cannot be changed by an update.
- Lookup does not scan (it uses the index query).

**Owner.** Resolver.

## R7. Duplicated conversation reading (PersonalOS, Multiplayer)

**Where.** PersonalOS `feltkit/_conversation.ts` (112 lines) and Multiplayer `feltkit/_compose.ts`
(87 lines).

**Actual behavior.** Two regex extractors with different outputs:
- PersonalOS: a summary, decisions and action items for a person, with source ids.
- Multiplayer: a project plan for the room.

The shared part is the decision, action, question and risk classification of messages with
provenance. What each produces from it differs and stays in the application.

**Smallest change.** One shared, pure, provenance-preserving reader of a bounded,
participant-attributed context, published with the interaction contract. Both apps keep their own
output. Its home is decided in M3 (see the after section).

**Tests.**
- Multiplayer's plan output is unchanged on its existing fixtures.
- PersonalOS's summary, decisions and items are unchanged.
- Every extracted item cites its source message.

**Owner.** Platform; the shared contract.

## R8. AuthBoundry clean install, distribution and CI (AuthBoundry)

**Where.** `package-lock.json`: `npm ci` fails with EUSAGE. The four `@authboundry/core-*` optional
platform packages are 1.16.0 in `package.json` with no matching lock entries. This also breaks its
own CI: `architecture-invariants.yml` runs `npm ci --ignore-scripts`.

**Licensing (evidence, no change needed).**
- `LICENSE` is MIT and `package.json` says `"license": "MIT"`, `publishConfig.access: public`.
- Commit `da5a757` (2026-11-11) is titled "License AuthBoundry under MIT (the owner's decision)".
- The npm 1.16.0 package (`gitHead 0b96095`, 2026-11-03) predates it, hence `UNLICENSED`.
- Distribution needs a new release by the owner.

**Smallest change.**
- Regenerate the lockfile so `npm ci` succeeds.
- The PersonalOS CI builds the real AuthBoundry from source at a pinned commit and runs the delegation acceptance against it.

**Owner.** AuthBoundry (lockfile, release), PersonalOS (CI).

## R9. Bridge acts for the owner inside PersonalOS (PersonalOS)

**Where.**
- `feltkit/_ops.ts` `actingFor`, used in `interactions:receive` and `reminders:fire`.
- The PersonalOS bridge principal `multiplayer` is a FeltKit service session, not an AuthBoundry agent.

**After R1/R2.** The decision becomes AuthBoundry's, with requester (`on_behalf_of`), executor (the
PersonalOS agent principal, proven by its agent credential) and delegation. `actingFor` remains
FeltKit-side tenancy of the *resource owner's records*, used only after an AuthBoundry delegated
allow. FeltKit has no on-behalf-of principal type (AppPort lacks one too), so that part stays an
application seam until the platform adds one.

**Owner.** PersonalOS (now); FeltKit / AppPort (a native on-behalf-of principal).

---

# After (2026-11-12)

Every row was verified by running the code named, not by reading documentation. "Real" means the
real component ran, not a stand-in.

| Repository | Commit (branch `claude/affectionate-bardeen-o1xu78`) |
|---|---|
| AuthBoundry | `9feca56` |
| FeltKit | `2f92c3b`, `5cec9a0`, `3a04846`, `70b38e0` |
| Resolver | `f2b29e7` |
| AppPort Services | `7de1de2` |
| PersonalOS, Multiplayer | the M3 commits on this branch |

| Row | Status | What changed | Evidence |
|---|---|---|---|
| R1 | **Done** | The check accepts `on_behalf_of` and a structured `resource`. It decides only from that delegator's live delegation to the asking agent, with an exact capability and an admitted scope. It uses no agent rules and fails closed on an attributed scope. It echoes `on_behalf_of` and `delegation_id`. Without `on_behalf_of`, behavior is unchanged. | AuthBoundry `crates/server/tests/enforcement_contract.rs` (8/8). The runtime, authz and server suites pass 276/0. Real server: PersonalOS `tests/authboundry-real.test.ts` (5/5) and e2e checks 4.1 and 4.2. |
| R2 | **Done** | `ctx.authority.decide` in mutation and action contexts, on FeltKit's own adapter. The executor and credential references are declared in `feltkit({ authority })`. An on-behalf allow without the echo is `unavailable`. Each decision is recorded in activity, without the credential. PersonalOS's HTTP client is deleted; `_authority.ts` keeps only the capability map. | FeltKit `test/application-platform.test.ts`. PersonalOS `tests/interactions.test.ts` (31/31). |
| R3 | **Done** | `services.webhooks.inbound` in `feltkit()`. `POST /webhooks/inbound/<integrationId>` passes the exact raw body. The declared mutation runs as `integration:<provider>` with only its declared roles. Integrations are registered in Studio admin; in development a dev route acts as `x-feltkit-as`. Multiplayer's `personalos:inbound` validates the event and schedules a tenant-scoped `sync`. The 5 s browser poll is replaced by one sync on open. | Multiplayer `tests/personalos.test.ts` (14/14). Real stack: e2e check 3.3 (approval in PersonalOS reaches a closed conversation by a signed event; reopened, the result is there; a replayed delivery changes nothing), and checks 10, 11 and 16. |
| R3a (found in M3) | **Done** | AppPort outbound deliveries signed only the body and sent no timestamp, while AppPort inbound requires both. Every PersonalOS → Multiplayer delivery was refused (HTTP 400, seen in the e2e diagnostics). Each attempt now also sends `X-AppPort-Timestamp` and `X-AppPort-Signature-V2`; inbound prefers V2. The documented `X-AppPort-Signature` is unchanged. | AppPort Services `tests/webhook-boundary.test.ts`: a real delivery from one stack is accepted once by another, and replay and tampering are refused. Suite 398/398. |
| R4 | **Mitigated in FeltKit; open upstream** | FeltKit's `receiveInbound` releases the replay record when the handler fails and answers `HANDLER_FAILED` (500), so the sender's retry is processed. AppPort Services' own `receiveWebhook` still records before its handler. | FeltKit `test/application-platform.test.ts` (fail once, retry processed once, replay after success refused). Owner: AppPort Services. |
| R5 | **Done for the bridge; open for Resolver** | `ctx.integrations.invoke` runs `IntegrationHost.invoke` as the caller, and the operation's `access` applies. Multiplayer's `personalos` integration holds `credential-ref:personalos-bridge`, and `PERSONALOS_BRIDGE_TOKEN` is gone. Rotation is `feltkit credential set`. PersonalOS's Resolver key is still `RESOLVER_API_KEY` from the environment. Moving it behind an integration would expose `resolver.put` to whoever may call the operation. | Multiplayer `tests/personalos.test.ts` ("credentials: …"): the token is never in requests, records or results. FeltKit `test/application-platform.test.ts` ("ctx.integrations: …"): server-side resolution, rotation, revocation, and refusal of a caller without the operation's access. Owner of the Resolver item: FeltKit (unpublished integration operations) and Resolver. |
| R6 | **Done** | `put({ lookup: { key, value } })` is fixed at creation. A compound index on (tenant, key, value) backs it, and `resolver.lookup` filters by grants, revocation and tenant. PersonalOS creates links with a lookup entry and resolves with `lookup`; there is no prefix scan. | Resolver `lookup.test.ts` (7/7); suite 184 pass, 9 skipped. PersonalOS ambiguity, unknown and revoked tests; e2e checks 3, 13 and 13.1. |
| R7 | **Partly done** | Inside Multiplayer, context selection is one function (`feltkit/_context.ts`) used by the room agent (unchanged bounds; 41/41) and by the PersonalOS envelope. The cross-app classifier (PersonalOS `_conversation.ts`, Multiplayer `_compose.ts`) is **not** shared: there is no published package to hold it, and creating one is a new distribution the owners have not decided. | Multiplayer suite 41/41. Owner: platform (where the interaction contract is published). |
| R8 | **Done (lockfile, CI); open (release)** | The AuthBoundry lockfile is regenerated and `npm ci` passes from a clean worktree. PersonalOS CI builds AuthBoundry from source at `9feca56` (`scripts/anywhere-platform.mjs`) and runs the real-server tests with `REQUIRE_REAL_AUTHBOUNDRY=1`, so a missing build fails. The licensing evidence is unchanged: MIT since `da5a757`, npm 1.16.0 predates it. | `npm ci` in a clean AuthBoundry worktree. CI needs the `PLATFORM_REPOS_TOKEN` secret (read access to the private repositories). Owners: AuthBoundry (release), the repository owner (secret). |
| R9 | **Done (decision); open (native principal)** | AuthBoundry now decides the delegated action, with requester (`on_behalf_of`), executor (`agent:personalos`) and delegation all recorded on the interaction. `actingFor` runs only after that allow. The executor is asserted by PersonalOS under its application check credential, not proven by an agent credential: AuthBoundry's check endpoint does not accept one. FeltKit and AppPort have no on-behalf-of principal type. | e2e check 4.2: Ada's delegation is revoked; requester, executor and link are unchanged; her next operation is refused. Owners: AuthBoundry (agent-credential proof on check), FeltKit / AppPort (native principal). |

Other blockers, each with its owner:

- **Releases.** None of these commits is on npm. The apps run them through
  `scripts/anywhere-platform.mjs` at pinned commits, recorded in `.anywhere/installed.json`.
  Publishing is each package owner's decision.
- **Delegation creation.** An AuthBoundry administrator creates delegations through the control API.
  The owner has no federated AuthBoundry sign-in to do it themselves. Owner: AuthBoundry.
- **Management route.** AppPort Services' management router has no inbound-integrations route.
  FeltKit's Studio admin route covers it for FeltKit apps. Owner: AppPort Services.
- **FeltKit test failures.** FeltKit has 28 pre-existing test failures (deploy, production and
  platform tests). The identical 28 fail on unmodified `main` in this environment. Owner: FeltKit.
- **Multiplayer CI.** Multiplayer has no CI workflow, so its suites and e2e run by hand. Owner:
  Multiplayer.

## Measurement against Milestone 2

`feltkit measure` was run on each app at its M2 commit (PersonalOS `cea4411`, Multiplayer `1daf528`)
and on this milestone. `feltkit measure --compare` gives the side-by-side; the method is in
`measure.json` (`method`).

| Authored lines (files) | PersonalOS M2 | PersonalOS M3 | Multiplayer M2 | Multiplayer M3 |
|---|--:|--:|--:|--:|
| domain | 2821 (27) | 2811 (27) | 1350 (17) | 1414 (18) |
| experience | 1914 (20) | 1914 (20) | 1251 (8) | 1248 (8) |
| infrastructure | 24 (1) | 95 (2) | 0 | 0 |
| configuration | 158 (6) | 172 (7) | 74 (5) | 74 (5) |
| tests | 1911 (12) | 2129 (13) | 1547 (6) | 1716 (6) |
| **authored** | **4917** | **4992** | **2675** | **2736** |
| distinct platform APIs used | 33 | 34 | 43 | 44 |
| failing measure checks | none | none | none | none |

What the numbers show:

- **PersonalOS domain code shrank by 10 lines while gaining delegation.** `_authority.ts` went from
  60 to 21 code lines; its HTTP client is now FeltKit's (`ctx.authority`).
- **The PersonalOS infrastructure increase (+71) is `scripts/anywhere-platform.mjs`.** It installs
  unreleased platform commits, and it is deleted when they are released.
- **Multiplayer domain grew by 64 lines.** The new pieces are:
  - the declared `personalos` integration
  - the inbound role and handler (`personalos:inbound`)
  - `_context.ts`, which replaced two separate context readers
- **Tests:** PersonalOS +218 lines (real AuthBoundry, delegation, events), Multiplayer +169 lines
  (events, credentials).

Behavior, measured on the real stack:

| | M2 | M3 |
|---|---|---|
| Real-stack acceptance | 15/15 | 17/17. New: 3.3 (closed conversation, signed event, replay) and 4.2 (delegation revoke) |
| Updates after approval | Polled every 5 s while the conversation was open | One signed event per change: 4 `interaction.updated` deliveries, 4 delivered on the first attempt (`docs/screenshots/anywhere/evidence.json` in Multiplayer). One sync when the conversation is opened |
| Who may act for the owner | Any delegation, or the agent's own rules | Only the owner's live delegation to `agent:personalos` (AuthBoundry `on_behalf_of`) |
| Identity resolution | Prefix list of every reference, then one resolve per candidate | One indexed `resolver.lookup` |
| Bridge token | `process.env` in app code | FeltKit credential reference, used only by the integration |
| AuthBoundry in tests | A stand-in authority, plus the real server in the e2e | Real server in the app suite (5 tests) and in the e2e; required in CI |

The app suites now:

- PersonalOS 64/64, 0 skipped, with the real AuthBoundry required.
- Multiplayer 41/41.
- The Multiplayer browser suite 21/21.
- The PersonalOS UI suite: 9 checks before a server restart and 3 after.
