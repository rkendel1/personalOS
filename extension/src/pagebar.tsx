import { useEffect, useRef, useState } from "react";
import { useFeltKit, useMutation, useSession } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { PENDING_KEY, type Pending } from "./config";

interface PageInfo { title: string; url: string; selection: string; text: string }

/** What the person is looking at, read only now, in the active tab, because they asked (activeTab + scripting). */
async function readPage(): Promise<PageInfo> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || !/^https?:/.test(tab.url ?? "")) throw new Error("Open a web page first. Chrome's own pages can't be read.");
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

  // The active tab, kept current so the bar says what "this page" is.
  useEffect(() => {
    const refresh = () => void chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => setTab(t?.url ? { title: t.title ?? t.url, url: t.url } : null));
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
      if (pending.kind === "ask") compose(`${clip(pending.text ?? "", 2500)}\n\nFrom: ${pending.title ?? ""} ${pending.url ?? ""}\n\nWhat should I know about this?`);
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
          <button className="secondary tiny" disabled={busy} onClick={() => void askAbout("summarize")}>Summarize</button>
          <button className="secondary tiny" disabled={busy} onClick={() => void askAbout("ask")}>Ask about it</button>
          <button className="secondary tiny" disabled={busy} onClick={() => void run(async () => save(await readPage()))}>Save to Files</button>
          <button className="ghost tiny" disabled={busy} onClick={() => tab && compose(`Add a task: read "${clip(tab.title, 120)}"\n(${tab.url})`)}>Read later</button>
        </div>
      )}
      {note && <p className={note.tone === "error" ? "error-text small" : "muted small"} role="status">{note.text}</p>}
      <div className="muted small">Connected to {new URL(url).host} · <button className="link small" onClick={onDisconnect}>Change</button></div>
    </div>
  );
}
