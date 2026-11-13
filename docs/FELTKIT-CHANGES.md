# Changes needed in FeltKit and its sibling packages

Found on 2026-11-13 while taking PersonalOS's X bot live on Fly (`@feltdb/feltkit` 0.3.28). Each item
says what happened, the evidence, the workaround we used, and the change to make. **Verified** means
observed against the running production app or server; **Read** means read from the package source
(`node_modules/@feltdb/feltkit/dist/…`) and not exercised separately.

No secret value appears in this document.

## Priority summary

| # | Change | Package | Blocks |
|---|---|---|---|
| 1 | Production credential store drops `kind: "oauth2"` | FeltKit | importing a grant |
| 2 | `credential connect` unavailable in production, no Connect button | FeltKit | connecting a grant the intended way |
| 3 | No production service sessions (`session create`) | FeltKit | a durable adapter identity |
| 4 | No CLI to call an app function in production | FeltKit | starting a polling chain |
| 5 | `credential status` hides OAuth state | FeltKit | proving renewal |
| 6 | Vault directory defaults to the image, not the volume | FeltKit | grants surviving a deploy |
| 7 | `authority.application` can't come from configuration | FeltKit | AuthBoundry matching |
| 8 | Dashboard variables, database-held credentials, production endpoint defaults | FeltKit | the config you listed |
| 9 | `@appport/resolver` CLI exits silently when run through the npm symlink | Resolver | any global install |
| 10 | AuthBoundry image can't find its Services bridge | AuthBoundry | check credentials, Services panel |
| 11 | AuthBoundry portal can't build on Vercel; check-credentials UI not live | AuthBoundry | issuing the check credential |
| 12 | A foreign-origin request carrying an ambient session cookie is refused instead of ignored | FeltKit | extension hosts for people also signed in on the web |

## FeltKit

### 1. Production `POST /credentials` drops `kind`
- **Happened:** `feltkit credential set credential-ref:x --oauth --env production` reported success. The
  first poll then failed with `credential-ref:x holds a plain value, not an OAuth 2.0 grant`.
- **Evidence (Read):** the CLI sends `{ ref, value, provider, kind: "oauth2" }`. The development route
  passes `kind` to `storeCredential` (`dist/server/admin.js`, ~line 532); the production route
  (`case "POST /credentials"`, ~line 1240) passes only `{ ref, value, provider }`, so the OAuth validation
  at ~line 794 never runs. **Verified:** the stored grant was a plain value until the connect flow
  replaced it (version 1 → 2).
- **Workaround:** the real connect flow (item 2).
- **Change:** pass `body.kind` through in the production route. Also refuse to store an OAuth integration's
  credential as a plain value, with a message naming `credential connect`.
- **Test:** import a token-response JSON with `--env production`; the status shows an OAuth grant.

### 2. `credential connect` is unavailable in production, and there is no Connect button
- **Happened:** `feltkit credential connect x --env production` → `POST /integrations/x/connect is not
  available in production.`
- **Evidence:** **Read:** the connect route exists only in the development admin (`admin.js` ~line 537).
  **Verified:** production already serves `POST /api/integrations/<name>/oauth/connect`
  (`server/index.js` ~line 488), and an operator bearer token with the `admin` role (which holds
  `credential.*`) got an authorization URL from it. The callback route works the same way. The grant
  became "Connected, version 2".
- **Workaround:** call that route with the operator token and open the returned URL.
- **Change:**
  1. Add `POST /integrations/:name/connect` to the production operator routes, requiring
     `feltkit.operations.write` and `credential.store`, so the CLI works unchanged.
  2. Add a **Connect** button to Studio → Integrations, showing grant status.
  3. Make the callback page link back to Studio.
- **Test:** `feltkit credential connect x --env production` prints the address. Callback shows
  "Connected". `credential status` shows the grant.

### 3. No production service sessions
- **Happened:** `feltkit session create --type service --id x-adapter --role xadapter --env production` →
  `POST /sessions is not available in production.`
- **Workaround:** `operator signin --id x-adapter --role xadapter` gives an operator session (8 hours)
  that holds only that role. The poll chain was started under it (`startedBy: x-adapter`).
