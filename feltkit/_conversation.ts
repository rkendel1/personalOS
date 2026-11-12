/**
 * Reading a conversation PersonalOS was brought into (from an interaction's context), without a
 * model: summarize it, answer "what did we decide…", and pull out its action items. Pure. Every
 * answer cites the source messages it used (provenance), and says when its view is partial.
 *
 * It sees only what the envelope carries: messages the requester could already read in that
 * conversation. Nothing here reads the owner's private PersonalOS data, so its answers are safe to
 * post back into a shared conversation.
 */
import { relevance } from "./_interpret.js";
import type { EnvelopeT } from "./_interaction.js";

export type ConversationIntent =
  | { kind: "conversation.summary" }
  | { kind: "conversation.decisions"; topic: string }
  | { kind: "conversation.actionItems" };

type Msg = EnvelopeT["context"]["messages"][number];

const SUMMARY = /\b(summari[sz]e|summary|recap|tl;?dr|catch me up)\b/i;
const DECISIONS = /\bwhat (?:did|have|had) we (?:decide|agree|settle|land)(?:d)?(?: on)?\b|\bdecisions?\b/i;
const ACTION_ITEMS = /\b(action items?|next steps|to-?dos?)\b/i;
const CREATE = /\b(create|make|add|turn|capture|track)\b/i;

