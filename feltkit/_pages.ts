/**
 * Reading a company's own pages, for research. It reads public web pages only, and says exactly what
 * happened to each one:
 *
 *   read               the page answered with HTML or text, and readable text was extracted from it
 *   unavailable        it could not be fetched (DNS, connection, timeout, an HTTP error status)
 *   extraction-failed  it answered, but no readable text came out (a script-rendered page, a PDF, an image)
 *   not-allowed        it was not fetched: a private or local address, a port other than 80/443, or
 *                      its robots.txt asks automated readers to stay out
 *
 * A page that was not read is never treated as saying anything, and "it does not say X" is only ever
 * concluded from a page that was read.
 *
 * Why this is application code and not a FeltKit integration: an integration has one fixed base URL
 * (its provider), and reading the open web means any URL. No credential is involved.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type PageStatus = "read" | "unavailable" | "extraction-failed" | "not-allowed";

export interface PageRead {
  url: string;
  /** Where it ended up after redirects. */
  finalUrl: string;
  status: PageStatus;
  httpStatus: number | null;
  title: string;
  text: string;
  detail: string;
  ms: number;
}

const USER_AGENT = "PersonalOS-research/1.0 (reads public pages for its owner; honours robots.txt)";
const MAX_BYTES = 1_500_000;
const MAX_TEXT = 20_000;
const MIN_TEXT = 200;
const TIMEOUT_MS = 12_000;
const MAX_REDIRECTS = 4;

/** Hosts a test (or a local deployment) may read although they are private: exact names, outside production. */
function allowedPrivate(host: string): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return (process.env.PERSONALOS_PAGE_READER_ALLOW_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean).includes(host);
}

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  if (x.startsWith("::ffff:")) return privateAddress(x.slice(7));
  return x === "::" || x === "::1" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80") || x.startsWith("ff");
}

/** Whether this URL may be fetched: public http(s) on the standard ports, resolving only to public addresses. */
async function permitted(url: URL): Promise<string | null> {
  if (url.protocol !== "https:" && url.protocol !== "http:") return `only http(s) pages are read (${url.protocol})`;
  if (url.username || url.password) return "URLs with credentials are not read";
  if (url.port && url.port !== "80" && url.port !== "443" && !allowedPrivate(url.hostname)) return `port ${url.port} is not read`;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (allowedPrivate(host)) return null;
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host)) return `${host} is a local name`;
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addresses.length) return null; // the fetch will fail and say so (unavailable)
  const bad = addresses.find(privateAddress);
  return bad ? `${host} resolves to a private address` : null;
}

async function get(url: string, signal: AbortSignal, accept: string): Promise<{ response: Response; finalUrl: string } | { refused: string }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const u = new URL(current);
    const refusal = await permitted(u);
    if (refusal) return { refused: refusal };
    const response = await fetch(u, { redirect: "manual", signal, headers: { "user-agent": USER_AGENT, accept } });
    if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      await response.body?.cancel().catch(() => undefined);
      current = new URL(response.headers.get("location")!, u).toString();
      continue;
    }
    return { response, finalUrl: current };
  }
  return { refused: "too many redirects" };
}

/** robots.txt rules for every reader (`User-agent: *`): whether the path is disallowed. Unreadable robots.txt allows. */
async function robotsAllow(url: URL, signal: AbortSignal): Promise<boolean> {
  try {
    const got = await get(`${url.origin}/robots.txt`, signal, "text/plain");
    if ("refused" in got || !got.response.ok) return true;
    const text = (await got.response.text()).slice(0, 100_000);
    let applies = false;
    const disallow: string[] = [];
    const allow: string[] = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/#.*/, "").trim();
      const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
      if (!m) continue;
      const [key, value] = [m[1]!.toLowerCase(), m[2]!.trim()];
      if (key === "user-agent") applies = value === "*";
      else if (applies && key === "disallow" && value) disallow.push(value);
      else if (applies && key === "allow" && value) allow.push(value);
    }
    const path = url.pathname + url.search;
    const longest = (rules: string[]) => Math.max(-1, ...rules.filter((r) => path.startsWith(r.replace(/\*.*$/, ""))).map((r) => r.length));
    return longest(allow) >= longest(disallow);
  } catch {
    return true;
  }
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™" };
const decode = (s: string) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (all, e: string) => {
  if (e[0] === "#") {
    const n = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
  }
  return ENTITIES[e.toLowerCase()] ?? all;
});

