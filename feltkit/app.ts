/**
 * PersonalOS: a personal assistant whose durable state is the product.
 *
 * Everything the assistant knows or did lives in this app's FeltDB instance: conversations,
 * messages, memory, tasks, projects, and the action log (with evidence). The model is optional
 * and replaceable; it only ever *proposes* an interpretation (see feltkit/assistant.ts).
 *
 * Every record carries `owner` (the principal id). Handlers read and write only the caller's own
 * records (feltkit/_own.ts), so one deployment can serve several people without seeing each
 * other's data.
 */
import { feltkit, s } from "@feltdb/feltkit";

/** What a person who owns an assistant may do. */
const OWNER = [
  "assistant.*", "conversations.*", "tasks.*", "memory.*", "projects.*", "actions.*", "briefing.read", "settings.*",
  "notifications.read", "notifications.update",
  // Reminders are jobs queued as the owner, re-authorized each run (feltkit/reminders.ts).
  "jobs.create", "jobs.execute", "notifications.send",
  // The model proposes through FeltKit's agent; the owner approves in the app (FeltKit M1).
  "feltkit.agent.*",
  // Documents: files the owner keeps, stored by AppPort Services Files (feltkit/documents.ts).
  "documents.*", "files.read", "files.write", "files.delete",
  // Outbound events (task.completed, reminder.fired, interaction.updated) to endpoints the operator
  // registers; each delivery is authorized again as the emitter (webhooks.deliver, runtime-internal).
  "webhooks.emit", "webhooks.deliver",
  // Connected surfaces (feltkit/links.ts, interactions.ts): link and unlink them, see what they asked.
  "links.*", "interactions.read",
  // Identity links in Resolver are written only by the `identity` agent (feltkit/links.ts), after the
  // owner confirms or disconnects here; no person's session holds identity.resolve or identity.link.
  // A reminder job fires as whoever queued it: the owner, or a surface's bridge acting for the owner.
  "reminders.fire",
  // Research (feltkit/research.ts): start, follow, cancel and retry research; read its sources and
  // prospects; and use the web search integration, which research steps (jobs, as the owner) call.
  "research.*",
  // Invocations from outside PersonalOS (feltkit/invocations.ts): the iOS share extension submits with
  // the person's own session; its job processes it as them, under their AuthBoundry delegation.
  "invocations.*",
  // X (feltkit/xsurface.ts): publishing a result to X is the owner's explicit act, never automatic.
  "x.publish",
];

/**
 * A connected surface's bridge (Multiplayer today): an operator-issued session
 * (`feltkit session create --type service --id multiplayer --role bridge`). It may hand PersonalOS
 * interactions and read their outcome, and nothing else: it holds no owner's data permissions.
 * Inside interactions:receive it works for the PersonalOS account an *active link* names
 * (feltkit/_ops.ts actingFor). It can never approve: actions:approve is `approval: "required"`.
 */
const BRIDGE = ["interactions.receive", "identity.resolve", "jobs.create", "jobs.execute", "notifications.send", "webhooks.emit", "webhooks.deliver", "reminders.fire"];

/**
 * The X adapter (feltkit/xsurface.ts): an operator-issued service session
 * (`feltkit session create --type service --id x-adapter --role xadapter`), like Multiplayer's bridge.
 * It polls the bot account's mentions and posts the bot's replies (the `x` integration, whose token is
 * the BOT's authorization and proves nothing about who mentions it). Each mention's author is a
 * separate identity, resolved through a link the person confirmed (Resolver). It holds no owner's
 * data permissions; inside xsurface:receive it works for the account a link names (_ops.ts actingFor).
 */
const XADAPTER = ["x.read", "x.post", "x.receive", "x.poll", "identity.resolve", "jobs.create", "jobs.execute", "notifications.send", "webhooks.emit", "webhooks.deliver", "reminders.fire"];

export const app = feltkit({
  name: "personalos",
  description: "A personal assistant: conversations, memory, tasks, reminders and a daily briefing, with an auditable action log.",
  roles: {
    owner: OWNER,
    // Read-only access (used to prove refusals in tests; useful for a shared view later).
    viewer: ["conversations.read", "tasks.read", "memory.read", "projects.read", "actions.read", "briefing.read", "settings.read", "documents.read"],
    // Operators configure the model and services in Studio. Never granted to the assistant itself.
    bridge: BRIDGE,
    // The `identity` agent (feltkit/links.ts), and nobody else: it reads and writes identity links in
    // Resolver through the `identity` and `identitylinks` integrations. No session can be signed in as
    // it, so those integrations' capabilities, which FeltKit also serves on /appport, are refused to
    // every person and to the bridge (whose identity.resolve covers reads only).
    identitylinker: ["identity.resolve", "identity.link", "links.write"],
    // webhooks.*: registering endpoints (interaction.updated to a connected surface, Studio → Webhooks).
    xadapter: XADAPTER,
    admin: ["intelligence.*", "credential.*", "configuration.*", "jobs.*", "schedules.*", "webhooks.*", "feltkit.operations.*"],
  },
  auth: { accounts: { roles: ["owner"] } },
  dev: {
    users: [
      { id: "ada", name: "Ada Lovelace", roles: ["owner", "admin"] },
      { id: "grace", name: "Grace Hopper", roles: ["owner"] },
      { id: "guest", name: "Read-only guest", roles: ["viewer"] },
    ],
  },
  // AuthBoundry decides delegated work from connected surfaces (ctx.authority, feltkit/interactions.ts):
  // PersonalOS's executor `agent:personalos` acts on behalf of a person, under that person's
  // delegation to it, never under its own rules. Credentials are custody references
  // (`feltkit credential set credential-ref:authboundry-check`, or FELTKIT_CREDENTIAL_AUTHBOUNDRY_CHECK).
  authority: {
    url: { env: "AUTHBOUNDRY_URL" },
    application: { env: "AUTHBOUNDRY_APPLICATION", development: "personalos" },
    checkCredential: "credential-ref:authboundry-check",
    executor: { principal: "agent:personalos", type: "agent" },
  },
  // Production decides with whatever this Resolver reference points to; change the model there,
  // without a redeploy (docs/RESOLVER.md in @feltdb/feltkit). Development uses Studio → Models.
  // Development may name one too (PERSONALOS_MODEL_REF, with RESOLVER_URL / RESOLVER_API_KEY), to switch models live.
  agent: { model: { production: "ref://prod/personalos/model", ...(process.env.PERSONALOS_MODEL_REF ? { development: process.env.PERSONALOS_MODEL_REF as `ref://${string}` } : {}) } },
  services: {
    notifications: { types: ["reminder.due", "checkin.daily", "review.weekly"] },
    configuration: true,
    jobs: { handlers: { "reminder.fire": "reminders:fire", "checkin.fire": "checkins:fire", "review.fire": "weekly:fire", "research.step": "research:step", "invocation.process": "invocations:process", "x.poll": "xsurface:poll", "x.reply": "xsurface:deliver" } },
    // Recurring jobs an operator sets up in Studio. Per-person recurrence (reminders, check-ins) is a
    // job chain owned by the person, so it runs as them (feltkit/checkins.ts).
    schedules: true,
    // Documents the owner keeps (feltkit/documents.ts). 10 MB each.
    files: { maxBytes: 10 * 1024 * 1024 },
    // Signed outbound events to endpoints an operator registers (Studio → Webhooks).
    // interaction.updated: an interaction from a connected surface changed (approved, declined,
    // cancelled). It names the interaction only; the surface fetches the content with its bridge
    // session (interactions:status), which refuses once the person disconnected that surface.
    webhooks: { events: ["task.completed", "reminder.fired", "document.added", "interaction.updated"] },
    intelligence: true,
  },
});