- **Risks:** the session expires after 8 hours. **Not verified:** whether the already-queued jobs keep
  running as `x-adapter` after it expires. An operator token also works as a bearer token on `/api/*`
  although the cookie is scoped to `/_feltkit`. That may be intended; please review it, because it lets an
  operator session act as an application principal.
- **Change:** production-online `session create` for service sessions, with an explicit TTL and
  revocation. Or declare service principals in `feltkit()` config, so the adapter's identity doesn't
  depend on a human's sign-in.
- **Test:** the adapter session outlives 24 hours and can be revoked, and the poll chain keeps going.

### 4. No way to call an application function in production from the CLI
- **Happened:** starting polling needed a hand-built request: `POST /api/mutation/xsurface:startPolling`
  with an operator bearer token and `x-feltkit-environment: production`. `feltkit op` only covers FeltKit's
  own operations capabilities.
- **Change:** `feltkit call <module:function> [--input '<json>'] --env production`, authorized as the
  signed-in operator through the normal function authorizer, recorded as activity.
- **Test:** `feltkit call xsurface:startPolling --env production` as the adapter operator.

### 5. `credential status` hides OAuth state
- **Happened:** it prints `✓ credential-ref:x: set (local encrypted vault, version 3)`. `docs/X.md` expects
  expiry, "renewable" and `refreshes ≥ 1`. `credential-ref:x-client-secret` isn't listed at all, though
  the integration needs it.
- **Change:** show kind (`oauth2`), connected account, expiry, renewable, refresh count, last refresh
  result, and `reconnect_required`. List referenced client secrets. `feltkit readiness` should fail when an
  OAuth integration's client secret reference has no value.
- **Why it mattered:** `X_CLIENT_SECRET` was deployed under the wrong name for the first hour and nothing
  flagged it.

### 6. Vault directory defaults to the image
- **Read:** production vault directory is `FELTKIT_CREDENTIAL_VAULT_DIR`, else `.feltkit/production`
  (`docs/GUARANTEES.md`). In the Fly image that path is on the container filesystem, so a deploy would erase
  the grant.
- **Workaround:** set `FELTKIT_CREDENTIAL_VAULT_DIR=/data/vault` on the volume.
- **Change:** with `FELTKIT_CREDENTIAL_VAULT=1`, the Fly, container and self-hosted targets default the
  vault under the persistent data directory. `feltkit fly deploy` should also set the vault key (never
  displayed) and warn that it must not change.

### 7. `authority.application` is a literal
- **Happened:** AuthBoundry assigned the id `personalos-9567637ab348`. `feltkit/app.ts` has
  `application: "personalos"`. They won't match.
- **Change:** accept `{ env: "AUTHBOUNDRY_APPLICATION" }`, like `url`. Fall back to the app name.
- **Test:** the check request carries the configured id.

### 8. Configuration ergonomics (from your list)
Pointers, based on this deployment. These are your stated requirements, and I haven't designed them:
- **Integrations reading dashboard variables:** endpoints (`X_TOKEN_URL`, `X_AUTHORIZE_URL`, `X_REVOKE_URL`,
  `X_API_URL`) and `X_CLIENT_ID` are all `{ env: … }` today, so each needed a Fly secret.
- **Credentials stored in the database:** the vault is a file plus a key in the environment.
- **Production defaults for endpoints:** the X endpoints are fixed public URLs and could be defaults for a
  known provider.

### 12. Ambient cookie plus a foreign Origin is a hard error
- **Happened:** the Chrome extension showed a black side panel with `FeltKitClientError: Cross-site request
  refused.` for a person who was also signed in to the web app. **Verified** by reading
  `server/index.js` (`identify`, ~line 163) and `session-http.js` (`checkCookieRequest`): a bearer token is tried
  first, then the session cookie. Before the panel has a token, Chrome attaches the browser's cookie for the
  instance (the extension has host permission), and the cookie check refuses `Origin: chrome-extension://…`.
