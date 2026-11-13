import { useEffect, useRef, useState } from "react";
import { useFeltKit, useMutation, useSession } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { PENDING_KEY, type Pending } from "./config";
import { LAST_SUMMON_KEY, SummonForm, SummonStatus } from "./summonform";

interface PageInfo { title: string; url: string; selection: string; text: string }

/** The web page "this page" means: the active tab, or, when the panel itself is a tab, the last web page you were on. */
let lastWebTab: { id: number; url: string; title: string } | null = null;
async function currentPage(): Promise<{ id: number; url: string; title: string } | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id && /^https?:/.test(tab.url ?? "")) return (lastWebTab = { id: tab.id, url: tab.url!, title: tab.title ?? tab.url! });
  if (lastWebTab) {
    const still = await chrome.tabs.get(lastWebTab.id).catch(() => null);
    if (still?.url && /^https?:/.test(still.url)) return (lastWebTab = { id: lastWebTab.id, url: still.url, title: still.title ?? still.url });
  }
  // The panel opened as a tab before any page was active here: the window's most recently used web page.
  const web = (await chrome.tabs.query({ lastFocusedWindow: true })).filter((t) => t.id && /^https?:/.test(t.url ?? "")).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  return web ? (lastWebTab = { id: web.id!, url: web.url!, title: web.title ?? web.url! }) : null;
}

/** What the person is looking at, read only now, in that tab, because they asked (activeTab + scripting). */
async function readPage(): Promise<PageInfo> {
  const tab = await currentPage();
  if (!tab) throw new Error("Open a web page first. Chrome's own pages can't be read.");
  const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
  if (!result?.result) throw new Error("Couldn't read this page.");
  return result.result as PageInfo;
}

const compose = (text: string) => dispatchEvent(new CustomEvent("personalos:compose", { detail: { text: text.slice(0, 4000) } }));
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function PageBar({ url, onDisconnect }: { url: string; onDisconnect: () => void }) {
  const client = useFeltKit();
  const { session } = useSession();
  const signedIn = Boolean(session?.principal);
  const prepare = useMutation(api.documents.prepareUpload);
  const attach = useMutation(api.documents.attach);
  const [tab, setTab] = useState<{ title: string; url: string } | null>(null);
  const [note, setNote] = useState<{ tone: "info" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // Summon: the form for this page (optionally with a selection the right-click menu passed), or the last summon's status.
  const [summon, setSummon] = useState<{ url: string; title: string; selection?: string } | null>(null);
  const [lastSummon, setLastSummon] = useState<{ invocationId: string; title: string } | null>(null);
  useEffect(() => void chrome.storage.session.get(LAST_SUMMON_KEY).then((got) => setLastSummon((got[LAST_SUMMON_KEY] as { invocationId: string; title: string } | undefined) ?? null)), []);

  // The active tab, kept current so the bar says what "this page" is.
  useEffect(() => {
    const refresh = () => void currentPage().then((t) => setTab(t ? { title: t.title, url: t.url } : null));
    refresh();
    chrome.tabs.onActivated.addListener(refresh);
    chrome.tabs.onUpdated.addListener(refresh);
    return () => (chrome.tabs.onActivated.removeListener(refresh), chrome.tabs.onUpdated.removeListener(refresh));
  }, []);

  const run = async (work: () => Promise<string | void>) => {
    setBusy(true);
    setNote(null);
    try {
      const done = await work();
      if (done) setNote({ tone: "info", text: done });
    } catch (e) {
      setNote({ tone: "error", text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const askAbout = (kind: "summarize" | "ask") =>
    run(async () => {
      const p = await readPage();
      const body = p.selection || p.text;
      const lead = kind === "summarize" ? "Summarize this page for me, and tell me if anything in it needs action from me" : "I'm reading this page; I'll ask about it";
      compose(`${lead}.\n\nPage: ${p.title}\n${p.url}\n\n${p.selection ? "Selected text" : "Page text"}:\n${clip(body, 2800)}`);
    });

  /** Keep the page as a document: Files service, owner-checked, with its address as the note. */
  const save = (p: { title: string; url: string; text: string }) =>
    run(async () => {
      const name = `${p.title.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 100) || "page"}.md`;
      const content = `# ${p.title}\n\n${p.url}\n\n${p.text}`;
      const target = await prepare({ name, contentType: "text/markdown" });
      const stored = await client.uploadFile(target, new Blob([content], { type: "text/markdown" }), { name, contentType: "text/markdown" });
      await attach({ fileId: stored.id, note: p.url.slice(0, 500) });
      return `Saved “${clip(p.title, 50)}” to Files.`;
    });

  // A right-click action from the service worker, taken once the panel is signed in and ready.
  const handled = useRef(false);
  useEffect(() => {
    if (!signedIn) return;
    const take = async () => {
      const got = await chrome.storage.session.get(PENDING_KEY);
      const pending = got[PENDING_KEY] as Pending | undefined;
      if (!pending) return;
      await chrome.storage.session.remove(PENDING_KEY);
      if (pending.kind === "summon") setSummon({ url: pending.url ?? "", title: pending.title ?? "", ...(pending.text ? { selection: pending.text } : {}) });
      else if (pending.kind === "ask") compose(`${clip(pending.text ?? "", 2500)}\n\nFrom: ${pending.title ?? ""} ${pending.url ?? ""}\n\nWhat should I know about this?`);
      else if (pending.kind === "task") compose(`Add a task: ${clip(pending.text || pending.title || "", 160)}\n(${pending.url ?? ""})`);
      else void save({ title: pending.title ?? "Page", url: pending.url ?? "", text: (await readPage().catch(() => null))?.text ?? "" });
    };
    if (!handled.current) (handled.current = true), void take();
    const on = (changes: Record<string, unknown>, area: string) => area === "session" && PENDING_KEY in changes && void take();
    chrome.storage.onChanged.addListener(on);
    return () => chrome.storage.onChanged.removeListener(on);
  }, [signedIn]);

  return (
    <div className="pagebar">
      <div className="pagebar-page" title={tab?.url}>
        <span className="muted small">This page</span>
        <strong>{tab ? clip(tab.title, 60) : "No page open"}</strong>
      </div>
      {signedIn && (
        <div className="row wrap">
          <button className="tiny" disabled={busy || !tab} onClick={() => tab && setSummon({ url: tab.url, title: tab.title })}>Summon PersonalOS</button>
          <button className="secondary tiny" disabled={busy} onClick={() => void askAbout("summarize")}>Summarize</button>
          <button className="secondary tiny" disabled={busy} onClick={() => void askAbout("ask")}>Ask about it</button>
          <button className="secondary tiny" disabled={busy} onClick={() => void run(async () => save(await readPage()))}>Save to Files</button>
          <button className="ghost tiny" disabled={busy} onClick={() => tab && compose(`Add a task: read "${clip(tab.title, 120)}"\n(${tab.url})`)}>Read later</button>
        </div>
      )}
      {signedIn && summon && <SummonForm key={summon.url} target={summon} readPage={readPage} initialSelection={summon.selection} onClose={() => setSummon(null)} />}
      {signedIn && !summon && lastSummon && <SummonStatus invocationId={lastSummon.invocationId} onClose={() => void chrome.storage.session.remove(LAST_SUMMON_KEY).then(() => setLastSummon(null))} />}
      {note && <p className={note.tone === "error" ? "error-text small" : "muted small"} role="status">{note.text}</p>}
      <div className="muted small">Connected to {new URL(url).host} · <button className="link small" onClick={onDisconnect}>Change</button></div>
    </div>
  );
}
