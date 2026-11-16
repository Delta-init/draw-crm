/**
 * "Don't count in sales" (services/notCountedService.ts, the user 2026-11-16: "only that 11k, only that closing"),
 * on a scratch database:
 *   1. Who: a Super Admin and the Sales Manager mark and unmark; a team leader, a salesperson cannot. A reason is needed;
 *      only a closed sale (one with an enrolment); not twice.
 *   2. Marked: the close and its money leave every count — the leaderboard (revenue + closings), the Sales TV (people,
 *      today's closings, the latest closes), Reports (revenue overview, user rankings), rewards' closedBy, daily
 *      closings — while another sale of the same person still counts, and the lead, its payments and the enrolment stay.
 *   3. Its commission sale is reversed with the reason; one finance had voided stays as finance left it.
 *   4. Counted again: every figure back, the commission sale back in the state it had; the lead's history says both.
 *
 * Run by not-counted-check.sh. Scratch database only.
 */
import { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/e2e|test|scratch/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch database, got "${uri}"`);
  process.exit(1);
}
let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const section = (s: string) => console.log(`\n${s}`);
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 400);

const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "not-counted-check-jwt-0123456789", JWT_REFRESH_SECRET: "not-counted-check-refresh-0123456789",
  NODE_ENV: "test", RUN_SCHEDULERS: "false",
  THREECX_URL: "", THREECX_CLIENT_ID: "", THREECX_API_KEY: "", HRMS_API_URL: "", HRMS_CLIENT_ID: "", HRMS_INTEGRATION_SECRET: "",
});
const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;

const GST = 4 * 3_600_000;
const now = Date.now();
const ago = (min: number) => new Date(now - min * 60_000);
const month = new Date(now + GST).toISOString().slice(0, 7);

const staffRole = new Types.ObjectId(), superRole = new Types.ObjectId();
await db.collection("roles").insertMany([
  { _id: staffRole, roleName: "Sales Staff", isSystemRole: false, permissions: {} },
  { _id: superRole, roleName: "Super Admin", isSystemRole: true, permissions: {} },
]);
const u = (name: string, role = staffRole) => ({ _id: new Types.ObjectId(), name, email: `${name.split(" ")[0].toLowerCase()}@t.local`, password: "x", role, status: "active" });
const jerin = u("Jerin Lead"), anna = u("Anna Ace"), sam = u("Sam Manager"), sue = u("Sue Super", superRole);
await db.collection("users").insertMany([jerin, anna, sam, sue]);
await db.collection("teams").insertOne({ _id: new Types.ObjectId(), name: "DRAW 1", leaders: [jerin._id], members: [anna._id], status: "active", settings: {} });
await db.collection("commissionsettings").insertOne({ key: "default", excludedUsers: [], fullViewers: [], salesManager: sam._id });
const course = new Types.ObjectId();
await db.collection("courses").insertOne({ _id: course, name: "Mastering Forex", isActive: true });

const lead = (who: { _id: Types.ObjectId }, amounts: number[], name: string) => ({
  _id: new Types.ObjectId(), name, phone: `+97150${Math.floor(Math.random() * 1e7)}`, status: "closed", assignedTo: who._id, assignedAt: ago(600),
  payments: amounts.map((a, i) => ({ _id: new Types.ObjectId(), amount: a, paidAt: ago(30 + i), addedBy: who._id })),
  notes: [], activityLogs: [], reminders: [], followUps: [], createdAt: ago(600), updatedAt: ago(30),
});
const big = lead(jerin, [6000, 5000], "Big close");      // the AED 11,000 close, in two payments
const small = lead(jerin, [2000], "Small close");        // Jerin's other sale: still counts
const annaLead = lead(anna, [1500], "Anna close");
const open = { ...lead(anna, [], "Open lead"), status: "followup" }; // no enrolment
await db.collection("leads").insertMany([big, small, annaLead, open]);
const stu = (l: { _id: Types.ObjectId; assignedTo: Types.ObjectId; name: string }, fee: number) => ({
  _id: new Types.ObjectId(), leadId: l._id, name: `S ${l.name}`, email: `${String(l._id)}@s.local`, phone: "+971500000000", courses: [course],
  assignedTo: l.assignedTo, totalFee: fee, paidAmount: fee, academy: "dubai", status: "active", enrollmentDate: ago(25), createdAt: ago(25), updatedAt: ago(25),
});
const bigS = stu(big, 11000), smallS = stu(small, 2000), annaS = stu(annaLead, 1500);
await db.collection("students").insertMany([bigS, smallS, annaS]);
await db.collection("commissionsales").insertMany([
  { _id: new Types.ObjectId(), student: bigS._id, saleDate: ago(25), month, state: "counted", reason: "", lines: [], plan: {} },
  { _id: new Types.ObjectId(), student: smallS._id, saleDate: ago(25), month, state: "reversed", reason: "Invoice IN-9 was voided in finance", lines: [], plan: {} },
]);

// Every model registered, as the API has them (populate needs Role, Course …).
await import("../src/routes/index.js");
const svc = await import("../src/services/notCountedService.js");
const { LeaderboardService } = await import("../src/services/leaderboardService.js");
const { salesTv } = await import("../src/services/salesTvService.js");
const { ReportService } = await import("../src/services/reportService.js");
const { closedBy } = await import("../src/services/rewardsService.js");
const { StudentService } = await import("../src/services/studentService.js");
const role = (id: Types.ObjectId) => ({ _id: id, roleName: id.equals(superRole) ? "Super Admin" : "Sales Staff", isSystemRole: id.equals(superRole) } as any);
const as = (p: { _id: Types.ObjectId; role: Types.ObjectId }) => ({ userId: String(p._id), role: role(p.role) });

const figures = async () => {
  const board = await new LeaderboardService().getLeaderboard(month, "revenue", { withSuperAdmins: true });
  const row = board.rows.find((r: any) => r.userId === String(jerin._id)) as any;
  const tv = await salesTv({});
  const tvJ = tv.people?.find((p: any) => p.id === String(jerin._id)) as any;
  const overview = await new ReportService().getRevenueOverview();
  const ranks = await new ReportService().getUserRankings();
  const rank = (ranks as any[]).find?.((r: any) => String(r.userId ?? r._id) === String(jerin._id)) ?? (ranks as any)?.rankings?.find?.((r: any) => String(r.userId ?? r._id) === String(jerin._id));
  const daily = await new StudentService().listDailyClosings({});
  return {
    revenue: row?.revenue, closings: row?.closings,
    tvRevenue: tvJ?.revenueMonth, tvClosings: tvJ?.closingsMonth, tvToday: tvJ?.closingsToday,
    tvCloses: tv.closes.filter((c: any) => c.closerEmail === jerin.email).length,
    reportTotal: (overview as any).totalRevenue,
    rankRevenue: rank?.revenue ?? rank?.totalRevenue,
    rewards: await closedBy([jerin._id], month),
    dailyCount: (daily as any).totals?.count,
  };
};

section("Before");
const before = await figures();
check("Jerin: AED 13,000 and 2 closings everywhere", before.revenue === 13000 && before.closings === 2 && before.tvRevenue === 13000 && before.tvClosings === 2
  && before.tvToday === 2 && before.tvCloses === 2 && before.rankRevenue === 13000 && before.reportTotal === 14500 && before.rewards === 13000 && before.dailyCount === 3, j(before));

section("1. Who");
let err = "";
try { await svc.markNotCounted(String(big._id), as(anna), "Not a sale"); } catch (e) { err = `${(e as any).status} ${(e as Error).message}`; }
check("a salesperson: refused", /^403/.test(err), err);
err = ""; try { await svc.markNotCounted(String(big._id), as(jerin), "Not a sale"); } catch (e) { err = `${(e as any).status}`; }
check("a team leader: refused", err === "403", err);
err = ""; try { await svc.markNotCounted(String(big._id), as(sam), " x "); } catch (e) { err = `${(e as any).status}`; }
check("no real reason: refused", err === "400", err);
err = ""; try { await svc.markNotCounted(String(open._id), as(sam), "Not a sale"); } catch (e) { err = `${(e as any).status} ${(e as Error).message}`; }
check("a lead with no enrolment: refused", /^409 Only a closed sale/.test(err), err);
const st = await svc.notCountedStatus(String(big._id), as(anna));
check("the lead page asks: a close, this person may not change it", st.closed && !st.mayMark && st.notCountedInSales === null && st.amount === 11000, j(st));

section("2. Marked by the Sales Manager");
const marked = await svc.markNotCounted(String(big._id), as(sam), "Closed by the team leader — not a sales close");
check("marked: who, when, why; AED 11,000 held back", marked.notCountedInSales?.byName === "Sam Manager" && /team leader/.test(marked.notCountedInSales?.reason ?? "") && marked.amount === 11000, j(marked));
err = ""; try { await svc.markNotCounted(String(big._id), as(sue), "Again"); } catch (e) { err = `${(e as any).status}`; }
check("not twice", err === "409", err);
const after = await figures();
check("leaderboard: Jerin AED 2,000 and 1 closing", after.revenue === 2000 && after.closings === 1, j(after));
check("Sales TV / Manager TV: AED 2,000, 1 closing this month and today", after.tvRevenue === 2000 && after.tvClosings === 1 && after.tvToday === 1, j(after));
check("…and the latest closes: only his other one", after.tvCloses === 1, j(after));
check("Reports: total revenue less AED 11,000", after.reportTotal === 3500, j(after));
check("Reports: user rankings less AED 11,000", after.rankRevenue === 2000, j(after));
check("rewards: AED 2,000", after.rewards === 2000, j(after));
check("daily closings: one fewer", after.dailyCount === 2, j(after));
const bigNow = await db.collection("leads").findOne({ _id: big._id }) as any;
check("the lead and its payments stay, each payment marked", bigNow.payments.length === 2 && bigNow.payments.every((p: any) => p.notCounted === true) && bigNow.status === "closed");
check("…its history says so", bigNow.activityLogs.some((a: any) => a.action === "sale_not_counted" && /team leader/.test(a.description)));
check("the enrolment stays, marked", (await db.collection("students").findOne({ _id: bigS._id }) as any)?.notCountedInSales?.byName === "Sam Manager");

section("3. Commission");
const cs = await db.collection("commissionsales").findOne({ student: bigS._id }) as any;
check("its commission sale reversed, with the reason, the state it had kept", cs.state === "reversed" && /^Not counted in sales: Closed by/.test(cs.reason) && cs.notCountedFrom === "counted", j(cs));
await svc.markNotCounted(String(small._id), as(sue), "Testing a voided one");
const voided = await db.collection("commissionsales").findOne({ student: smallS._id }) as any;
check("one finance had voided: left as finance left it", voided.state === "reversed" && /voided in finance/.test(voided.reason) && !voided.notCountedFrom, j(voided));
await svc.markCounted(String(small._id), as(sue));
const voidedBack = await db.collection("commissionsales").findOne({ student: smallS._id }) as any;
check("…and counting it again does not undo finance's void", voidedBack.state === "reversed" && /voided in finance/.test(voidedBack.reason), j(voidedBack));

section("4. Counted again");
err = ""; try { await svc.markCounted(String(big._id), as(anna)); } catch (e) { err = `${(e as any).status}`; }
check("a salesperson may not", err === "403", err);
const back = await svc.markCounted(String(big._id), as(sue));
check("a Super Admin counts it again", back.notCountedInSales === null, j(back));
const again = await figures();
check("every figure back as it was", JSON.stringify(again) === JSON.stringify(before), `${j(before)} vs ${j(again)}`);
const csBack = await db.collection("commissionsales").findOne({ student: bigS._id }) as any;
check("its commission sale back to counted", csBack.state === "counted" && !csBack.notCountedFrom && !csBack.reversedAt && csBack.reason === "", j(csBack));
const bigBack = await db.collection("leads").findOne({ _id: big._id }) as any;
check("payments unmarked, history says both", bigBack.payments.every((p: any) => p.notCounted === undefined) && !bigBack.notCountedInSales
  && bigBack.activityLogs.some((a: any) => a.action === "sale_counted"));
err = ""; try { await svc.markCounted(String(big._id), as(sue)); } catch (e) { err = `${(e as any).status}`; }
check("counting it again twice: said so", err === "409", err);

await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
