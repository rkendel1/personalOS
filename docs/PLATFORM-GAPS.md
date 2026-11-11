# Platform gaps found while building PersonalOS

Checked against `@feltdb/feltkit` 0.3.22 (with `@feltdb/core` 0.21.0 and `@appport/services` 0.16.0), as installed by `create-feltkit` 0.3.22 on 2026-11-11. Each gap cites where the evidence is, says what PersonalOS does instead, and says what would close it. None of these is worked around by inventing an API.

## G1. Applications cannot generate text with the environment's model

**Evidence.** The model host decides and does nothing else. `ModelHost.decide(request)` takes a FeltDB `DecisionRequest` whose kinds are `binary`, `choice` and `score` (`dist/runtime/decisions.d.ts`; `@feltdb/core` `dist/semantic-decision.d.ts`). The prompt is "Return exactly one label from the allowed labels" with `max_tokens: 16`, as observed on the wire in `tests/model.test.ts`. A handler's `ctx` has no model API: `QueryCtx` and `MutationCtx` in `dist/runtime/context.d.ts` offer only `ctx.agent.start`, which opens a decision task. AppPort Services Intelligence is "provider/model configuration only (AppPort Services never runs a model)" (`dist/runtime/services.d.ts:22`).

**Impact.** There is no open-ended conversation, no streamed replies, no summaries the model writes, and no free-form extraction. The brief's "Grok-like conversational experience" can't be built on the platform today.

**What PersonalOS does.** Replies are composed deterministically from verified results, so the assistant can't claim anything the action log doesn't show. The model is used for what the platform does support: picking an interpretation among options the app builds (`assistant.ts`, case `unknown`). The app doesn't call a provider itself. That would mean a second credential store next to FeltKit's custody, and it would bypass the Resolver receipts.

**What would close it.** A generation call (for example `ctx.agent.generate`, or `ModelHost.generate`) that goes through the same credential custody, Resolver reference, and receipt path as `decide`, with streaming to the client.

## G2. An application cannot show or approve agent proposals in its own UI

**Evidence.** `AgentHost.approve/reject` is reachable only through Studio's admin API (`/_feltkit/api/agent/tasks/:id/approve`, dev admin token, `dist/server/admin.js:565`) and production operator routes (`admin.js:1031`). Nothing in `ctx`, `@feltdb/feltkit/client` or `@feltdb/feltkit/react` reads a decision task or approves one as the signed-in person.

**Impact.** When the model proposes an interpretation, the owner approves it in Studio → Agent rather than in the chat where they asked. PersonalOS stores the agent task id on the reply (`interpretation.agentTaskId`) and says where to approve.

**What would close it.** Person-scoped capabilities (for example `feltkit.agent.task.get` and `feltkit.agent.action.approve`) callable over `/appport` with the user's session, under the same rules as Studio: people only, as the task owner.

**Not a gap:** PersonalOS's *own* approvals (deleting a task, forgetting a memory) are app records and approved in-app. `actions:approve` is `approval: "required"`, so agents and API keys can only propose it.

## G3. An application cannot read which model is active

**Evidence.** `ModelHost.status()` exists on the runtime (`dist/runtime/decisions.d.ts`), but no `ctx` or client API exposes it.

**Impact.** Settings can't show "currently: provider / model". It links to Studio → Models (dev) and names the Resolver reference (prod).

## G4. Memory retrieval is keyword overlap

**Evidence.** `ctx.db.search` is "a bounded scan … FeltDB has no text index yet" (`dist/app.d.ts`, `CollectionOptions.search`). There are no embeddings or vector index in FeltDB 0.21.

**Impact.** "What do you know about my boss?" finds "Sam is my manager" only if the words overlap. Recall uses `relevance()` in `feltkit/_interpret.ts` (keywords, plural folding, prefixes). Semantic retrieval is listed as P1 and hasn't been built.

## G5. No time zone on the principal or session

**Evidence.** Sessions carry roles and claims, but no locale or time zone (`useSession()`).

**Impact.** "Tomorrow" is relative to the user's local day, so the client sends `today` and `tzOffset` with every message. Reminders and check-ins store the offset they were created with. A daylight-saving change between creation and firing moves a reminder by an hour.

## G6. Portability scan false positive

`feltkit build` reports `feltkit/_ops.ts:273: approval: "required" is enforced by FeltKit's agent lifecycle…`. That line is the string value of an action record's field, not a function option. It's harmless, but it's noise in the portability report. (PersonalOS also uses `ctx.agent`, so it isn't AppBoundry-portable anyway.)
