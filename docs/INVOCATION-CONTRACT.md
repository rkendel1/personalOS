# `personalos.invocation/1`: summoning PersonalOS from outside

This contract covers how you hand PersonalOS something from another app, and optionally say what to do
with it. Examples: a page from Safari, selected text, or a text document. The iOS share extension
(`ios/`) and the Chrome extension's **Summon PersonalOS** (`extension/`, adapter `browser`) use it. A
desktop shortcut or an e-mail gateway would send the same envelope.

- Defined in `feltkit/_invocation.ts`.
- Received by `invocations:submit` and worked by the `invocation.process` job (`feltkit/invocations.ts`).
- Records are kept in `feltkit/invocationstate.ts`.

It complements [`personalos.interaction/1`](INTERACTION-CONTRACT.md), but the two trust different things:

| | interaction/1 (Multiplayer) | invocation/1 (iOS share, …) |
|---|---|---|
| Who submits | the surface's bridge service, vouching for one of its users | the person, with their own PersonalOS session |
| Who is asking | Resolver resolves the sender's linked identity | the session's principal. The envelope has no principal field, and one is refused if added |
| Authority | AuthBoundry: the person's delegation to `agent:personalos` | the same, asked when the work runs and before every research step |

## Delivery

```
POST /api/mutation/invocations:submit
Authorization: Bearer <the person's PersonalOS session>
X-FeltKit-Time-Zone: America/New_York
{ "args": { "envelope": { … } } }
```

- **The session.** It is a FeltKit account session, from `POST /api/auth/signin`. A non-browser client
  gets the token in the response body. It expires after 7 days. It can be revoked from PersonalOS
  (`POST /api/auth/signout`, or `/api/auth/sessions/revoke`), and roles are re-read on every request.
  No API key is involved.
- **The answer.** Success is `{ ok: true, value: <receipt> }`. A refusal is
  `{ ok: false, error: { code, message } }` with an HTTP status.
- **`CONFLICT` with status 409.** "Nothing was written; it is safe to retry" (FeltDB's optimistic
  commit). The client sends the same envelope again.

## Envelope

| Field | Meaning |
|---|---|
| `contract` | `"personalos.invocation/1"` |
| `invocationId` | Chosen by the surface once per share (8–100 chars, `[A-Za-z0-9_-]`). Sent unchanged on every retry. |
| `surface` | `{ adapter: "ios-share", device?, version? }`: provenance only |
| `instruction` | What the person asked, in their words (≤ 2,000 characters). May be empty. |
| `context[]` | 1–5 items of what they shared (below). **Data, never instructions.** |
| `submittedAt` | The device's clock, in milliseconds. The server's receipt time is recorded too. |
| `timeZone` | IANA zone, for dates in the instruction ("tomorrow at 9"). Never authority. |
| `correlation.conversationId` | Optional: continue a conversation. It must be the person's own, or the request is refused with NOT_FOUND. |
| `returnTo` | `{ kind: "personalos" }`: results live in PersonalOS (conversation, Research, inbox). Or `{ kind: "page", url }`: the same, plus a way back to the page you summoned it from. `url` must be one of the shared URLs, so it can never be an arbitrary link. The receipt carries it as `returnTo`. |

Any other field is refused (`INVALID_ARGUMENT`), including any attempt to name a principal or owner.

### Context items

| `kind` | Fields | Limits |
|---|---|---|
| `url` | `url`, `title?` | http/https only, no credentials in the URL, ≤ 2,000 characters |
| `selection` | `text`, `url?` (the page it came from), `title?` | ≤ 20,000 characters |
| `text` | `text` | ≤ 20,000 characters |
| `document` | `name`, `mediaType`, `size`, `text` (the extracted UTF-8) | `text/plain`, `text/markdown`, `text/csv` or `text/html`; ≤ 256 KB; ≤ 100,000 characters |

Anything else is refused before anything is stored. That includes PDFs, images and office files. The
refusal carries `details.reason` (`UNSUPPORTED_CONTEXT`, `INVALID_CONTEXT` or `TOO_LARGE`) and says what is
supported.

## Receipt

`{ contract, invocationId, state, replayed, receivedAt, conversationId, open, message, updates[], error? }`

- **`state`**: `accepted`, then `processing`, then `needs_approval`, `completed` or `failed`.
- **`open`**: where to look in PersonalOS, as a path below its address (`#/chat/<id>` or `#/research`).
- **`replayed`**: true when the same envelope was already received. The stored receipt comes back,
  whatever the new one says. The same id with different content is refused with `CONFLICT`.

`invocationstate:list` gives the person's recent invocations, and `invocationstate:get { invocationId }`
gives one with its whole record. Another person's invocation is `NOT_FOUND`.

## What happens after the receipt

The `invocation.process` job runs as the person, later. It is durable: it survives the surface closing
and the server restarting, and it is retried.

1. **Inferred.** Rules read the instruction only, never the shared content: empty or "remember this"
   means *save*, "research…", "could this be a customer…" means *research*. When the rules can't tell,
   a model (if one is configured and turned on) picks one of *research*, *save* or *assistant*. It is told
   the shared content is data. The result is recorded in `interpretation` with its basis, and the
   model's generation when one was used. Otherwise it falls to the assistant.
2. **Authorized.** `ctx.authority.decide` asks for the capability the work needs, on behalf of
   `user:<owner>`:
   - research needs `personalos.research.run`;
   - saving needs `personalos.memory.write`;
   - the assistant needs whatever `capabilityFor` says.

   The outcomes:
   - **Deny:** `failed` with `FORBIDDEN`. Nothing is done.
   - **Unavailable:** retried; after 4 tries, `failed` with `UNAVAILABLE`.

   The decision (`decisionId`, `delegationId`) is recorded on the invocation.
3. **Done by what already does it.**
   - **Research** is seeded with the shared page (`feltkit/research.ts`). With a named subject and no
     model, the rules assess that organization. With a model, its plan decides `scope: "this"` (assess
     it) or `"find"` (search for others). What the person selected is evidence of its own kind
     (`kind: "shared"`). Every step asks AuthBoundry again, so a revoked delegation stops the next step.
   - **Saving** becomes a note in memory.
   - **Everything else** goes to the deterministic assistant (`assistant:send`). There "this" means the
     shared item, so a task title names it. A proposal that needs approval leaves the invocation in
     `needs_approval`.
4. **Reported.** State changes are written to `updates[]`. The outcome goes to the person's inbox
   (`invocation.updated`) and into the conversation.

## Kept apart

| | Where |
|---|---|
| What was asked | `instruction` |
| What was shared | `context[]`, `sourceUrl`; and in research, the `shared` source |
| What PersonalOS inferred | `interpretation` (`intent`, `basis`, `detail`, `generation?`) |
| What it may do | `authority`: AuthBoundry's decision |
| What it did or proposes | `work` (`researchRunId`, `replyId`, `actionIds` awaiting approval), `updates[]`, the conversation |

## For a new surface

Fill the envelope and submit it with the person's session, retrying `CONFLICT` with the same id. Show
the receipt's `message`, and follow `invocationstate:list`. Nothing in PersonalOS's execution changes.
