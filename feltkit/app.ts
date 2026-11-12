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
  // Outbound events (task.completed, reminder.fired) to endpoints the operator registers.
  "webhooks.emit",
  // Connected surfaces (feltkit/links.ts, interactions.ts): link and unlink them, see what they asked.
  "links.*", "interactions.read",
  // A reminder job fires as whoever queued it: the owner, or a surface's bridge acting for the owner.
  "reminders.fire",
];

/**
 * A connected surface's bridge (Multiplayer today): an operator-issued session
 * (`feltkit session create --type service --id multiplayer --role bridge`). It may hand PersonalOS
 * interactions and read their outcome, and nothing else: it holds no owner's data permissions.
 * Inside interactions:receive it works for the PersonalOS account an *active link* names
 * (feltkit/_ops.ts actingFor). It can never approve: actions:approve is `approval: "required"`.
 */
const BRIDGE = ["interactions.receive", "jobs.create", "jobs.execute", "notifications.send", "webhooks.emit", "reminders.fire"];

export const app = feltkit({
  name: "personalos",
  description: "A personal assistant: conversations, memory, tasks, reminders and a daily briefing, with an auditable action log.",
  roles: {
    owner: OWNER,
    // Read-only access (used to prove refusals in tests; useful for a shared view later).
    viewer: ["conversations.read", "tasks.read", "memory.read", "projects.read", "actions.read", "briefing.read", "settings.read", "documents.read"],
    // Operators configure the model and services in Studio. Never granted to the assistant itself.
    bridge: BRIDGE,
    admin: ["intelligence.*", "credential.*", "configuration.*", "jobs.*", "schedules.*", "feltkit.operations.*"],
  },
  auth: { accounts: { roles: ["owner"] } },
  dev: {
    users: [
      { id: "ada", name: "Ada Lovelace", roles: ["owner", "admin"] },
      { id: "grace", name: "Grace Hopper", roles: ["owner"] },
      { id: "guest", name: "Read-only guest", roles: ["viewer"] },
    ],
  },
  // Production decides with whatever this Resolver reference points to; change the model there,
  // without a redeploy (docs/RESOLVER.md in @feltdb/feltkit). Development uses Studio → Models.
  // Development may name one too (PERSONALOS_MODEL_REF, with RESOLVER_URL / RESOLVER_API_KEY), to switch models live.
  agent: { model: { production: "ref://prod/personalos/model", ...(process.env.PERSONALOS_MODEL_REF ? { development: process.env.PERSONALOS_MODEL_REF as `ref://${string}` } : {}) } },
  services: {
    notifications: { types: ["reminder.due", "checkin.daily", "review.weekly"] },
    configuration: true,
    jobs: { handlers: { "reminder.fire": "reminders:fire", "checkin.fire": "checkins:fire", "review.fire": "weekly:fire" } },
    // Recurring jobs an operator sets up in Studio. Per-person recurrence (reminders, check-ins) is a
    // job chain owned by the person, so it runs as them (feltkit/checkins.ts).
    schedules: true,
    // Documents the owner keeps (feltkit/documents.ts). 10 MB each.
    files: { maxBytes: 10 * 1024 * 1024 },
    // Signed outbound events to endpoints an operator registers (Studio → Webhooks).
    webhooks: { events: ["task.completed", "reminder.fired", "document.added"] },
    intelligence: true,
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
    status: s.enum(["pending", "active", "revoked"] as const),
    codeDigest: s.optional(s.string()),
    codeExpiresAt: s.optional(s.number()),
    sourcePrincipalId: s.optional(s.string()),
    sourceDisplayName: s.optional(s.string({ maxLength: 120 })),
    sourceInstance: s.optional(s.string()),
    /** The link in Resolver (ref://identity/personalos/…): the authoritative record. */
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
      resolution: s.enum(["linked", "link_completed", "unlinked"] as const),
      linkId: s.optional(s.string()),
      resolverRef: s.optional(s.string()),
      resolverRevision: s.optional(s.number()),
      canonical: s.optional(s.string()),
    }),
    /** AuthBoundry's decision on the capability this request needed (feltkit/_authority.ts): the evidence it was allowed. */
    authority: s.optional(s.object({ capability: s.string(), outcome: s.string(), principal: s.string(), decisionId: s.optional(s.string()), reason: s.optional(s.string()) })),
    audience: s.enum(["private", "shared"] as const),
    state: s.string(),
    intent: s.optional(s.string()),
    threadKey: s.string(),
    sourceSequence: s.optional(s.number()),
    conversationId: s.optional(s.string()),
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
