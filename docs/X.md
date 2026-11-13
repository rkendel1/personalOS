# PersonalOS on X (@considered_done)

Mention the bot account on X and PersonalOS works for you in your own PersonalOS. It is not a separate
agent and not a separate store. Each mention becomes a `personalos.invocation/1` (surface `x`) in your
conversation, handled by the same assistant, AuthBoundry decisions and research as every other surface.
Nothing private is posted.

**Status: a local adapter, tested. Not a working integration with the real @considered_done account.**

- Everything below is tested against a local stand-in for the X API (`tests/fixtures/x-api.ts`), which
  answers in the shapes X's documentation gives.
- Nothing has run against X itself. The bot credential saved in this environment is answered
  `401 Unauthorized` by `GET /2/users/me` and by `GET /2/users/by/username/considered_done`.
- See [What real acceptance needs](#what-real-acceptance-needs).

## Two identities, never confused

| | What it is | What proves it | What it allows |
|---|---|---|---|
| **The bot** (@considered_done) | the X account PersonalOS reads and posts as | the `x` integration's OAuth token (credential `x`, FeltKit custody) | reading the bot's mentions; posting replies as the bot |
| **A person** (you, anyone) | the author of a mention, as X's API reports it (`author_id`) | a link that person confirmed in PersonalOS, recorded in Resolver (adapter `x`, instance `x.com`) | PersonalOS working for that PersonalOS account, as far as AuthBoundry allows |

- The bot's token proves nothing about who mentions the bot.
- A username or id written in a post's text is never identity.
- An author without an active link gets nothing done, and no reply.

## How it works (`feltkit/xsurface.ts`, `feltkit/_x.ts`)

1. **Polling, not webhooks.** X's webhooks (the X Activity API, and the deprecated Account Activity API)
   need a public HTTPS endpoint that answers CRC challenges. This deployment has none, and adding one
   would be new infrastructure.
   - The X adapter's service session (role `xadapter`) starts a chain of `x.poll` jobs, every 2 minutes
     by default.
   - Each poll asks for `GET /2/users/:id/mentions?since_id=…` with up to 3 pages of 100.
   - The first poll only sets the starting point: older mentions are history, not requests.
2. **Receiving** (`xsurface:receive`). There is one record per post id (unique index), so a mention read
   twice is handled once. Mentions are handled oldest first.
   - If Resolver or AuthBoundry can't be reached, nothing is recorded and the cursor stops there. That
     mention is read again on the next poll.
   - **`link XXXX-XXXX`** marks the author's X account as having presented that code (more under
     [Linking](#linking)).
   - **Unlinked, revoked or ambiguous author:** recorded as refused. Nothing is done and there is no
     reply.
   - **Linked author:** an invocation in that person's conversation:
     - The post's text, without X's leading `@handles`, is the instruction.
     - The posts it replies to or quotes come back in the same response (`expansions=referenced_tweets.id`)
       and are kept as context. They are data, never instructions.
     - The post itself is provenance (`https://x.com/i/web/status/<id>`).
3. **What runs now, and what waits.**
   - Notes, tasks and reminders run immediately for the owner once AuthBoundry allows the exact
     capability, the same as for Multiplayer. A denial is recorded with AuthBoundry's decision.
   - Research and model answers wait (`needs_approval`, `work.waitingFor: "owner"`) until the owner
     presses **Run it** in PersonalOS (`invocations:run`).
     - Why they wait: FeltKit runs a job as the principal that queued it.
     - Work queued by the X adapter would run as the adapter, and only the owner's own session may run
       research or the model for them.
     - AuthBoundry decides again when the work runs.
4. **Replies.**
   - Every mention from a linked author, and every link-code post, gets one generic acknowledgement:
     "Received (ref ABC123). It's in your PersonalOS, and the result stays private there…". It never
     includes what was asked, what was found, or anything about the account.
   - The `ref` makes each one distinct.
   - There is no link in the reply: X prices a post with a URL at $0.20 against $0.015 without.
   - Each reply is posted at most once:
     - **Claim before sending.** A reply is claimed (`pending → sending`) in a transaction before it is
       sent.
     - **Idempotency key.** The reply is sent with key `x-reply:<post>:<n>`, and FeltKit refuses to
       resend a call with that key whose outcome it never saw.
     - **Delivery status.** Each reply is recorded as sent (with X's reply id), failed (X refused it,
       4xx), pending (rate limited, retried after 15 minutes; or never reached X) or unknown (X answered
       5xx or never answered).
     - **Unknown is never retried automatically.** A person checks the bot's timeline.
5. **Publishing** (`xsurface:publish`) is the owner's explicit act.
   - Under **Where this came from → Reply publicly on X…**, the owner types the exact text and presses
     Publish.
   - AuthBoundry must allow `personalos.x.publish` for them. A refusal is recorded in the post's reply
     list with the decision.
   - A post that asks PersonalOS to publish something publishes nothing.

## Linking

1. In PersonalOS: Settings → Connected surfaces → **Connect X** gives a one-time code. It lasts 10
   minutes and only its digest is stored.
2. From your X account, post `@considered_done link XXXX-XXXX`.
3. PersonalOS records which X account posted it (X's `author_id`) and uses the code up.
4. Back in PersonalOS, you see that account (handle and X user id) and confirm **This is me**. Only then
   does the `identity` agent write the link to Resolver (`links.ts`, unchanged).

**The code is public once posted.** That is acceptable because:
- the first post carrying it uses it up;
- someone who copies it can only present *their* account, which you would not confirm;
- an X account already linked to someone else can't present another person's code (the code is burnt).

**Direct messages were not used.** X's DM documentation pages could not be fetched (404), so DM-based
linking was not built on unverified behaviour.

**Revoking** (Disconnect) revokes the Resolver reference. The account's next mention is refused, with
no reply. Reconnecting is a new link, confirmed again.

## Continuity

- **Within an X thread:**
  - **Same author:** a later mention by the same author in the same X thread (`conversation_id`)
    continues the same PersonalOS conversation.
  - **Another author:** someone else replying in that thread is never taken to be them. Each author
    resolves on their own, and a linked one gets their own conversation.
  - **The X thread is not the record.** The conversation, its invocations and their evidence live in
    PersonalOS.
- **Pointing at another conversation:** `@considered_done continue <conversation id> [request]` points
  the thread at one of your conversations. AuthBoundry decides `personalos.conversation.continue`.
- **Continuing elsewhere:** a conversation started on X continues from Chrome ("Continue the open
  conversation") and from Multiplayer (`continue <id>` in a DM). Each part keeps its own surface,
  instruction, shared material and authority decision (`continuity:of`, PersonalOS's **Where this came
  from**).

## Tests (local adapter only)

**`tests/x.test.ts`** runs in-process against the X stand-in, a real Resolver, and the AuthBoundry
stand-in.

| # | Scenario | Result |
|---|---|---|
| 1 | Linked mention | pass |
| 2 | Exactly one invocation | pass |
| 3 | Generic acknowledgement, with reply id and delivery status kept | pass |
| 4 | Answer waits for the owner, runs from their session, completes in the same conversation; the thread continues it | pass |
| 5 | Continue from Chrome (the extension's own `buildEnvelope`) | pass |
| 6 | Continue from Multiplayer (`continue <id>`), and `continue <id>` from X | pass |
| 7 | Duplicate delivery: re-read, and handed over twice; one invocation, one reply | pass |
| 8 | Unlinked account: nothing, no reply | pass |
| 9 | Identity claimed in the text; another person in the thread; claiming a link | pass |
| 10 | Revoked link, then relinking | pass |
| 11 | AuthBoundry denial recorded; "publish this" in a post publishes nothing; publishing denied, then allowed | pass |
| 12 | Restart keeps the cursor, the waiting work and a rate-limited reply; a 5xx reply is not resent; a 401 token is recorded and polling recovers | pass |

Also:
- the pure parsing tests pass;
- the polling-start and role checks pass;
- **`tests/x-authboundry-real.test.ts`** passes. It runs the same flow against the **real AuthBoundry**:
  allowed under Ada's delegation, refused once it is revoked, publishing needing its own delegation.

None of this is real-X acceptance.

## What real acceptance needs

1. **A valid user-context token for @considered_done**, saved in custody as `x`
   (`FELTKIT_CREDENTIAL_X`, or `feltkit credential set x`).
   - It must be OAuth 2.0 Authorization Code with PKCE, with scopes `tweet.read users.read tweet.write`.
   - The credential saved in this environment returns 401: it is invalid, expired, or not a
     user-context token. An app-only Bearer token can read mentions but can't post.
2. **`X_API_URL=https://api.x.com`.**
3. **The adapter's service session:**
   ```bash
   feltkit session create --type service --id x-adapter --role xadapter
   ```
   With that session, call `xsurface:startPolling`.
4. **A human X account** to link and to post the mentions (the bot's own posts are ignored).
5. **A pay-per-use X API plan with credit.** Costs are below.

## Token lifetime and refresh

- An OAuth 2.0 user access token from X lasts **2 hours**. With the `offline.access` scope, X also
  issues a refresh token.
- **FeltKit 0.3.27 can't use it. This was checked in the installed package, not assumed:**
  - An integration's `credential` is a custody reference sent as `Authorization: Bearer <value>`.
  - Application code has no way to read or write a credential: `ActionCtx` offers `integrations.invoke`
    only, and `ctx.credential` is not available to functions.
  - The only `grant_type` FeltKit sends is `authorization_code`, for sign-in providers (`server/oauth.js`).
  - Stored credentials change only through `credential.store`, from Studio or `feltkit credential set`
    (a person or an operator).
- So today a real run must fit in the token's two hours, or an operator replaces the token.
- **Ways to fix it, best first:**
  1. **A refreshable OAuth credential in FeltKit custody (platform work).** Custody would hold the
     access token, refresh token, token endpoint and client id/secret. It would refresh before expiry
     or on a 401, and store the rotated refresh token. Nothing in application code would see a secret.
     This is the right home for it.
  2. **OAuth 1.0a user tokens.** X documents these for the same endpoints, and they don't expire. But
     every request must be HMAC-signed with four secrets, which FeltKit's integration credential
     (one header value) can't do. This is also platform work.
  3. **An operator script.** It would use the refresh token to get a new access token and store it with
     `feltkit credential set x`, more often than every 2 hours. It works without FeltKit changes, but it
     is a host process and needs somewhere to keep the refresh token.
- **Still to check before relying on refresh:**
  - whether X rotates the refresh token on each use (that decides whether option 3 is safe to run
    unattended);
  - how long an unused refresh token lasts.

## X API facts used, and costs

These are from docs.x.com, read on 2026-11-13. Nothing else is assumed.

- `GET /2/users/:id/mentions`:
  - auth: user context or app-only Bearer;
  - parameters: `since_id`, `pagination_token`, `max_results` 5–100;
  - fields: `author_id`, `conversation_id`, `created_at`, `referenced_tweets`;
  - `expansions=author_id,referenced_tweets.id`.
- `GET /2/users/me`: needs user context.
- `POST /2/tweets` with `reply.in_reply_to_tweet_id`: needs user context with `tweet.read`, `users.read`
  and `tweet.write`.
- **Pricing (pay-per-use):**
  - posts and owned reads: $0.001;
  - post read: $0.005;
  - user read: $0.010;
  - post create: $0.015, or $0.20 with a URL;
  - monthly cap: 3 million post reads.
- **Not established:**
  - whether a mentions request that returns nothing is charged;
  - whether included referenced posts are charged as post reads.

  Measure both on the first real run before choosing the poll interval.
- **A rough cost:** at a 2-minute poll interval there are 21,600 polls a month. Each linked mention costs
  its reads, plus $0.015 for the acknowledgement. Replies to unlinked accounts cost nothing, because
  there are none.

## Not done, and why

- **Real-X acceptance.** Blocked by the 401 token and the missing human test account (above).
- **Webhook delivery.** It needs a public HTTPS endpoint: no new infrastructure was allowed.
- **Research from X running at once.** It waits for the owner, because FeltKit has no on-behalf-of job
  principal. This is the same gap as Multiplayer's (docs/CONTINUITY.md).
- **Clarifying questions answered in the thread** (Multiplayer's `needs_clarification`). The question is
  asked in PersonalOS, and you answer there.
- **Automatic token refresh.** See above.
- **Verifying an unknown reply against X.** The integration declares no verification probe. A person
  checks the bot's timeline.
