/**
 * Gmail and Google Calendar as Anywhere Aide reads and writes them: the request it builds and how it
 * reads the answer. Pure: no I/O, so every rule here is tested without Google (tests/connections.test.ts).
 */
import { offsetFor } from "./_clock.js";

/** One address, as a person writes it. No display names, no lists: what is sent is exactly what was approved. */
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export const isAddress = (value: string) => value.length <= 254 && ADDRESS.test(value);

export interface Draft {
  to: string[];
  cc?: string[];
  subject: string;
  text: string;
}

/** Why a draft can't be sent as it is, or null. Checked before it is proposed and again when it is sent. */
export function draftProblem(d: Draft): string | null {
  if (!d.to.length) return "Who is it to? Give at least one address.";
  const bad = [...d.to, ...(d.cc ?? [])].filter((a) => !isAddress(a));
  if (bad.length) return `Not an email address: ${bad.join(", ")}.`;
  if (/[\r\n]/.test(d.subject)) return "The subject must be one line.";
  if (!d.text.trim()) return "The message is empty.";
  return null;
}

const b64url = (buf: Buffer) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** A header value: ASCII as is, anything else as an RFC 2047 encoded word. */
const header = (value: string) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`);

/** The RFC 2822 message Gmail's send takes, base64url-encoded. The body is UTF-8, base64 in 76-column lines. */
export function rawMessage(d: Draft): string {
  const problem = draftProblem(d);
  if (problem) throw new Error(problem);
  const body = Buffer.from(d.text, "utf8").toString("base64").replace(/.{1,76}/g, "$&\r\n");
  const lines = [
    `To: ${d.to.join(", ")}`,
    ...(d.cc?.length ? [`Cc: ${d.cc.join(", ")}`] : []),
    `Subject: ${header(d.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ];
  return b64url(Buffer.from(lines.join("\r\n"), "utf8"));
}

export interface MailSummary {
  id: string;
  threadId: string | null;
  from: string;
  subject: string;
  date: string;
  snippet: string;
  unread: boolean;
}

/** A Gmail message (format=metadata) as a summary. Never its body: only headers and Gmail's own snippet. */
export function mailSummary(message: unknown): MailSummary | null {
  const m = message as { id?: unknown; threadId?: unknown; snippet?: unknown; labelIds?: unknown; payload?: { headers?: Array<{ name?: unknown; value?: unknown }> } } | null;
  if (!m || typeof m.id !== "string") return null;
  const h = (name: string) => {
    const found = (m.payload?.headers ?? []).find((x) => typeof x?.name === "string" && x.name.toLowerCase() === name);
    return typeof found?.value === "string" ? found.value.slice(0, 300) : "";
  };
  const decode = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  return {
    id: m.id,
    threadId: typeof m.threadId === "string" ? m.threadId : null,
    from: h("from"),
    subject: h("subject") || "(no subject)",
    date: h("date"),
    snippet: typeof m.snippet === "string" ? decode(m.snippet).slice(0, 300) : "",
    unread: Array.isArray(m.labelIds) && m.labelIds.includes("UNREAD"),
  };
}

/** Message ids from a Gmail list answer (`messages[].id`). */
export const messageIds = (list: unknown): string[] =>
  ((list as { messages?: Array<{ id?: unknown }> } | null)?.messages ?? []).flatMap((m) => (typeof m?.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(m.id) ? [m.id] : []));

export interface EventSummary {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string | null;
  link: string | null;
}

/** Google Calendar events (`items[]`) as summaries; cancelled ones are left out. */
export function eventSummaries(answer: unknown): EventSummary[] {
  const items = (answer as { items?: unknown[] } | null)?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((raw) => {
    const e = raw as { id?: unknown; status?: unknown; summary?: unknown; location?: unknown; htmlLink?: unknown; start?: { dateTime?: unknown; date?: unknown }; end?: { dateTime?: unknown; date?: unknown } };
    if (typeof e?.id !== "string" || e.status === "cancelled") return [];
    const at = (x: { dateTime?: unknown; date?: unknown } | undefined) => (typeof x?.dateTime === "string" ? x.dateTime : typeof x?.date === "string" ? x.date : "");
    return [{
      id: e.id,
      title: typeof e.summary === "string" && e.summary ? e.summary.slice(0, 300) : "(untitled)",
      start: at(e.start),
      end: at(e.end),
      allDay: typeof e.start?.date === "string" && typeof e.start?.dateTime !== "string",
      location: typeof e.location === "string" ? e.location.slice(0, 300) : null,
      link: typeof e.htmlLink === "string" && /^https:\/\//.test(e.htmlLink) ? e.htmlLink : null,
    }];
  });
}

const pad = (n: number) => String(Math.abs(n)).padStart(2, "0");
/** RFC 3339 for a local date and time in `timeZone` (with its offset that day). */
export function instant(day: string, time: string, timeZone: string): string {
  const offset = -offsetFor(day, time, timeZone); // minutes local − UTC
  const sign = offset < 0 ? "-" : "+";
  return `${day}T${time}:00${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

/** The days [from, from + days) in `timeZone`, as the timeMin/timeMax a Calendar query takes. */
export function window(from: string, days: number, timeZone: string): { timeMin: string; timeMax: string } {
  const [y, m, d] = from.split("-").map(Number) as [number, number, number];
  const end = new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
  return { timeMin: instant(from, "00:00", timeZone), timeMax: instant(end, "00:00", timeZone) };
}

/** A local end time `minutes` after day/time, as [day, time] (it may cross midnight). */
export function after(day: string, time: string, minutes: number): [string, string] {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const [h, min] = time.split(":").map(Number) as [number, number];
  const t = new Date(Date.UTC(y, m - 1, d, h, min + minutes));
  return [t.toISOString().slice(0, 10), t.toISOString().slice(11, 16)];
}

/** "Tue 09:30–10:00 Standup (Room 4)" in the person's time zone. */
export function describeEvent(e: EventSummary, timeZone: string): string {
  if (e.allDay) return `${e.start} all day: ${e.title}${e.location ? ` (${e.location})` : ""}`;
  const f = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const g = new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const start = Date.parse(e.start);
  const end = Date.parse(e.end);
  const span = Number.isFinite(start) ? `${f.format(start)}${Number.isFinite(end) ? `–${g.format(end)}` : ""}` : e.start;
  return `${span} ${e.title}${e.location ? ` (${e.location})` : ""}`;
}
