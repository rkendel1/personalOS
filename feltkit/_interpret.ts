/**
 * The deterministic interpreter: a user's sentence → one intent with its slots, and what is
 * missing. Pure and synchronous. This is the assistant's first (and usually only) reader; a
 * model is consulted only for sentences this returns as "unknown" (feltkit/assistant.ts).
 */
import { parseWhen, stripSpans, type Day } from "./_dates.js";

export type MemoryKind = "preference" | "person" | "project" | "decision" | "date" | "instruction" | "fact";
export type TaskRef = { that: true } | { query: string };

export type Intent =
  | { kind: "greet" }
  | { kind: "thanks" }
  | { kind: "help" }
  | { kind: "remember"; content: string; memoryKind: MemoryKind; subject: string; status: "confirmed" | "inferred"; date?: Day }
  | { kind: "forget"; query: string }
  | { kind: "recall"; query: string }
  | { kind: "task.create"; title: string; due?: Day; time?: string; recurrence?: "daily" | "weekdays" | "weekly" | "monthly"; priority: "low" | "normal" | "high"; reminder: boolean }
  | { kind: "task.complete"; ref: TaskRef }
  | { kind: "task.reschedule"; ref: TaskRef; due?: Day; time?: string }
  | { kind: "task.delete"; ref: TaskRef }
  | { kind: "task.list"; range: "today" | "week" | "all" | "overdue" }
  | { kind: "briefing" }
  | { kind: "forgetting" }
  | { kind: "plan.week" }
  | { kind: "project.create"; name: string; description?: string }
  | { kind: "project.status"; name: string }
  | { kind: "confirm"; yes: boolean }
  | { kind: "unknown" };

export interface Interpretation {
  intent: Intent;
  /** Facts the intent needs and the sentence did not give ("when", "title", "which task"). */
  missing: string[];
}

const clean = (s: string) => s.replace(/\s+/g, " ").replace(/^[\s,.:;!?-]+|[\s,.!?;:]+$/g, "").trim();
const sentence = (s: string) => {
  const c = clean(s);
  return c ? c[0]!.toUpperCase() + c.slice(1) : c;
};