/**
 * Resolver, for identity links (feltkit/_resolver.ts): its HTTP endpoint (`POST /appport`, one AppPort
 * request envelope per call). Two integrations, two keys, so that resolving can never write:
 *
 *   identity        a key with `read` on ref://identity/personalos/* only (credential resolver-resolve)
 *   identitylinks  a key with `write` on that prefix only (credential resolver-link); `put` can only
 *                   create (expectedRevision 0), never change a link; the `identity` agent only
 *                   (identity.link, held by no session)
 *
 * Each operation names exactly one Resolver capability in its input schema, so it cannot be used for
 * another. They are `consequential` because FeltKit observations must be GETs, and Resolver's
 * endpoint is POST-only; lookup and resolve change nothing.
 */
const resolverRequest = (capability: string, input: Record<string, ReturnType<typeof s.string> | ReturnType<typeof s.unknown> | ReturnType<typeof s.optional>>) => ({
  protocol: s.literal("appport/1"),
  type: s.literal("request"),
  requestId: s.string({ minLength: 1, maxLength: 100 }),
  capability: s.object({ name: s.literal(capability), version: s.literal(1) }),
  input: s.object(input as any),
});
const ResolverResponse = s.record(s.unknown());
const REF = s.string({ minLength: 1, maxLength: 500, pattern: "^ref://identity/personalos/" });

export const identityResolver = app.integration("identity", {
  description: "Resolver, read-only: find and resolve identity links.",
  baseUrl: { env: "RESOLVER_URL" },
  credential: "credential-ref:resolver-resolve",
  timeoutMs: 5000,
  operations: {
    lookup: { method: "POST", path: "/appport", input: resolverRequest("resolver.lookup", { key: s.string({ minLength: 1, maxLength: 300 }), value: s.string({ minLength: 1, maxLength: 300 }) }), output: ResolverResponse, effect: "consequential", access: "identity.resolve", description: "The active link references with exactly this lookup entry (indexed)." },
    resolve: { method: "POST", path: "/appport", input: resolverRequest("resolver.resolve", { ref: REF }), output: ResolverResponse, effect: "consequential", access: "identity.resolve", description: "One link reference's current value (404 when revoked)." },
  },
});

export const identityLinker = app.integration("identitylinks", {
  description: "Resolver, write-only: create and revoke identity links. Only the identity agent.",
  baseUrl: { env: "RESOLVER_URL" },
  credential: "credential-ref:resolver-link",
  timeoutMs: 5000,
  operations: {
    put: {
      method: "POST", path: "/appport",
      input: resolverRequest("resolver.put", { ref: REF, kind: s.literal("value"), schema: s.unknown(), binding: s.unknown(), expectedRevision: s.literal(0), ttlSeconds: s.literal(0), lookup: s.object({ key: s.string({ minLength: 1, maxLength: 300 }), value: s.string({ minLength: 1, maxLength: 300 }) }), reason: s.string({ maxLength: 500 }) } as any),
      output: ResolverResponse, effect: "consequential", access: "identity.link", description: "Create one identity link (never change one: expectedRevision is 0).",
    },
    revoke: { method: "POST", path: "/appport", input: resolverRequest("resolver.revoke", { ref: REF, expectedRevision: s.integer({ minimum: 1 }), reason: s.string({ maxLength: 500 }) } as any), output: ResolverResponse, effect: "consequential", access: "identity.link", description: "Revoke one identity link; it never resolves again." },
  },
});

/**
 * Web search, for research (feltkit/research.ts): the Brave Search API's web search
 * (`GET /res/v1/web/search?q=&count=`, key in `X-Subscription-Token`, results at `web.results[]`).
 * Which provider answers is configuration, not code: WEBSEARCH_URL (https://api.search.brave.com, or
 * any service that answers the same request) and the credential `websearch`. Until both are set the
 * capability is declared but not ready, and research says so instead of claiming it cannot search.
 */
