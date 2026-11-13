import { useEffect, useRef, useState } from "react";
import { useFeltKit, useMutation, useSession } from "@feltdb/feltkit/react";
import { api } from "../../feltkit/_generated/api";
import { PENDING_KEY, type Pending } from "./config";
import { LAST_SUMMON_KEY, SummonForm, SummonStatus, submitEnvelope } from "./summonform";
import { buildEnvelope } from "./summon";

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
  const [summon, setSummon] = useState<{ url: string; title: string; selection?: string; ask?: boolean } | null>(null);
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

  /**
   * A request about this page, sent straight away as an invocation (personalos.invocation/1): the
   * instruction is the button's, the page is context, and PersonalOS does it in the background under
   * your delegation. The result opens in a new conversation, as these actions always have.
   */
  const request = (instruction: string, how: { pageText?: boolean; page?: PageInfo | null; tab?: { url: string; title: string } }) =>
    run(async () => {
      const page = how.page !== undefined ? how.page : how.pageText ? await readPage() : null;
      const target = how.tab ?? (page ? { url: page.url, title: page.title } : tab);
      if (!target) throw new Error("Open a web page first.");
      const built = buildEnvelope({
        invocationId: `browser-${crypto.randomUUID()}`, tab: target, page, instruction, includeSelection: Boolean(page?.selection) && !how.pageText,
        includePageText: how.pageText ?? false, now: Date.now(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, version: chrome.runtime.getManifest().version,
      });
      if ("error" in built) throw new Error(built.error);
      const receipt = await submitEnvelope(client, built.envelope);
      const last = { invocationId: receipt.invocationId, title: target.title };
      await chrome.storage.session.set({ [LAST_SUMMON_KEY]: last });
      setLastSummon(last);
      location.hash = `#/chat/${receipt.conversationId}`;
      return built.notes.join(" ") || undefined;
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
      // "Ask PersonalOS about…": the Summon form with the selection; the person asks their question.
      else if (pending.kind === "ask") setSummon({ url: pending.url ?? "", title: pending.title ?? "", ...(pending.text ? { selection: pending.text } : {}), ask: true });
      // "Add to my PersonalOS tasks": the selection (or link) as context, the request as the instruction.
      else if (pending.kind === "task") {
        const page = { url: pending.url ?? "", title: pending.title ?? "", selection: pending.text ?? "", text: "" };
        void request(pending.text ? "Add this to my tasks" : "Add read this to my tasks", { page, tab: { url: page.url, title: page.title } });
      }
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
          <button className="secondary tiny" disabled={busy || !tab} onClick={() => void request("Summarize this page for me, and tell me if anything in it needs action from me.", { pageText: true })}>Summarize</button>
          <button className="secondary tiny" disabled={busy || !tab} onClick={() => tab && setSummon({ url: tab.url, title: tab.title, ask: true })}>Ask about it</button>
          <button className="secondary tiny" disabled={busy} onClick={() => void run(async () => save(await readPage()))}>Save to Files</button>
          <button className="ghost tiny" disabled={busy || !tab} onClick={() => tab && void request("Add read this to my tasks", { page: null, tab })}>Read later</button>
        </div>
      )}
      {signedIn && summon && <SummonForm key={`${summon.url}:${summon.ask ? "ask" : "summon"}`} target={summon} readPage={readPage} initialSelection={summon.selection} ask={summon.ask} onClose={() => setSummon(null)} />}
      {signedIn && !summon && lastSummon && <SummonStatus invocationId={lastSummon.invocationId} onClose={() => void chrome.storage.session.remove(LAST_SUMMON_KEY).then(() => setLastSummon(null))} />}
      {note && <p className={note.tone === "error" ? "error-text small" : "muted small"} role="status">{note.text}</p>}
      <div className="muted small">Connected to {new URL(url).host} · <button className="link small" onClick={onDisconnect}>Change</button></div>
    </div>
  );
}
