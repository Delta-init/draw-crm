/**
 * Checks that a Bangalore enrolment's money counts in the revenue figures (2026-10-28, utils/bangaloreRevenue.ts, as
 * in the Sales CRM) on a scratch database: rupees at the Settings rate, AED cash (Draw's `currency: "AED"` +
 * `amountInCurrency`) at its AED, the payment already on the lead once, a dropped enrolment not at all, an older close
 * with no payment list by its paid amount — on the leaderboard (and so the Sales TV), the Reports (revenue overview,
 * timelines, team revenue, user and team rankings, sources), the team pages, a user's own revenue and a new rate.
 * What is still owed is not touched. Nothing stored changes.
 *
 * Run by bangalore-revenue-check.sh. Scratch database only.
 */
import { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/e2e|test|scratch/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch database, got "${uri}"`);
  process.exit(1);
}

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}\x1b[0m`); }
}
const section = (s: string) => console.log(`\n${s}`);
const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, JWT_SECRET: "blr-check-jwt", JWT_REFRESH_SECRET: "blr-check-refresh", NODE_ENV: "test", RUN_SCHEDULERS: "false" });

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;

const { LeaderboardService } = await import("../src/services/leaderboardService.js");
const { ReportService } = await import("../src/services/reportService.js");
const { TeamService } = await import("../src/services/teamService.js");
const { getUserRevenue } = await import("../src/controllers/leadController.js");
const { salesTv } = await import("../src/services/salesTvService.js");
const { updateAppSettings, getAppSettings } = await import("../src/services/settingsService.js");
const { updateAppSettingsSchema } = await import("../src/validations/settingsValidation.js");

const id = () => new Types.ObjectId();
const now = new Date(Date.now() - 60_000);
const lastMonth = new Date(Date.now() - 40 * 86_400_000);
const role = id(), ria = id(), ben = id(), team = id();
const [l1, l2, l3, l4, l5] = [id(), id(), id(), id(), id()];

await db.collection("roles").insertOne({ _id: role, roleName: "Sales", isSystemRole: false, permissions: [] });
await db.collection("users").insertMany([
  { _id: ria, name: "Ria", email: "ria@scratch.test", status: "active", role },
  { _id: ben, name: "Ben", email: "ben@scratch.test", status: "active", role },
]);
await db.collection("teams").insertOne({ _id: team, name: "TEAM A", status: "active", members: [ria, ben], leaders: [] });
const lead = (_id: Types.ObjectId, who: Types.ObjectId, payments: unknown[] = [], extra: Record<string, unknown> = {}) =>
  ({ _id, name: `Lead ${_id}`, phone: `+9715${String(_id).slice(-8)}`, status: "closed", assignedTo: who, team, createdAt: now, payments, ...extra });
await db.collection("leads").insertMany([
  // Its 200 AED was on the lead before the Bangalore close (collectedBefore on the enrolment). Sold for AED 5,000: what
  // is still owed stays 5,000 − 200 — the Bangalore money is in rupees on the enrolment's own fee, not this one.
  lead(l1, ria, [{ _id: id(), amount: 200, paidAt: now, note: "Advance" }], { sellingAmount: 5000 }),
  lead(l2, ben, [{ _id: id(), amount: 1000, paidAt: now, note: "Collected at enrolment · Cash" }]),
  lead(l3, ben),
  lead(l4, ria),
  lead(l5, ria),
]);
const student = (leadId: Types.ObjectId, who: Types.ObjectId, extra: Record<string, unknown>) =>
  ({ _id: id(), leadId, assignedTo: who, team, name: "S", enrollmentNumber: `E-${leadId}`, status: "active", enrollmentDate: now, createdAt: now, ...extra });
await db.collection("students").insertMany([
  student(l1, ria, {
    academy: "bangalore", totalFee: 100000, paidAmount: 52325,
    payments: [
      { method: "bank_transfer", amount: 45500, paidAt: now },                                                       // AED 2,000 at 22.75
      { method: "cash", amount: 2275, paidAt: now, currency: "AED", amountInCurrency: 100, exchangeRate: 22.75 },   // AED 100 cash
      { method: "cash", amount: 4550, paidAt: now, collectedBefore: true, currency: "AED", amountInCurrency: 200, exchangeRate: 22.75 },
    ],
  }),
  student(l2, ben, { totalFee: 1000, paidAmount: 1000, payments: [{ method: "cash", amount: 1000, paidAt: now }] }), // Dubai
  student(l3, ben, { academy: "bangalore", status: "dropped", paidAmount: 22750, payments: [{ method: "upi", amount: 22750, paidAt: now }] }),
  student(l4, ria, { academy: "bangalore", enrollmentDate: lastMonth, paidAmount: 22750, payments: [{ method: "upi", amount: 22750, paidAt: lastMonth }] }),
  student(l5, ria, { academy: "bangalore", paidAmount: 11375 }), // an older close: no list
]);

const board = async () => new Map((await new LeaderboardService().getLeaderboard()).rows.map((r) => [r.name, r.revenue]));

section("Leaderboard (and so the Sales TV / Manager TV)");
let b = await board();
check("Ria: 200 on the lead + ₹45,500 → 2,000 + AED 100 cash + older close ₹11,375 → 500 = 2,800", b.get("Ria") === 2800, b.get("Ria"));
check("Ben: his Dubai 1,000 only — the dropped Bangalore enrolment not counted", b.get("Ben") === 1000, b.get("Ben"));
const tv = await salesTv({});
check("Sales TV revenueMonth for Ria is 2,800", tv.people?.find((p) => p.name === "Ria")?.revenueMonth === 2800, tv.people);

