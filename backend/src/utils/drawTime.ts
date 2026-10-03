/* ─────────────────────────────────────────────────────────────────────────────
   Days on Draw's clock: midnight to midnight in DRAW_TZ.

   Date filters arrive as calendar dates (YYYY-MM-DD, from the web's presets and
   pickers, which read the same calendar — delta/lib/drawDates.ts; change the
   zone there too if it changes here). They used to be read as UTC days, so
   whatever came in during the hours the two calendars disagree counted on the
   day before, and charts split their days at that hour instead of midnight.
   Every range and every daily, weekly or monthly bucket now follows Draw's
   calendar.
───────────────────────────────────────────────────────────────────────────── */

/** Draw's business day: UAE time, as the rest of Draw runs (reminders, a team's "today", lead splits).
    One place to change it — with its fixed UTC offset (the UAE keeps no daylight saving). */
export const DRAW_TZ = "Asia/Dubai";
const DRAW_OFFSET = "+04:00";
const OFFSET_MS = 4 * 60 * 60_000;

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar date (YYYY-MM-DD) an instant falls on, on Draw's clock. */
export function drawDateOf(at: Date): string {
  return new Date(at.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/** Today on Draw's calendar. */
export function drawToday(now: Date = new Date()): string {
  return drawDateOf(now);
}

/** The day a filter value names: a YYYY-MM-DD as written, a timestamp by the day it falls on. Null if it is neither. */
function drawDay(value: string): string | null {
  if (CALENDAR_DATE.test(value)) return value;
  const at = new Date(value);
  return isNaN(at.getTime()) ? null : drawDateOf(at);
}

/** When that day begins. */
export function drawDayStart(value: string): Date | null {
  const day = drawDay(value);
  return day ? new Date(`${day}T00:00:00.000${DRAW_OFFSET}`) : null;
}

/** The last millisecond of that day. */
export function drawDayEnd(value: string): Date | null {
  const day = drawDay(value);
  return day ? new Date(`${day}T23:59:59.999${DRAW_OFFSET}`) : null;
}

/** A $gte/$lte range covering whole days from `from` to `to`; an end that is missing or not a date is left open. */
export function drawDayRange(from?: string, to?: string): { $gte?: Date; $lte?: Date } {
  const range: { $gte?: Date; $lte?: Date } = {};
  const start = from ? drawDayStart(from) : null;
  const end = to ? drawDayEnd(to) : null;
  if (start) range.$gte = start;
  if (end) range.$lte = end;
  return range;
}

/** When this month began, on Draw's calendar. */
export function drawMonthStart(now: Date = new Date()): Date {
  return new Date(`${drawToday(now).slice(0, 7)}-01T00:00:00.000${DRAW_OFFSET}`);
}
