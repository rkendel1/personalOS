# PersonalOS on X (@considered_done)

Mention the bot account on X and PersonalOS works for you in your own PersonalOS. It is not a separate
agent and not a separate store. Each mention becomes a `personalos.invocation/1` (surface `x`) in your
conversation, handled by the same assistant, AuthBoundry decisions and research as every other surface.
Nothing private is posted.

**Status (2026-11-13):**
- **Live on Fly** (`https://personalos.fly.dev`): one machine with a volume. The bot's OAuth 2.0 grant is
  connected as @considered_done, and polling is running.
- **Not yet shown:** the end-to-end test with a human X account, and a real token renewal (the access token
  lasts two hours).
- **In-process tests** run against a local stand-in for the X API (`tests/fixtures/x-api.ts`), which is
  not X.

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

## The bot's credential: an OAuth 2.0 grant FeltKit keeps current

**Status:** adopted. `feltkit/app.ts` declares the bot's grant, on FeltKit 0.3.28.

**What FeltKit owns** for an integration declared with `credential: { ref, oauth2: {…} }`:
- **Connecting:** `feltkit credential connect x`, which runs X's authorization code flow with PKCE (S256).
- **Custody:** the access and refresh tokens are kept encrypted. Application code never sees either.
- **Renewal:** before expiry, or once after a 401.
- **Rotation:** a rotated refresh token is stored atomically and never overwrites a newer grant.
- **One renewal at a time** per grant, across requests and processes.
- **Classified failures:** a provider that refuses the refresh token marks the grant
  `reconnect_required`, and nothing more is sent.
- **Disconnecting** revokes the tokens at X.

There is no operator script and no second process. The declaration:
- endpoints `X_TOKEN_URL`, `X_AUTHORIZE_URL`, `X_REVOKE_URL`;
- client `X_CLIENT_ID`, with the secret `credential-ref:x-client-secret` sent as HTTP Basic;
- scopes `tweet.read users.read tweet.write offline.access`.

**The two identities stay separate.**
- The grant is the bot's authorization to read its mentions and post as itself. It proves nothing about
  who mentions it.
- Each author still resolves only through a link they confirmed (Resolver, adapter `x`).
- AuthBoundry still decides each piece of work when it runs.
- Public replies are still a generic acknowledgement.

### What X documents about OAuth 2.0, and what it doesn't

Read on 2026-11-13 from docs.x.com:
- fundamentals/authentication/oauth-2-0/authorization-code;
- …/user-access-token;
- …/overview;
- the v2 authentication mapping.

| | X says |
|---|---|
| Authorize | `https://x.com/i/oauth2/authorize`: `response_type=code`, `client_id`, `redirect_uri` (exact match), `scope`, `state` (up to 500 characters), `code_challenge`, `code_challenge_method` S256 or plain |
| Token | `POST https://api.x.com/2/oauth2/token`, form-encoded. Code exchange: `code`, `grant_type`, `redirect_uri`, `code_verifier`. Confidential clients (Web App, Automated App or bot) use HTTP Basic. Public clients put `client_id` in the body. The authorization code is valid for 30 seconds. |
| Refresh | the same endpoint, `grant_type=refresh_token`, `refresh_token`, with the same client authentication |
| Revoke | `POST https://api.x.com/2/oauth2/revoke`, `token` (with the same client authentication) |
| `offline.access` | "If this scope is not passed, we will not generate a refresh token." |
| Access token lifetime | two hours, "unless you've used the offline.access scope" |
| Scopes for our endpoints | `/2/users/me` and mentions: `tweet.read users.read`. `POST /2/tweets`: `tweet.read tweet.write users.read`. |
| **Not stated** | the token response's fields; whether refresh tokens rotate, are single-use, or expire; behaviour on reuse; error codes; whether revoke takes `token_type_hint` |

**How FeltKit handles the gaps.** It assumes none of the unstated points:
- It reads the RFC 6749 fields and treats a missing `expires_in` as "unknown", renewing on a 401.
- It keeps the old refresh token when none is returned and replaces it when one is.
- It treats any refusal of the refresh token (`invalid_grant` or otherwise) as needing a reconnect.
- It sends `token_type_hint`, which RFC 7009 allows a server to ignore.

The stand-in rotates refresh tokens and answers a bad one with `invalid_request`. That is one plausible
behaviour, not X's documented one.

