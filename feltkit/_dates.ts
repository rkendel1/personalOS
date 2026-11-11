/**
 * Calendar arithmetic and natural-language date/time parsing. Pure: every function takes the
 * user's local "today" (YYYY-MM-DD) instead of reading a clock, so results are reproducible and
 * testable, and the server never guesses the user's time zone.
 */

export type Day = string; // YYYY-MM-DD

const pad = (n: number) => String(n).padStart(2, "0");

export function isDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function toUTC(day: Day): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}
function fromUTC(date: Date): Day {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function addDays(day: Day, n: number): Day {
  const d = toUTC(day);
  d.setUTCDate(d.getUTCDate() + n);
  return fromUTC(d);
}
export function addMonths(day: Day, n: number): Day {
  const d = toUTC(day);
  const target = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(target, last));
  return fromUTC(d);
}
/** 0 = Sunday … 6 = Saturday. */
export function weekday(day: Day): number {
  return toUTC(day).getUTCDay();
}
export function daysBetween(from: Day, to: Day): number {
  return Math.round((toUTC(to).getTime() - toUTC(from).getTime()) / 86_400_000);
}

export const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** The next date (strictly after `today`) that falls on `dow`. */
export function nextWeekday(today: Day, dow: number): Day {
  const delta = (dow - weekday(today) + 7) % 7 || 7;
  return addDays(today, delta);
}

/** A human label relative to today: "today", "tomorrow", "Friday", "Mon, Nov 24". */
export function describeDay(day: Day, today: Day): string {
  const delta = daysBetween(today, day);
  if (delta === 0) return "today";
  if (delta === 1) return "tomorrow";
  if (delta === -1) return "yesterday";
  const name = WEEKDAYS[weekday(day)]!;
  const cap = name[0]!.toUpperCase() + name.slice(1);
  if (delta > 1 && delta < 7) return cap;
  const [, m, d] = day.split("-").map(Number) as [number, number, number];
  const month = MONTHS[m - 1]!.slice(0, 3);
  return `${cap.slice(0, 3)}, ${month[0]!.toUpperCase()}${month.slice(1)} ${d}`;
}

export function describeTime(time: string): string {
  const [h, m] = time.split(":").map(Number) as [number, number];
  if (h === 12 && m === 0) return "noon";
  const suffix = h >= 12 ? "pm" : "am";
  const hour = h % 12 || 12;
  return m ? `${hour}:${pad(m)}${suffix}` : `${hour}${suffix}`;
}

/** Epoch ms of a local date and time, given the client's `Date#getTimezoneOffset()` (minutes, UTC − local). */
export function instant(day: Day, time: string, tzOffsetMinutes: number): number {
  const [y, mo, d] = day.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  return Date.UTC(y, mo - 1, d, h, mi) + tzOffsetMinutes * 60_000;
}

export interface When {
  due?: Day;
  time?: string; // HH:MM, 24h
  recurrence?: "daily" | "weekdays" | "weekly" | "monthly";
  /** The phrases that expressed the date/time, removed from the text to leave the task title. */
  spans: string[];
}

const WD = "(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?";
function dowOf(token: string): number {
  const t = token.toLowerCase().slice(0, 3);
  return ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(t);
}

function parseClock(raw: string): string | null {
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i.exec(raw.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase().replace(/\./g, "");
  if (min > 59) return null;
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === "pm" && h !== 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
  } else {
    if (h > 23) return null;
    // "at 3" means 3pm; nobody schedules a reminder for 3am without saying so.
    if (!m[2] && h >= 1 && h <= 7) h += 12;
  }
  return `${pad(h)}:${pad(min)}`;
}

/**
 * Find a date, a time and a recurrence in free text. Weekday names mean the next such day after
 * today ("friday" on a Friday is a week out); "next week" is next Monday; "this weekend" is
 * Saturday; "end of the week" is Friday.
 */