export const websearch = app.integration("websearch", {
  description: "Web search (Brave Search API compatible): results with title, URL and description.",
  baseUrl: { env: "WEBSEARCH_URL" },
  credential: { ref: "credential-ref:websearch", header: "x-subscription-token", scheme: "" },
  timeoutMs: 15000,
  operations: {
    search: {
      method: "GET",
      path: "/res/v1/web/search",
      input: { q: s.string({ minLength: 1, maxLength: 400 }), count: s.integer({ minimum: 1, maximum: 20 }), extra_snippets: s.optional(s.boolean()) },
      output: s.record(s.unknown()),
      effect: "observation",
      access: "research.search",
      description: "Search the web; reading only.",
    },
  },
});

/**
 * Web search from OpenAI (the Responses API with its `web_search` tool), the other provider of the same
 * need (feltkit/_search.ts reads its answer as results). OPENAISEARCH_URL: https://api.openai.com, or any
 * service answering the same request (Vercel AI Gateway: https://ai-gateway.vercel.sh, with
 * OPENAISEARCH_MODEL=openai/gpt-4.1-mini); its key is the credential `openaisearch`
 * (FELTKIT_CREDENTIAL_OPENAISEARCH), its own custody entry, apart from the model's. Its input
 * admits only the web_search tool, so the key cannot be borrowed for anything but a search; like the
 * Brave operation it needs research.search. It stays a catalog capability (not `expose: false`) because
 * FeltKit's catalog leaves app-only operations out, and discovery needs its readiness before any call.
 */
export const openaisearch = app.integration("openaisearch", {
  description: "Web search through OpenAI's Responses API web_search tool: cited pages and the search's sources.",
  baseUrl: { env: "OPENAISEARCH_URL" },
  credential: "credential-ref:openaisearch",
  timeoutMs: 60000,
  operations: {
    search: {
      method: "POST",
      path: "/v1/responses",
      readOnly: true,
      input: {
        model: s.string({ minLength: 1, maxLength: 80 }),
        input: s.string({ minLength: 1, maxLength: 1000 }),
        tools: s.array(s.object({ type: s.enum(["web_search"] as const) }), { minItems: 1, maxItems: 1 }),
        tool_choice: s.enum(["required"] as const),
        include: s.array(s.enum(["web_search_call.action.sources"] as const)),
        max_output_tokens: s.integer({ minimum: 100, maximum: 4000 }),
      },
      output: s.record(s.unknown()),
      effect: "observation",
      access: "research.search",
      description: "Search the web; reading only.",
    },
  },
});

/**
 * X (feltkit/xsurface.ts): the bot account's mentions and its replies. The credential `x` is the BOT
 * account's OAuth 2.0 grant (authorization code with PKCE, as X documents it), which FeltKit keeps
 * current: renewed with the refresh token before it expires, rotated refresh tokens stored atomically,
 * revoked on disconnect (FeltKit docs/OAUTH-CREDENTIALS.md). PersonalOS never holds a token. It says
 * nothing about who mentions the bot: each author is linked separately (links.ts, Resolver).
 *
 * X's endpoints (docs.x.com, read 2026-11-13): authorize https://x.com/i/oauth2/authorize, token
 * https://api.x.com/2/oauth2/token, revoke https://api.x.com/2/oauth2/revoke. A bot is a confidential
 * client (HTTP Basic with the client secret). Scopes: tweet.read users.read (me, mentions), tweet.write
 * (replies), offline.access (a refresh token at all). Connect: `feltkit credential connect x`.
 */
const X_OAUTH = {
  tokenUrl: { env: "X_TOKEN_URL" },
  authorizeUrl: { env: "X_AUTHORIZE_URL" },
  revokeUrl: { env: "X_REVOKE_URL" },
  clientId: { env: "X_CLIENT_ID" },
  clientSecret: "credential-ref:x-client-secret",
  clientAuthentication: "basic",
  scopes: ["tweet.read", "users.read", "tweet.write", "offline.access"],
} as const;
const XPost = s.record(s.unknown());
export const x = app.integration("x", {
  description: "X API v2 for the PersonalOS bot account: who it is, its mentions, and its replies.",
  baseUrl: { env: "X_API_URL" },
  credential: { ref: "credential-ref:x", oauth2: { ...X_OAUTH, scopes: [...X_OAUTH.scopes] } },
  timeoutMs: 20000,
  expose: false,
  operations: {
    me: { method: "GET", path: "/2/users/me", input: {}, output: XPost, effect: "observation", access: "x.read", description: "The bot account (id, username)." },
    mentions: {
      method: "GET", path: "/2/users/{id}/mentions",
      input: {
        id: s.string({ pattern: "^[0-9]{1,19}$" }),
        since_id: s.optional(s.string({ pattern: "^[0-9]{1,19}$" })),
        pagination_token: s.optional(s.string({ maxLength: 200, pattern: "^[A-Za-z0-9_-]+$" })),
        max_results: s.integer({ minimum: 5, maximum: 100 }),
        expansions: s.string({ maxLength: 200 }),
        "tweet.fields": s.string({ maxLength: 300 }),
        "user.fields": s.string({ maxLength: 200 }),
      },
      output: XPost, effect: "observation", access: "x.read", description: "Posts that mention the bot account, newest first.",
    },
    reply: {
      method: "POST", path: "/2/tweets",
      input: { text: s.string({ minLength: 1, maxLength: 280 }), reply: s.object({ in_reply_to_tweet_id: s.string({ pattern: "^[0-9]{1,19}$" }) }) },
      output: XPost, effect: "consequential", access: "x.post", description: "Reply, as the bot account, to one post.",
    },
  },
});

const owner = s.string({ minLength: 1 });

