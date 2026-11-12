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
builds the envelope (bounded      4 authority ──────────────────────────────▶ AuthBoundry: check, mode enforce
context) and delivers it          5 understand: deterministic (assistant.ts / _conversation.ts)
                                  6 execute: _ops.ts (verified, evidence in actions)
posts the reply in the        ◀─  7 record: interaction, its conversation, updates
originating thread;               approvals: actions:approve (the owner, here) → update
pulls later updates (sync)
```

| Concern | Owner | How |
|---|---|---|
| Event authenticity | Multiplayer and FeltKit | The message was posted by a FeltKit-authenticated session. `requestedBy` is derived from it, and the agent run re-checks membership, authorship and deletion when it runs. |
| Adapter authenticity | FeltKit (PersonalOS) | A bridge session that holds only `interactions.receive`. |
| Identity resolution | **Resolver** | `feltkit/_resolver.ts` |
| Proof of control of both identities | PersonalOS | A code issued to a signed-in account (`links:start`), redeemed by the authenticated sender in a direct message only. |
| Capability authorization | **AuthBoundry** | `feltkit/_authority.ts`, before anything runs |
| Understanding, execution, memory, tasks, approvals, audit | PersonalOS | the same deterministic assistant and `_ops.ts` the chat uses; no second planner or store |
| Durable state | FeltDB (both apps), Resolver's FeltDB for links | |

## Identity through Resolver

Resolver (`@appport/resolver`) has no identity kind. A link is a typed `value` reference, created with
a fixed JSON Schema (`LINK_SCHEMA`) and `ttlSeconds: 0`:

```
ref://identity/personalos/<adapter>/<sha256(instance)>/<sha256(principal)>/<challenge>
  → { canonical: "personalos:account:<owner>",
      external: { adapter, instance, principalId },
      verification: { method: "personalos.link-code/dm", challengeId, verifiedAt },
      linkedAt }
```

| Requirement | How |
|---|---|
| Resolve | List the active references under the sender's prefix; exactly one whose stored `external` equals the sender exactly. |
| Unknown | None matches: `NOT_LINKED`. |
| Ambiguous | More than one matches: `AMBIGUOUS_IDENTITY`. Fails closed for everyone. |
| Proof of control of both sides | The PersonalOS session issues a code; the surface's authenticated sender redeems it in a DM. A code posted in a shared conversation is refused and burned. |
| Many-to-one | Several external identities (other principals, other installations) may each resolve to one account. |
| Durable, auditable | Resolver revisions record actor, reason and time; `identityLinks` in PersonalOS is the owner's index (codes, listing), not an authority. |
| Revocable | `links:revoke` revokes the Resolver reference first. Every later resolution fails, and in-flight interactions report `revoked`. A revoked name is never reused; relinking creates a new reference. |
| Spoofing | Names are hashes for layout only; matching is on stored values. Display names, case variants, claims and planted references under another sender's prefix do not resolve. |
| Fail closed | Resolver unconfigured or unreachable: `UNAVAILABLE`, nothing recorded, and the surface retries the same key. |
| Least privilege | PersonalOS's Resolver key holds `read, write` on `ref://identity/personalos/*` only. |

Configuration: `RESOLVER_URL`, `RESOLVER_API_KEY`.

## Authority through AuthBoundry

Each request maps to one capability (`capabilityFor`):

- `personalos.reminders.create`, `tasks.create|read|update|delete`
- `memory.read|write|delete`, `projects.create`
- `conversation.read`, `assistant.converse`

PersonalOS asks AuthBoundry (`POST /_authboundry/authorize/check`, mode `enforce`, principal
`user:<owner>`) **before** anything runs. This is the same contract FeltKit and AuthBoundry's SDK
speak.

- Only an exact allow with a decision id is an allow.
- A deny or unknown principal is recorded as `refused`, with the decision.
- An unreachable, slow or unverifiable authority is `UNAVAILABLE`: nothing recorded, retried.
- The decision (`capability`, `outcome`, `principal`, `decisionId`) is kept on the interaction as
  evidence.

Configuration: `FELTKIT_AUTHBOUNDRY_URL`, `FELTKIT_AUTHBOUNDRY_APPLICATION`,
`FELTKIT_AUTHBOUNDRY_CHECK_CREDENTIAL`. Without them, nothing a surface asks for is allowed.

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
# AuthBoundry (rkendel1/authboundry), once:
cargo build --release --bin authboundry
npm install --omit=dev --omit=optional --ignore-scripts --no-package-lock   # see Platform gaps: npm ci fails

