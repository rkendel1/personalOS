# PersonalOS agent

PersonalOS's own eve agent: the separate process that carries out delegated work for a person through PersonalOS's
`/appport`, under that person's AuthBoundry grants. PersonalOS hands it work through its `agent` integration
(`PERSONALOS_AGENT_URL`, `feltkit/anywhere.ts`); PersonalOS works fully without it. It needs no Vercel account or service.

- **Framework.** eve from [rkendel1/eve2](https://github.com/rkendel1/eve2), published as `@appport/eve` and installed as
  `eve` (`"eve": "npm:@appport/eve@…"`). It was moved here from eve2's `examples/appport-agent`.
- **Tests.** `npm test`. The PersonalOS suites run against this repository (`PERSONALOS_DIR` overrides it, with its
  dependencies installed); `test/feltkit.test.mjs` needs `FELTKIT_SDK_DIR`, a FeltKit `packages/sdk` checkout.

- **Model.** `anthropic("claude-sonnet-5")` direct (`ANTHROPIC_API_KEY`), overridable with `APPPORT_AGENT_MODEL`.
- **Tools.** `defaultTools: false`. The agent has only `appport_capabilities`, `appport_contract`, and `appport_invoke`.
- **Route auth.** `jwtHmac` (HS256; `AGENT_JWT_SECRET`, `AGENT_JWT_ISSUER`, `AGENT_JWT_AUDIENCE`), then `placeholderAuth()`.
- **Execution state.** eve's local Workflow world in `.eve/.workflow-data` (SQLite): sessions, turns, checkpoints. Sessions continue after a restart.
- **Work state.** FeltDB (`@feltdb/core` agent state, local file runtime) in `APPPORT_AGENT_WORK_DIR`. This is the authoritative record of each piece of work, independent of eve's sessions.

## How a capability call is authorized

Authentication, delegation and capability authorization are separate steps, each with its own owner.

1. **The person.** eve verifies the caller's JWT. The verified principal, for example `appport-agent-operator:alice`, becomes `ctx.session.auth.current`. The model never supplies it.
2. **The agent.** The tool calls AppPort with `@appport/client` at `APPPORT_URL` (`…/appport`). It sends the agent's AuthBoundry credential as `Authorization: Bearer` and the person as `x-appport-on-behalf-of`.
3. **Authentication at AppPort.** The host's `authenticate` hook accepts the request only when the credential equals the one the application holds for `agent:appport-agent`. That proves which agent is calling and grants nothing.
4. **Delegation.** The host's AppPort `Authorizer` asks AuthBoundry for each permission the capability declares:
   - it uses `POST /_authboundry/authorize/check` with the agent's credential and `on_behalf_of`;
   - it allows only on `allow`, which comes with the person's `delegation_id`;
   - any other answer is `FORBIDDEN` (`delegation_missing`, `delegation_revoked`, `delegation_expired`, and so on);
   - if AuthBoundry is unreachable the call fails closed (`INTERNAL_ERROR`).
5. **Exposure.** Only capabilities listed in `APPPORT_AGENT_CAPABILITIES` are ever sent (the run command below lists `catalog.lookup`, `catalog.reserve` and `catalog.reservation`). A capability that is not `effect: "observation"` is sent only as a durable operation within accepted work; see [Durable operations](#durable-operations).
6. **Provenance** goes to `APPPORT_PROVENANCE_FILE`, joined by `requestId`:
   - `authorization`: agent, person, decision, `decisionId`, `delegationId`, reason;
   - `execution`: written by the handler, only when it ran;
   - `request`: AppPort's own telemetry.

## Durable work

Submit work to `POST /work`, authenticated with the same JWT as the eve channel and an `Idempotency-Key` header:

```bash
curl -X POST "$AGENT_URL/work" -H "authorization: Bearer $JWT" -H "idempotency-key: order-123" \
  -H "content-type: application/json" -d '{"objective":"How many units of SKU ALPHA-1 are in stock?"}'
# 201 {"workId":"work_…","sessionId":"wrun_…","replayed":false}
curl "$AGENT_URL/work/work_…" -H "authorization: Bearer $JWT"
```

**What `POST /work` does:**

1. **Authenticate** with eve's `routeAuth` and `jwtHmac`.
2. **Record the submission.** Derive the work id from (requester, key) and commit a `work_submissions` record first: the objective and the caller's verified `AuthResult`. JWT claims only, never the token.
3. **Create the record.** Create a FeltDB `AgentTask` with:
   - `objective`;
   - `owner` = `agent:appport-agent`;
   - `scope.workspace` = the requester;
   - `scope.project` = `inventory`.
4. **Start the session.** Send the objective to the eve session at address = work id, with eve's delivery `idempotencyKey`.

**Repeated submissions.** The same key and objective return the same work and session and run nothing again. The same key with a different objective, or a different `readOnly`, returns `409 IDEMPOTENCY_KEY_REUSED`.

**Read-only work.** A body of `{ "objective": …, "readOnly": true }` is stored in the submission. That work runs only capabilities whose manifest declares `effect: "observation"`; any other or undeclared effect is refused with `READ_ONLY_WORK` before an operation is recorded or sent, on the first call, a retry or recovery alike. The model cannot set or clear it.

**Identity authority (connected surfaces).** Personal OS resolves who sent a surface message (Resolver) and submits the work for that person. It authenticates with its own ES256 token: issuer `APPPORT_AGENT_IDENTITY_ISSUER`, verified with `APPPORT_AGENT_IDENTITY_PUBLIC_KEY`, audience `appport-agent-identity`. The issuer must differ from the requester issuer.

- **What it may send:** only that token may carry `onBehalfOf` (the person) and `surface` (scalar provenance, at most 4 KB). Anyone else's token gets `403 ON_BEHALF_OF_NOT_ALLOWED`.
- **Who the work is for:** it is accepted as `<requester issuer>:<person>`, the same requester as the person's own submissions, and runs under that person's grants.
- **What is recorded:** the submission keeps who asserted the person (`assertedBy`) and the surface provenance. Both are shown by `GET /work/:id`, which the authority may read for work it submitted.
- **Finding its work:** `GET /submissions/:person/:key` finds work the authority submitted by its own key. It lets the authority learn whether a submission with no definite answer was accepted, without sending it again.

**Progress** is recorded by the `work` channel's event handlers as immutable FeltDB checkpoints, never overwritten:

| eve event                           | Checkpoint                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `turn.started`                      | `running`, with the eve session id as `execution.conversation_id`; the session is bound to the work in `work_sessions` before any tool runs |
| `call.settled` for `appport_invoke` | `running`, citing the invocation record as evidence (verified by FeltDB inside the commit)                                                  |
| `turn.settled`                      | One of the three outcomes below, decided from recorded evidence, never from the model's text                                                |

| Outcome                                                                                      | When                                                                                                                                     |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `completed`                                                                                  | At least one invocation was authorized, and the completion gate below passes                                                             |
| `blocked` with `blocked: not completed: <reason>`                                            | The turn would complete, but the ledger does not prove it (completion gate)                                                              |
| `blocked` with `waiting: every AppPort invocation was rejected`                              | Every invocation was rejected                                                                                                            |
| `blocked` with `failed: the eve turn ended failed`                                           | The turn failed                                                                                                                          |
| `blocked` with `indeterminate: N AppPort operation(s) without an established outcome: <ids>` | An `appport_invoke` call settled while its operation's outcome is unknown (see Durable operations). The ids are what an operator settles |

When an operator settled any of the work's operations, the decision ends with `; N settled by an operator`.

The agent's reply is kept in the summary as the agent's claim.

**Completion gate.** Every write of `completed` (a turn, recovery, settlement) is checked against the operation ledger. It requires all of the following; otherwise the work is `blocked: not completed: <reason>`:

- at least one operation;
- every operation `succeeded` or `failed`, none `prepared`, `executing` or `indeterminate`;
- each operation requested by the submitter and consistent with any settlement;
- at least one success, with a recorded result (`output_digest` and request id, or an operator's settled success);
- each success cited.

**Invocation evidence.** Each call is a durable operation (below). The work cites `appport_operations` records, never model text. AppPort's `traceId` is the work id, so the host's provenance carries the work id beside the AuthBoundry `delegationId`, `decisionId` and authority.

**Reading work.** `GET /work/:id` returns a requester's own work only; anyone else gets 404. The response includes:

- status, history, decisions and evidence;
- invocation outcomes;
- `ledger`: every operation, with state, contract digest and checks, effect and settlement;
- `refusals`: calls refused before an operation existed;
- `readOnly`;
- the recorded session, and the session eve currently holds for that address.

Only one eve process may open the work store: FeltDB holds an exclusive lock.

## Durable operations

Within accepted work, every `appport_invoke` call is a durable operation in the FeltDB work store (`appport_operations`). Each eve call is linked to its operation, or recorded as refused, in `appport_invocations`.

**Identity.** `op_` + SHA-256 of (work id, capability, then either `operationKey` if the model passed one, or the RFC 8785 canonical digest of capability, version and input).

- A repeated call with the same input, or the same key, resolves to the same operation. That includes a call the model re-issues after eve abandoned an interrupted one.
- Different input is a different operation.
- The same key with different input or capability is refused as `OPERATION_CONFLICT`, and the recorded intent is never overwritten.
- eve call ids and AppPort request ids are **not** used as identity: neither is stable across retries.

**Lifecycle.**

```
prepared ─▶ executing ─▶ succeeded | failed | indeterminate
```

1. `prepared` is committed, and the call linked, before anything is sent.
2. `executing` is committed, naming this process, before the request is sent.
3. The request is sent with the operation id as AppPort's `idempotencyKey`, when the manifest declares `idempotency: "supported"`.
4. The outcome is committed from AppPort's actual response.

Transitions are compare-and-set on the record version.

**Contract pinning.** `prepared` records the capability's contract as AppPort's `capabilityDigest`, with that version's manifest entry and integration declaration. Before every send (the first, a retry or recovery), the current manifest is compared with AppPort's `compareManifests`, for that capability only:

- the same digest, or a compatible change, is sent against the pinned entry and version. A compatible change is recorded in `contract_checks`; the pin is never replaced;
- a breaking change, a changed integration declaration, or a contract that is gone is not sent:
  - an operation never sent becomes `failed` (`CONTRACT_CHANGED` / `CONTRACT_UNAVAILABLE`);
  - one sent before becomes `indeterminate` for an operator to settle.

**Repeated attempts.**

| Recorded state                          | What happens                                                          |
| --------------------------------------- | --------------------------------------------------------------------- |
| `succeeded`, `failed`                   | The recorded outcome is returned; nothing is sent                     |
| `indeterminate`                         | Returned as `OPERATION_INDETERMINATE`; never sent again automatically |
| Settled by an operator                  | `succeeded` or `OPERATION_SETTLED_FAILED`; nothing is sent            |
| `prepared`                              | Sent: nothing was sent before                                         |
| `executing` from a process that is gone | Depends on the downstream guarantee (next table)                      |

| Downstream guarantee (from the AppPort manifest) | `executing` after an interruption                                                                                                                                          |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idempotency: "supported"`                       | Sent again with the **same** key. AppPort replays the recorded response, so the effect does not run again. An `IDEMPOTENCY_OUTCOME_UNKNOWN` answer becomes `indeterminate` |
| `effect: "observation"` (no effect declared)     | Sent again (a repeated read)                                                                                                                                               |
| Neither                                          | `indeterminate`, with a resolution note. A person must establish whether it took effect                                                                                    |

**How answers are classified.**

- An answer that proves the capability did not run is `failed`, and is not retried: `UNAUTHORIZED`, `FORBIDDEN`, `INVALID_INPUT`, `INVALID_REQUEST`, `NOT_FOUND`, `UNKNOWN_CAPABILITY` or `UNSUPPORTED_CAPABILITY_VERSION`.
- Any other error is `indeterminate`.
- An unreachable AppPort leaves a keyed or observation operation reconcilable by a later attempt. An operation with neither guarantee becomes `indeterminate`.

**Not guaranteed.**

- **Exactly-once effects.** The downstream key gives at-most-once execution of the handler, and the example host keeps its keys in a durable store (below). A durable claim and the capability's external effect are still not one transaction.
- **Calls outside accepted work.** Consequential capabilities are refused outside accepted work.
- **A model that changes the input on retry.** That creates a new operation.

## The state-changing capability: `catalog.reserve`

`catalog.reserve@1` is the one capability that changes state. It reserves units of a catalog item for the requesting person, and the reserved units stop being available.

| Property        | Value                                                                          |
| --------------- | ------------------------------------------------------------------------------ |
| Effect          | `consequential`                                                                |
| Idempotency     | `supported`                                                                    |
| Authorization   | Needs `catalog.reserve`, granted by the person through AuthBoundry             |
| Idempotency key | Required (`IDEMPOTENCY_KEY_REQUIRED` otherwise). eve's operation id is the key |

**State.** Inventory lives in the host's FeltDB store, `<APPPORT_HOST_DATA_DIR>/inventory`, seeded once from `catalog.json`.

- A reservation commits in **one** FeltDB transaction: the item's stock goes down (compare-and-set on its version), and a `reservations` record is created.
- The reservation records the person, the agent, the AuthBoundry `delegation_id`, the AppPort `request_id` and the idempotency key.
- The reservation id is derived from the scoped key, so one key can never hold two reservations.
- `catalog.lookup` reads the same state.

**Reversal.** Reversal is an operator action, not a capability: `inventory.release(reservationId)` in `appport-host/inventory.mjs` restores the stock in one transaction.

**Reconciliation.** This uses Stack-Agent's `decide`, ported from `chip-agent-state/src/reconcile.rs`.

- **Where it applies:** an operation whose outcome eve lost (its process stopped while it was executing), or one already `indeterminate`.
- **How it is resolved:** by **reading** `catalog.reservation@1`, never by dispatching again. That read capability is configured with `APPPORT_AGENT_RECONCILERS=catalog.reserve=catalog.reservation`.
- **What the read reports**, for the caller's key:
  - the destination's own record of the operation (committed with its input, or not applied);
  - whether the reservation is still held.
- **What the ledger concludes:**
  - `completed` (the operation becomes `succeeded`) only if the destination committed **this** key and input **and** the effect is present;
  - a missing reservation does not prove the operation never ran, because the host does not bar the key, so the operation stays `indeterminate`.
- Every query is recorded in the operation's `reconciliations`.

## Durable AppPort idempotency

The example host replaces AppPort's in-memory idempotency store with `appport-host/idempotency-store.mjs`. It implements AppPort's own `IdempotencyStore` interface (`get`, `set`, `claim`, `release`, `findByRequestId`) on a FeltDB collection in `<APPPORT_HOST_DATA_DIR>/idempotency`. AppPort's runtime is unchanged.

**Key scope.** AppPort scopes a key to `<session>|<capability>@<version>|<key>`. The host derives one AppPort session per (agent, person), so:

- a key never answers another person's request;
- a key never answers another agent's request;
- an unauthenticated request never reaches the store.

**Records.** One record per scoped key: `in-progress` (claim), `completed` (response), or `released`. Each record holds:

- the capability and version;
- AppPort's request digest (canonical capability, version and input);
- the claiming `requestId`, session and principal;
- the host instance (`owner`) that wrote it.

| Store operation | FeltDB write                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| claim           | Create-if-absent (`requireAbsent`); a `released` record is re-claimed by compare-and-set                     |
| set (completed) | Compare-and-set on the claim of the same `requestId`; another request's claim or record is never overwritten |
| release         | Compare-and-set to `released`, only for the same `requestId`                                                 |

**What a repeated request gets.** AppPort's runtime decides this from the stored record:

| Stored                                           | Repeated request                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Nothing                                          | Claimed, then executed                                                                     |
| `completed`                                      | The stored response is replayed (`idempotentReplay: true`), including after a host restart |
| `in-progress`, live or abandoned                 | `CONFLICT` / `IDEMPOTENCY_OUTCOME_UNKNOWN`; not executed                                   |
| Different capability, version or input           | `CONFLICT` / `IDEMPOTENCY_KEY_REUSED`; not executed                                        |
| `released` (the handler threw, or never started) | Claimed again and executed. AppPort treats a throwing handler as having had no effect      |

**Deliberate difference from the interface comment.** AppPort's interface says an expired entry counts as absent (24-hour TTL). This store never expires anything, so an abandoned claim stays uncertain until a person resolves it, instead of becoming executable after a day. Retention is left to the operator.

**One host per store.** FeltDB's exclusive lock refuses a second host on the same data directory with `STATE_LOCKED`; the host opens the store before it starts AuthBoundry.

## Recovery

eve has no startup hook. The `work` channel therefore reconciles every unfinished work record (`ready`, `running`, `blocked`) once per process, before it answers its first `/work` request. `POST /work/reconcile` forces another pass; only the principal named by `APPPORT_AGENT_OPERATOR` may call it.

Run it right after start: from the supervisor (for example a systemd `ExecStartPost`), or by sending any `/work` request.

For each record, the reconciler reads eve's recorded events in process (`sessions.attach(id).stream({ follow: false })` from `eve/server`), folds them with `eve/events` selectors, and decides:

| eve shows                                                                                                                                                    | Work becomes                                                                                 | Runs anything?               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------- |
| No session for the work, record `ready`, submission recorded                                                                                                 | Submitted at its address with the original delivery key; decision `recovered: submitted…`    | Yes: the accepted turn, once |
| No session, record not `ready`, or no submission record                                                                                                      | `blocked`, `indeterminate: …`                                                                | No                           |
| A turn still running                                                                                                                                         | `running`; eve's own world resumes it                                                        | No                           |
| A turn running with no AppPort call in flight, no interaction awaited, and no session or ledger activity for `APPPORT_AGENT_STALL_AFTER_MS` (default 15 min) | `blocked`, `stalled: no progress since …`; reclassified on each pass                         | No                           |
| A turn waiting on an interaction (approval)                                                                                                                  | `blocked`, `waiting: …`                                                                      | No                           |
| A settled turn                                                                                                                                               | The live outcome rule, prefixed by `recovered: final state reconstructed from eve session …` | No                           |
| A session that cannot be read                                                                                                                                | `blocked`, `indeterminate: eve session … could not be read`                                  | No                           |

**Idempotent.** A pass writes only when the derived status or decision differs from the record, so repeated passes change nothing.

**No invented evidence.** Evidence comes only from committed invocation records belonging to that work. A settled `appport_invoke` call without one makes the work indeterminate.

## Acting for a person in a FeltKit application

The same agent invokes a FeltKit application's published capabilities for the person who submitted the work (FeltKit's delegated `/appport`; `docs/LOCAL-AUTHORITY.md` in FeltKit):

- `APPPORT_URL` is the application's `/appport`.
- `APPPORT_AGENT_CREDENTIAL_FILE` holds the agent's FeltKit session (`feltkit session create --type agent`). The application's operator registers the agent (`ctx.authority.agents.register`), and each person grants it capabilities.
- `APPPORT_ON_BEHALF_OF=subject` names the person by the subject of the requester's verified token (the part after `AGENT_JWT_ISSUER:`): the requester issuer and the application must share person ids. A principal from another issuer names nobody, and the call fails. Without it the full principal id is sent, as the example host expects.

FeltKit decides each call with AuthBoundry as this agent, proven by its own credential, for that person and that capability, and runs the function as the person. Nothing else changes here: the ledger sends its operation id as the idempotency key, FeltKit's durable store replays it, and FORBIDDEN is a failure that is never retried.

### Personal OS

Personal OS's tasks, reminders and daily briefing are published FeltKit capabilities: `tasks.list`, `tasks.create`, `tasks.update`, `tasks.complete`, `tasks.reopen` and `briefing.today`. A person grants each one to the agent separately in Personal OS (`delegation.set` with `agent`), after an administrator registers the agent (`delegation.registerAgent`). Deleting a task stays the person's own act and is not available to an agent.

Memory works the same way, with `memory.list` and `memory.propose`. A proposal is stored as an unconfirmed (inferred) note, attributed to the agent; only the person confirms or drops it in Personal OS. Personal OS refuses every trusted-memory change made under an agent's delegation.

Projects and documents use `projects.list`, `projects.create`, `projects.update`, `documents.list` and `documents.update`, each granted separately. A project grant never exposes documents. Uploading a document, a download link, and removing a document are never available to an agent.

Research uses `research.start`, `research.list`, `research.get`, `research.cancel` and `research.retry`, and is bounded by a research budget the person sets for the agent, in billable calls (model generations and web searches). Starting with no budget, or beyond what is left, is refused. Personal OS charges each call to the run before making it, stops the run when its calls are used, and makes no further call once it is cancelled or the grant is revoked.

The agent adds no task, memory, project, document or research logic of its own: Personal OS creates the task, verifies it, schedules its reminder as the person, and records the action with the agent and the AuthBoundry decision.

## Operator settlement

An `indeterminate` operation stays that way until a person resolves it. An operator settles it with:

```http
POST /operations/:operationId/settle
Authorization: Bearer <ES256 operator JWT>

{ "outcome": "succeeded" | "failed", "reason": "…", "evidence": "…" }
```

**Who may settle.** Only a bearer of an ES256 JWT that verifies against `APPPORT_AGENT_OPERATOR_PUBLIC_KEY` (PEM), with issuer `APPPORT_AGENT_OPERATOR_ISSUER` and audience `appport-agent-settlement` (eve's `jwtEcdsa`). The recorded operator is the verified `issuer:subject`; the body cannot name one.

- The eve process holds only the public key, so neither the agent nor anyone holding `AGENT_JWT_SECRET` can mint an operator token.
- Requester tokens, the `/work/reconcile` operator token (HMAC), and the agent's AuthBoundry credential are all refused (401).
- Without both variables the route answers 503; there is no fallback.
- No tool or AppPort capability reaches settlement. The model's tools are unchanged.

**Rules** (from Stack-Agent's `settle`, `chip-agent-state/src/lib.rs:1737`):

- Only an `indeterminate` operation is settled. Anything else is refused (409), as is an unknown operation (404).
- `outcome`, `reason` (1-1000 characters, one line) and `evidence` (1-512 characters, one line) are required. Unknown fields, including `operator`, are refused (400).
- Settlement is written once, by compare-and-set on the record version. A second settlement, even an identical one, is refused (409).
- It records nothing but `state` and an appended `settlement` (`at`, `operator`, `outcome`, `reason`, `evidence`, `prior_state`). Intent, key, attempts, request ids, AppPort's last answer, resolution and every reconciliation are kept as they were.
- It performs nothing and invents no receipt. A settled `succeeded` carries the operator's attestation, not an AppPort output.
- Afterwards the work is re-decided from its eve session, so completion reflects the settled outcome.

**Unlike Stack-Agent**, a settled failure is final. Stack-Agent lets the normal path perform an intent settled as not executed. Here the operation is never dispatched again with that key, by a repeated model call or by reconciliation. Doing the action again takes a new operation.

## Who owns what

| Concern                                      | Owner                                                                            |
| -------------------------------------------- | -------------------------------------------------------------------------------- |
| AuthBoundry server process and its state     | The AppPort application (`appport-host/host.mjs`), via `@authboundry/local`      |
| Grants and revocations                       | AuthBoundry, through the application (`authority.grant` / `authority.revoke`)    |
| The agent's credential (issue, renew, store) | The application, written to `APPPORT_AGENT_CREDENTIAL_FILE` (mode 0600)          |
| Reading the current credential               | eve, from the same file, on every call                                           |
| Work records, progress, outcomes, evidence   | FeltDB, written by the eve agent (`agent/lib/work.ts`, `agent/channels/work.ts`) |
| Sessions, turns, execution checkpoints       | eve's Workflow world; never the work record                                      |

The agent never sends AuthBoundry a credential of its own. A renewed credential supersedes the old one, and replaying a superseded credential revokes the whole family (verified). So the application keeps custody and compares what the agent presents with its current copy.

## Run it

```bash
pnpm install
AUTHBOUNDRY_ADMIN_SECRET=<32+ chars> APPPORT_AGENT_CREDENTIAL_FILE=$PWD/.appport-host/agent-credential \
  APPPORT_PORT=4317 pnpm appport-host
EVE_MODEL_CATALOG=bundled pnpm build
ANTHROPIC_API_KEY=… AGENT_JWT_SECRET=<32+ chars> APPPORT_URL=http://127.0.0.1:4317/appport \
  APPPORT_AGENT_CREDENTIAL_FILE=$PWD/.appport-host/agent-credential \
  APPPORT_AGENT_CAPABILITIES=catalog.lookup,catalog.reserve,catalog.reservation \
  APPPORT_AGENT_RECONCILERS=catalog.reserve=catalog.reservation \
  APPPORT_AGENT_WORK_DIR=$PWD/.appport-agent-work pnpm start
```

The host keeps AuthBoundry's state and its check credential in `APPPORT_HOST_DATA_DIR` (default `.appport-host`).

Run the host under a supervisor that stops its whole process group (for example systemd's default `KillMode=control-group`). If the host is killed abruptly, the AuthBoundry server it started keeps running.

People grant through the application. This example has no person-facing grant screen; the tests grant and revoke with `host.authority`.

## Tests

`pnpm test` runs `node --test`.

**Always**, with real AppPort and AuthBoundry servers and no model:

- discovery and the capability's contract;
- no grant → `delegation_missing`;
- Alice's grant → a result equal to `catalog.json`, with the delegation in provenance;
- Bob can't use Alice's grant;
- invalid input is rejected;
- revocation stops the next call, and a new grant gets a new id;
- an expired grant is rejected;
- a forged agent credential gets `UNAUTHORIZED`;
- an AuthBoundry outage fails closed, then calls recover after the automatic restart;
- an AppPort outage is a failure, never a result;
- unexposed capabilities are never sent;
- grants and credentials survive a restart of the application.

Every rejected call is checked to have no `execution` record.

**Always, `test/work.test.mjs`.** Real eve (`eve start`), FeltDB on disk, AppPort and AuthBoundry, with a scripted `mockModel` agent generated from `agent/` with only `agent.ts` replaced:

- one record per submission, and the actual outcome;
- AppPort provenance linked to the work and the delegation;
- idempotent replay, and a key-reuse conflict;
- Bob can't read Alice's work;
- revocation blocks invocation;
- a failed turn is recorded as failed;
- the record and session association survive an eve restart (whole process group killed);
- the records read directly from FeltDB without eve;
- recovery after process-group crashes:
  - between record creation and send;
  - after AppPort answered but before the evidence was written;
  - before the final checkpoint;
- a failed checkpoint write stays visible until reconciliation;
- a call without committed evidence is never cited;
- durable operations, with test-only `probe.applykeyed` (`idempotency: "supported"`) and `probe.applyunkeyed` capabilities that count their effects:
  - intent is committed before invocation;
  - a crash after the effect is replayed through the key once (keyed) or becomes indeterminate (unkeyed), and is never repeated;
  - indeterminate stays indeterminate across recovery passes;
  - repeats, conflicts, distinct operations, failures and Bob's authority are covered;
- **Always, `test/idempotency.test.mjs`.** The host runs as its own process (`test/probe-host.mjs`, effects appended to a file). Each restart test kills the host and AuthBoundry, checks both are gone, reads the host's FeltDB records directly, and starts a new host on the same store. It covers:
  - completed replay after a restart;
  - key reuse with changed input;
  - a crash after the claim;
  - a crash after the effect but before the response;
  - concurrency;
  - a second host refused;
  - per-person key scope;
  - no claim for an unauthenticated caller;
  - eve's ledger replaying through the durable store after both eve and the host restart;
- **Always, `test/reserve.test.mjs`.** `catalog.reserve` end to end with the host as its own process. It covers:
  - an authorized reservation with its delegation in provenance;
  - Bob without the delegation, and a forged credential;
  - a repeated request (one AppPort request), and concurrent requests (one handler run);
  - eve crashing before invoking, and after the effect (reconciled by reading);
  - the host crashing after the effect (uncertain across the restart, then reconciled) and after the claim (stays indeterminate);
  - revocation;
  - inventory totals matching every recorded outcome, and an operator release.
- **Always, `test/safety.test.mjs`.** Runtime safety, with real eve, FeltDB, the host process (restarted with changed contracts) and AuthBoundry. It covers:
  - a stalled turn, durably and after restart; an operation that takes long, not stalled;
  - the completion gate on live and recovery paths;
  - contract pinning with compatible, breaking and removed contracts before send, retry and recovery;
  - read-only work, including an undeclared effect, a flipped `readOnly`, and recovery.

  See [`RUNTIME-SAFETY-REPORT.md`](../../audits/appport-foundation/RUNTIME-SAFETY-REPORT.md).

- **With `PERSONALOS_DIR`**, `test/anywhere.test.mjs`: AnywhereAide surfaces through Personal OS to this agent. It runs real eve, the Personal OS server process, its private AuthBoundry, the Resolver server process and FeltDB. The Multiplayer bridge and the X adapter's poll are played by the test with real service sessions; no X API is involved. See [`ANYWHEREAIDE-INTEGRATION-REPORT.md`](../../audits/appport-foundation/ANYWHEREAIDE-INTEGRATION-REPORT.md).
- **Always, `test/settle.test.mjs`.** Operator settlement, with real eve, FeltDB, the host process and AuthBoundry. It covers:
  - work blocked while an operation is indeterminate;
  - settling the host-crash-after-effect reservation as succeeded (the work completes) and the crash-after-claim one as failed (after reconciliation kept it indeterminate);
  - refusal of the agent's credential, requester and HMAC operator tokens, another key, the wrong audience or issuer, and an expired token;
  - malformed bodies, a second settlement, and a non-indeterminate operation;
  - the appended record and its unchanged history;
  - the model repeating a settled failure: no AppPort request;
  - an eve restart and reconciliation;
  - no tool or capability reaching settlement.
- **With `FELTKIT_SDK_DIR`** (a FeltKit `packages/sdk` checkout with delegated `/appport` and its dependencies), `test/feltkit.test.mjs`: real eve, a FeltKit server process (`test/feltkit-host.mjs`) with its private AuthBoundry, and FeltDB. It covers:
  - Alice's delegated add and list, run as Alice;
  - Bob without a grant, and Carol's read-only grant for a write: refused;
  - a person's own session naming someone else: refused;
  - eve and FeltKit both killed after FeltKit applied the note: one note after restarts;
  - revocation;
  - FeltKit's audit records naming Alice, the agent, and the AuthBoundry decision and delegation.
- **With `PERSONALOS_DIR`** (a Personal OS checkout with agent delegation, its dependencies installed, and a FeltKit with delegated `/appport`), `test/personalos.test.mjs`: real eve against a Personal OS server process (`test/personalos-host.mjs`, Personal OS's own `feltkit/` sources and installed FeltKit) with its private AuthBoundry. It covers:
  - list, create with a reminder, update, complete and reopen, each only once granted;
  - deletion never available;
  - Grace never reaching Ada's tasks;
  - revocation;
  - a repeated call creating one task;
  - eve and Personal OS crashing after the commit (one task);
  - Personal OS dying before recording its answer (left indeterminate, never re-sent);
  - the briefing reflecting eve's changes;
  - the reminder firing through Personal OS's own job with eve stopped;
  - eve's operation, FeltKit's audit record and Personal OS's action linked by request and decision ids;
  - memory:
    - reads only with a grant, and never another person's;
    - a repeated proposal stored once, unconfirmed and attributed;
    - `memory.confirm` and `memory.add` refused;
    - Ada confirming and dropping proposals through Personal OS's own HTTP API;
    - one proposal across an eve and Personal OS crash;
    - revocation;
  - projects and documents:
    - project reads that expose no documents;
    - create and update, each only with its grant, and a repeated create stored once;
    - a duplicate project name left unresolved, not retried;
    - document reads without contents, and re-filing a document to a project;
    - no download link;
    - one project across an eve and Personal OS crash;
    - revocation;
  - research, against a stand-in web search provider owned by the test, which counts every search:
    - no start without a grant or a budget;
    - a run stopping at exactly its budget;
    - retry within budget, and a completed run never run again;
    - its citations;
    - a cancel mid-search with nothing searched afterwards, even after a restart;
    - one run across an eve and Personal OS crash;
    - revocation.
- **Always, `test/reconcile-decide.test.mjs`.** Every row of Stack-Agent's decision table.
- waiting work stays waiting;
- reconciliation run twice changes nothing;
- a replayed key after restarts runs nothing;
- a missing eve session is never reported as completed.

The scripted agent replaces `agent/lib/faults.ts` (a no-op in the real agent) to crash or fail at named points, and adds an approval-gated tool.

**With `APPPORT_AGENT_E2E_ANTHROPIC_API_KEY`**, the built agent on `eve start` with a real model:

- an unauthenticated request gets 401;
- Alice's answer comes through her delegation;
- the same session continues after a kill and restart;
- Bob is rejected;
- Alice's request to reserve 2 units of BETA-2 becomes one `catalog.reserve` operation under her delegation, and stock drops by exactly 2.
