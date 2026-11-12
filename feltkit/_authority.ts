/**
 * AuthBoundry decides whether a resolved PersonalOS account may perform the capability a surface
 * request needs, before anything runs (feltkit/interactions.ts). Resolver only said *who*; this says
 * *whether*. FeltKit's own AuthBoundry adapter governs its platform layer, not application calls, and
 * is not exported, so this speaks the same documented contract FeltKit and AuthBoundry's enforcement
 * SDK speak: POST /_authboundry/authorize/check, mode "enforce", with an application check credential.
 *
 * Fail closed: only an exact, attributable allow (this application, principal and capability echoed,
 * with a decision id) is an allow. A deny, an unknown principal, an unreachable or slow authority, or a
 * malformed answer is not. The decision id is kept on the interaction as evidence.
 *
 * Configuration (the names FeltKit already uses): FELTKIT_AUTHBOUNDRY_URL, FELTKIT_AUTHBOUNDRY_APPLICATION,
 * FELTKIT_AUTHBOUNDRY_CHECK_CREDENTIAL. A check credential may ask, never grant.
 */
export interface Decision {
  allowed: boolean;
  outcome: "allow" | "deny" | "unavailable" | "invalid";
  capability: string;
  principal: string;
  decisionId: string | null;
  reason: string | null;
}

/** The AuthBoundry principal of a PersonalOS account. */
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
    default: return "personalos.assistant.converse";
  }
}

/** Every capability a connected surface can ask for (the contract AuthBoundry is given). */
export const CAPABILITIES = [
  "personalos.assistant.converse", "personalos.conversation.read",
  "personalos.tasks.read", "personalos.tasks.create", "personalos.tasks.update", "personalos.tasks.delete", "personalos.reminders.create",
  "personalos.memory.read", "personalos.memory.write", "personalos.memory.delete", "personalos.projects.create",
] as const;

export async function decide(owner: string, capability: string, context: Record<string, string>): Promise<Decision> {
  const url = process.env.FELTKIT_AUTHBOUNDRY_URL;
  const application = process.env.FELTKIT_AUTHBOUNDRY_APPLICATION;
  const credential = process.env.FELTKIT_AUTHBOUNDRY_CHECK_CREDENTIAL;
  const principal = authorityPrincipal(owner);
  const base = { capability, principal };
  if (!url || !application || !credential) return { ...base, allowed: false, outcome: "unavailable", decisionId: null, reason: "No authority is configured (FELTKIT_AUTHBOUNDRY_URL, _APPLICATION, _CHECK_CREDENTIAL), so nothing a surface asks for is allowed." };
  const body = { application_id: application, principal_id: principal, capability, mode: "enforce", enforcement_point: "personalos.interactions", context };
  let status: number;
  let d: any;
  try {
    const response = await fetch(new URL("/_authboundry/authorize/check", url), {
      method: "POST", cache: "no-store", signal: AbortSignal.timeout(3000),
      headers: { accept: "application/json", "content-type": "application/json", "x-authboundry-check-credential": credential },
      body: JSON.stringify(body),
    });
    status = response.status;
    d = JSON.parse(await response.text());
  } catch (error) {
    return { ...base, allowed: false, outcome: "unavailable", decisionId: null, reason: `AuthBoundry is unreachable or answered malformed JSON: ${(error as Error).message}` };
  }
  const reason = typeof d?.reason === "string" ? d.reason : typeof d?.message === "string" ? d.message : null;
  const decisionId = typeof d?.decision_id === "string" ? d.decision_id : null;
  if (status === 400) return { ...base, allowed: false, outcome: "invalid", decisionId, reason: reason ?? "AuthBoundry rejected the request" };
  if ([401, 403, 404, 409].includes(status)) return { ...base, allowed: false, outcome: "deny", decisionId, reason: reason ?? `denied (${status})` };
  if (status !== 200 || !d || typeof d !== "object") return { ...base, allowed: false, outcome: "unavailable", decisionId, reason: `AuthBoundry could not decide (${status})` };
  if (d.decision === "deny") return { ...base, allowed: false, outcome: "deny", decisionId, reason: reason ?? "denied" };
  const exact = d.decision === "allow" && d.application_id === application && d.principal_id === principal && d.capability === capability && d.mode === "enforce" && decisionId;
  if (!exact) return { ...base, allowed: false, outcome: "unavailable", decisionId, reason: "AuthBoundry returned an unverifiable decision" };
  return { ...base, allowed: true, outcome: "allow", decisionId, reason };
}
