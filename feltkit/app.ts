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
  // The model may propose; the owner approves in Studio → Agent (docs/PLATFORM-GAPS.md, G2).
  "feltkit.agent.*",
];

export const app = feltkit({
  name: "personalos",
  description: "A personal assistant: conversations, memory, tasks, reminders and a daily briefing, with an auditable action log.",
  roles: {
    owner: OWNER,
    // Read-only access (used to prove refusals in tests; useful for a shared view later).
    viewer: ["conversations.read", "tasks.read", "memory.read", "projects.read", "actions.read", "briefing.read", "settings.read"],
    // Operators configure the model and services in Studio. Never granted to the assistant itself.
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
  agent: { model: { production: "ref://prod/personalos/model" } },
  services: {
    notifications: { types: ["reminder.due"] },
    configuration: true,
    jobs: { handlers: { "reminder.fire": "reminders:fire" } },
    intelligence: true,
  },
});

const owner = s.string({ minLength: 1 });

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
  },
  { indexes: [{ fields: ["conversationId", "seq"] }], search: ["text"] },
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
    /** Send messages the rules cannot interpret to the environment's model as a proposal. */
    modelAssist: s.boolean(),
    updatedAt: s.number(),
  },
  { unique: [{ fields: ["owner"] }] },
);
