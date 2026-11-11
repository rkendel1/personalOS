/**
 * What the extension remembers: which PersonalOS instance it is connected to, and the session
 * FeltKit issued when the person signed in to their account. Both live in chrome.storage.local,
 * which only this extension can read. The session is a bearer token the server can revoke
 * (Settings → sessions, or sign out), exactly like a session on another device.
 */
import type { TokenStore } from "@feltdb/feltkit/client";

const URL_KEY = "personalos:url";
const TOKEN_KEY = "personalos:token";

export interface Connection {
  url: string | null;
  token: string | null;
}

export async function loadConnection(): Promise<Connection> {
  const got = await chrome.storage.local.get([URL_KEY, TOKEN_KEY]);
  return { url: (got[URL_KEY] as string | undefined) ?? null, token: (got[TOKEN_KEY] as string | undefined) ?? null };
}

export async function saveUrl(url: string | null): Promise<void> {
  if (url) await chrome.storage.local.set({ [URL_KEY]: url });
  else await chrome.storage.local.remove([URL_KEY, TOKEN_KEY]);
}

/** FeltKit's token store is synchronous: serve from memory, write through to chrome.storage. */
export function chromeTokenStore(initial: string | null): TokenStore {
  let token = initial;
  return {
    get: () => token,
    set: (next) => {
      token = next;
      void (next ? chrome.storage.local.set({ [TOKEN_KEY]: next }) : chrome.storage.local.remove(TOKEN_KEY));
    },
  };
}

/** A normalized origin ("https://my.app"), or null. Plain http is accepted only for localhost. */
export function parseInstance(input: string): string | null {
  let text = input.trim();
  if (!text) return null;
  if (!/^[a-z]+:\/\//i.test(text)) text = (/^(localhost|127\.0\.0\.1)(:|$)/.test(text) ? "http://" : "https://") + text;
  try {
    const u = new URL(text);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** What the side panel and the service worker pass to each other (chrome.storage.session). */
export const PENDING_KEY = "personalos:pending";
export interface Pending {
  kind: "ask" | "task" | "page";
  text?: string;
  url?: string;
  title?: string;
}