## Running it in production (Fly)

This is what took the bot live, with the FeltKit changes it needed. Items marked *FeltKit ≥ next* need
the FeltKit release after 0.3.28; on 0.3.28, use the workaround given.

1. **Deploy on one machine with a volume.** The OAuth grant lives in a vault file, which belongs to one
   machine.
2. **Settings on the host:**
   - `X_CLIENT_ID`; `FELTKIT_CREDENTIAL_X_CLIENT_SECRET` (a secret);
   - `X_API_URL=https://api.x.com`;
   - `X_TOKEN_URL=https://api.x.com/2/oauth2/token`;
   - `X_AUTHORIZE_URL=https://x.com/i/oauth2/authorize`;
   - `X_REVOKE_URL=https://api.x.com/2/oauth2/revoke`;
   - `FELTKIT_PUBLIC_URL=https://personalos.fly.dev`;
   - `FELTKIT_CREDENTIAL_VAULT=1`, and `FELTKIT_CREDENTIAL_VAULT_KEY` (a secret; never change it);
   - the vault on the volume: `FELTKIT_CREDENTIAL_VAULT_DIR=/data/vault`. *FeltKit ≥ next* defaults it
     beside `FELTKIT_STATE_DIR`.
3. **Register the callback with X:** `https://personalos.fly.dev/api/integrations/x/oauth/callback`.
4. **Connect** as a signed-in operator:
   ```bash
   feltkit operator signin --env production
   ```
   ```bash
   feltkit credential connect x --env production
   ```
   Sign in to X as @considered_done. *FeltKit ≥ next*, or Studio → Integrations → Connect. On 0.3.28: call
   `POST /api/integrations/x/oauth/connect` with the operator's token and open the returned `url`.
5. **The adapter's identity.**
   - *FeltKit ≥ next:*
     ```bash
     feltkit session create --type service --id x-adapter --role xadapter --ttl 2160 --env production
     ```
   - On 0.3.28: `feltkit operator signin --id x-adapter --role xadapter` (an 8-hour session).
6. **Start polling.**
   - *FeltKit ≥ next:*
     ```bash
     feltkit call xsurface:startPolling --env production
     ```
     Run it as the adapter.
   - On 0.3.28: `POST /api/mutation/xsurface:startPolling` with the adapter's token.
7. **Check:**
   - `feltkit credential status --env production` should show the grant: state, expiry, renewals. *FeltKit
     ≥ next* prints these.
   - Readiness should pass.

**X API credit.** X is pay-per-use. When the X app's credit runs out, X answers **HTTP 402** (`credits
depleted`). That comes from X, not from PersonalOS. Polling records it and backs off (the wait doubles up
to 30 minutes after failures in a row), then resumes once credit is added. Nothing is lost: the cursor
moves only past mentions that were handled.

## Acceptance

- **A. Platform:** done. The FeltKit OAuth lifecycle passes its tests against a simulated provider.
- **B. X connection:** connected in production as @considered_done, and polling. Still to show: a real
  renewal. After the first two hours, `credential status` should show `refreshes ≥ 1`; the
  `credential.refresh` activity records whether X rotated the refresh token.
- **C. End to end:** to do:
  1. link a human X account;
  2. mention @considered_done from it;
  3. check: one invocation, AuthBoundry's decision, the generic acknowledgement on X, the result only in
     PersonalOS, and continuing the conversation from Chrome and Multiplayer.

  AuthBoundry in production still needs its principals, policy, agent, delegation and check credential,
  plus `AUTHBOUNDRY_URL` on Fly. `authority.application` must match the id AuthBoundry assigned. *FeltKit
  ≥ next* reads it from `AUTHBOUNDRY_APPLICATION`.

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

- **End-to-end acceptance on X.** See Acceptance above.
- **Webhook delivery.** It needs a public HTTPS endpoint: no new infrastructure was allowed.
- **Research from X running at once.** It waits for the owner, because FeltKit has no on-behalf-of job
  principal. This is the same gap as Multiplayer's (docs/CONTINUITY.md).
- **Clarifying questions answered in the thread** (Multiplayer's `needs_clarification`). The question is
  asked in PersonalOS, and you answer there.
- **Verifying an unknown reply against X.** The integration declares no verification probe. A person
  checks the bot's timeline.