/** A file the owner keeps. The bytes live in AppPort Services Files (`fileId`); this record says whose and what for. */
export const documents = app.collection(
  "documents",
  {
    owner,
    fileId: s.string(),
    name: s.string({ minLength: 1, maxLength: 200 }),
    contentType: s.optional(s.string({ maxLength: 120 })),
    size: s.number(),
    note: s.optional(s.string({ maxLength: 500 })),
    projectId: s.optional(s.string()),
    taskId: s.optional(s.string()),
    createdAt: s.number(),
  },
  { indexes: [{ fields: ["owner"] }, { fields: ["fileId"] }], search: ["name", "note"] },
);

export const conversations = app.collection(
  "conversations",
  { owner, title: s.string({ minLength: 1, maxLength: 120 }), createdAt: s.number(), updatedAt: s.number(), messageCount: s.number() },
  { indexes: [{ fields: ["owner"] }] },
);

/** Where an assistant reply came from: the deterministic interpreter, or a model proposal a person approved. */
const Interpretation = s.object({
  intent: s.string(),
  source: s.enum(["rules", "model"] as const),
  missing: s.optional(s.array(s.string())),
  agentTaskId: s.optional(s.string()),
});

export const messages = app.collection(
  "messages",
  {
    owner,
    conversationId: s.string(),
    seq: s.number(),
    role: s.enum(["user", "assistant"] as const),
    text: s.string({ maxLength: 8000 }),
    createdAt: s.number(),
    interpretation: s.optional(Interpretation),
    /** Actions this reply reports on (ids in `actions`). A reply claims nothing it cannot cite here. */
    actionIds: s.optional(s.array(s.string())),
    /** Suggested follow-ups the UI renders as buttons. */
    suggestions: s.optional(s.array(s.string())),
    /** Set when the user edited this message and the conversation was continued from the edit. */
    supersededBy: s.optional(s.string()),
    /** The client's id for a user message: a retried send is the same message (and the same turn). */
    clientId: s.optional(s.string({ maxLength: 100 })),
    /**
     * A model turn's reply: the FeltKit agent task that holds its evidence, the generation records,
     * and the proposals the model made (each waits for the owner's approval unless it only reads).
     */
    agent: s.optional(
      s.object({
        taskId: s.string(),
        replyTo: s.string(),
        model: s.string(),
        reference: s.optional(s.string()),
        generations: s.array(s.string()),
        proposals: s.array(s.object({ taskId: s.string(), actionId: s.string(), capability: s.string(), effect: s.string(), state: s.string(), input: s.record(s.unknown()) })),
        cancelled: s.optional(s.boolean()),
      }),
    ),
  },
  { indexes: [{ fields: ["conversationId", "seq"] }, { fields: ["owner", "clientId"] }], search: ["text"] },
);

export const MEMORY_KINDS = ["preference", "person", "project", "decision", "date", "instruction", "fact"] as const;

export const memories = app.collection(
  "memories",
  {
    owner,
    kind: s.enum(MEMORY_KINDS),
    /** What the memory is about ("John", "coffee", "Q3 launch"), lower-cased words for lookup. */
    subject: s.string({ maxLength: 200 }),
    content: s.string({ minLength: 1, maxLength: 2000 }),
    /** confirmed: the user said it or confirmed it. inferred: the assistant concluded it; never used as fact. */
    status: s.enum(["confirmed", "inferred"] as const),
    source: s.object({
      kind: s.enum(["conversation", "manual", "model"] as const),
      conversationId: s.optional(s.string()),
      messageId: s.optional(s.string()),
      quote: s.optional(s.string({ maxLength: 500 })),
    }),
    date: s.optional(s.string()), // YYYY-MM-DD, for kind "date"
    createdAt: s.number(),
    updatedAt: s.number(),
    confirmedAt: s.optional(s.number()),
  },
  { indexes: [{ fields: ["owner"] }], search: ["subject", "content"] },
);

export const RECURRENCE = ["none", "daily", "weekdays", "weekly", "monthly"] as const;

export const tasks = app.collection(
  "tasks",
  {
    owner,
    title: s.string({ minLength: 1, maxLength: 200 }),
    notes: s.optional(s.string({ maxLength: 4000 })),
    status: s.enum(["open", "done"] as const),
    priority: s.enum(["low", "normal", "high"] as const),
    due: s.optional(s.string()), // YYYY-MM-DD in the owner's local calendar
    /** A reminder: the instant it fires (epoch ms), the local time it was asked for, and when it fired. */
    remindAt: s.optional(s.number()),
    remindTime: s.optional(s.string()), // HH:MM
    /** The client's UTC offset (minutes, Date#getTimezoneOffset) when the reminder was set. */
    tzOffset: s.optional(s.number()),
    remindedAt: s.optional(s.number()),
    recurrence: s.enum(RECURRENCE),
    projectId: s.optional(s.string()),
    source: s.object({ kind: s.enum(["conversation", "manual", "model", "recurrence"] as const), conversationId: s.optional(s.string()), messageId: s.optional(s.string()) }),
    createdAt: s.number(),
    updatedAt: s.number(),
    completedAt: s.optional(s.number()),
  },
  { indexes: [{ fields: ["owner", "status"] }], search: ["title", "notes"] },
);

export const projects = app.collection(
  "projects",
  {
    owner,
    name: s.string({ minLength: 1, maxLength: 120 }),
    description: s.optional(s.string({ maxLength: 2000 })),
    status: s.enum(["active", "paused", "done"] as const),
    createdAt: s.number(),
    updatedAt: s.number(),
  },
  { indexes: [{ fields: ["owner"] }], search: ["name", "description"] },
);

/**
 * The action log: every state change the assistant made or proposed, with its outcome and the
 * record that proves it. Append-only in spirit: rows change state (proposed → succeeded/rejected),
 * never content.
 */
