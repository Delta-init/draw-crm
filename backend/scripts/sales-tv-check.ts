/**
 * GET /api/v1/service/sales-tv (services/salesTvService.ts) — what this CRM tells the Root portal's Sales TV, the same
 * shape as the Sales CRM's — through the API with the portal secret, on a scratch database:
 *   - the secret: none or a wrong one refused; not configured → off (503);
 *   - the shape, exactly: crm "draw", generatedAt, month, onBreak, closes, people — and parts=live only the first four;
 *   - people: the sales staff only (an active team's members and leaders, active — not a Super Admin, not someone in
 *     no team or only in an inactive team, not someone excluded from commission, not a deactivated account), this
 *     month's and today's (Dubai) closings, this month's revenue, today's 3CX calls, connected and talk time; ordered
 *     by closings;
 *   - on a break now: today's, not yesterday's, not a deactivated account's; a break taken with the button shows;
 *   - closes: after `after`, else the last two hours, never more than a day back, the newest 20; never the student's
 *     name; the courses, the amount and its currency, the academy, the closer and their email.
 *
 * Run by sales-tv-check.sh. Scratch database only.
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
const j = (v: unknown) => String(JSON.stringify(v)).slice(0, 500);
const keys = (o: unknown) => (o && typeof o === "object" ? Object.keys(o).sort().join() : "");

const SECRET = "sales-tv-check-secret-long-enough-0123";
const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "sales-tv-check-jwt-0123456789", JWT_REFRESH_SECRET: "sales-tv-check-refresh-0123456789",
  NODE_ENV: "test", RUN_SCHEDULERS: "false", ROOT_ERP_SECRET: SECRET,
  THREECX_URL: "", THREECX_CLIENT_ID: "", THREECX_API_KEY: "", HRMS_API_URL: "", HRMS_CLIENT_ID: "", HRMS_INTEGRATION_SECRET: "",
});
const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;

// Draw's day: Dubai (UTC+4 all year) — utils/drawTime.ts.
const GST = 4 * 3_600_000;
const now = Date.now();
const dubaiDay = (t: number) => new Date(t + GST).toISOString().slice(0, 10);
const today = dubaiDay(now);
const dayAt = (n: number, h: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000 + h * 3_600_000 - GST);
const ago = (min: number) => new Date(now - min * 60_000);
const isToday = (d: Date) => dubaiDay(d.getTime()) === today;
const thisMonth = (d: Date) => dubaiDay(d.getTime()).slice(0, 7) === today.slice(0, 7);

const staffRole = new Types.ObjectId(), superRole = new Types.ObjectId();
await db.collection("roles").insertMany([
  { _id: staffRole, roleName: "Sales Staff", isSystemRole: false, permissions: {} },
  { _id: superRole, roleName: "Super Admin", isSystemRole: true, permissions: {} },
]);
type Seeded = { _id: Types.ObjectId; name: string; email: string; extension?: string };
const u = (name: string, role = staffRole, x: Record<string, unknown> = {}) =>
  ({ _id: new Types.ObjectId(), name, email: `${name.split(" ")[0].toLowerCase()}@t.local`, password: "x", role, status: "active", ...x }) as Seeded & Record<string, unknown>;
const anna = u("Anna Ace", staffRole, { extension: "101" });
const ben = u("Ben Bee", staffRole, { extension: "102", breakSince: ago(15), breakKind: "lunch" });
const lena = u("Lena Lead", staffRole, { breakSince: dayAt(-1, 14), breakKind: "tea" }); // yesterday's break: not now
const boss = u("Boss Super", superRole);                                                 // a Super Admin in the team: on the TV
const sid = u("Sid Outside", superRole);                                                 // a Super Admin in no team: not
const loner = u("Loner Nobody");                                                         // in no team
const xena = u("Xena Excluded");                                                         // excluded from commission
const ina = u("Ina Inactive", staffRole, { status: "inactive", breakSince: ago(5), breakKind: "tea" }); // deactivated
const olly = u("Olly Oldteam");                                                          // only in an inactive team
await db.collection("users").insertMany([anna, ben, lena, boss, loner, xena, ina, olly, sid]);
await db.collection("teams").insertMany([
  { _id: new Types.ObjectId(), name: "TEAM TITAN", leaders: [lena._id], members: [anna._id, ben._id, boss._id, xena._id, ina._id], status: "active", settings: {} },
  { _id: new Types.ObjectId(), name: "TEAM GONE", leaders: [], members: [olly._id, anna._id], status: "inactive", settings: {} },
]);
await db.collection("commissionsettings").insertOne({ key: "default", excludedUsers: [xena._id], fullViewers: [] });
const forex = new Types.ObjectId(), pa = new Types.ObjectId();
await db.collection("courses").insertMany([{ _id: forex, name: "Mastering Forex", isActive: true }, { _id: pa, name: "Price Action", isActive: true }]);
const stu = (name: string, who: Seeded, created: Date, x: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(), name, email: `${name.toLowerCase()}@s.local`, phone: "+971500000000", courses: [forex], assignedTo: who._id, totalFee: 5000, academy: "dubai",
  status: "active", enrollmentDate: created, createdAt: created, updatedAt: created, ...x,
});
const seededStudents = [
  stu("Student1", anna, ago(30), { courses: [forex, pa] }),              // recent, two courses
  stu("Student2", anna, dayAt(-3, 12)),                                  // three days ago
  stu("Student3", ben, ago(10), { academy: "bangalore", totalFee: 90000 }), // recent, Bangalore (INR)
  stu("Student4", boss, ago(20)),                                        // a super admin's close: a close, not a person on the board
  stu("Dropped", anna, ago(5), { status: "dropped" }),                   // dropped: no
  stu("Old", ben, ago(60 * 5)),                                          // 5 hours ago: not in the last 2 h
  stu("Xclose", xena, ago(25)),                                          // excluded from commission: still a close
];
await db.collection("students").insertMany(seededStudents);
const closingsOf = (who: Seeded, when: (d: Date) => boolean) =>
  seededStudents.filter((s) => String(s.assignedTo) === String(who._id) && s.status !== "dropped" && when(s.enrollmentDate)).length;
// Revenue: payments on the leads each person holds (the Leaderboard's rule).
await db.collection("leads").insertOne({
  _id: new Types.ObjectId(), name: "Paying lead", phone: "+971511111111", status: "closed", assignedTo: anna._id, assignedAt: ago(600),
  payments: [{ _id: new Types.ObjectId(), amount: 1200, paidAt: ago(60) }], notes: [], activityLogs: [], reminders: [], followUps: [], createdAt: ago(600), updatedAt: ago(60),
});
let k = 0;
const call = (who: Seeded, at: Date, o: Record<string, unknown> = {}) => ({
  key: `k${++k}`, callId: `c${k}`, segmentId: "", startedAt: at, direction: "out", status: "answered", answered: true, talkSeconds: 60, ringSeconds: 5,
  extension: who.extension ?? "", user: who._id, userName: who.name, number: "971", numberKey: "1", recordingIds: [], rows: 1, lead: null,
  syncedAt: new Date(), createdAt: new Date(), updatedAt: new Date(), ...o,
});
const calls = [
  call(anna, ago(40)), call(anna, ago(35), { status: "no_answer", answered: false, talkSeconds: 0 }), call(ben, ago(50), { talkSeconds: 300 }),
  call(anna, dayAt(-1, 11)), // yesterday: not today
];
await db.collection("lead_calls").insertMany(calls);
const callsOf = (who: Seeded) => calls.filter((c) => String(c.user) === String(who._id) && isToday(c.startedAt as Date));

const express = (await import("express")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { env } = await import("../src/config/env.js");
const { signAccessToken } = await import("../src/utils/jwt.js");
const app = express();
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
async function get(path: string, secret: string | null = SECRET) {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/service${path}`, { headers: secret === null ? {} : { "x-portal-secret": secret } });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as { data?: Any; message?: string } };
}

section("The secret");
check("no secret: 401", (await get("/sales-tv", null)).status === 401);
check("a wrong one: 401", (await get("/sales-tv", "wrong-secret-0123456789")).status === 401);
check("a wrong one of the right length: 401", (await get("/sales-tv", SECRET.replace(/.$/, "X"))).status === 401);
env.ROOT_ERP_SECRET = "";
check("not configured on this server: off (503), even with the old secret", (await get("/sales-tv")).status === 503);
env.ROOT_ERP_SECRET = SECRET;

section("The shape");
const all = await get("/sales-tv");
const d = all.body.data ?? {};
check("answers: crm draw, generatedAt, this month named", all.status === 200 && d.crm === "draw" && !Number.isNaN(Date.parse(d.generatedAt)) && d.month === today.slice(0, 7), j(all.body));
check("exactly: closes, crm, generatedAt, month, onBreak, people", keys(d) === "closes,crm,generatedAt,month,onBreak,people", keys(d));
check("a person: id, name, email, team, closings month/today, revenue month, calls/connected/talk today — nothing else",
  keys(d.people?.[0]) === "callsToday,closingsMonth,closingsToday,connectedToday,email,id,name,revenueMonth,talkSecondsToday,team", keys(d.people?.[0]));
check("a break: id, name, email, team, since, kind", keys(d.onBreak?.[0]) === "email,id,kind,name,since,team", keys(d.onBreak?.[0]));
check("a close: id, closer, closerEmail, courses, amount, academy, currency, at — nothing else",
  keys(d.closes?.[0]) === "academy,amount,at,closer,closerEmail,courses,currency,id", keys(d.closes?.[0]));

section("People — the sales staff only");
const names = (d.people ?? []).map((p: Any) => p.name);
check("Anna, Ben, Boss (a Super Admin in the team), Lena — not the Super Admin in no team, not someone in no team, not the excluded one, not the deactivated one, not one only in an inactive team",
  [...names].sort().join() === "Anna Ace,Ben Bee,Boss Super,Lena Lead", j(names));
{
  const { LeaderboardService } = await import("../src/services/leaderboardService.js");
  const own = (await new LeaderboardService().getLeaderboard()).rows.map((r) => r.name);
  check("the CRM's own leaderboard still leaves every Super Admin out", !own.includes("Boss Super") && !own.includes("Sid Outside"), j(own));
}
const P = (n: string) => (d.people ?? []).find((p: Any) => p.name === n);
const A = P("Anna Ace"), B = P("Ben Bee"), L = P("Lena Lead");
check(`Anna: closings today ${closingsOf(anna, isToday)}, this month ${closingsOf(anna, thisMonth)} — not the dropped one`,
  A?.closingsToday === closingsOf(anna, isToday) && A?.closingsMonth === closingsOf(anna, thisMonth), j(A));
check(`Anna: revenue this month ${thisMonth(ago(60)) ? 1200 : 0} (the payment on her lead)`, A?.revenueMonth === (thisMonth(ago(60)) ? 1200 : 0), j(A));
const ac = callsOf(anna);
check(`Anna: today's calls ${ac.length}, connected ${ac.filter((c) => c.status === "answered").length}, talk ${ac.reduce((n, c) => n + Number(c.talkSeconds), 0)} s — not yesterday's`,
  A?.callsToday === ac.length && A?.connectedToday === ac.filter((c) => c.status === "answered").length && A?.talkSecondsToday === ac.reduce((n, c) => n + Number(c.talkSeconds), 0), j(A));
check(`Ben: closings today ${closingsOf(ben, isToday)} (the 5-hour-old one counts when it was today), ${callsOf(ben).length} call of 300 s; his team named`,
  B?.closingsToday === closingsOf(ben, isToday) && B?.callsToday === callsOf(ben).length && B?.talkSecondsToday === (callsOf(ben).length ? 300 : 0) && B?.team === "TEAM TITAN", j(B));
check("Lena, the team's leader: there, nothing counted", L?.team === "TEAM TITAN" && L?.closingsMonth === 0 && L?.callsToday === 0, j(L));
check("ordered by closings this month", (d.people ?? []).every((p: Any, i: number, a: Any[]) => i === 0 || a[i - 1].closingsMonth >= p.closingsMonth), j((d.people ?? []).map((p: Any) => [p.name, p.closingsMonth])));
check("each with an email for the photo", !!A?.email && /@t\.local$/.test(A.email) && B?.email === "ben@t.local");

section("On a break now");
check("Ben, on a lunch break since 15 minutes — not Lena's from yesterday, not the deactivated Ina's",
  (d.onBreak ?? []).length === 1 && d.onBreak[0].name === "Ben Bee" && d.onBreak[0].kind === "lunch" && d.onBreak[0].team === "TEAM TITAN"
  && Math.abs(Date.parse(d.onBreak[0].since) - ago(15).getTime()) < 1000, j(d.onBreak));
const annaToken = signAccessToken({ userId: String(anna._id), email: anna.email, roleId: String(staffRole) });
const take = await fetch(`http://127.0.0.1:${port}/api/v1/break`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${annaToken}` }, body: JSON.stringify({ on: true, kind: "meeting" }) });
const afterTake = await get("/sales-tv?parts=live");
const annaBreak = (afterTake.body.data?.onBreak ?? []).find((b: Any) => b.name === "Anna Ace");
check("Anna presses Take break (meeting) → on the TV, with her team and email", take.status === 200 && annaBreak?.kind === "meeting" && annaBreak?.team === "TEAM TITAN" && annaBreak?.email === "anna@t.local", j(afterTake.body.data?.onBreak));
await fetch(`http://127.0.0.1:${port}/api/v1/break`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${annaToken}` }, body: JSON.stringify({ on: false }) });
check("…End break → off it", !((await get("/sales-tv?parts=live")).body.data?.onBreak ?? []).some((b: Any) => b.name === "Anna Ace"));

section("Closes");
const closes = d.closes ?? [];
check("the last two hours' closes, newest first: Ben's, the super admin's, the excluded one's, Anna's — not the dropped, not 5 hours ago",
  closes.map((c: Any) => c.closer).join() === "Ben Bee,Boss Super,Xena Excluded,Anna Ace", j(closes.map((c: Any) => [c.closer, c.at])));
const bc = closes[0], ac2 = closes[3];
check("…Ben's: the course, the amount in its currency (Bangalore, INR), the academy, the closer's email, when", bc?.courses?.join() === "Mastering Forex" && bc?.amount === 90000 && bc?.currency === "INR"
  && bc?.academy === "bangalore" && bc?.closerEmail === "ben@t.local" && Math.abs(Date.parse(bc?.at) - ago(10).getTime()) < 1000, j(bc));
check("…Anna's: both courses, AED 5,000, Dubai", ac2?.courses?.join() === "Mastering Forex,Price Action" && ac2?.amount === 5000 && ac2?.currency === "AED" && ac2?.academy === "dubai", j(ac2));
check("…the enrolment's id, to show each once", ac2?.id === String(seededStudents[0]._id), j(ac2?.id));
check("…never the student's name", closes.every((c: Any) => !("student" in c)) && !JSON.stringify(all.body).includes("Student"), j(closes));
const after = await get(`/sales-tv?parts=live&after=${encodeURIComponent(ago(15).toISOString())}`);
check("after 15 minutes ago: only Ben's", after.body.data?.closes?.map((c: Any) => c.closer).join() === "Ben Bee", j(after.body.data?.closes));
const afterNow = await get(`/sales-tv?parts=live&after=${encodeURIComponent(new Date().toISOString())}`);
check("after now: none", Array.isArray(afterNow.body.data?.closes) && afterNow.body.data.closes.length === 0, j(afterNow.body.data?.closes));
const far = await get(`/sales-tv?parts=live&after=${encodeURIComponent(new Date(now - 7 * 86_400_000).toISOString())}`);
const farNames = (far.body.data?.closes ?? []).map((c: Any) => c.closer);
check("after a week ago: at most a day back — the 5-hour-old one in, the 3-day-old one out", farNames.length === 5 && farNames[4] === "Ben Bee"
  && !(far.body.data?.closes ?? []).some((c: Any) => c.id === String(seededStudents[1]._id)), j(far.body.data?.closes?.map((c: Any) => [c.closer, c.at])));
const junk = await get(`/sales-tv?parts=live&after=not-a-date`);
check("an `after` that isn't a date: the last two hours", junk.status === 200 && junk.body.data?.closes?.length === 4, j(junk.body.data?.closes?.length));

section("parts=live");
const live = await get("/sales-tv?parts=live");
check("only crm, generatedAt, who is on a break and the closes — no people, no month", live.status === 200 && keys(live.body.data) === "closes,crm,generatedAt,onBreak", keys(live.body.data));

section("The newest 20");
await db.collection("students").insertMany(Array.from({ length: 22 }, (_, i) => stu(`Burst${i}`, anna, ago(60 + i))));
const burst = await get("/sales-tv?parts=live");
check("25 closes in the last two hours: the newest 20, newest first", burst.body.data?.closes?.length === 20 && burst.body.data.closes[0].closer === "Ben Bee"
  && burst.body.data.closes.every((c: Any, i: number, a: Any[]) => i === 0 || Date.parse(a[i - 1].at) >= Date.parse(c.at)), j(burst.body.data?.closes?.length));

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
