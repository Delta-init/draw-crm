/**
 * Days on Draw's clock (utils/drawTime.ts), against a real database.
 *
 * Draw's filters and charts used to count UTC days: "This Month" took in the
 * last day of the month before, and whatever came in during the hours the two
 * calendars disagree landed on the wrong day. Every instant below is placed in
 * those hours, so each check fails on the old reading:
 *   A. the helpers: a calendar date is a whole day on Draw's clock, a timestamp
 *      names the day it falls on, and nonsense is no bound at all;
 *   B. reports: a month's leads, its daily and monthly buckets and its revenue
 *      are that month's on Draw's calendar — nothing from either side of it;
 *   C. the leads page's revenue card: Today, This Week, This Month and This
 *      Year by Draw's calendar, whatever the server's clock.
 *
 * Scratch database only — run through scripts/draw-dates-e2e.sh. Anywhere else
 * (a plain `bun test`, with the live .env) it skips, touching nothing.
 */
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import mongoose, { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
const scratch = /127\.0\.0\.1|localhost/.test(uri) && /e2e/.test(uri);

// Imported only against a scratch database: the services read the configuration as they load.
const load = async () => ({
  ...(await import("../src/utils/drawTime.js")),
  ...(await import("../src/services/reportService.js")),
  ...(await import("../src/models/Lead.js")),
  ...(await import("../src/controllers/leadController.js")),
});
let m: Awaited<ReturnType<typeof load>>;

/** `minutes` after the start of `day` on Draw's clock — negative for the day before. */
const at = (day: string, minutes: number) => new Date(m.drawDayStart(day)!.getTime() + minutes * 60_000);
const agent = new Types.ObjectId();

describe.skipIf(!scratch)("Days on Draw's clock (run scripts/draw-dates-e2e.sh)", () => {
beforeAll(async () => {
  m = await load();
  await mongoose.connect(uri);
  await mongoose.connection.dropDatabase();
  const lead = (name: string, createdAt: Date, extra: Record<string, unknown> = {}) => ({
    name, phone: "0500000000", status: "new", assignedTo: agent, reporter: agent, createdAt, updatedAt: createdAt, ...extra,
  });
  await m.Lead.collection.insertMany([
    lead("Sept, last half hour",  at("2026-10-01", -30)),
    lead("Oct 1, 00:30",          at("2026-10-01", 30)),
    lead("Oct 1, 02:00",          at("2026-10-01", 120)),
    lead("Oct 1, 10:00",          at("2026-10-01", 600)),
    lead("Oct 31, 23:59",         at("2026-11-01", -1)),
    lead("Nov 1, 01:00",          at("2026-11-01", 60)),
    lead("Paying", at("2026-09-15", 600), {
      payments: [
        { amount: 100, paidAt: at("2026-10-01", 60) },    // Oct 1, 01:00
        { amount: 50,  paidAt: at("2026-10-01", -60) },   // Sept 30, 23:00
        { amount: 25,  paidAt: at("2026-11-01", 30) },    // Nov 1, 00:30
        { amount: 10,  paidAt: at("2026-10-31", 600) },   // Oct 31, 10:00
      ],
    }),
  ]);
});

afterAll(async () => {
  setSystemTime();
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect();
});

test("A. a calendar date is a whole day on Draw's clock", () => {
  const start = m.drawDayStart("2026-10-01")!;
  const end = m.drawDayEnd("2026-10-01")!;
  expect(end.getTime() - start.getTime()).toBe(24 * 60 * 60 * 1000 - 1);
  expect(m.drawDateOf(start)).toBe("2026-10-01");
  expect(m.drawDateOf(new Date(start.getTime() - 1))).toBe("2026-09-30");
  // A timestamp names the day it falls on, on Draw's clock.
  expect(m.drawDayStart(at("2026-10-01", 30).toISOString())!.getTime()).toBe(start.getTime());
  // Nonsense is no bound at all, rather than an invalid date in a query.
  expect(m.drawDayStart("not a date")).toBeNull();
  expect(m.drawDayRange("not a date", undefined)).toEqual({});
  expect(m.drawDayRange(undefined, "2026-10-31")).toEqual({ $lte: m.drawDayEnd("2026-10-31")! });
});

test("B. October's leads are October's on Draw's calendar", async () => {
  const overview = await new m.ReportService().getOverview("2026-10-01", "2026-10-31");
  // Oct 1 00:30, 02:00, 10:00 and Oct 31 23:59 — not Sept 30's last half hour, not Nov 1 01:00
  // (and not the paying lead, created in September).
  expect(overview.summary.total).toBe(4);
});

test("B. daily and monthly buckets split at Draw's midnight", async () => {
  const daily = await new m.ReportService().getTimeline("daily", "2026-10-01", "2026-10-31");
  expect(Object.fromEntries(daily.map((r) => [r.label, r.total]))).toEqual({ "2026-10-01": 3, "2026-10-31": 1 });
  const monthly = await new m.ReportService().getTimeline("monthly", "2026-09-01", "2026-11-30");
  expect(Object.fromEntries(monthly.map((r) => [r.label, r.total]))).toEqual({ "Sep '26": 2, "Oct '26": 4, "Nov '26": 1 });
});

test("B. October's revenue is what was paid in October on Draw's calendar", async () => {
  const revenue = await new m.ReportService().getRevenueOverview("2026-10-01", "2026-10-31");
  expect(revenue.totalRevenue).toBe(100 + 10);
  const { timeline } = await new m.ReportService().getRevenueTimeline("daily", "2026-10-01", "2026-10-31");
  expect(Object.fromEntries(timeline.map((r) => [r.label, r.total]))).toEqual({ "2026-10-01": 100, "2026-10-31": 10 });
});

test("C. the revenue card's periods follow Draw's calendar, whatever the server's clock", async () => {
  // Sunday 4 Oct, 03:00 on Draw's clock — still the 3rd in UTC.
  setSystemTime(at("2026-10-04", 180));
  const ask = async (period: string) => {
    let body: { data?: { totalRevenue: number; dateFrom: string; dateTo: string } } = {};
    const res = { status() { return res; }, json(b: typeof body) { body = b; return res; } };
    await m.getUserRevenue({ params: { userId: String(agent) }, query: { period } } as never, res as never, (e: unknown) => { throw e; });
    const d = body.data!;
    return { from: m.drawDateOf(new Date(d.dateFrom)), to: m.drawDateOf(new Date(d.dateTo)), revenue: d.totalRevenue };
  };
  expect(await ask("today")).toEqual({ from: "2026-10-04", to: "2026-10-04", revenue: 0 });
  expect(await ask("week")).toEqual({ from: "2026-09-28", to: "2026-10-04", revenue: 100 + 50 });   // Sept 30's payment is in this week
  expect(await ask("month")).toEqual({ from: "2026-10-01", to: "2026-10-31", revenue: 110 });
  expect(await ask("year")).toEqual({ from: "2026-01-01", to: "2026-12-31", revenue: 185 });
  setSystemTime();
});
});
