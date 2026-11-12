import { Research } from "./research";
import { useCallback, useEffect, useRef, useState } from "react";
import { useConnectionState, useFeltKit, useMutation, useQuery, useSession } from "@feltdb/feltkit/react";
import { api } from "../feltkit/_generated/api";
import { focusMain, Shell } from "@stack-ui/react";
import { useThemePreference } from "./theme";
import { describe, ResetForm, SignedOut } from "./auth";
import { Chat, type Compose } from "./chat";
import { Activity, Files, MemoryScreen, Projects, Settings, Tasks, Today } from "./screens";
import { clientDay } from "./ui";

type Tab = "chat" | "today" | "tasks" | "memory" | "research" | "projects" | "files" | "activity" | "settings";
const PRIMARY: Array<{ tab: Tab; label: string }> = [
  { tab: "chat", label: "Chat" },
  { tab: "today", label: "Today" },
  { tab: "tasks", label: "Tasks" },
  { tab: "memory", label: "Memory" },
];
const SECONDARY: Array<{ tab: Tab; label: string }> = [
  { tab: "research", label: "Research" },
  { tab: "projects", label: "Projects" },
  { tab: "files", label: "Files" },
  { tab: "activity", label: "Activity" },
  { tab: "settings", label: "Settings" },
];

/** The tab and conversation live in the URL hash, so reload and back keep your place. */
function readHash(): { tab: Tab; conversation: string | null } {
  const [tab, conversation] = location.hash.replace(/^#\/?/, "").split("/");
  const all = [...PRIMARY, ...SECONDARY].map((t) => t.tab);
  return { tab: all.includes(tab as Tab) ? (tab as Tab) : "chat", conversation: conversation || null };
}

export function App() {
  const { session, signInAsDevUser, signIn, signUp, signOut } = useSession();
  const live = useConnectionState();
  const [notice, setNotice] = useState<{ tone: "error" | "info"; text: string } | null>(null);
  const principal = session?.principal ?? null;

  const tried = useRef(false);
  useEffect(() => {
    if (session && !principal && session.devUsers.length && !tried.current) {
      tried.current = true;
      void signInAsDevUser(session.devUsers[0]!.id);
    }
  }, [session, principal, signInAsDevUser]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 7000);
    return () => clearTimeout(timer);
  }, [notice]);
  const report = useCallback((error: unknown) => setNotice({ tone: "error", text: describe(error) }), []);

  const client = useFeltKit();
  const [resetToken, setResetToken] = useState<string | null>(null);
  useEffect(() => {
    void client.handleRedirect().then((r) => {
      if (r?.kind === "reset") setResetToken(r.token);
      else if (r?.kind === "verified") setNotice({ tone: "info", text: `${r.email} is verified.` });
      else if (r?.kind === "error" || r?.kind === "verify-failed") setNotice({ tone: "error", text: r.message });
    });
  }, [client]);

  return (
    <div className="shell">
      {notice && (
        <div className={`notice ${notice.tone}`} role="status">
          {notice.text}
          <button className="ghost" onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      {!session ? (
        <div className="center muted">Connecting…</div>
      ) : resetToken ? (
        <div className="center"><div className="card narrow"><ResetForm token={resetToken} onDone={() => (setResetToken(null), setNotice({ tone: "info", text: "Your password is set." }))} /></div></div>
      ) : !principal ? (
        <SignedOut devUsers={session.devUsers} accounts={session.accounts ?? null} onDevSignIn={(id) => signInAsDevUser(id).catch(report)} onSignIn={signIn} onSignUp={signUp} />
      ) : (
        <Workspace
          key={principal.id}
          live={live}
          onError={report}
          principal={principal.displayName ?? principal.id}
          devUsers={session.devUsers}
          currentDev={principal.id}
          onSwitch={(id) => (id ? signInAsDevUser(id).catch(report) : signOut())}
          onSignOut={session.devUsers.length ? undefined : () => void signOut().catch(report)}
          dashboard={session.dashboard ?? null}
          environment={session.environment.production ? null : session.environment.name}
        />
      )}
    </div>
  );
}

function Workspace(props: {
  live: boolean;
  onError: (e: unknown) => void;
  principal: string;
  devUsers: Array<{ id: string; name: string; roles: string[] }>;
  currentDev: string;
  onSwitch: (id: string) => void;
  onSignOut?: () => void;
  dashboard: string | null;
  environment: string | null;
}) {
  const [{ tab, conversation }, setRoute] = useState(readHash);
  const [menuOpen, setMenuOpen] = useState(false);
  const theme = useThemePreference();
  // Coming back to Chat reopens the conversation you left.
  const lastConversation = useRef<string | null>(readHash().conversation);
  if (tab === "chat") lastConversation.current = conversation;
  useEffect(() => {
    const onHash = () => setRoute(readHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);
  const go = useCallback((next: Tab, conv: string | null = null) => {
    const hash = `#/${next}${conv ? `/${conv}` : ""}`;
    if (location.hash !== hash) location.hash = hash;
    setRoute({ tab: next, conversation: conv });
    setMenuOpen(false);
  }, []);
  // Another surface (the browser extension) can ask Chat to send something: a new conversation with it.
  const [compose, setCompose] = useState<Compose | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text;
      if (!text) return;
      lastConversation.current = null;
      go("chat", null);
      setCompose({ text, nonce: Date.now() });
    };
    addEventListener("personalos:compose", on);
    return () => removeEventListener("personalos:compose", on);
  }, [go]);
  const settings = useQuery(api.settings.get);
  const pending = useQuery(api.actions.list, { status: "proposed" })?.length ?? 0;
  const send = useMutation(api.assistant.send);
  // A question asked from another screen opens a new conversation with it.
  const ask = (text: string) =>
    void send({ text, ...clientDay() })
      .then((r) => go("chat", r.conversationId))
      .catch(props.onError);

  // The shared stack-ui Shell: a sidebar on wide screens; below 768px (phones, the extension's
  // side panel) the navigation is a menu behind the bar's button.
  const navigation = [...PRIMARY, ...SECONDARY].map((i, order) => ({
    id: i.tab,
    label: i.tab === "activity" && pending > 0 ? `${i.label} (${pending} waiting)` : i.label,
    href: `#/${i.tab}${i.tab === "chat" && lastConversation.current ? `/${lastConversation.current}` : ""}`,
    group: order < PRIMARY.length ? undefined : "More",
    order,
    current: tab === i.tab,
  }));
  const onNavigate = (href: string) => {
    const next = href.replace(/^#\/?/, "").split("/")[0] as Tab;
    go(next, next === "chat" ? lastConversation.current : null);
    // Keyboard and screen-reader users start at the new page (stack-ui product-shell §2).
    requestAnimationFrame(() => focusMain("main"));
  };

  return (
    <Shell
      className="app-shell"
      product={{ name: "PersonalOS", homeHref: "#/chat", mark: "P" }}
      mainId="main"
      navigation={navigation}
      onNavigate={onNavigate}
      narrowNavigation="menu"
      navigationOpen={menuOpen}
      onNavigationToggle={setMenuOpen}
      theme={theme}
      account={<span className={`live ${props.live ? "on" : ""}`} title={props.live ? "Live" : "Reconnecting"}><span className="dot" /><span className="sr-only">{props.live ? "Live" : "Reconnecting"}</span></span>}
    >
      {tab === "chat" && <Chat conversationId={conversation} onConversation={(id) => go("chat", id)} onError={props.onError} name={settings?.name ?? null} compose={compose} />}
      {tab === "today" && <Today onError={props.onError} onAsk={ask} />}
      {tab === "tasks" && <Tasks onError={props.onError} />}
      {tab === "memory" && <MemoryScreen onError={props.onError} onOpenConversation={(id) => go("chat", id)} />}
      {tab === "research" && <Research onError={props.onError} onOpenConversation={(id) => go("chat", id)} />}
      {tab === "projects" && <Projects onError={props.onError} onAsk={ask} />}
      {tab === "files" && <Files onError={props.onError} />}
      {tab === "activity" && <Activity onError={props.onError} onOpenConversation={(id) => go("chat", id)} />}
      {tab === "settings" && (
        <Settings onError={props.onError} dashboard={props.dashboard} principal={props.principal} onSignOut={props.onSignOut}>
          <Footer {...props} />
        </Settings>
      )}
    </Shell>
  );
}

function Footer(props: { live: boolean; devUsers: Array<{ id: string; name: string; roles: string[] }>; currentDev: string; onSwitch: (id: string) => void; dashboard: string | null; environment: string | null }) {
  return (
    <div className="foot">
      <div className="row between">
        <span className={`live ${props.live ? "on" : ""}`}><span className="dot" /> {props.live ? "Live" : "Reconnecting"}</span>
      </div>
      {props.devUsers.length > 0 && (
        <select value={props.currentDev} onChange={(e) => props.onSwitch(e.target.value)} aria-label="Signed in as (development)">
          {props.devUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          <option value="">Sign out</option>
        </select>
      )}
      {props.environment && (
        <div className="muted small">
          {props.environment}
          {props.dashboard && <> · <a href={props.dashboard} target="_blank" rel="noreferrer">Studio ↗</a></>}
        </div>
      )}
    </div>
  );
}