const DECISION = /\b(decided|decision|agreed|we(?:'ll| will) go with|we go with|going with|let's go with|final(?:ly)?:)\b/i;
const ACTION = /\b(i'll|i will|we need to|need to|needs to|can you|could you|todo|to do|action item|let's|please)\b/i;
const QUESTION = /\?\s*$/;
const DATE = /\b(by|before|on|until|due)\s+((?:mon|tue|wed|thu|fri|sat|sun)[a-z]*|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|\d{4}-\d{2}-\d{2}|tomorrow|next week|end of (?:day|week|month))/i;

/** A request about the conversation itself, or null (then it is a personal request). */
export function conversationIntent(text: string): ConversationIntent | null {
  const t = text.replace(/@[a-z0-9-]+/gi, " ");
  if (ACTION_ITEMS.test(t) && CREATE.test(t)) return { kind: "conversation.actionItems" };
  if (/\b(this|the) (thread|conversation|discussion|channel|chat)\b/i.test(t) && SUMMARY.test(t)) return { kind: "conversation.summary" };
  if (SUMMARY.test(t) && !/\bmy\b/i.test(t)) return { kind: "conversation.summary" };
  const d = DECISIONS.exec(t);
  if (d && /\bwe\b|\bdecisions?\b/i.test(t)) {
    const topic = /\b(?:about|on|for|regarding)\s+(?:the\s+)?(.+?)[?.!]*$/i.exec(t)?.[1]?.trim() ?? "";
    return { kind: "conversation.decisions", topic };
  }
  return null;
}

const clean = (text: string) => text.replace(/@[a-z0-9-]+/gi, "").replace(/\s+/g, " ").trim().replace(/[.!]+$/, "");

/** What people said, without agents' replies or the requests addressed to PersonalOS. */
function discussion(e: EnvelopeT): Msg[] {
  return e.context.messages.filter((m) => m.authorKind === "human" && m.id !== e.message.id && !/@personalos\b/i.test(m.text) && m.text.trim());
}

export interface Reading {
  text: string;
  /** Source message ids the answer used. */
  sources: string[];
  items?: Array<{ title: string; owner?: string; due?: string; sourceMessageId: string }>;
}

function partial(e: EnvelopeT): string {
  return e.context.limits.truncated ? ` I read the latest ${e.context.messages.length} messages; earlier ones were outside my view.` : "";
}

function where(e: EnvelopeT): string {
  const c = e.conversation;
  if (c.threadId) return "this thread";
  return c.kind === "public" || c.kind === "private" ? `#${c.name ?? "this channel"}` : "this conversation";
}

export function summarize(e: EnvelopeT): Reading {
  const msgs = discussion(e);
  if (!msgs.length) return { text: `There's nothing in ${where(e)} for me to summarize yet.`, sources: [] };
  const people = [...new Set(msgs.map((m) => m.authorName))];
  const decisions = msgs.filter((m) => DECISION.test(m.text));
  const questions = msgs.filter((m) => QUESTION.test(m.text.trim()) && !/\b(can|could) you\b/i.test(m.text));
  const actions = msgs.filter((m) => ACTION.test(m.text) && !DECISION.test(m.text) && !questions.includes(m));
  const lines = [`**${where(e).replace(/^t/, "T")}**: ${people.length} ${people.length === 1 ? "person" : "people"} (${people.join(", ")}), ${msgs.length} message${msgs.length === 1 ? "" : "s"}.${partial(e)}`];
  if (decisions.length) lines.push("", "**Decided**", ...decisions.map((m) => `• ${clean(m.text)} — ${m.authorName}`));
  if (actions.length) lines.push("", "**Action items**", ...actions.map((m) => `• ${clean(m.text)} — ${m.authorName}`));
  if (questions.length) lines.push("", "**Open questions**", ...questions.map((m) => `• ${clean(m.text)}? — ${m.authorName}`.replace(/\?\?/, "?")));
  if (!decisions.length && !actions.length && !questions.length) {
    lines.push("", "No decisions, action items or open questions stood out. The latest messages:", ...msgs.slice(-3).map((m) => `• ${m.authorName}: ${clean(m.text).slice(0, 160)}`));
  }
  const used = [...new Set([...decisions, ...actions, ...questions].map((m) => m.id))];
  return { text: lines.join("\n"), sources: used.length ? used : msgs.slice(-3).map((m) => m.id) };
}

export function decisions(e: EnvelopeT, topic: string): Reading {
  const found = discussion(e).filter((m) => DECISION.test(m.text));
  const relevant = topic ? found.filter((m) => relevance(topic, m.text) > 0) : found;
  if (!relevant.length) {
    const about = topic ? ` about ${topic}` : "";
    return { text: `I don't see a decision${about} in ${where(e)}.${partial(e)} Nobody wrote "decided", "agreed" or "going with"${about}.`, sources: [] };
  }
  const lines = [`What ${where(e)} decided${topic ? ` about **${topic}**` : ""}:`, ...relevant.map((m) => `• ${clean(m.text)} — ${m.authorName}, ${new Date(m.at).toISOString().slice(0, 10)}`)];
  if (partial(e)) lines.push(partial(e).trim());
  return { text: lines.join("\n"), sources: relevant.map((m) => m.id) };
}

/** Action items, each tied to the message it came from; owners only when the message names one. */
export function actionItems(e: EnvelopeT): Reading {
  const msgs = discussion(e);
  const items: NonNullable<Reading["items"]> = [];
  for (const m of msgs) {
    if (!ACTION.test(m.text) || DECISION.test(m.text) || (QUESTION.test(m.text.trim()) && !/\b(can|could) you\b/i.test(m.text))) continue;
    const title = clean(m.text).replace(/^(yes|great|ok|okay|sure)[,.!]?\s*/i, "").replace(/^(i'll|i will|we need to|need to|let's|please|todo:?)\s+/i, "");
    if (!title) continue;
    const owner = /\b(i'll|i will)\b/i.test(m.text) ? m.authorName : /^([A-Z][a-z]+),\s+(can|could) you/.exec(m.text)?.[1];
    const due = DATE.exec(m.text);
    items.push({ title: title.charAt(0).toUpperCase() + title.slice(1, 200), ...(owner ? { owner } : {}), ...(due ? { due: `${due[1]} ${due[2]}` } : {}), sourceMessageId: m.id });
  }
  return { text: "", sources: items.map((i) => i.sourceMessageId), items };
}