section("Reports");
const rs = new ReportService();
const ov = await rs.getRevenueOverview();
check("Revenue overview total 4,800 (all time: + last month's ₹22,750 → 1,000)", ov.totalRevenue === 4800, ov.totalRevenue);
check("6 payments counted", ov.paymentCount === 6, ov.paymentCount);
check("4 paying leads (a lead with its own and Bangalore money once)", ov.payingLeadCount === 4, ov.payingLeadCount);
check("Top agent Ria 3,800; top team TEAM A 4,800", ov.topAgent?.name === "Ria" && ov.topAgent.revenue === 3800 && ov.topTeam?.revenue === 4800, { a: ov.topAgent, t: ov.topTeam });
check("Still owed untouched: 5,000 − 200 = 4,800", ov.totalPending === 4800, ov.totalPending);
const tl = await rs.getRevenueTimeline("monthly");
const tlTotal = tl.timeline.reduce((s: number, r: { total: number }) => s + r.total, 0);
check("Revenue timeline adds to 4,800", tlTotal === 4800, tl.timeline);
const rt = await rs.getRevenueTeams();
const rtRia = (rt[0]?.members as { name: string; revenue: number }[] | undefined)?.find((m) => m.name === "Ria");
check("Revenue teams: TEAM A 4,800, Ria in it 3,800", rt[0]?.revenue === 4800 && rtRia?.revenue === 3800, rt);
const tr = await rs.getTeamRevenue(String(team));
check("Team revenue 4,800", (tr as { totalRevenue?: number }).totalRevenue === 4800, (tr as { totalRevenue?: number }).totalRevenue);
const ttl = await rs.getTeamRevenueTimeline(String(team), "monthly");
const ttlTotal = (ttl.timeline as { total: number }[]).reduce((s, r) => s + r.total, 0);
check("Team revenue timeline adds to 4,800", ttlTotal === 4800, ttl.timeline);
const ranks = await rs.getUserRankings();
const rank = new Map(ranks.map((r) => [r.name as string, r.revenue as number]));
check("User rankings: Ria 3,800, Ben 1,000", rank.get("Ria") === 3800 && rank.get("Ben") === 1000, Object.fromEntries(rank));
const teamRanks = await rs.getTeamRankings();
check("Team rankings: TEAM A 4,800", teamRanks[0]?.totalPayments === 4800, teamRanks);
const sources = await rs.getSourceAnalytics();
check("Source analytics: revenue 4,800", sources.reduce((s, r) => s + r.revenue, 0) === 4800, sources);

section("Team pages and a user's own revenue");
const ts = new TeamService();
const split = new Map((await ts.getTeamMemberSplit(String(team))).map((r) => [r.name as string, r.revenue as number]));
check("Team member split: Ria 3,800, Ben 1,000", split.get("Ria") === 3800 && split.get("Ben") === 1000, Object.fromEntries(split));
const dash = await ts.getTeamDashboard(String(team));
const dashRia = dash.memberRankings.find((m) => String((m.user as { _id: unknown })._id) === String(ria));
check("Team dashboard: Ria's total payments 3,800", dashRia?.totalPayments === 3800, dashRia?.totalPayments);
const member = await ts.getTeamMemberById(String(team), String(ria), String(ria), { isSystemRole: true, roleName: "Super Admin" });
check("Team member page: Ria's total payments 3,800", (member as { stats?: { totalPayments?: number } }).stats?.totalPayments === 3800, (member as { stats?: unknown }).stats);
let mine: { totalRevenue?: number; paymentCount?: number; leadCount?: number } = {};
await getUserRevenue(
  { params: { userId: String(ria) }, query: {} } as never,
  { status() { return this; }, json(body: { data: typeof mine }) { mine = body.data; return this; } } as never,
  (err?: unknown) => { if (err) throw err; },
);
check("Ria's own revenue: 3,800 from 5 payments on 3 leads", mine.totalRevenue === 3800 && mine.paymentCount === 5 && mine.leadCount === 3, mine);

section("A new rate");
check("Default rate 22.75", (await getAppSettings()).bangaloreRevenue.inrPerAed === 22.75);
check("Rate 0 refused", !updateAppSettingsSchema.safeParse({ bangaloreRevenue: { inrPerAed: 0 } }).success);
check("Rate 45.5 accepted", updateAppSettingsSchema.safeParse({ bangaloreRevenue: { inrPerAed: 45.5 } }).success);
await updateAppSettings({ bangaloreRevenue: { inrPerAed: 45.5 } }, String(ria));
check("Saved: rate 45.5", (await getAppSettings()).bangaloreRevenue.inrPerAed === 45.5);
b = await board();
check("At 45.5: Ria 200 + 1,000 + 100 (AED cash, at its AED) + 250 = 1,550", b.get("Ria") === 1550, b.get("Ria"));

section("Nothing stored changed");
const l1Doc = await db.collection("leads").findOne({ _id: l1 });
check("Ria's lead still has its one payment", l1Doc?.payments?.length === 1, l1Doc?.payments);
check("No other lead got payments", (await db.collection("leads").countDocuments({ _id: { $in: [l3, l4, l5] }, "payments.0": { $exists: true } })) === 0);

console.log(`\n${checks - failures}/${checks} passed`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