- **Workaround (PersonalOS):** every extension request omits cookies (`extension/src/nocookies.ts`, passed as the
  client's `fetch`). The e2e test had no cookie in its profile, so it never saw this.
- **Change:** with no bearer token, treat a cookie sent from a foreign origin as absent (anonymous), not as an
  error, for endpoints that allow anonymous access. Or let a host declare its allowed origins. Add an e2e case with
  a pre-existing web session cookie. `docs/EXTENSION-HOSTS.md` should say extensions must omit cookies.
- **Also:** the panel renders nothing when the first request fails. An error boundary with a retry would have shown
  the message instead of a black screen.

## Resolver (`@appport/resolver` 0.4.0)

### 9. CLI exits 0 with no output via the npm symlink
- **Verified:** in `node:22-slim`, `npm i -g @appport/resolver` then `resolver serve …` does nothing and
  exits 0. `node …/dist/cli.js serve …` works. `/usr/local/bin/resolver` is a symlink to `cli.js`, so
  the "am I the entry point" check likely compares unresolved paths.
- **Change:** compare real paths (`realpathSync`). Also print an error when the check fails.
- **Docs:** `RESOLVER_URL=https://api.appport.io` appears in this environment but the host does not
  resolve (NXDOMAIN). Document the real default or remove it. Add a Docker and Fly example. Say that
  `resolver init` needs the server stopped (state lock).

## AuthBoundry (`rkendel1/authboundry`)

### 10. Image can't find the Services bridge
- **Verified:** the Services panel and application services returned `AppPort Services bridge does not
  exist: /build/crates/server/../../bridge/appport-services.cjs`. The binary reads
  `AUTHBOUNDRY_APPPORT_SERVICES_BRIDGE`. The image sets only `AUTHBOUNDRY_FELTDB_BRIDGE`.
- **Workaround:** set it to `/app/bridge/appport-services.cjs` in the host env file and recreate the container.
- **Change:** set it in the Dockerfile `ENV`, beside the FeltDB bridge.

### 11. Portal build is broken; check-credentials UI is merged but not live
- **Verified:** every Vercel production build since Nov 12 fails. `apps/web/package.json` requires
  `@stack-ui/*` 0.9.0, but `vendor/stack-ui` is 0.6.2, so a clean `npm ci` fails (`ETARGET`). The latest
  builds also fail with `../../dist/server.js: Can't resolve '@appport/services'`. The `portal` CI job fails
  `tests/stack-ui-vendor.test.ts`.
- **Done:** PRs #146 and #147 add a **Check credentials** panel (Authorization tab: issue, show once,
  revoke) and its API routes. It cannot ship until the build is fixed.
- **Change:** re-vendor stack-ui to 0.9.0 per the vendor README, and make `dist/server.js` resolve
  `@appport/services` in the Vercel install. Prove it with a clean `npm ci && npm run build`.
- **Also seen:** after GitHub sign-in the browser stops on a JSON page instead of the console. The portal
  API can't create organizations, so applications must go under an existing one.

## PersonalOS follow-ups
- Update `docs/X.md`: it still says adoption waits for a FeltKit release, but `app.ts` is adopted and
  0.3.28 works. Document the production steps and the X pay-per-use credit requirement (HTTP 402
  `credits depleted` came from the X app, not from us).
- The poll chain stalled at tick 1 after a `CONFIGURATION` error (a plain-value credential) and only
  resumed when restarted. After 402s it kept retrying. Make the chain retry after configuration errors too.
- Change `authority.application` once item 7 ships, or hard-code `personalos-9567637ab348` until then.
- Remove `AUTHBOUNDRY_SESSION` from `.env.local` (a one-hour portal cookie, now stale), and the older X
  keys that nothing uses.

## Where things stand (no secrets)

| | |
|---|---|
| PersonalOS on Fly | one machine with a volume; X grant connected as the bot account (being renamed to @anywhereaide); polling running; model `anthropic/claude-sonnet-5-5` resolved through Resolver |
| Resolver | `https://resolver.boundry.company` on the Hetzner server (`/opt/resolver`), tenant `kendel`, keys in gitignored files under `resolver/deploy/hetzner/` |
| AuthBoundry | `https://api.authboundry.com` on Hetzner, tenant `default`; the Fly app `authboundry-api` is stale. The new GitHub OAuth app signs you in |
| PersonalOS in AuthBoundry | application and 14-capability contract registered. Still missing: principals, policy, agent, delegation, check credential |
| Not yet done | `AUTHBOUNDRY_URL` and the check credential on Fly; the human-mention end-to-end test; confirming the 2-hour token renewal |
| To clean up | the unused `kendel-resolver` app on Fly; uncommitted deploy files in the resolver repo |
