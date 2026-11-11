/**
 * The caller's local calendar, from the IANA time zone FeltKit reports for the request
 * (`ctx.auth.context.timeZone`). Server-side Intl, so no client has to send its date.
 */
export interface Clock {
  timeZone: string;
  today: string; // YYYY-MM-DD
  time: string; // HH:MM
  weekday: string;
  /** Date#getTimezoneOffset() semantics: minutes, UTC − local, at `now`. */
  tzOffset: number;
}

function parts(at: number, timeZone: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "long" });
  const p = Object.fromEntries(f.formatToParts(new Date(at)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute), weekday: String(p.weekday) };
}

/** Minutes UTC − local for `timeZone` at instant `at` (DST-aware). */
export function offsetAt(at: number, timeZone: string): number {
  const p = parts(at, timeZone);
  const local = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
  return Math.round((Math.floor(at / 60_000) * 60_000 - local) / 60_000);
}

/** The offset that applies to a local date and time in `timeZone` (for a reminder set on another day). */
export function offsetFor(day: string, time: string, timeZone: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const [h, min] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, h, min);
  return offsetAt(guess + offsetAt(guess, timeZone) * 60_000, timeZone);
}

export function clockFor(timeZone: string | null | undefined, now = Date.now()): Clock {
  const zone = timeZone || "UTC";
  const p = parts(now, zone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return { timeZone: zone, today: `${p.y}-${pad(p.m)}-${pad(p.d)}`, time: `${pad(p.h)}:${pad(p.min)}`, weekday: p.weekday, tzOffset: offsetAt(now, zone) };
}
