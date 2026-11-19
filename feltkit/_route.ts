/**
 * Whether a conversation request goes to the person's agent (feltkit/agentwork.ts) or stays with
 * Anywhere Aide's own assistant. Deterministic: rules decide, never a model. Simple requests stay here;
 * work that needs durable, multi-step execution goes to the agent. When unsure, it stays, and the
 * person can choose "Work on this".
 */
export interface Route {
  delegate: boolean;
  /** Why, in words for the person and the record. */
  reason: string;
}

/** The person asks for it explicitly: in the background, while away, or "work on this". */
const EXPLICIT =
  /\b(work on (this|it|that)|(do|keep working on|handle|take care of) (this|it|that) (for me |in the background |while i'?m (away|out|gone))|in the background|while i'?m (away|out|gone|offline|asleep)|when i'?m back|keep (working|going) on|delegate (this|it)|hand (this|it) (off|over))\b/i;

/** Things a person asks an agent to do: the start of one step of work. */
const STEP = /^(please\s+)?(organi[sz]e|plan|research|find|look into|compare|prepare|draft|review|go through|collect|gather|summari[sz]e|check|investigate|work out|figure out|sort out|put together|set up|follow up on|create|write up|update|reorgani[sz]e|clean up|triage)\b/i;

/** A question about what is, answered from records: stays here. */
const QUESTION = /^(what|what's|whats|when|where|who|which|how many|how much|is|are|do i|did i|have i|show me|list|tell me)\b/i;

/** The request split into its steps ("organize X, research Y and prepare Z"). */
export function stepsOf(text: string): string[] {
  return text
    .trim()
    .split(/\s*(?:[;.]\s+|,\s*(?:(?:and\s+)?then\s+|and\s+)?|\s+and then\s+|\s+then\s+|\s+and\s+(?=(?:please\s+)?(?:organi[sz]e|plan|research|find|look into|compare|prepare|draft|review|go through|collect|gather|summari[sz]e|check|investigate|work out|figure out|sort out|put together|set up|follow up on|create|write up|update|reorgani[sz]e|clean up|triage)\b))\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function routeOf(text: string): Route {
  const t = text.trim();
  if (EXPLICIT.test(t)) return { delegate: true, reason: "you asked for it to be worked on in the background" };
  if (QUESTION.test(t) && !/\b(and then|then)\b/i.test(t)) return { delegate: false, reason: "a question Anywhere Aide answers itself" };
  const steps = stepsOf(t).filter((step) => STEP.test(step));
  if (steps.length >= 2) return { delegate: true, reason: `it has ${steps.length} steps to carry out` };
  if (/^(please\s+)?research\b/i.test(t) && /\b(compare|recommend|prepare|plan|decide|shortlist|pick|choose|draft|write up)\b/i.test(t)) {
    return { delegate: true, reason: "research with several stages (finding, then deciding or preparing)" };
  }
  return { delegate: false, reason: "a single request Anywhere Aide handles itself" };
}