export const actions = app.collection(
  "actions",
  {
    owner,
    seq: s.number(),
    kind: s.string(), // "task.create", "memory.remember", …
    summary: s.string({ maxLength: 500 }),
    status: s.enum(["proposed", "succeeded", "failed", "rejected"] as const),
    /** "none": ran on the user's explicit request. "required": waits for the user (destructive, or model-chosen). */
    approval: s.enum(["none", "required"] as const),
    input: s.record(s.unknown()),
    evidence: s.optional(s.object({ collection: s.string(), id: s.string(), version: s.number(), verified: s.boolean() })),
    error: s.optional(s.object({ code: s.string(), message: s.string() })),
    via: s.enum(["chat", "ui", "model", "job"] as const),
    conversationId: s.optional(s.string()),
    messageId: s.optional(s.string()),
    createdAt: s.number(),
    decidedAt: s.optional(s.number()),
  },
  { indexes: [{ fields: ["owner", "seq"] }, { fields: ["owner", "status"] }] },
);

export const settings = app.collection(
  "settings",
  {
    owner,
    name: s.optional(s.string({ maxLength: 80 })),
    /** Converse with the environment's model when one is ready (default). Off: the deterministic assistant only. */
    modelAssist: s.boolean(),
    /** Daily check-in: local time (HH:MM), the client's UTC offset, the instant the next one is due, and its thread. */
    checkinTime: s.optional(s.string()),
    tzOffset: s.optional(s.number()),
    checkinAt: s.optional(s.number()),
    checkinConversationId: s.optional(s.string()),
    /** Weekly review: day of week (0 = Sunday), local time, the client's UTC offset, the next due instant, and its thread. */
    reviewDay: s.optional(s.number()),
    reviewTime: s.optional(s.string()),
    reviewTzOffset: s.optional(s.number()),
    reviewAt: s.optional(s.number()),
    reviewConversationId: s.optional(s.string()),
    updatedAt: s.number(),
  },
  { unique: [{ fields: ["owner"] }] },
);

/**
 * The owner's side of linking a surface identity (feltkit/links.ts): the pending one-time code (a
 * digest only) and, once verified, the Resolver reference that *is* the link. This is an index for
 * the owner's Settings screen, not an authority: resolution reads Resolver only (feltkit/_resolver.ts),
 * and revocation goes to Resolver first.
 */
export const identityLinks = app.collection(
  "identityLinks",
  {
    owner,
    /** The bridge principal of the surface (its adapter id), e.g. "multiplayer". */
    adapter: s.string({ minLength: 1, maxLength: 100 }),
    // pending: a code was issued. presented: the code was sent from a surface account, which waits
    // for the owner to confirm it here (links:confirm). confirming / revoking: the owner decided and
    // the identity agent is recording it in Resolver. active: recorded in Resolver. revoked: done.
    status: s.enum(["pending", "presented", "confirming", "active", "revoking", "revoked"] as const),
    /** Why the identity agent could not record the owner's decision (shown to the owner). */
    error: s.optional(s.string({ maxLength: 500 })),
    confirmedAt: s.optional(s.number()),
    codeDigest: s.optional(s.string()),
    codeExpiresAt: s.optional(s.number()),
    sourcePrincipalId: s.optional(s.string()),
    sourceDisplayName: s.optional(s.string({ maxLength: 120 })),
    sourceInstance: s.optional(s.string()),
    /** The link in Resolver (ref://identity/personalos/…): the authoritative record. */
    presentedAt: s.optional(s.number()),
    resolverRef: s.optional(s.string()),
    createdAt: s.number(),
    linkedAt: s.optional(s.number()),
    revokedAt: s.optional(s.number()),
    lastUsedAt: s.optional(s.number()),
  },
  { indexes: [{ fields: ["owner"] }, { fields: ["adapter", "sourcePrincipalId", "status"] }, { fields: ["codeDigest"] }] },
);

const InteractionUpdate = s.object({ seq: s.number(), state: s.string(), text: s.string({ maxLength: 8000 }), at: s.number(), actionId: s.optional(s.string()) });

/**
 * One request from a connected surface (personalos.interaction/1, feltkit/_interaction.ts): the
 * envelope as delivered (provenance), who it resolved to, what PersonalOS did, and the updates the
 * surface posts back. Exactly one per (adapter, idempotency key): a repeated delivery is answered
 * from here and never executed again. The conversation, actions and evidence it produced are the
 * ordinary PersonalOS records, so there is one history, not a copy per surface.
 */
/**
 * An invocation from outside PersonalOS (`personalos.invocation/1`, feltkit/_invocation.ts): what the
 * person asked and shared, from which surface, and what became of it. The owner is the session that
 * submitted it, never a field of the envelope. One per (owner, invocationId).
 */
