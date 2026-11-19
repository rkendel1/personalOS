# Known limitations

What PersonalOS doesn't do, and why. Each item names what would change it.

## Product

- **Memory recall is keyword-based.** "What do you know about my boss?" finds "Sam is my manager"
  only if the words overlap (`relevance()` in `feltkit/_interpret.ts`: keywords, plural folding,
  prefixes). FeltDB has no text or vector index yet (`ctx.db.search` is a bounded scan). Semantic
  retrieval needs an index in FeltDB.
- **Email and calendar are Google only** (Gmail, Google Calendar primary), and read headers and snippets,
  never message bodies. Each needs a Google OAuth client on the server (README). A send or new event is
  delivered once; if Google never answers, it is marked "unknown" and not resent automatically (Gmail has
  no idempotency key, so a resend could send twice).
- **No messaging integration.** Slack's OAuth returns a person's token in a non-standard field
  (`authed_user.access_token`) and asks for user scopes with `user_scope`, which FeltKit's per-person OAuth
  doesn't read; Microsoft Teams via Graph would fit but isn't built.
- **Web search needs a provider** (Brave Search API or OpenAI web search). Without one the assistant says
  so instead of answering from memory.
- **API keys are off.** An API key authenticates as its own identity, so anything it created would be
  owned by the key, not by you. They stay off until a key can act for a person.
- **Per-person recurrence is a job chain.** Reminders and check-ins run as the person who set them up
  (each run queues the next). Operator schedules (Studio → Schedules) run as whoever created them, so
  they are not used for per-person work.

## Model

- **Model features need a provider.** Configure one in Studio → Models, with `feltkit model set`, or
  through a Resolver reference (`PERSONALOS_MODEL_REF` in development, `ref://prod/personalos/model` in
  production). Without one, the built-in assistant answers: tasks, reminders, memory and the briefing
  still work.
- **A streamed reply isn't resumed after a reconnect.** If the connection drops mid-reply, the turn is
  recorded as interrupted and you ask again.

## Chrome extension

- **Sign-in by password or an operator-issued session.** OAuth providers and e-mail links return to
  the web app's origin, not into the extension.
- **Sessions last 7 days and aren't refreshed.** After that you sign in again. Revocation and expiry are
  noticed by an open panel without any action on your part.
- **Chrome only** (Manifest V3 side panel). Firefox and Safari aren't built.

## Build

- `feltkit build` prints a portability note about `feltkit/_ops.ts` (`approval: "required"`). It is a
  false positive: the line is a string value in an action record, not a function option. PersonalOS uses
  `ctx.agent`, so it runs on a FeltKit server rather than as an AppBoundry artifact anyway.