export function parseWhen(text: string, today: Day): When {
  const spans: string[] = [];
  let due: Day | undefined;
  let time: string | undefined;
  let recurrence: When["recurrence"];
  const take = (re: RegExp, fn: (m: RegExpExecArray) => boolean | void) => {
    const m = re.exec(text);
    if (m && fn(m) !== false) spans.push(m[0]);
  };

  // Recurrence first: "every friday" is weekly *and* a due date.
  take(/\b(every ?day|daily|each day)\b/i, () => void (recurrence = "daily"));
  if (!recurrence) take(/\b(every weekday|on weekdays|weekdays)\b/i, () => void (recurrence = "weekdays"));
  if (!recurrence)
    take(new RegExp(`\\bevery\\s+${WD}\\b`, "i"), (m) => {
      recurrence = "weekly";
      due = nextWeekday(today, dowOf(m[1]!));
    });
  if (!recurrence) take(/\b(every week|weekly|each week)\b/i, () => void (recurrence = "weekly"));
  if (!recurrence) take(/\b(every month|monthly|each month)\b/i, () => void (recurrence = "monthly"));

  if (!due) take(/\b(the )?day after tomorrow\b/i, () => void (due = addDays(today, 2)));
  if (!due) take(/\b(tomorrow|tmrw|tmr)( morning| afternoon| evening| night)?\b/i, (m) => {
    due = addDays(today, 1);
    if (m[2]) time = { " morning": "09:00", " afternoon": "14:00", " evening": "18:00", " night": "20:00" }[m[2].toLowerCase()];
  });
  if (!due) take(/\b(today|tonight|this (morning|afternoon|evening))\b/i, (m) => {
    due = today;
    const word = m[0].toLowerCase();
    if (word === "tonight") time = "20:00";
    else if (word.endsWith("morning")) time = "09:00";
    else if (word.endsWith("afternoon")) time = "14:00";
    else if (word.endsWith("evening")) time = "18:00";
  });
  if (!due) take(/\bin (\d{1,3}|a|an|one|two|three|four|five|six|seven) (day|days|week|weeks)\b/i, (m) => {
    const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
    const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : words[m[1]!.toLowerCase()]!;
    due = addDays(today, m[2]!.toLowerCase().startsWith("week") ? n * 7 : n);
  });
  if (!due) take(/\bnext week\b/i, () => void (due = nextWeekday(today, 1)));
  if (!due) take(/\b(this|next) weekend\b|\bon the weekend\b|\bthis weekend\b/i, () => void (due = nextWeekday(today, 6)));
  if (!due) take(/\b(by |before )?(the )?end of (the |this )?week\b/i, () => void (due = weekday(today) === 5 ? today : nextWeekday(today, 5)));
  if (!due) take(/\b\d{4}-\d{2}-\d{2}\b/, (m) => (isDay(m[0]) ? void (due = m[0]) : false));
  if (!due)
    take(new RegExp(`\\b(?:on |by |this |next |for )?${WD}\\b`, "i"), (m) => {
      const dow = dowOf(m[1]!);
      if (dow < 0) return false;
      due = nextWeekday(today, dow);
    });
  if (!due)
    take(/\b(?:on |by )?(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?\b/i, (m) => {
      const month = MONTHS.findIndex((name) => name.startsWith(m[1]!.toLowerCase().slice(0, 3)));
      const year = Number(today.slice(0, 4));
      let day = `${year}-${pad(month + 1)}-${pad(Number(m[2]))}`;
      if (!isDay(day)) return false;
      if (daysBetween(today, day) < 0) day = `${year + 1}-${day.slice(5)}`;
      due = day;
    });
  if (!due)
    take(/\b(?:on |by )?(\d{1,2})\/(\d{1,2})\b/, (m) => {
      const year = Number(today.slice(0, 4));
      let day = `${year}-${pad(Number(m[1]))}-${pad(Number(m[2]))}`;
      if (!isDay(day)) return false;
      if (daysBetween(today, day) < 0) day = `${year + 1}-${day.slice(5)}`;
      due = day;
    });

  if (!time)
    take(/\b(?:at |@ ?|by )?(\d{1,2}(?::\d{2})?\s*(?:am|pm|a\.m\.|p\.m\.))(?=\W|$)/i, (m) => {
      const t = parseClock(m[1]!);
      if (!t) return false;
      time = t;
    });
  if (!time)
    take(/\bat (\d{1,2}(?::\d{2})?)\b/i, (m) => {
      const t = parseClock(m[1]!);
      if (!t) return false;
      time = t;
    });
  if (!time) take(/\b(at )?noon\b/i, () => void (time = "12:00"));
  if (!time) take(/\b(in the )?(morning)\b/i, () => void (time = "09:00"));
  if (!time) take(/\b(in the )?(afternoon)\b/i, () => void (time = "14:00"));
  if (!time) take(/\b(in the )?(evening)\b/i, () => void (time = "18:00"));

  // A time alone means its next occurrence: today, unless it has passed (the caller knows "now").
  return { ...(due ? { due } : {}), ...(time ? { time } : {}), ...(recurrence ? { recurrence } : {}), spans };
}

/** Remove the date phrases from a sentence, and tidy what is left. */
export function stripSpans(text: string, spans: string[]): string {
  let out = text;
  for (const span of spans) out = out.replace(span, " ");
  return out
    .replace(/\s+/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\b(on|by|at|for|this|next)\s*$/i, "")
    .replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "")
    .trim();
}

/** The next date a recurring task is due after `from`. */
export function nextOccurrence(from: Day, recurrence: "daily" | "weekdays" | "weekly" | "monthly"): Day {
  if (recurrence === "daily") return addDays(from, 1);
  if (recurrence === "weekly") return addDays(from, 7);
  if (recurrence === "monthly") return addMonths(from, 1);
  let next = addDays(from, 1);
  while (weekday(next) === 0 || weekday(next) === 6) next = addDays(next, 1);
  return next;
}