export const invocations = app.collection(
  "invocations",
  {
    owner,
    invocationId: s.string({ maxLength: 100 }),
    contract: s.string(),
    surface: s.object({ adapter: s.string(), device: s.optional(s.string()), version: s.optional(s.string()) }),
    /** What the person explicitly asked, in their words. */
    instruction: s.string({ maxLength: 2000 }),
    /** What they supplied as context: untrusted data, kept as they sent it (normalized). */
    context: s.array(s.object({
      kind: s.enum(["url", "text", "selection", "document", "page"] as const),
      url: s.optional(s.string({ maxLength: 2000 })), title: s.optional(s.string({ maxLength: 300 })),
      text: s.optional(s.string({ maxLength: 100_000 })), name: s.optional(s.string({ maxLength: 200 })),
      mediaType: s.optional(s.string({ maxLength: 100 })), size: s.optional(s.number()),
    })),
    sourceUrl: s.optional(s.string({ maxLength: 2000 })),
    /** The device's clock at submission, and the server's at receipt. */
    submittedAt: s.number(),
    receivedAt: s.number(),
    timeZone: s.optional(s.string()),
    digest: s.string(),
    conversationId: s.string(),
    /** "personalos", or "page": the page the person came from (returnUrl), offered as the way back. */
    returnTo: s.string(),
    returnUrl: s.optional(s.string({ maxLength: 2000 })),
    state: s.enum(["accepted", "processing", "needs_approval", "completed", "failed"] as const),
    /** What PersonalOS inferred the request to be, and how: never confused with what was asked. */
    interpretation: s.optional(s.object({
      intent: s.enum(["research", "assistant", "save", "answer"] as const),
      basis: s.enum(["rules", "model"] as const),
      detail: s.string({ maxLength: 500 }),
      generation: s.optional(s.object({ generationId: s.string(), memoryId: s.string(), model: s.string() })),
      /** For an answer: the generation that wrote it (from the shared material only, with no tools). */
      answeredBy: s.optional(s.object({ generationId: s.string(), memoryId: s.string(), model: s.string() })),
    })),
    /** AuthBoundry's decision on the capability the work needs, made when the work runs. */
    authority: s.optional(s.object({
      capability: s.string(), outcome: s.string(), principal: s.optional(s.string()), onBehalfOf: s.optional(s.string()),
      delegationId: s.optional(s.string()), decisionId: s.optional(s.string()), reason: s.optional(s.string({ maxLength: 500 })), at: s.number(),
    })),
    /** Where the work lives: the research run, the assistant's reply, the action awaiting approval. */
    // waitingFor "owner": work only the person's own session can run (research, answers from a model,
    // asked from X): it waits until they run it in PersonalOS (invocations:run).
    work: s.optional(s.object({ researchRunId: s.optional(s.string()), replyId: s.optional(s.string()), actionIds: s.optional(s.array(s.string())), waitingFor: s.optional(s.enum(["owner"] as const)) })),
    /** What the person sees: one line per state change. */
    updates: s.array(s.object({ seq: s.number(), state: s.string(), text: s.string({ maxLength: 2000 }), at: s.number() })),
    error: s.optional(s.object({ code: s.string(), message: s.string({ maxLength: 1000 }) })),
    /** Times processing found the authority unreachable (it gives up after a few). */
    attempts: s.optional(s.number()),
    createdAt: s.number(),
    updatedAt: s.number(),
  },
  { unique: [["owner", "invocationId"]], indexes: [{ fields: ["owner", "invocationId"] }, { fields: ["owner", "createdAt"] }] },
);

export const interactions = app.collection(
  "interactions",
  {
    /** The PersonalOS account it was done for; absent when the sender resolved to none (refused). */
    owner: s.optional(s.string()),
    adapter: s.string(),
    key: s.string(),
    envelope: s.record(s.unknown()),
    /**
     * Who asked. `sourcePrincipalId` is the adapter-authenticated source identity; `canonical` the
     * PersonalOS identity Resolver resolved it to (`resolverRef` at `resolverRevision`); `displayName`
     * is presentation only.
     */
    identity: s.object({
      sourcePrincipalId: s.string(),
      displayName: s.string(),
      resolution: s.enum(["linked", "link_presented", "link_completed", "unlinked"] as const),
      linkId: s.optional(s.string()),
      resolverRef: s.optional(s.string()),
      resolverRevision: s.optional(s.number()),
      canonical: s.optional(s.string()),
    }),
    /** AuthBoundry's decision on the capability this request needed (feltkit/_authority.ts): the evidence it was allowed. */
    /**
     * AuthBoundry's decision (feltkit/_authority.ts): the executor (`principal`, PersonalOS's agent),
     * the requester it acted for (`onBehalfOf`), the delegation that decided, and the decision id.
     */
    authority: s.optional(s.object({ capability: s.string(), outcome: s.string(), principal: s.string(), onBehalfOf: s.optional(s.string()), delegationId: s.optional(s.string()), decisionId: s.optional(s.string()), reason: s.optional(s.string()) })),
    audience: s.enum(["private", "shared"] as const),
    state: s.string(),
    intent: s.optional(s.string()),
    threadKey: s.string(),
    sourceSequence: s.optional(s.number()),
    conversationId: s.optional(s.string()),
    /**
     * Set when this interaction pointed its source thread at an existing PersonalOS conversation
     * ("continue <id>"): later messages in the thread continue that conversation. Never set on a refusal.
     */
    continuation: s.optional(s.object({ conversationId: s.string(), at: s.number() })),
    messageId: s.optional(s.string()),
    replyId: s.optional(s.string()),
    actionIds: s.array(s.string()),
    /** The proposal waiting for the owner, when the interaction needs approval. */
    approval: s.optional(s.object({ actionId: s.string(), summary: s.string(), reason: s.string() })),
    provenance: s.object({ messageIds: s.array(s.string()), attachmentIds: s.array(s.string()), privateDataUsed: s.boolean() }),
    updates: s.array(InteractionUpdate),
    error: s.optional(s.object({ code: s.string(), message: s.string() })),
    createdAt: s.number(),
    updatedAt: s.number(),
  },
  { unique: [["key"]], indexes: [{ fields: ["owner"] }, { fields: ["threadKey"] }, { fields: ["owner", "messageId"] }] },
);

/**
 * A research run: one outcome the person asked for ("find me new customers for FeltKit"), how
 * PersonalOS pursues it, and where it stands. What the platform could do for it (discovery) is
 * recorded when it starts, so "I couldn't" is always backed by what was looked for.
 */
