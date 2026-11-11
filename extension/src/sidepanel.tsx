/**
 * The side panel is the PersonalOS web app itself (src/App.tsx), pointed at the person's deployed
 * instance with a bearer session. Same account, same collections, same functions, same services
 * (files, notifications, jobs, model), so there is nothing to keep in sync. What the extension adds
 * is the page beside it: a bar with what the person is looking at, and a right-click menu.
 */
import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createClient } from "@feltdb/feltkit/client";
import { FeltKitProvider } from "@feltdb/feltkit/react";
import { App } from "../../src/App";
import "@stack-ui/tokens/tokens.css";
import "@stack-ui/core/core.css";
import "../../src/styles.css";
import "./extension.css";
import { chromeTokenStore, loadConnection, saveUrl } from "./config";
import { Connect } from "./connect";
import { PageBar } from "./pagebar";

function Root() {
  const [conn, setConn] = useState<{ url: string | null; token: string | null } | undefined>();
  useEffect(() => void loadConnection().then(setConn), []);
  const [client, setClient] = useState<ReturnType<typeof createClient> | null>(null);
  useEffect(() => {
    if (!conn?.url) return setClient(null);
    const c = createClient({ url: conn.url, session: "bearer", tokens: chromeTokenStore(conn.token) });
    setClient(c);
    return undefined;
  }, [conn?.url]);

  if (!conn) return null;
  if (!conn.url || !client) return <Connect onConnected={(url) => void saveUrl(url).then(() => setConn({ url, token: null }))} />;
  return (
    <FeltKitProvider client={client}>
      <div className="ext">
        <PageBar url={conn.url} onDisconnect={() => void saveUrl(null).then(() => setConn({ url: null, token: null }))} />
        <div className="ext-app"><App /></div>
      </div>
    </FeltKitProvider>
  );
}

createRoot(document.getElementById("root")!).render(<StrictMode><Root /></StrictMode>);