# From the multiplayer repository:
PERSONALOS_DIR=../personalOS AUTHBOUNDRY_DIR=../authboundry node e2e/personalos-anywhere.e2e.mjs
```

The script starts Resolver, AuthBoundry (bootstrapped through its control API), PersonalOS and
Multiplayer with fresh state, creates the bridge session, and drives both apps in Chromium as Ada and
Grace. It writes screenshots and `evidence.json`.

By hand, with the same services:

1. Start PersonalOS with `RESOLVER_*` and `FELTKIT_AUTHBOUNDRY_*` set:
   `npx feltkit dev --port 3110`.
2. Create the bridge session:
   `npx feltkit session create --type service --id multiplayer --role bridge`.
3. Start Multiplayer with `PERSONALOS_URL=http://localhost:3110` and
   `PERSONALOS_BRIDGE_TOKEN=<token>`.
4. In Multiplayer, choose **✦ Add @personalos**.
5. In PersonalOS, choose **Settings → Connected surfaces → Connect Multiplayer**.
6. Send `link XXXX-XXXX` to PersonalOS in a Multiplayer direct message.
7. In a channel, write `@PersonalOS remind me to follow up with Sarah tomorrow at 9am`.

## Platform gaps found (with evidence)

| Gap | Evidence | Workaround here | Owner |
|---|---|---|---|
| No on-behalf-of identity for application calls: a bridge cannot act *as* a linked person | FeltKit `docs/AGENT-OPERATIONS.md` §9: delegation (PR 4) not implemented; AppPort has no on-behalf-of chain | `actingFor` in `_ops.ts`, used only inside `interactions:receive` after Resolver and AuthBoundry, and in `reminders:fire` after re-resolving the link | FeltKit / AppPort / AuthBoundry |
| FeltKit's AuthBoundry adapter governs only its platform layer and is not exported | `dist/platform/platform.js` is the only caller of `authBoundryFromEnvironment`; `exports` lists no path to it | `_authority.ts` speaks the same contract (about 60 lines that duplicate FeltKit's `runtime/authboundry.js`) | FeltKit |
| No inbound events into a FeltKit app, and no per-request tenant for a bearer session | No inbound webhooks ("Not provided: webhooks into integrations"); only `X-FeltKit-*` CSRF, session, time zone and locale headers | Multiplayer pulls updates (`personalos:sync`) while someone looks at the conversation | FeltKit |
| Application code cannot resolve a credential reference | `ConfigurationReader` has `get`/`list` only; integrations cannot be invoked from app code | `PERSONALOS_BRIDGE_TOKEN` is read from the process environment | FeltKit |
| Resolver has no identity kind or lookup by value | `KINDS` = model, secret, endpoint, agent, value | Schema'd `value` references plus prefix listing (one resolve per candidate) | Resolver |
| AuthBoundry's `npm ci` fails on `main` (lockfile out of sync for the four platform packages); its server is not published under a usable license | `npm ci` EUSAGE; `@authboundry/core` is `UNLICENSED` | `npm install --no-package-lock` locally; CI tests use a contract-level authority (`tests/fixtures/anywhere.ts`), and the real server runs in the e2e | AuthBoundry |
| Conversation reading is implemented twice | Multiplayer `feltkit/_compose.ts` and PersonalOS `feltkit/_conversation.ts` | — (candidate for a shared capability) | Platform |

Settled questions:

- On FeltKit 0.3.25 a webhook emitted by an `app.agent` **is** delivered and signed (Multiplayer
  `tests/personalos.test.ts`).
- The browser's time zone reaches `ctx.auth.context.timeZone` server-side; Multiplayer records it
  with the request.

## Limitations

- Surface interactions use the deterministic assistant only. A model turn (`turn.ts`) needs the
  owner's own session (`ctx.agent.openTask` as the caller), which a bridge does not have until
  delegation exists.
- Updates after approval reach Multiplayer when someone has the conversation open (pull, every 5 s).
- Attachments are references; PersonalOS does not read their bytes.
- No email, calendar or file data is exposed through surfaces: none is connected, and private reads
  are withheld from shared audiences anyway.