/** Readable text from HTML: title, meta description, then the body's text in reading order. */
export function htmlText(html: string): { title: string; text: string } {
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim()).slice(0, 300);
  const meta = decode(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1] ?? /<meta[^>]+content=["']([^"']*)["'][^>]*name=["']description["']/i.exec(html)?.[1] ?? "").trim();
  const body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(p|div|section|article|header|footer|li|ul|ol|h[1-6]|br|tr|td|th|table|main|aside|nav|blockquote|dd|dt)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const lines = decode(body).split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length > 1);
  const text = [meta, ...lines].filter(Boolean).join("\n").slice(0, MAX_TEXT);
  return { title, text };
}

/** Read one public page. Never throws: the outcome is in `status` and `detail`. */
export async function readPage(url: string, options: { signal?: AbortSignal } = {}): Promise<PageRead> {
  const started = Date.now();
  const done = (r: Omit<PageRead, "url" | "ms">): PageRead => ({ url, ...r, ms: Date.now() - started });
  let parsed: URL;
  try { parsed = new URL(url); } catch { return done({ finalUrl: url, status: "not-allowed", httpStatus: null, title: "", text: "", detail: "not a valid URL" }); }
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    if (!(await robotsAllow(parsed, signal))) return done({ finalUrl: url, status: "not-allowed", httpStatus: null, title: "", text: "", detail: "its robots.txt asks automated readers not to read this page" });
    const got = await get(url, signal, "text/html,application/xhtml+xml,text/plain;q=0.8");
    if ("refused" in got) return done({ finalUrl: url, status: "not-allowed", httpStatus: null, title: "", text: "", detail: got.refused });
    const { response, finalUrl } = got;
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return done({ finalUrl, status: "unavailable", httpStatus: response.status, title: "", text: "", detail: `the site answered HTTP ${response.status}` });
    }
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    if (!/text\/html|application\/xhtml|text\/plain/.test(type)) {
      await response.body?.cancel().catch(() => undefined);
      return done({ finalUrl, status: "extraction-failed", httpStatus: response.status, title: "", text: "", detail: `not a web page (${type || "no content type"})` });
    }
    // Read at most MAX_BYTES; a larger page is read up to there.
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_BYTES) {
      const { value, done: end } = await reader.read();
      if (end) break;
      chunks.push(value);
      size += value.byteLength;
    }
    await reader.cancel().catch(() => undefined);
    const raw = new TextDecoder().decode(Buffer.concat(chunks));
    const { title, text } = type.includes("text/plain") ? { title: "", text: raw.replace(/[ \t]+/g, " ").slice(0, MAX_TEXT) } : htmlText(raw);
    if (text.length < MIN_TEXT) return done({ finalUrl, status: "extraction-failed", httpStatus: response.status, title, text, detail: `only ${text.length} characters of readable text (the page may be rendered by scripts)` });
    return done({ finalUrl, status: "read", httpStatus: response.status, title, text, detail: `${text.length} characters of text` });
  } catch (error) {
    const e = error as { name?: string; message?: string; cause?: { code?: string; message?: string } };
    const why = e.name === "TimeoutError" || timeout.aborted ? `no answer within ${TIMEOUT_MS / 1000}s` : options.signal?.aborted ? "stopped" : (e.cause?.code ?? e.cause?.message ?? e.message ?? String(error));
    return done({ finalUrl: url, status: "unavailable", httpStatus: null, title: "", text: "", detail: `could not be fetched: ${String(why).slice(0, 200)}` });
  }
}

/** Whitespace- and case-insensitive containment: whether a quote is verbatim in a page's text. */
export function quoted(quote: string, text: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
  const q = norm(quote);
  return q.length >= 12 && norm(text).includes(q);
}
