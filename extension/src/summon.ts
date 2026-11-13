/**
 * Summoning PersonalOS from the browser: the page you're on (its address as Chrome reports it, its
 * title), the text you selected, and what you want done, as a `personalos.invocation/1` envelope
 * (docs/INVOCATION-CONTRACT.md). Pure: no chrome.*, so it is tested in Node (tests/browser-summon.test.ts).
 *
 * The envelope names no one: PersonalOS takes who is asking from the panel's session. The page's text
 * is context (data), never part of the instruction, and the page is where the result offers to return.
 */

export const LIMITS = { selectionChars: 20_000, titleChars: 300, urlChars: 2000, instructionChars: 2000 } as const;

export interface Tab { url: string; title?: string }
/** What content.js read in the page (an isolated world: page scripts can't change what it sees). */
export interface PageRead { url: string; title: string; selection: string }

export interface SummonInput {
  invocationId: string;
  tab: Tab;
  page?: PageRead | null;
  instruction: string;
  includeSelection: boolean;
  /** Continue this PersonalOS conversation (one of the person's own; the server checks). */
  conversationId?: string | null;
  now: number;
  timeZone: string;
  version: string;
}

export interface Envelope {
  contract: "personalos.invocation/1";
  invocationId: string;
  surface: { adapter: "browser"; device: string; version: string };
  instruction: string;
  context: Array<{ kind: "url" | "selection"; url: string; title?: string; text?: string }>;
  submittedAt: number;
  timeZone: string;
  returnTo: { kind: "page"; url: string };
  correlation?: { conversationId: string };
}

export type Built = { envelope: Envelope; notes: string[] } | { error: string };

/** The envelope for a summon, or why it can't be sent (the person fixes it; nothing is cut silently). */
export function buildEnvelope(input: SummonInput): Built {
  const address = input.tab.url;
  let url: URL;
  try { url = new URL(address); } catch { return { error: "This tab has no web address PersonalOS can use." }; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { error: "Open a web page first: PersonalOS can be summoned from http and https pages, not this one." };
  if (url.username || url.password) return { error: "This page's address has a user name or password in it; PersonalOS won't take it." };
  if (address.length > LIMITS.urlChars) return { error: `This page's address is longer than PersonalOS takes (${LIMITS.urlChars} characters).` };
  const instruction = input.instruction.trim();
  if (instruction.length > LIMITS.instructionChars) return { error: `Say it in ${LIMITS.instructionChars.toLocaleString("en-US")} characters or fewer.` };
  const notes: string[] = [];
  // The address is Chrome's (tab.url). What was read in the page counts only if it is the same document
  // (the tab may have moved on since the form opened): else only the address and title are sent.
  const page = input.page && sameDocument(input.page.url, address) ? input.page : null;
  if (input.page && !page) notes.push("The tab has moved to another page since; only this page's address and title are sent.");
  const title = (page?.title || input.tab.title || url.hostname).replace(/\s+/g, " ").trim().slice(0, LIMITS.titleChars);
  const context: Envelope["context"] = [{ kind: "url", url: url.toString(), title }];
  const selection = (page?.selection ?? "").trim();
  if (input.includeSelection && selection) {
    if (selection.length > LIMITS.selectionChars) {
      return { error: `Your selection is ${selection.length.toLocaleString("en-US")} characters; PersonalOS takes up to ${LIMITS.selectionChars.toLocaleString("en-US")}. Select less, or send without it.` };
    }
    context.push({ kind: "selection", url: url.toString(), text: selection });
  }
  return {
    envelope: {
      contract: "personalos.invocation/1",
      invocationId: input.invocationId,
      surface: { adapter: "browser", device: "Chrome", version: input.version },
      instruction,
      context,
      submittedAt: input.now,
      timeZone: input.timeZone,
      returnTo: { kind: "page", url: url.toString() },
      ...(input.conversationId ? { correlation: { conversationId: input.conversationId } } : {}),
    },
    notes,
  };
}

/** The same document: same address, apart from the fragment (#section). */
export function sameDocument(a: string, b: string): boolean {
  try {
    const x = new URL(a), y = new URL(b);
    x.hash = ""; y.hash = "";
    return x.toString() === y.toString();
  } catch {
    return false;
  }
}

/** The most recent conversation summoned from this page, to offer continuing it. */
export function previousFor(rows: Array<{ conversationId: string; returnTo?: { url?: string }; shared?: Array<{ url?: string | null }>; createdAt: number }>, url: string): { conversationId: string; at: number } | null {
  const hit = rows.filter((r) => r.returnTo?.url === url || r.shared?.some((s) => s.url === url)).sort((a, b) => b.createdAt - a.createdAt)[0];
  return hit ? { conversationId: hit.conversationId, at: hit.createdAt } : null;
}

export const STATE_LABEL: Record<string, string> = {
  accepted: "Accepted",
  processing: "Working on it",
  needs_approval: "Needs your approval",
  completed: "Done",
  failed: "Couldn't finish",
};
