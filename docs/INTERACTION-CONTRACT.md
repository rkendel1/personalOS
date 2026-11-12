# `personalos.interaction/1`: the interaction contract

What a communication surface (Multiplayer today) hands PersonalOS when someone asks it for something,
and what it gets back. Defined in `feltkit/_interaction.ts`; enforced by `interactions:receive`.
It names no surface: a new adapter fills the same envelope and needs no change in PersonalOS's
execution.

## Delivery

`POST /api/mutation/interactions:receive` with `{ "args": { "envelope": … } }` and
`Authorization: Bearer <bridge session>`. The bridge session is operator-issued
(`feltkit session create --type service --id <adapter> --role bridge`) and holds only
`interactions.receive` (plus the job and notification plumbing reminders need). Its principal id
**is** the adapter id: an envelope whose `source.adapter` differs is refused (`FORBIDDEN`).

Then, with the same session:

| Function | Kind | Args | Returns |
|---|---|---|---|
| `interactions:receive` | mutation | `{ envelope }` | the outcome (below) |
| `interactions:status` | query | `{ key, afterSeq }` | `{ state, updates[], revoked }` |
| `interactions:cancel` | mutation | `{ key, sourcePrincipalId }` | `{ state, updates[], revoked }`; only the original sender |

`key` is the envelope's `idempotencyKey`.

## Envelope

| Field | Meaning | Trusted as |
|---|---|---|
| `contract` | `"personalos.interaction/1"` | — |
| `source.adapter` | the adapter id | must equal the authenticated bridge principal |
| `source.instance` | which installation of the surface | part of the external identity |
| `source.eventId`, `sequence`, `receivedAt` | the source's id, order in its conversation, and time | provenance; `sequence` guards out-of-order clarification merges |
| `sender.sourcePrincipalId` | the sender's principal **in the source system**, from the surface's authenticated session | the external identity Resolver resolves (exact match) |
| `sender.displayName`, `handle` | presentation | never identity |
| `sender.claimed` | anything the sender or metadata asserted | kept, never used |
| `sender.timeZone` | the sender's IANA zone as their client reported it | dates only ("tomorrow at 9"), never authority |
| `conversation.*` | workspace, conversation, kind (`public`, `private`, `dm`, `group`), thread, participants, `directWithAssistant` | decides the audience |
| `message` | the request: id, text (≤ 4000), mentions, attachment references | — |
| `context` | bounded messages the requester could read (≤ 60, ≤ 1000 chars each), each with author, `isRequester`, time, thread, attachment references; and the limits applied | provenance for conversation answers |
| `respondTo` | where replies belong | — |
| `idempotencyKey` | stable for every delivery of the event | one execution per `(adapter, key)` |

Attachments travel as references (id, name, type, size, source message). PersonalOS does not fetch
their bytes.

## Who is asking: five identities

| Identity | Where it comes from |
|---|---|
| Adapter principal | FeltKit authenticates the bridge session on the request |
| Source identity | `sender.sourcePrincipalId`, vouched for by the adapter from its own authenticated session |
| Canonical PersonalOS identity | **Resolver**: the one active, exactly matching link (`feltkit/_resolver.ts`); never in the envelope |
| Display name | `sender.displayName`: presentation only |
| Claimed identity | `sender.claimed`, message text: never used |

## Outcome

`{ interactionId, state, replayed, audience, reply, updateSeq, approval, refusal, conversationId }`.

- `reply` is what the surface may post. It is already limited to the audience: in anything but a
  direct conversation with PersonalOS it carries none of the owner's private data.
- `state` is one of `received`, `understanding`, `working`, `awaiting_approval`,
  `needs_clarification`, `completed`, `failed`, `cancelled` or `refused`. The last four are terminal.
- `approval`: `{ actionId, summary, reason }` when the owner must approve in PersonalOS.
- `refusal`: `{ code, message }`. Codes:

  | Code | Meaning |
  |---|---|
  | `NOT_LINKED` | No link resolves the sender. |
  | `AMBIGUOUS_IDENTITY` | More than one link resolves the sender. |
  | `FORBIDDEN` | AuthBoundry denied the capability. |
  | `LINK_NOT_PRIVATE`, `LINK_CODE_INVALID`, `ALREADY_LINKED` | Linking failed. |

- A repeated key returns the stored outcome with `replayed: true`, whatever the new envelope says.
- `UNAVAILABLE` (thrown, nothing recorded) means Resolver or AuthBoundry could not answer. Retry the
  same key.

Updates (`interactions:status`) are `{ seq, state, text, at, actionId? }`, limited to the audience
like `reply`. After the owner disconnects the surface, `revoked: true` comes back and no content
follows.