export const researchRuns = app.collection(
  "researchRuns",
  {
    owner,
    /** What is being looked for: customers for the subject, its competitors, or organizations matching the objective. */
    kind: s.enum(["prospects", "competitors", "organizations"] as const),
    request: s.string({ maxLength: 4000 }),
    product: s.string({ maxLength: 120 }),
    objective: s.string({ maxLength: 1000 }),
    status: s.enum(["running", "blocked", "completed", "partial", "failed", "cancelled"] as const),
    /** What the platform offers for each need, as discovered (feltkit/_capabilities.ts). */
    discovery: s.record(s.unknown()),
    /** The profile the search works from: the person's own statements about the product. */
    profile: s.object({ statements: s.array(s.object({ id: s.string(), text: s.string() })), keywords: s.array(s.string()) }),
    queries: s.array(s.object({
      text: s.string(),
      state: s.enum(["pending", "done", "failed"] as const),
      attempts: s.number(),
      results: s.optional(s.number()),
      error: s.optional(s.string({ maxLength: 500 })),
      at: s.optional(s.number()),
      /** Planned at the start, or added after reading the first results. */
      origin: s.optional(s.enum(["plan", "refinement"] as const)),
      provider: s.optional(s.string()),
      ms: s.optional(s.number()),
    })),
    /** Which step runs next. Absent on runs from before steps (they run search, then prospects). */
    phase: s.optional(s.enum(["planning", "searching", "selecting", "reading", "assessing", "finishing", "done"] as const)),
    /** How the plan was made: rules, or a model proposal (its generation) that the rules accepted. */
    plan: s.optional(s.object({
      basis: s.enum(["rules", "model"] as const),
      criteria: s.array(s.string({ maxLength: 300 })),
      generation: s.optional(s.object({ generationId: s.string(), memoryId: s.string(), model: s.string() })),
      rejected: s.optional(s.array(s.string({ maxLength: 300 }))),
      /** "this": assess the organization the person shared; "find": search for organizations. */
      scope: s.optional(s.enum(["this", "find"] as const)),
      /** What the subject is, as the plan understood it from the person's own words: what assessments compare against. */
      summary: s.optional(s.string({ maxLength: 600 })),
    })),
    /** The organizations chosen from the search results for a closer look, and what happened to each. */
    candidates: s.optional(s.array(s.object({
      domain: s.string(),
      name: s.string({ maxLength: 200 }),
      sourceIds: s.array(s.string()),
      why: s.string({ maxLength: 500 }),
      state: s.enum(["pending", "read", "assessed", "rejected", "failed"] as const),
      pageIds: s.optional(s.array(s.string())),
      verdict: s.optional(s.string({ maxLength: 500 })),
      attempts: s.optional(s.number()),
    }))),
    selection: s.optional(s.object({ basis: s.enum(["rules", "model"] as const), generation: s.optional(s.object({ generationId: s.string(), memoryId: s.string(), model: s.string() })), rejected: s.optional(s.array(s.string({ maxLength: 300 }))) })),
    /** The FeltKit agent task holding this run's model generations. */
    taskId: s.optional(s.string()),
    /** Started by an invocation from outside PersonalOS (feltkit/invocations.ts): each step re-checks its authority. */
    invocationId: s.optional(s.string()),
    /** What the person shared to start it: the page to look at (its own source is in researchSources). */
    seed: s.optional(s.object({ url: s.string({ maxLength: 2000 }), title: s.optional(s.string({ maxLength: 300 })), sourceId: s.optional(s.string()) })),
    /** Model calls that met a transient refusal (a rate limit) in the current step, and were tried again later. */
    modelRetries: s.optional(s.number()),
    /** What the run used: model generations and tokens, searches, pages, and time. */
    usage: s.optional(s.object({
      generations: s.number(), inputTokens: s.number(), outputTokens: s.number(), costUsd: s.optional(s.number()), modelMs: s.number(),
      searches: s.number(), searchFailures: s.number(), searchMs: s.number(),
      /** Tokens the search provider reports for its own model (OpenAI web search), apart from the research model's. */
      searchInputTokens: s.optional(s.number()), searchOutputTokens: s.optional(s.number()),
      pagesRequested: s.number(), pagesRead: s.number(), pageMs: s.number(),
      quotesOffered: s.number(), quotesVerified: s.number(),
    })),
    /** One line per step: when, which, how long, what came of it. The run's observable history. */
    steps: s.optional(s.array(s.object({ at: s.number(), phase: s.string(), ms: s.number(), outcome: s.string({ maxLength: 500 }) }))),
    /** Why it stopped short, in the person's terms, with what would unblock it. */
    blocker: s.optional(s.object({ need: s.string(), state: s.string(), detail: s.string({ maxLength: 1000 }), howToEnable: s.optional(s.string({ maxLength: 1000 })) })),
    cancelRequested: s.optional(s.boolean()),
    conversationId: s.optional(s.string()),
    prospectCount: s.optional(s.number()),
    createdAt: s.number(),
    updatedAt: s.number(),
    completedAt: s.optional(s.number()),
  },
  { indexes: [{ fields: ["owner", "createdAt"] }] },
);

/** What a source returned, verbatim, and when: the evidence. Never edited by an assessment. */
export const researchSources = app.collection(
  "researchSources",
  {
    owner,
    runId: s.string(),
    url: s.string({ maxLength: 1000 }),
    title: s.string({ maxLength: 300 }),
    text: s.string({ maxLength: 20000 }),
    query: s.string({ maxLength: 400 }),
    provider: s.string(),
    retrievedAt: s.number(),
    /** Where the provider ranked it among that search's results (0 first). */
    position: s.optional(s.number()),
    /** A search result, or a page read in full. Absent on older records: a search result. */
    kind: s.optional(s.enum(["search", "page", "shared"] as const)),
    /** What `text` is: the engine's snippet, a search model's summary (never quoted), the page's own text, or what the person shared. */
    textKind: s.optional(s.enum(["search-snippet", "provider-summary", "page-text", "user-shared"] as const)),
    /** For a page: what happened when it was read (feltkit/_pages.ts). */
    status: s.optional(s.enum(["read", "unavailable", "extraction-failed", "not-allowed"] as const)),
    httpStatus: s.optional(s.number()),
    detail: s.optional(s.string({ maxLength: 500 })),
  },
  { indexes: [{ fields: ["runId"] }, { fields: ["owner"] }] },
);

