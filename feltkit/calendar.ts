/**
 * Calendar: the person's own Google Calendar (primary), connected in Settings → Connections.
 *
 *   upcoming  events in a window of days, in the person's time zone. The chat runs it; no approval.
 *   create    adds one event. From the chat the model only PROPOSES it; the person approves it, then it is
 *             queued and added as them (feltkit/outbox.ts). Times are local to the person's time zone,
 *             which the app fills in, never the model.
 */
import { fail, s } from "@feltdb/feltkit";
import type { ActionCtx } from "@feltdb/feltkit";
import { app, outbox, PROPOSED_BY } from "./app.js";
import { queue } from "./outbox.js";
import { clockFor } from "./_clock.js";
import { after, eventSummaries, instant, isAddress, window, type EventSummary } from "./_google.js";

const DAY = s.string({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const TIME = s.string({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" });

export async function upcomingEvents(ctx: ActionCtx, from: string, days: number, timeZone: string): Promise<EventSummary[]> {
  const { timeMin, timeMax } = window(from, days, timeZone);
  return eventSummaries(await ctx.integrations.invoke("calendar.events", { timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: 50 }));
}

export const upcoming = app.action({
  access: "calendar.read",
  args: { from: s.optional(DAY), days: s.optional(s.integer({ minimum: 1, maximum: 31 })) },
  handler: async (ctx, { from, days }) => {
    const clock = clockFor(ctx.auth.context.timeZone);
    return upcomingEvents(ctx, from ?? clock.today, days ?? 1, clock.timeZone);
  },
});

export const create = app.mutation({
  access: "calendar.write",
  args: {
    title: s.string({ minLength: 1, maxLength: 300 }),
    date: DAY,
    time: TIME,
    durationMinutes: s.optional(s.integer({ minimum: 5, maximum: 1440 })),
    location: s.optional(s.string({ maxLength: 300 })),
    notes: s.optional(s.string({ maxLength: 4000 })),
    attendees: s.optional(s.array(s.string({ maxLength: 254 }), { maxItems: 20 })),
    /** The time zone the date and time are in: filled by the app from the person's clock, never the model. */
    timeZone: s.optional(s.string({ maxLength: 60 })),
    proposedBy: PROPOSED_BY,
  },
  returns: s.doc(outbox),
  capability: { name: "calendar.create", description: "Add an event to the user's connected Google Calendar: title, local date (YYYY-MM-DD) and start time (HH:MM), optional duration in minutes (default 30), location, notes and attendee emails (Google may email them an invitation). Always waits for the user's approval; once approved it is queued and added as them." },
  retry: { sequenceConflicts: 3 },
  handler: async (ctx, { proposedBy, timeZone, ...e }) => {
    const bad = (e.attendees ?? []).filter((a) => !isAddress(a));
    if (bad.length) fail("INVALID_ARGUMENT", `Not an email address: ${bad.join(", ")}.`);
    const zone = validZone(timeZone) ?? clockFor(ctx.auth.context.timeZone).timeZone;
    const minutes = e.durationMinutes ?? 30;
    const [endDay, endTime] = after(e.date, e.time, minutes);
    const payload = {
      title: e.title, date: e.date, time: e.time, durationMinutes: minutes, timeZone: zone,
      start: instant(e.date, e.time, zone), end: instant(endDay, endTime, zone),
      ...(e.location ? { location: e.location } : {}), ...(e.notes ? { notes: e.notes } : {}), ...(e.attendees?.length ? { attendees: e.attendees } : {}),
    };
    return queue(ctx, "calendar.create", `Calendar: ${e.title}, ${e.date} ${e.time} (${zone})`, payload, proposedBy);
  },
});

const validZone = (zone: string | undefined) => {
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
};
