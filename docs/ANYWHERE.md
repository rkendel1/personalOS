# PersonalOS Anywhere

Mention @personalos in another app. It works in **your** PersonalOS account, asks when it needs to,
waits for your approval when it should, and answers in the same conversation. The first surface is
[Multiplayer](https://github.com/rkendel1/multiplayer). The contract is
[`personalos.interaction/1`](INTERACTION-CONTRACT.md).

## Who does what

```
Multiplayer (surface)           PersonalOS                                   platform
───────────────────────         ──────────────────────────────────────       ───────────────────────────
messages:send records the       interactions:receive (bridge session)
request from the verified ───▶    1 adapter = authenticated principal         FeltKit sessions
session; app.agent            ─▶  2 idempotency (adapter, key)                FeltDB unique index
"personalos" re-verifies it,      3 identity ───────────────────────────────▶ Resolver: value reference per link
builds the envelope (bounded      4 authority (ctx.authority) ──────────────▶ AuthBoundry: on_behalf_of check
context) and delivers it          5 understand: deterministic (assistant.ts / _conversation.ts)
                                  6 execute: _ops.ts (verified, evidence in actions)
posts the reply in the        ◀─  7 record: interaction, its conversation, updates
originating thread                approvals: actions:approve (the owner, here) → update
personalos:inbound (signed    ◀─  interaction.updated event ─────────────────▶ AppPort Services webhooks
event, no browser) → sync         (durable, retried, signed)                   (FeltKit routes both ends)
```

| Concern | Owner | How |
|---|---|---|
| Event authenticity | Multiplayer and FeltKit | The message was posted by a FeltKit-authenticated session. `requestedBy` is derived from it, and the agent run re-checks membership, authorship and deletion when it runs. |
| Adapter authenticity | FeltKit (PersonalOS) | A bridge session that holds only `interactions.receive`, used by Multiplayer through its declared `personalos` integration; the token is a FeltKit credential reference. |
| Identity resolution | **Resolver** | `feltkit/_resolver.ts` |
| Proof of control of both identities | PersonalOS | A code issued to a signed-in account (`links:start`), redeemed by the authenticated sender in a direct message only. |
| Capability authorization | **AuthBoundry** | `ctx.authority.decide` (FeltKit's adapter), on behalf of the owner, through the owner's delegation to `agent:personalos`, before anything runs |
| Event delivery back to the surface | AppPort Services through FeltKit | PersonalOS emits `interaction.updated`; Multiplayer's inbound endpoint verifies it, refuses replays, and runs `personalos:inbound` as `integration:personalos` |
| Understanding, execution, memory, tasks, approvals, audit | PersonalOS | the same deterministic assistant and `_ops.ts` the chat uses; no second planner or store |
| Durable state | FeltDB (both apps), Resolver's FeltDB for links | |

## Identity through Resolver

Resolver (`@appport/resolver`) has no identity kind. A link is a typed `value` reference, created with
a fixed JSON Schema (`LINK_SCHEMA`) and `ttlSeconds: 0`:

```
ref://identity/personalos/<adapter>/<sha256(instance)>/<sha256(principal)>/<challenge>
  → { canonical: "personalos:account:<owner>",
      external: { adapter, instance, principalId },
      verification: { method: "personalos.link-code/dm+owner-confirmed", challengeId, verifiedAt },
      linkedAt }
```

| Requirement | How |
|---|---|
| Resolve | `resolver.lookup` on the indexed entry `identity.personalos:<adapter>:<sha256(instance)>` = the sender's principal id, fixed when the link is created; exactly one active reference whose stored `external` equals the sender exactly. No prefix scan. |
| Unknown | None matches: `NOT_LINKED`. |
| Ambiguous | More than one matches: `AMBIGUOUS_IDENTITY`. Fails closed for everyone. |
| Proof of control of both sides | The PersonalOS session issues a code. The surface's authenticated sender presents it in a DM, which uses it up and records which account presented it. The signed-in owner then confirms that account in PersonalOS. A code someone else saw and sent first shows *their* account, which the owner does not confirm. A code posted in a shared conversation is refused and burned. |
| Many-to-one | Several external identities (other principals, other installations) may each resolve to one account. |
| Durable, auditable | Resolver revisions record actor, reason and time; `identityLinks` in PersonalOS is the owner's index (codes, listing), not an authority. |
| Revocable | `links:revoke` marks the link disconnected, so the next request is refused at once, and the identity agent revokes the Resolver reference. Every later resolution fails, and in-flight interactions report `revoked`. A revoked name is never reused; relinking creates a new reference. |
| Who writes links | Only the `identity` agent (`feltkit/links.ts`), after the owner's confirmation or disconnection commits. It runs as its own principal with the only role that holds `identity.link`, so no person's or bridge's session can call the Resolver integrations directly (FeltKit also serves them on `/appport`). The `put` operation's input schema allows only `expectedRevision: 0`: it can create a link, never change one. |
| Spoofing | Names are hashes for layout only; matching is on stored values. Display names, case variants, claims and planted references under another sender's prefix do not resolve. |
| Fail closed | Resolver unconfigured or unreachable: `UNAVAILABLE`, nothing recorded, and the surface retries the same key. |
| Least privilege | Two Resolver keys, both on `ref://identity/personalos/*` only: one holds `read` (resolving), one holds `write` (linking) and cannot read. Resolver itself refuses a write with the first and a read with the second. |
| Credentials | Both keys are FeltKit credentials (custody references), used only through the declared `identity` and `identitylinks` integrations. App code never holds them. Rotation is a new credential version; revocation is revoking the key in Resolver. |

Configuration: `RESOLVER_URL`, and the two keys as FeltKit credentials `resolver-resolve` and
`resolver-link` (`feltkit credential set`, or `FELTKIT_CREDENTIAL_RESOLVER_RESOLVE` /
`FELTKIT_CREDENTIAL_RESOLVER_LINK`).

## Authority through AuthBoundry

Each request maps to one capability (`capabilityFor`):

- `personalos.reminders.create`, `tasks.create|read|update|delete`
- `memory.read|write|delete`, `projects.create`
- `conversation.read`, `assistant.converse`

Before anything runs, PersonalOS calls `ctx.authority.decide({ capability, onBehalfOf: "user:<owner>" })`.
That is FeltKit's own AuthBoundry adapter, configured once in `feltkit/app.ts`:

```ts
authority: { url: { env: "AUTHBOUNDRY_URL" }, application: "personalos",
             checkCredential: "credential-ref:authboundry-check",
             executor: { principal: "agent:personalos", type: "agent" } }
```

The identities are distinct and each has one authority:

| Role | Who | Decided by |
|---|---|---|
| Requester | the Multiplayer participant who wrote the message | FeltKit session in Multiplayer (`requestedBy`) |
| Resource owner | the PersonalOS account the sender is linked to | Resolver |
| Executor | `agent:personalos` | AuthBoundry agent principal |
| Delegated authority | the owner's delegation to `agent:personalos` (capabilities, scope, expiry) | AuthBoundry, created and revoked there |
| Evidence | `decisionId`, `delegationId`, `onBehalfOf`, `principal` on the interaction | AuthBoundry's decision record |

AuthBoundry (`POST /_authboundry/authorize/check` with `on_behalf_of`) uses only that person's live
delegation to the executor. None of these allow:

- another person's delegation
- the agent's own rules
- an expired, revoked or out-of-scope delegation
- a capability the delegator has lost

The decision outcomes:

- An allow counts only if it is exact, echoes `on_behalf_of`, and names a `delegation_id`.
- A deny is recorded as `refused`, with the decision.
- An unreachable, slow or unverifiable authority is `UNAVAILABLE`: nothing recorded, retried.
- Revoking the delegation in AuthBoundry stops the next operation. The link and the identities are
  unchanged.

Configuration: `AUTHBOUNDRY_URL`, and the check credential as `FELTKIT_CREDENTIAL_AUTHBOUNDRY_CHECK`
(or `feltkit credential set authboundry-check`). Without them, nothing a surface asks for is allowed.

AuthBoundry decides *whether the account may*. PersonalOS's own rules still apply after it:

- **Audience.** A shared conversation never gets private data.
- **Approvals.** Deleting or forgetting waits for the owner in PersonalOS. The proposal records the
  exact kind, input, conversation and message, so the approval is bound to the exact action. The
  bridge cannot approve: `actions:approve` is `approval: "required"`.

## Privacy in shared conversations

Only a direct conversation between the requester and PersonalOS is private. In a channel, a group or
a DM with another person:

- Requests that read private data get their full answer in PersonalOS only. The surface is told it
  was answered privately. This covers memory, task lists, briefings, project status, and matching an
  existing task.
- Proposals are described generically ("delete a task in your PersonalOS"), without titles.
- Answers about the conversation itself (summary, decisions, action items) use only the envelope's
  context, which everyone there can already read.

## Running the demonstration

```bash
# From the personalOS repository: the platform at its pinned commits (scripts/anywhere-platform.mjs)
node scripts/anywhere-platform.mjs build
node scripts/anywhere-platform.mjs install . ../multiplayer

# From the multiplayer repository:
PERSONALOS_DIR=../personalOS AUTHBOUNDRY_DIR=../personalOS/.anywhere/src/authboundry node e2e/personalos-anywhere.e2e.mjs
```

The script starts Resolver, AuthBoundry (bootstrapped through its control API), PersonalOS and
Multiplayer with fresh state. It creates:

- the bridge session
- the agent and both people's delegations
- the event endpoint and the inbound integration

It then drives both apps in Chromium as Ada and Grace. It writes screenshots, `evidence.json` and
per-server logs. Every secret the run created is replaced by `[secret]` before anything is written.

By hand, with the same services:

1. In AuthBoundry, create:
   - the `personalos` application and its capabilities
   - the owner's principal and policy
   - the agent `agent:personalos`
   - the owner's delegation to the agent
   - a check credential
2. Start PersonalOS (`npx feltkit dev --port 3110`) with these set:
   - `RESOLVER_URL`, and the two Resolver keys as `FELTKIT_CREDENTIAL_RESOLVER_RESOLVE` (grant `read`) and
     `FELTKIT_CREDENTIAL_RESOLVER_LINK` (grant `write`), both on `ref://identity/personalos/*`
   - `AUTHBOUNDRY_URL` and `FELTKIT_CREDENTIAL_AUTHBOUNDRY_CHECK`
   - the event signing secret, as `FELTKIT_CREDENTIAL_SURFACE_EVENTS`
3. Create the bridge session:
   `npx feltkit session create --type service --id multiplayer --role bridge`.
4. Start Multiplayer with these set:
   - `PERSONALOS_URL=http://localhost:3110`
   - `FELTKIT_CREDENTIAL_PERSONALOS_BRIDGE=<token>`
   - the same signing secret, as `FELTKIT_CREDENTIAL_PERSONALOS_EVENTS`
5. Register the event path through each app's Studio admin API, as an administrator of that app.
   - In Multiplayer, `POST /services/webhooks/integrations` with
     `{ provider: "personalos", signingCredentialRef: "credential-ref:personalos-events" }`.
   - In PersonalOS, `POST /services/manage/_appport/webhooks` with
     `{ url: "<multiplayer>/webhooks/inbound/<integration id>", events: ["interaction.updated"], signingCredentialRef: "credential-ref:surface-events" }`.
6. In Multiplayer, choose **✦ Add @personalos**.
7. In PersonalOS, choose **Settings → Connected surfaces → Connect Multiplayer**.
8. Send `link XXXX-XXXX` to PersonalOS in a Multiplayer direct message, then in PersonalOS confirm the account that sent it ("This is me").
9. In a channel, write `@PersonalOS remind me to follow up with Sarah tomorrow at 9am`.

## Platform gaps: Milestone 2 → Milestone 3

The full before/after, with source locations and tests, is in
[ANYWHERE-M3-REGISTER.md](ANYWHERE-M3-REGISTER.md).

| Gap at M2 | Now | Where |
|---|---|---|
| No on-behalf-of decision: any delegation, or the agent's own rules, could allow | An `on_behalf_of` check: only that person's live, in-scope delegation | AuthBoundry `9feca56` |
| FeltKit's AuthBoundry adapter was unreachable from apps; PersonalOS duplicated it | `ctx.authority.decide`; PersonalOS's HTTP client is deleted | FeltKit `2f92c3b` |
| No inbound events into a FeltKit app; Multiplayer polled every 5 s with the page open | `POST /webhooks/inbound/<id>` runs an app mutation as `integration:<provider>`; Multiplayer syncs on the event | FeltKit `2f92c3b`, `5cec9a0`, `3a04846`, `70b38e0` |
| A failed inbound handler consumed the event id | FeltKit releases the replay record when the handler fails | FeltKit `2f92c3b` (AppPort Services still records it before the handler) |
| AppPort inbound endpoints could not verify AppPort outbound deliveries | Deliveries also carry `X-AppPort-Timestamp` and `X-AppPort-Signature-V2` | AppPort Services `7de1de2` |
| App code could not use a stored credential; the bridge token was in `process.env` | `ctx.integrations.invoke` through the declared `personalos` integration | FeltKit `2f92c3b`, Multiplayer |
| Identity resolution scanned every reference | `resolver.lookup` on an indexed, immutable lookup entry | Resolver `f2b29e7` |
| Context selection was duplicated inside Multiplayer | `feltkit/_context.ts`, used by the room agent and the envelope | Multiplayer |
| AuthBoundry `npm ci` failed; tests used a stand-in authority | Lockfile fixed; CI builds the real server at a pinned commit and runs `tests/authboundry-real.test.ts` | AuthBoundry `9feca56`, PersonalOS CI |

Still open (owners are in the register):

- These commits are not released.
- The cross-app conversation classifier (`_conversation.ts` / `_compose.ts`) has no shared home.
- An AuthBoundry administrator creates the delegations. The owner has no federated sign-in to do it.
- The executor is asserted under the application's check credential. It is not proven by its own
  agent credential.
- FeltKit and AppPort have no native on-behalf-of principal. `actingFor` remains PersonalOS's seam,
  used only after an AuthBoundry delegated allow.

Settled questions:

- On FeltKit 0.3.25 a webhook emitted by an `app.agent` **is** delivered and signed (Multiplayer
  `tests/personalos.test.ts`).
- The browser's time zone reaches `ctx.auth.context.timeZone` server-side; Multiplayer records it
  with the request.

## Limitations

- Surface interactions use the deterministic assistant only. A model turn (`turn.ts`) needs the
  owner's own session (`ctx.agent.openTask` as the caller). The AuthBoundry delegation decides
  capabilities; it does not give FeltKit an owner session.
- Updates after approval reach Multiplayer by a signed event, whether or not anyone has the
  conversation open. If the event endpoint is not registered, they arrive when the conversation is
  next opened (one sync).
- Attachments are references; PersonalOS does not read their bytes.
- No email, calendar or file data is exposed through surfaces: none is connected, and private reads
  are withheld from shared audiences anyway.
