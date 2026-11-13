/**
 * Summon PersonalOS with the page you're on: its address and title, the text you selected (if you
 * want), and what to do. It submits a `personalos.invocation/1` with the panel's session and shows
 * the receipt and, live, what becomes of it. The work runs in PersonalOS: you can close the page and
 * the panel; the result is in the conversation (and the inbox) when you come back.
 */
import { useEffect, useRef, useState } from "react";
import { useFeltKit, useQuery } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { buildEnvelope, previousFor, STATE_LABEL, type PageRead, type Tab } from "./summon";

export const LAST_SUMMON_KEY = "personalos:lastSummon";
const SUGGESTIONS = ["Research this company: could it be a customer for FeltKit?", "Remember this", "Remind me to read this tomorrow"];

export interface Receipt { invocationId: string; state: string; conversationId: string; message: string; returnTo: { kind: string; url?: string } }

/** The conversation open in the panel (#/chat/<id>): continuing it is the natural default. */
export function openConversation(): string | null {
  return /^#\/chat\/([A-Za-z0-9_-]+)/.exec(location.hash)?.[1] ?? null;
}

/** Submit an envelope; a "safe to retry" refusal is retried with the same id. */
export async function submitEnvelope(client: ReturnType<typeof useFeltKit>, envelope: object): Promise<Receipt> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (await client.mutation(api.invocations.submit, { envelope } as never)) as Receipt;
    } catch (e) {
      if ((e as { code?: string }).code !== "CONFLICT" || attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
}

export function SummonForm({ target, readPage, initialSelection, ask, onClose }: {
  target: Tab & { tabId?: number };
  readPage: () => Promise<PageRead>;
  initialSelection?: string;
  /** Opened by "Ask about it": the person types their question about the page. */
  ask?: boolean;
  onClose: () => void;
}) {
  const client = useFeltKit();
  const [page, setPage] = useState<PageRead | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [instruction, setInstruction] = useState("");
  const [includeSelection, setIncludeSelection] = useState(true);
  const [continueIt, setContinueIt] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  // One id for this summon: a retry after a failure is the same invocation, never a second one.
  const invocationId = useRef(`browser-${crypto.randomUUID()}`);
  const recent = useQuery(api.invocationstate.list, { limit: 50 });
  const conversations = useQuery(api.conversations.list, {}) as Array<{ id: string; title: string }> | undefined;
  // Continue: the conversation open in the panel (wherever it began: Multiplayer, iOS, here), else the
  // last one summoned from this page.
  const open = openConversation();
  const openTitle = open ? conversations?.find((c) => c.id === open)?.title ?? null : null;
  const fromPage = recent ? previousFor(recent as never, target.url) : null;
  const previous = open && openTitle ? { conversationId: open, at: 0, title: openTitle } : fromPage ? { ...fromPage, title: null as string | null } : null;

  useEffect(() => {
    readPage()
      .then((p) => setPage(initialSelection && !p.selection ? { ...p, selection: initialSelection } : p))
      .catch((e: Error) => {
        // The page couldn't be read (a Chrome page, a blocked site): summon with its address and title only.
        setReadError(e.message);
        setPage({ url: target.url, title: target.title ?? "", selection: initialSelection ?? "" });
      });
  }, [readPage, target.url, target.title, initialSelection]);

  const send = async () => {
    setError(null);
    const built = buildEnvelope({
      invocationId: invocationId.current, tab: target, page, instruction, includeSelection,
      conversationId: continueIt && previous ? previous.conversationId : null,
      now: Date.now(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, version: chrome.runtime.getManifest().version,
    });
    if ("error" in built) return setError(built.error);
    setSending(true);
    try {
      const answer = await submitEnvelope(client, built.envelope);
      setReceipt(answer);
      void chrome.storage.session.set({ [LAST_SUMMON_KEY]: { invocationId: answer!.invocationId, title: page?.title ?? target.title ?? target.url } });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  if (receipt) return <SummonStatus invocationId={receipt.invocationId} first={receipt} onClose={onClose} />;
  const selection = page?.selection ?? "";
  return (
    <div className="summon" data-testid="summon">
      <div className="small"><strong>Summon PersonalOS</strong> with <span title={target.url}>{page?.title || target.title || target.url}</span></div>
      {readError && <p className="muted small">{readError} Sending the address and title only.</p>}
      {selection && (
        <label className="small summon-selection">
          <input type="checkbox" checked={includeSelection} onChange={(e) => setIncludeSelection(e.target.checked)} />
          Include the text you selected ({selection.length.toLocaleString()} characters)
        </label>
      )}
      <textarea aria-label="What should PersonalOS do?" placeholder={ask ? "What do you want to know about it?" : "What should PersonalOS do? (optional)"} rows={3} value={instruction} autoFocus={ask} onChange={(e) => setInstruction(e.target.value)} />
      {!ask && (
        <div className="row wrap">
          {SUGGESTIONS.map((s) => <button key={s} className="ghost tiny" onClick={() => setInstruction(s)}>{s}</button>)}
        </div>
      )}
      {previous && (
        <label className="small">
          <input type="checkbox" checked={continueIt} onChange={(e) => setContinueIt(e.target.checked)} />
          {previous.title ? `Continue the open conversation: ${previous.title}` : `Continue the conversation from your last summon on this page (${new Date(previous.at).toLocaleString()})`}
        </label>
      )}
      <p className="muted small">PersonalOS works on it after you close this page. What the page says is treated as information, never as instructions; nothing is sent to anyone.</p>
      {error && <p className="error-text small" role="alert">{error}</p>}
      <div className="row">
        <button className="tiny" disabled={sending || !page || (ask && !instruction.trim())} onClick={() => void send()}>{sending ? "Sending…" : "Send"}</button>
        <button className="ghost tiny" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}

/** The receipt, then what becomes of it, live (the same durable invocation record every surface reads). */
export function SummonStatus({ invocationId, first, onClose }: { invocationId: string; first?: Receipt; onClose: () => void }) {
  const live = useQuery(api.invocationstate.get, { invocationId }) as { receipt: Receipt } | undefined;
  const r = live?.receipt ?? first;
  if (!r) return null;
  const back = r.returnTo?.url;
  return (
    <div className="summon" data-testid="summon-status" data-state={r.state}>
      <div className="small"><strong>{STATE_LABEL[r.state] ?? r.state}</strong></div>
      <p className="small summon-message">{r.message}</p>
      <div className="row wrap">
        <button className="tiny" onClick={() => { location.hash = `#/chat/${r.conversationId}`; }}>Open conversation</button>
        {back && <button className="ghost tiny" onClick={() => void returnTo(back)}>Back to the page</button>}
        <button className="ghost tiny" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

/** The page the summon came from: its tab if it is still open, else a new one. */
async function returnTo(url: string) {
  const [open] = await chrome.tabs.query({ url });
  if (open?.id) await chrome.tabs.update(open.id, { active: true });
  else await chrome.tabs.create({ url });
}
