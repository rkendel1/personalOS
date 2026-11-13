/**
 * What a request from a connected surface needs from AuthBoundry: the capability each understood
 * request requires. The decision itself is FeltKit's `ctx.authority.decide` (the same AuthBoundry
 * contract and implementation FeltKit's platform uses), asked as PersonalOS's executor
 * (`agent:personalos`, feltkit/app.ts `authority`) on behalf of the resolved account: AuthBoundry
 * answers from that person's delegation to PersonalOS alone (interactions.ts).
 */

/** The AuthBoundry principal of a PersonalOS account: the requester, the delegator. */
export const authorityPrincipal = (owner: string) => `user:${owner}`;

/**
 * The capability each understood request needs. Conversation reading is its own capability: it reads
 * only the surface's context, never the account's private data. Anything unknown needs `converse`.
 */
export function capabilityFor(intent: string, detail: { reminder?: boolean } = {}): string {
  switch (intent) {
    case "task.create": return detail.reminder ? "personalos.reminders.create" : "personalos.tasks.create";
    case "conversation.actionItems": return "personalos.tasks.create";
    case "task.complete": case "task.reschedule": return "personalos.tasks.update";
    case "task.delete": return "personalos.tasks.delete";
    case "task.list": case "briefing": case "forgetting": case "plan.week": case "project.status": return "personalos.tasks.read";
    case "remember": case "confirm": return "personalos.memory.write";
    case "forget": return "personalos.memory.delete";
    case "recall": return "personalos.memory.read";
    case "project.create": return "personalos.projects.create";
    case "conversation.summary": case "conversation.decisions": return "personalos.conversation.read";
    // Continuing one of your PersonalOS conversations from a surface, and reading its work there.
    case "conversation.continue": case "conversation.work": return "personalos.conversation.continue";
    default: return "personalos.assistant.converse";
  }
}

/** Every capability a connected surface can ask for (the contract AuthBoundry is given). */
export const CAPABILITIES = [
  "personalos.assistant.converse", "personalos.conversation.read",
  "personalos.tasks.read", "personalos.tasks.create", "personalos.tasks.update", "personalos.tasks.delete", "personalos.reminders.create",
  "personalos.memory.read", "personalos.memory.write", "personalos.memory.delete", "personalos.projects.create",
  // Research started from outside PersonalOS (feltkit/invocations.ts): checked when it starts and before every step.
  "personalos.research.run",
  // Continuing a PersonalOS conversation (and reading its work) from a surface (feltkit/interactions.ts).
  "personalos.conversation.continue",
  // Publishing something to X from PersonalOS (feltkit/xsurface.ts): the owner's explicit act, decided here too.
  "personalos.x.publish",
] as const;

/** What each capability lets PersonalOS do for a person, in their words (Settings → What PersonalOS may do for you). */
export const CAPABILITY_LABELS: Record<(typeof CAPABILITIES)[number], string> = {
  "personalos.assistant.converse": "Answer you when you mention it",
  "personalos.conversation.read": "Read the conversation it's mentioned in (summaries, decisions)",
  "personalos.tasks.read": "See your tasks, plans and projects",
  "personalos.tasks.create": "Add tasks",
  "personalos.tasks.update": "Complete and reschedule tasks",
  "personalos.tasks.delete": "Delete tasks",
  "personalos.reminders.create": "Set reminders",
  "personalos.memory.read": "Recall what you've told it",
  "personalos.memory.write": "Remember what you tell it",
  "personalos.memory.delete": "Forget things",
  "personalos.projects.create": "Start projects",
  "personalos.research.run": "Research for you",
  "personalos.conversation.continue": "Continue your PersonalOS conversations",
  "personalos.x.publish": "Publish on X for you, as the bot",
};
