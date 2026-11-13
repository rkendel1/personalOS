import { useState, type FormEvent } from "react";
import { parseInstance } from "./config";
import { fetchWithoutCookies } from "./nocookies";

/** First run: which PersonalOS instance is yours. Sign-in itself is the app's own form, once connected. */
export function Connect({ onConnected }: { onConnected: (url: string) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const url = parseInstance(text);
    if (!url) return setError("Enter your PersonalOS address, like https://personalos.example.com (plain http only works for localhost).");
    setBusy(true);
    try {
      // Asks Chrome for access to this one address (a user gesture); it is the only site the extension can reach.
      const granted = await chrome.permissions.request({ origins: [`${url}/*`] });
      if (!granted) return setError("Chrome needs your permission to let this extension talk to that address.");
      const info = await fetchWithoutCookies(`${url}/api/session`, { headers: { Accept: "application/json" } }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))));
      if (info?.application !== "personalos") return setError(`That address answered, but it isn't a PersonalOS instance${info?.application ? ` (it is "${info.application}")` : ""}.`);
      onConnected(url);
    } catch (err) {
      setError(`Couldn't reach ${url}: ${(err as Error).message}. Is it deployed and running?`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="center">
      <form className="card narrow stack" onSubmit={submit}>
        <h1>Connect PersonalOS</h1>
        <p className="muted">Enter the address of your PersonalOS instance. You'll sign in with the same account you use on the web, and see the same conversations, tasks, memory and files.</p>
        <label className="field">
          <span>Your PersonalOS address</span>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="https://personalos.example.com" autoFocus spellCheck={false} inputMode="url" />
        </label>
        {error && <p className="error-text" role="alert">{error}</p>}
        <button className="wide" type="submit" disabled={busy || !text.trim()}>{busy ? "Connecting…" : "Connect"}</button>
      </form>
    </div>
  );
}
