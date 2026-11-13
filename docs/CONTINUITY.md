# One PersonalOS across surfaces

Start something in Multiplayer, carry it on from Chrome, and come back to Multiplayer: it is one
conversation, one piece of work, one person, one authority, with each part's own provenance. The same
holds in the other direction. iOS uses the same invocation contract (compatibility tested; not
accepted on a device).

## What identifies what

These are kept apart and never confused.

| | Identifier | Where it comes from |
|---|---|---|
| The person | the PersonalOS owner id (`ada`, `acct_…`); `user:<owner>` at AuthBoundry | Multiplayer: Resolver resolves the sender's active link. Chrome and iOS: the session. Never an envelope field. |
| The conversation | `conversations.id`, owned by one person | Multiplayer: a source thread follows the latest non-refused interaction in it that has a conversation. Chrome and iOS: `correlation.conversationId`, or a new conversation. |
| The invocation | Multiplayer: `interactions.id` (key `adapter:idempotencyKey`). Chrome and iOS: `invocations` (owner + `invocationId`, unique) | the surface's delivery |
| The durable work | research run, task, action, memory ids | what the work created |
| The execution attempt | the AppPort Services job, each research step (`steps[]`), each AuthBoundry `decisionId`, each model `generationId` | the run |
| The originating surface | `interactions.adapter` + the envelope's source; `invocations.surface` + `returnUrl` | the part's own record; a later part never borrows it |

## What was missing, and what changed

The data model already supported most of this:

- Every record names its conversation.
- Durable jobs survive a surface closing or a restart.
- Chrome and iOS could continue any of the person's conversations (`correlation`).

Three gaps needed small changes.

1. **A Multiplayer thread could only see its own conversation.**
   - Now, in a direct message with PersonalOS, `continue <conversation id>` points the thread at one of
     the sender's conversations. The change is one interaction record with `continuation`; there is no
     new linkage store.
   - It needs the conversation to be the resolved owner's: anyone else's id reads as nonexistent.
   - It needs AuthBoundry's decision on `personalos.conversation.continue`, made now. A refusal is kept
     in that conversation's history and never moves the thread.
2. **Multiplayer couldn't see browser, iOS or research work.**
   - Now "status" (or "what did you find") in a direct message lists the conversation's parts. It is
     checked by AuthBoundry the same way.
3. **There was no single view of where a conversation's content came from.**
   - Now `continuity:of` gathers the conversation's interactions, invocations, research and tasks from
     their own records (`feltkit/continuity.ts`).
   - Each part keeps its surface, what was asked, what was shared, how it was read, AuthBoundry's
     decision at the time, and what was done.
   - PersonalOS's chat shows it under **Where this came from**, with the line that continues the
     conversation in Multiplayer. Multiplayer's "status" shows the same.

In Chrome, the Summon form offers **Continue the open conversation**, which is whatever is open in the
panel, wherever it began.

## Kept apart in a continued conversation

- **Surfaces.** A Chrome part says Chrome and a Multiplayer part says Multiplayer. The research a Chrome
  invocation started says so. Nothing is relabelled by where you are now.
- **Shared material.** Each share is that part's own evidence. A new page shared later is new evidence
  and replaces nothing.
- **Authority.** Every part was decided when it ran. A continuation asks AuthBoundry again, and research
  asks before every step. Revoking a delegation stops the next attempt from any surface, and the denial
  stays in the history with AuthBoundry's decision.

## Browser actions that bypassed the contract

The extension's page actions used to paste page text into a chat message: no invocation, no provenance,
no execution-time authority, and the page's text mixed with what you typed. They are now invocations:

| Action | Now |
|---|---|
| Summarize | the page's visible text as context of kind `page`, plus the explicit instruction. The `answer` intent: a model reads the material as data, with no tools, and replies, citing its generation. Without a model it fails and says so. |
| Ask about it, right-click *Ask PersonalOS about…* | the Summon form with the selection; you type the question |
| Read later, right-click *Add to my PersonalOS tasks* | an invocation the assistant turns into a task |
| Save to Files | unchanged: you uploading your own file, not a request for work |

## Evidence

- **`tests/continuity.test.ts`**: scenarios A–E, the migrated actions, and iOS compatibility. Runs
  in-process with Resolver and an AuthBoundry stand-in.
- **`tests/continuity-authboundry-real.test.ts`**: the same with the real AuthBoundry.
- **`e2e/continuity.e2e.mjs`** (Multiplayer repository) runs the real stack:
  - Resolver and AuthBoundry;
  - PersonalOS and Multiplayer as `feltkit dev`;
  - Chromium driving Multiplayer as Ada and Grace;
  - Chromium with the unpacked extension on a real page;
  - PersonalOS killed with SIGKILL mid-work and restarted.

  Results, screenshots and the full evidence are in `docs/evidence/continuity/`.

## Not done

- **Research can't be started or resumed from Multiplayer.** Multiplayer requests run as the bridge
  principal, and FeltKit jobs run as whoever queued them. A research step queued from Multiplayer would
  run as the bridge, and is refused by the owner check and by the model. Doing it needs an on-behalf-of
  principal in FeltKit. Research starts and resumes from Chrome, iOS or PersonalOS itself.
- **Chat typed in the panel or the web app has no surface record.** It is the PersonalOS app either way,
  and FeltKit tells the server nothing about the client. Only summons and Multiplayer messages carry a
  surface.
- **Long continuation replies are cut off in Multiplayer** (the update text is limited). The full list
  is in PersonalOS.
- **Finding the conversation id.** To continue in Multiplayer you copy the line from PersonalOS's "Where
  this came from". There is no picker in Multiplayer.