/** Second person → first person, for storing what the user said about themselves ("my" stays "my"). */
function normalizeSelf(text: string): string {
  return text.replace(/\bi'm\b/gi, "I'm").replace(/\bi\b/g, "I");
}

const PRIORITY_HIGH = /\b(urgent|urgently|asap|important|high priority|critical|top priority)\b/i;
const PRIORITY_LOW = /\b(low priority|someday|whenever|no rush|eventually)\b/i;

const RELATIONS =
  "wife|husband|partner|girlfriend|boyfriend|son|daughter|kid|mom|mother|dad|father|brother|sister|boss|manager|cofounder|co-founder|colleague|coworker|friend|assistant|doctor|dentist|lawyer|accountant|landlord|neighbor|client|investor|mentor";

export function classifyMemory(content: string, today: Day): { memoryKind: MemoryKind; subject: string; date?: Day } {
  const text = content.trim();
  const lower = text.toLowerCase();
  let m: RegExpExecArray | null;

  if ((m = new RegExp(`^([A-Z][\\w'-]+(?: [A-Z][\\w'-]+)?) is my (${RELATIONS})\\b`).exec(text)))
    return { memoryKind: "person", subject: m[1]!.toLowerCase() };
  if ((m = new RegExp(`\\bmy (${RELATIONS})(?:'s name)? is ([A-Z][\\w'-]+(?: [A-Z][\\w'-]+)?)`, "i").exec(text)))
    return { memoryKind: "person", subject: `${m[2]!.toLowerCase()} ${m[1]!.toLowerCase()}` };

  if (/\b(birthday|anniversary|deadline|due date|appointment|flight|wedding)\b/i.test(text)) {
    const when = parseWhen(text, today);
    const who = /([A-Z][\w'-]+)'s (birthday|anniversary|wedding)/.exec(text)?.[1];
    const thing = /\b(birthday|anniversary|deadline|due date|appointment|flight|wedding)\b/i.exec(text)![1]!.toLowerCase();
    return { memoryKind: "date", subject: who ? `${who.toLowerCase()} ${thing}` : thing, ...(when.due ? { date: when.due } : {}) };
  }
  if (/^(always|never|don't ever|do not ever|please always|please never)\b|\bwhen you\b|\bfrom now on\b/i.test(text))
    return { memoryKind: "instruction", subject: keywords(text).slice(0, 4).join(" ") };
  if (/\b(we|i) (decided|agreed|chose|picked)\b|\bdecision\b/i.test(text)) return { memoryKind: "decision", subject: keywords(text).slice(0, 4).join(" ") };
  if (/\bi (prefer|like|love|hate|dislike|don't like|do not like|can't stand|enjoy)\b|\bmy fav(ou)?rite\b|\bi'm (allergic|vegetarian|vegan)\b|\bi am (allergic|vegetarian|vegan)\b/i.test(text))
    return { memoryKind: "preference", subject: keywords(text.replace(/\b(i|prefer|like|love|hate|dislike|don't|enjoy|favorite|favourite|my)\b/gi, "")).slice(0, 3).join(" ") };
  if (/\b(i'm|i am|we're|we are) (working on|building|launching|running|leading)\b|\bproject\b/i.test(lower))
    return { memoryKind: "project", subject: keywords(text.replace(/\b(working|building|launching|running|leading|on|project)\b/gi, "")).slice(0, 4).join(" ") };
  return { memoryKind: "fact", subject: keywords(text).slice(0, 4).join(" ") };
}

const STOP = new Set(
  "a an the and or but of to in on at for with about from by is are was were be been am i me my mine you your it its this that these those what whats what's who whom whose when where why how do does did can could would should will shall may might know tell remember please any anything something there their they them we us our again just also really very much more most some all have has had not no yes".split(" "),
);
/** Significant lower-case words, singularized, for matching. */
export function keywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/'s\b/g, "")
    .split(/[^a-z0-9-]+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
}

/** Overlap score of a query against a candidate text (0 = no shared keyword). */
export function relevance(query: string, candidate: string): number {
  const q = new Set(keywords(query));
  if (!q.size) return 0;
  const c = keywords(candidate);
  let score = 0;
  for (const word of new Set(c)) if (q.has(word)) score += 1;
  // Prefix matches catch "meet"/"meeting", "plan"/"planning".
  for (const qw of q) if (qw.length >= 4 && c.some((w) => w !== qw && (w.startsWith(qw) || qw.startsWith(w)) && w.length >= 4)) score += 0.5;
  return score / q.size;
}

function taskRef(raw: string): TaskRef {
  const r = clean(raw.replace(/^(the|my)\s+/i, "").replace(/\s+(task|todo|to-do|reminder|one)$/i, ""));
  if (!r || /^(that|it|this|that one|the last one|the task|that task|this task|that reminder)$/i.test(r)) return { that: true };
  return { query: r };
}

export function interpret(input: string, today: Day): Interpretation {
  const text = input.trim().replace(/\s+/g, " ");
  const lower = text.toLowerCase().replace(/[.!]+$/, "");
  const ok = (intent: Intent, missing: string[] = []): Interpretation => ({ intent, missing });
  let m: RegExpExecArray | null;

  if (!text) return ok({ kind: "unknown" });

  // Short social turns.
  if (/^(yes|yep|yeah|yup|correct|right|confirm|sure|ok|okay|keep it|yes,? (remember|keep|save) (that|it)|that's right|exactly)$/i.test(lower)) return ok({ kind: "confirm", yes: true });
  if (/^(no|nope|nah|don't|do not|wrong|that's wrong|no,? (don't|do not) (remember|keep|save) (that|it)|forget it)$/i.test(lower)) return ok({ kind: "confirm", yes: false });
  if (/^(thanks|thank you|thx|ty|cheers|appreciate it|great,? thanks|perfect,? thanks)\b/i.test(lower) && lower.split(" ").length <= 5) return ok({ kind: "thanks" });
  if (/^(help|what can you do|how does this work|what do you do|\?)\??$/i.test(lower)) return ok({ kind: "help" });

  // Briefing, focus, forgetting, planning.
  if (/what am i (forgetting|missing|overlooking)|did i forget (anything|something)|anything i('m| am) forgetting/i.test(lower)) return ok({ kind: "forgetting" });
  if (/\b(plan|planning|organi[sz]e) (out )?(my|the|this|next) week\b|\bweek(ly)? plan\b|\bhelp me plan\b/i.test(lower)) return ok({ kind: "plan.week" });
  if (/\b(daily )?brief(ing)?( me)?\b|what should i (focus on|do|work on)|what needs (my )?attention|what's (on )?(my )?(plate|agenda)|what does (my |today )?(day|today) look like|how does (my |today )?(day|today) look|what's (happening )?today|^(good morning|morning|gm)$/i.test(lower))
    return ok({ kind: "briefing" });

  // Lists.
  if (/\b(what'?s|what is|anything) overdue\b|\boverdue (tasks|items)?\b|\bwhat did i miss\b/i.test(lower)) return ok({ kind: "task.list", range: "overdue" });
  if (/^(show|list|what are|what's|whats|give me|see) (me )?(all )?(my )?(open )?(tasks|todos|to-dos|reminders|list)\b|^(my )?(tasks|todos|to-do list|todo list)\??$|what('s| is) on my (list|to-?do list)/i.test(lower))
    return ok({ kind: "task.list", range: /\btoday\b/.test(lower) ? "today" : /\bweek\b/.test(lower) ? "week" : "all" });
  if (/what('s| is) (due|left|scheduled)|what do i have( to do)?|what('s| is) (coming up|next)/i.test(lower))
    return ok({ kind: "task.list", range: /\btoday\b/.test(lower) ? "today" : /\b(week|coming up|next)\b/.test(lower) ? "week" : "all" });

  // Projects.
  if ((m = /^(?:start|create|add|new|begin|track)(?: a)?(?: new)? project(?: called| named)?\s+["“]?([^"”:]+?)["”]?(?:[:—-]\s*(.+))?$/i.exec(text)))
    return ok({ kind: "project.create", name: sentence(m[1]!), ...(m[2] ? { description: sentence(m[2]) } : {}) });
  if ((m = /^(?:what(?:'s| is) the )?status (?:of|on|for) (?:the )?(.+?)(?: project)?\??$/i.exec(text)) || (m = /^how(?:'s| is) (?:the )?(.+?) (?:project )?going\??$/i.exec(text)) || (m = /^what(?:'s| is) (?:happening|going on|new) with (?:the )?(.+?)(?: project)?\??$/i.exec(text)))
    return ok({ kind: "project.status", name: clean(m[1]!) });

  // Memory: explicit.
  if ((m = /^(?:please )?(?:forget|delete the memory|remove the memory|stop remembering)(?: that| about| the fact that)?\s+(.+)$/i.exec(text)) && !/^forget to\b/i.test(m[1]!))
    return ok({ kind: "forget", query: clean(m[1]!) });
  if ((m = /^(?:please )?(?:remember|note|keep in mind|make a note|fyi|for the record|save this)(?: that|:|,)?\s+(?!to\b)(.+)$/i.exec(text))) {
    const content = sentence(normalizeSelf(m[1]!));
    return ok({ kind: "remember", content, status: "confirmed", ...classifyMemory(content, today) });
  }

  // Recall.
  if ((m = /^(?:what do you (?:know|remember) about|what did i (?:tell you|say) about|tell me about|do you remember|remind me what|what(?:'s| is) my|what are my|who(?:'s| is)|when(?:'s| is)|where(?:'s| is))\s+(.+?)\??$/i.exec(text))) {
    const q = clean(m[1]!);
    // "who is on my list" etc. are not recall; "what's my plan" falls through to recall, which is fine.
    return ok({ kind: "recall", query: /^(my )?(preferences|memories|everything)$/i.test(q) ? "" : q });
  }
  if (/^what do you (know|remember)( about me)?\??$/i.test(lower)) return ok({ kind: "recall", query: "" });

  // Tasks: complete, reschedule, delete.
  if ((m = /^(?:mark|check off|tick off|complete|finish|close)\s+(.+?)(?:\s+as)?(?:\s+(?:done|complete|completed|finished))?$/i.exec(text)) || (m = /^(.+?)\s+(?:is|are)\s+(?:done|finished|complete|completed)$/i.exec(text)) || (m = /^i(?:'ve| have)?\s+(?:finished|completed|done|did)\s+(.+)$/i.exec(text)) || (m = /^done with\s+(.+)$/i.exec(text)))
    return ok({ kind: "task.complete", ref: taskRef(m[1]!) });
  if (/^(done|did it|finished|completed)$/i.test(lower)) return ok({ kind: "task.complete", ref: { that: true } });
  if ((m = /^(?:move|push|reschedule|postpone|delay|bump|shift|change)\s+(.+?)\s+(?:to|until|till|for|back to|out to)\s+(.+)$/i.exec(text))) {
    const when = parseWhen(m[2]!, today);
    return ok({ kind: "task.reschedule", ref: taskRef(m[1]!), ...(when.due ? { due: when.due } : {}), ...(when.time ? { time: when.time } : {}) }, when.due || when.time ? [] : ["when"]);
  }
  if ((m = /^(?:delete|remove|drop|cancel|get rid of)\s+(?:the\s+)?(?:task|todo|reminder)?\s*(.+)$/i.exec(text)))
    return ok({ kind: "task.delete", ref: taskRef(m[1]!) });

  // Tasks and reminders: create.
  const reminder = /\bremind me\b|\bdon't let me forget\b|\bping me\b|\bnudge me\b/i.test(text);
  const create =
    /^(?:please )?(?:remind me|don't let me forget|ping me|nudge me)\b/i.exec(text) ||
    /^(?:please )?(?:add|create|make|put|new)(?: a| an)?(?: new)?(?: task| todo| to-do| reminder)?(?: to| for| called| :)?\s+/i.exec(text) ||
    /^(?:todo|to-do|task)\s*[:\-]\s*/i.exec(text) ||
    /^i (?:need|have|'ve got|must|should|gotta|got) to\s+/i.exec(text);
  if (create) {
    const when = parseWhen(text, today);
    let title = text.slice(create.index + create[0].length);
    if (reminder) title = title.replace(/^(?:me\s+)?(?:about|that i need to|that i have to|to)\s+/i, "").replace(/^(?:on|at|in)\b[^,]*?\bto\s+/i, "");
    title = stripSpans(title, when.spans)
      .replace(/\s*(?:to|on|in) my (?:list|to-?do list|tasks)$/i, "")
      .replace(PRIORITY_HIGH, "")
      .replace(PRIORITY_LOW, "")
      .replace(/^(?:to|that)\s+/i, "")
      .replace(/[,;]?\s*(?:it's|it is|this is|that's|which is)\s*$/i, "");
    title = sentence(title.replace(/\bmy\b/g, "my"));
    const priority = PRIORITY_HIGH.test(text) ? "high" : PRIORITY_LOW.test(text) ? "low" : "normal";
    const intent: Intent = {
      kind: "task.create",
      title,
      reminder,
      priority,
      ...(when.due ? { due: when.due } : when.time ? { due: today } : {}),
      ...(when.time ? { time: when.time } : {}),
      ...(when.recurrence ? { recurrence: when.recurrence } : {}),
    };
    const missing: string[] = [];
    if (!title) missing.push("title");
    if (reminder && !when.due && !when.time && !when.recurrence) missing.push("when");
    return ok(intent, missing);
  }

  // Things worth remembering that the user did not ask to be remembered: stored as *inferred*.
  if (/^(?:i (?:prefer|like|love|hate|dislike|don't like|can't stand|always|never)|my (?:favou?rite|wife|husband|partner|boss|manager|son|daughter|mom|dad|mother|father|brother|sister|birthday|anniversary)|i'm (?:allergic|vegetarian|vegan|working on|building)|i am (?:allergic|vegetarian|vegan|working on|building)|we (?:decided|agreed))\b/i.test(text)) {
    const content = sentence(normalizeSelf(text.replace(/[.!]+$/, "")));
    return ok({ kind: "remember", content, status: "inferred", ...classifyMemory(content, today) });
  }

  if (/^(hi|hello|hey|yo|hiya|howdy|sup|what's up|good (afternoon|evening))\b/i.test(lower)) return ok({ kind: "greet" });
  return ok({ kind: "unknown" });
}
