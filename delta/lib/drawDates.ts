/* ─────────────────────────────────────────────────────────────────────────────
   Calendar dates on Draw's clock, whatever the browser's clock says.

   The date filters used to take a local Date and write it out with
   toISOString(), which gives the UTC date — in India and in the UAE, the day
   before until the early morning. So "This Month" began on the last day of the
   previous month (and a month-end's sales landed in the new month), and
   "Today" was still yesterday in the small hours. Every preset now reads
   Draw's calendar: the same days the server counts in (backend
   utils/drawTime.ts — change the zone there too if it changes here).
───────────────────────────────────────────────────────────────────────────── */

/** Draw's business day: UAE time, as the rest of Draw runs (reminders, a team's "today", lead splits). One place to change it. */
export const DRAW_TZ = "Asia/Dubai";

const DAY = new Intl.DateTimeFormat("en-GB", { timeZone: DRAW_TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** YYYY-MM-DD of the day `at` falls on, on Draw's calendar. */
export function drawDate(at: Date = new Date()): string {
  const part = (type: string) => DAY.formatToParts(at).find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** A YYYY-MM-DD moved by whole days: calendar arithmetic, no clock involved. */
function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
}

export type DrawPreset = "today" | "week" | "month" | "quarter" | "year";

/**
 * From and to, both YYYY-MM-DD on Draw's calendar, for a preset ending today.
 * A week starts on Monday unless `weekStartsOn` is 0 (Sunday).
 */
export function drawRange(preset: DrawPreset, opts: { weekStartsOn?: 0 | 1 } = {}): { from: string; to: string } {
  const today = drawDate();
  const [y, m, d] = today.split("-").map(Number) as [number, number, number];
  const pad = (n: number) => String(n).padStart(2, "0");
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "week": {
      const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 is Sunday
      return { from: addDays(today, -(opts.weekStartsOn === 0 ? dow : (dow + 6) % 7)), to: today };
    }
    case "month":
      return { from: `${y}-${pad(m)}-01`, to: today };
    case "quarter":
      return { from: `${y}-${pad(Math.floor((m - 1) / 3) * 3 + 1)}-01`, to: today };
    case "year":
      return { from: `${y}-01-01`, to: today };
  }
}