/** A prospect: facts (each citing a source) apart from the assessment (and how it was reached). */
export const prospects = app.collection(
  "prospects",
  {
    owner,
    runId: s.string(),
    rank: s.number(),
    company: s.string({ maxLength: 200 }),
    domain: s.string({ maxLength: 200 }),
    website: s.string({ maxLength: 300 }),
    /** quote: verbatim from a page that was read (checked); search-result: what a search returned about it. */
    facts: s.array(s.object({ sourceId: s.string(), url: s.string(), text: s.string({ maxLength: 4000 }), kind: s.optional(s.enum(["quote", "search-result", "shared"] as const)) })),
    assessment: s.object({
      basis: s.enum(["rules", "model"] as const),
      method: s.string({ maxLength: 500 }),
      /** For a model assessment: the generation that made it. */
      generation: s.optional(s.object({ generationId: s.string(), memoryId: s.string(), model: s.string() })),
      /** Quotes the model offered that were not found in the cited page, and were dropped. */
      rejectedQuotes: s.optional(s.number()),
      /** The model's reading of the evidence: does it offer a product like the subject (a competitor, not a buyer)? */
      offersSimilarProduct: s.optional(s.boolean()),
      fit: s.enum(["high", "medium", "low"] as const),
      score: s.number(),
      whyFeltKit: s.string({ maxLength: 1000 }),
      rationale: s.array(s.object({ text: s.string({ maxLength: 500 }), sourceIds: s.array(s.string()) })),
      confidence: s.enum(["high", "medium", "low"] as const),
    }),
    openQuestions: s.array(s.string({ maxLength: 300 })),
    nextAction: s.string({ maxLength: 500 }),
    researchedAt: s.number(),
  },
  { indexes: [{ fields: ["runId"] }, { fields: ["owner"] }] },
);


/**
 * The X adapter's delivery ledger (feltkit/xsurface.ts): one record per post that mentioned the bot,
 * whatever became of it, and the bot's public reply. Not a conversation store: what was asked lives
 * in the owner's invocation and conversation; this keeps X's own identifiers and delivery state.
 */
export const xPosts = app.collection(
  "xPosts",
  {
    postId: s.string({ maxLength: 20 }),
    /** The author as X's API reported it (author_id): the only identity used. */
    authorId: s.string({ maxLength: 20 }),
    /** Presentation only, never identity. */
    authorUsername: s.optional(s.string({ maxLength: 50 })),
    botUserId: s.string({ maxLength: 20 }),
    /** X's thread: the root post's id. */
    xConversationId: s.optional(s.string({ maxLength: 20 })),
    inReplyToPostId: s.optional(s.string({ maxLength: 20 })),
    text: s.string({ maxLength: 4000 }),
    /** The posts it replies to or quotes, as X reported them (untrusted data, the thread's context). */
    referenced: s.array(s.object({ type: s.string({ maxLength: 20 }), id: s.string({ maxLength: 20 }), authorId: s.optional(s.string({ maxLength: 20 })), text: s.optional(s.string({ maxLength: 4000 })) })),
    createdAt: s.optional(s.string({ maxLength: 40 })),
    receivedAt: s.number(),
    state: s.enum(["ignored", "refused", "linking", "invoked"] as const),
    refusal: s.optional(s.object({ code: s.string(), message: s.string({ maxLength: 500 }) })),
    owner: s.optional(s.string()),
    /** The Resolver link the author resolved through, when they did. */
    resolverRef: s.optional(s.string()),
    resolverRevision: s.optional(s.number()),
    invocationId: s.optional(s.string()),
    conversationId: s.optional(s.string()),
    /**
     * The bot's public replies to this post. An acknowledgement is generic by policy and never carries
     * a result; a publication is text the owner explicitly chose to publish (xsurface:publish).
     */
    replies: s.array(s.object({
      kind: s.enum(["acknowledgement", "publication"] as const),
      text: s.string({ maxLength: 280 }),
      status: s.enum(["pending", "sending", "sent", "failed", "unknown"] as const),
      attempts: s.number(),
      requestedBy: s.optional(s.string()),
      authority: s.optional(s.record(s.unknown())),
      replyPostId: s.optional(s.string({ maxLength: 20 })),
      error: s.optional(s.string({ maxLength: 500 })),
      /** When X last refused it for rate (429): it waits before the next try. */
      limitedAt: s.optional(s.number()),
      requestedAt: s.number(),
      at: s.optional(s.number()),
    })),
    updatedAt: s.number(),
  },
  { unique: [["postId"]], indexes: [{ fields: ["postId"] }, { fields: ["xConversationId", "authorId"] }, { fields: ["owner"] }, { fields: ["owner", "invocationId"] }] },
);

/** Where polling the bot's mentions stands: its account, and the newest mention seen. */
export const xState = app.collection(
  "xState",
  {
    key: s.string(), botUserId: s.optional(s.string()), botUsername: s.optional(s.string()), sinceId: s.optional(s.string()),
    polledAt: s.optional(s.number()), lastError: s.optional(s.string({ maxLength: 500 })), running: s.boolean(), intervalMs: s.number(),
    /** The current polling chain: a job from an older chain (startPolling again) stops itself. */
    chain: s.optional(s.string()),
    /** Which poll of the chain is due: a retried job of an earlier tick does nothing. */
    tick: s.optional(s.integer()),
    /** Polls in a row that ended with an error: the next waits longer (xsurface:nextDelay). */
    failures: s.optional(s.integer()),
    /** When the first poll set the starting point (mentions before it are not requests). */
    baselineAt: s.optional(s.number()),
    startedBy: s.optional(s.string()),
  },
  { unique: [["key"]], indexes: [{ fields: ["key"] }] },
);
