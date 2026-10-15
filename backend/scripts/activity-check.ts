/**
 * Checks the Activity page end to end on a scratch database (2026-10-15, as in the Sales CRM, with the HRMS): with a
 * stand-in for the HRMS's attendance — never the real HRMS, and nobody's phone (no push subscriptions here). The bell's
 * live notices are caught off the socket server (this CRM keeps no stored notices).
 *
 *   - Case 1: sign-ins (and refused ones, by reason) and sign-outs on record; the heartbeat — one active minute per
 *     minute, quiet heartbeats don't count; the People list's statuses, shift and clock-in from the HRMS;
 *   - Case 2: idle alerts — only someone clocked in on the HRMS; never on leave, clocked out, unknown to the HRMS,
 *     signed out, a Super Admin or a deactivated account; once per quiet stretch, again after they are back; a lunch
 *     clock-out isn't idle time; a clock-out or sign-out ends a stretch (alerts on or off), one open stretch at a time;
 *     the person, the Super Admins and their team leader told (no email); the HRMS linked but not answering → alerts
 *     wait; not linked → activity alone; switched off / outside working hours → nothing;
 *   - Case 3: the Attendance tab — the HRMS shift, first in, last out, every session, worked and late minutes,
 *     where each is now, a team, a search, another day, the HRMS not answering, answering junk, or failing one day;
 *   - Case 4: who sees what — the Activity box, a team's leaders for its own team, everyone's own heartbeat.
 *
 * Run by activity-check.sh. Scratch database only.
 */
import { randomBytes } from "node:crypto";
import { Types } from "mongoose";
import type { AttendanceDayResponse } from "../src/services/attendanceDayService.js";
import type { PeopleResponse, LoginEventDTO, IdleStretchDTO } from "../src/services/activityService.js";

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

const H = 3_600_000, MIN = 60_000;
const dubaiDay = (t: number) => new Date(t + 4 * H).toISOString().slice(0, 10);
const TODAY = dubaiDay(Date.now());
const YESTERDAY = dubaiDay(Date.now() - 24 * H);
const at = (day: string, hhmm: string) => new Date(`${day}T${hhmm}:00.000+04:00`);

/* ── A stand-in for the HRMS ──────────────────────────────────────────────── */

type Now = "in" | "out" | "leave";
interface Day {
  workDay: boolean;
  attendance: null | { status: string; firstIn: string | null; lastOut: string | null; sessions: Array<{ in: string; out: string | null }>; workedMinutes: number; lateMinutes: number };
  leave: { type: string; halfDay: boolean } | null;
  wfh: boolean;
  now: Now | null; // null: a row the HRMS couldn't read
}
let hrmsNow: Record<string, Now> = {};
let hrmsDays: Record<string, Day> = {};
let hrmsDown = false;
let hrmsGarbage = false;
let hrmsFailDay = ""; // one day the HRMS fails on (500), the rest answered
let hrmsExtraRows: unknown[] = []; // rows sent as they are, odd ones included
const asked = { now: 0, day: 0, any: 0 };
const shift = { name: "Sales floor", timeZone: "Asia/Dubai", loginTime: "10:00", logoutTime: "19:00", workDays: [1, 2, 3, 4, 5, 6], halfDays: [], mode: "fixed", requiredHours: null, assigned: true };
const hrmsServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    asked.any++;
    if (hrmsDown) return new Response("down", { status: 503 });
    if (hrmsGarbage) return new Response("<html><body>Back soon</body></html>", { status: 200, headers: { "content-type": "text/html" } });
    const emails = (url.searchParams.get("emails") ?? "").split(",").filter(Boolean);
    if (url.pathname === "/api/v1/integrations/directory/attendance-now") {
      asked.now++;
      const data = emails.filter((e) => hrmsNow[e]).map((e) => ({
        email: e, state: hrmsNow[e], since: hrmsNow[e] === "in" ? new Date().toISOString() : null,
        leave: hrmsNow[e] === "leave" ? { type: "Annual", halfDay: false } : null,
      }));
      return Response.json({ success: true, data });
    }
    if (url.pathname === "/api/v1/integrations/directory/attendance-day") {
      asked.day++;
      const day = url.searchParams.get("day") ?? "";
      if (day === hrmsFailDay) return new Response("boom", { status: 500 });
      // Someone given only a state (hrmsNow) has that day with no record — as the HRMS says it.
      const dayOf = (e: string): Day | undefined => hrmsDays[e] ?? (hrmsNow[e]
        ? { workDay: true, attendance: null, leave: hrmsNow[e] === "leave" ? { type: "Annual", halfDay: false } : null, wfh: false, now: hrmsNow[e]! }
        : undefined);
      const data = [...emails.filter((e) => dayOf(e)).map((e) => ({ email: e, name: e, schedule: shift, ...dayOf(e), now: day === TODAY ? dayOf(e)!.now : null })), ...hrmsExtraRows];
      return Response.json({ success: true, data });
    }
    return new Response("not here", { status: 404 });
  },
});

/* ── The app ─────────────────────────────────────────────────────────────── */

const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "activity-check-jwt",
  JWT_REFRESH_SECRET: "activity-check-refresh",
  NODE_ENV: "test",
  RUN_SCHEDULERS: "false",
  HRMS_API_URL: `http://127.0.0.1:${hrmsServer.port}`,
  HRMS_CLIENT_ID: "activity-check",
  HRMS_INTEGRATION_SECRET: "activity-check",
  HRMS_ORG_ID: "",
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;

const { signAccessToken } = await import("../src/utils/jwt.js");
const express = (await import("express")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const { User } = await import("../src/models/User.js");
const { LoginEvent } = await import("../src/models/LoginEvent.js");
const { UserPresence } = await import("../src/models/UserPresence.js");
const { ActivityDay } = await import("../src/models/ActivityDay.js");
const { IdleStretch } = await import("../src/models/IdleStretch.js");
const { AppSetting } = await import("../src/models/AppSetting.js");
const activity = await import("../src/services/activityService.js");
const { updateAppSettings } = await import("../src/services/settingsService.js");
const { env } = await import("../src/config/env.js");
const { forgetAttendanceDays } = await import("../src/services/attendanceDayService.js");
await Promise.all([LoginEvent.init(), UserPresence.init(), ActivityDay.init(), IdleStretch.init(), AppSetting.init()]);
const forgetHrms = () => forgetAttendanceDays();

const app = express();
app.set("trust proxy", true);
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const { createServer } = await import("node:http");
const { initSocket, getIO } = await import("../src/socket.js");
const server = createServer(app);
initSocket(server);
// The bell, as this CRM has it: live notices on the socket ("notification" to user:<id>) — caught here.
interface Notice { user: string; type: string; title: string; body: string; url?: string }
let notices: Notice[] = [];
const io = getIO();
io.to = ((room: string) => ({
  emit: (event: string, payload: Notice) => {
    if (event === "notification" && room.startsWith("user:")) notices.push({ ...payload, user: room.slice(5) });
    return true;
  },
})) as unknown as typeof io.to;
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;

interface ApiBody<T> { success: boolean; message: string; data: T; pagination?: { total: number } }
const tokens: Record<string, string> = {};
async function api<T>(method: string, path: string, who: string | null, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: ApiBody<T> }> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${tokens[who] ?? who}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as ApiBody<T> };
}

/* ── People, roles, teams ────────────────────────────────────────────────── */

const perms = (m: Record<string, Record<string, boolean>>) =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { view: false, create: false, edit: false, delete: false, approve: false, export: false, ...v }]));
const role = { admin: new Types.ObjectId(), staff: new Types.ObjectId(), watcher: new Types.ObjectId() };
await db.collection("roles").insertMany([
  { _id: role.admin, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  { _id: role.staff, roleName: "Sales Staff", isSystemRole: false, permissions: perms({ leads: { view: true } }) },
  { _id: role.watcher, roleName: "Floor Manager", isSystemRole: false, permissions: perms({ leads: { view: true }, activity: { view: true } }) },
]);
const ids: Record<string, Types.ObjectId> = {};
const emailOf = (name: string) => `${name.toLowerCase()}@test.local`;
async function person(name: string, r: Types.ObjectId, extra: Record<string, unknown> = {}) {
  const _id = new Types.ObjectId();
  await db.collection("users").insertOne({ _id, name, email: emailOf(name), password: "x", role: r, status: "active", ...extra });
  ids[name] = _id;
  tokens[name] = signAccessToken({ userId: String(_id), email: emailOf(name), roleId: String(r) });
}
for (const n of ["Admin"]) await person(n, role.admin);
for (const n of ["Ann", "Ben", "Cat", "Dan", "Eve", "Fay", "Lead1", "Lead2"]) await person(n, role.staff);
await person("Gus", role.staff, { status: "inactive" });
await person("Wes", role.watcher);
const password = randomBytes(12).toString("base64url"); // scratch only, never printed
const zed = await User.create({ name: "Zed", email: "zed@test.local", password, role: role.staff });
const off = await User.create({ name: "Off", email: "off@test.local", password, role: role.staff, status: "inactive" });
ids.Zed = zed._id as Types.ObjectId;
const alpha = new Types.ObjectId(), beta = new Types.ObjectId();
await db.collection("teams").insertMany([
  { _id: alpha, name: "Alpha", leaders: [ids.Lead1], members: [ids.Ann, ids.Ben, ids.Cat, ids.Dan, ids.Eve], status: "active", inactiveMembers: [], absentToday: [], settings: {} },
  { _id: beta, name: "Beta", leaders: [ids.Lead2], members: [ids.Fay], status: "active", inactiveMembers: [], absentToday: [], settings: {} },
]);

/* ═══ Case 1 ═══════════════════════════════════════════════════════════════ */

section("Case 1 — sign-ins, sign-outs, the heartbeat, the People list");
{
  // The client claims 203.0.113.66; our proxy (here, the check, on 127.0.0.1) added 198.51.100.7.
  const ua = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", "x-forwarded-for": "203.0.113.66, 198.51.100.7" };
  const ok = await api<{ accessToken: string }>("POST", "/auth/login", null, { email: "zed@test.local", password }, ua);
  check("a sign-in → 200", ok.status === 200, ok.status);
  tokens.Zed = ok.body.data?.accessToken ?? "";
  const ev = await LoginEvent.findOne({ email: "zed@test.local", kind: "login" }).lean();
  check("…on record: who, password, the IP our proxy saw (not the one the client claimed) and the device", !!ev && String(ev.user) === String(ids.Zed) && ev.method === "password" && ev.ip === "198.51.100.7" && /Safari/.test(ev.device), ev);
  const bad = await api("POST", "/auth/login", null, { email: "zed@test.local", password: "wrong-one-entirely" });
  const unknown = await api("POST", "/auth/login", null, { email: "nobody@test.local", password: "whatever-it-is" });
  const deactivated = await api("POST", "/auth/login", null, { email: "off@test.local", password });
  check("refused sign-ins still answer as before: 401, 401, 403", bad.status === 401 && unknown.status === 401 && deactivated.status === 403, [bad.status, unknown.status, deactivated.status]);
  const fails = await LoginEvent.find({ kind: "login_failed" }).sort({ createdAt: 1 }).lean();
  check("…on record with their reasons: wrong password, unknown email, deactivated", fails.map((f) => f.reason).join() === "wrong_password,unknown_email,deactivated" && String(fails[0]?.user) === String(ids.Zed) && fails[1]?.user === null && String(fails[2]?.user) === String(off._id), fails.map((f) => [f.reason, f.user]));
  const malformed = await api("POST", "/auth/login", null, { email: "zed@test.local" });
  check("a malformed sign-in → 400, not on record", malformed.status === 400 && (await LoginEvent.countDocuments()) === 4, malformed.status);

  const hb1 = await api("POST", "/activity/heartbeat", "Zed", { active: true });
  const hb2 = await api("POST", "/activity/heartbeat", "Zed", { active: true });
  const day1 = await ActivityDay.findOne({ user: ids.Zed }).lean();
  check("two heartbeats in the same minute → one active minute", hb1.status === 200 && hb2.status === 200 && day1?.activeMinutes === 1, day1);
  const before = await UserPresence.findOne({ user: ids.Zed }).lean();
  await Bun.sleep(20);
  await api("POST", "/activity/heartbeat", "Zed", { active: false });
  const after = await UserPresence.findOne({ user: ids.Zed }).lean();
  check("a quiet heartbeat moves 'last seen', not 'last active'", !!after && after.lastSeenAt! > before!.lastSeenAt! && after.lastActiveAt!.getTime() === before!.lastActiveAt!.getTime(), [before?.lastActiveAt, after?.lastActiveAt]);
  check("a heartbeat body that isn't {active} → 400", (await api("POST", "/activity/heartbeat", "Zed", { active: "yes" })).status === 400);

  const out = await api("POST", "/auth/logout", "Zed");
  check("signing out → 200 and on record", out.status === 200 && (await LoginEvent.countDocuments({ kind: "logout", user: ids.Zed })) === 1);

  // The People list: statuses, and today's shift and clock-in from the HRMS.
  hrmsDays = { [emailOf("Ann")]: { workDay: true, attendance: { status: "present", firstIn: at(TODAY, "09:57").toISOString(), lastOut: null, sessions: [{ in: at(TODAY, "09:57").toISOString(), out: null }], workedMinutes: 120, lateMinutes: 0 }, leave: null, wfh: false, now: "in" } };
  forgetHrms();
  await UserPresence.updateOne({ user: ids.Ann }, { $set: { lastSeenAt: new Date(), lastActiveAt: new Date() } }, { upsert: true });
  await UserPresence.updateOne({ user: ids.Fay }, { $set: { lastLoginAt: new Date(), lastSeenAt: null, lastActiveAt: null } }, { upsert: true });
  const people = await api<PeopleResponse>("GET", "/activity/people", "Admin");
  const ann = people.body.data.items.find((p) => p.name === "Ann");
  const zedRow = people.body.data.items.find((p) => p.name === "Zed");
  check("People: Ann active, Zed signed out today", ann?.status === "active" && zedRow?.status === "signed_out", [ann?.status, zedRow?.status]);
  check("…Ann's HRMS shift 10:00–19:00 and clocked in at 09:57, in now", ann?.shift?.from === "10:00" && ann.shift.to === "19:00" && ann.clockedInAt === at(TODAY, "09:57").toISOString() && ann.clockedOutAt === null && ann.attendance === "in", ann);
  check("…signed in today with no heartbeat (an app): here today, not 'not seen today'", people.body.data.items.find((p) => p.name === "Fay")?.status === "away", people.body.data.items.find((p) => p.name === "Fay")?.status);
  check("…someone not in the HRMS: no shift, 'unknown'", people.body.data.items.find((p) => p.name === "Ben")?.shift === null && people.body.data.items.find((p) => p.name === "Ben")?.attendance === "unknown");
  check("…and whether today is a working day for them (Ann: yes)", ann?.workDay === true, ann?.workDay);
  const nobody = await api<PeopleResponse>("GET", "/activity/people?search=zzzz-nobody", "Admin");
  check("a search that finds nobody still says idle alerts go by the HRMS", nobody.body.data.items.length === 0 && nobody.body.data.idleRule.byAttendance === true, nobody.body.data.idleRule);
  check("…the deactivated aren't listed", !people.body.data.items.some((p) => p.name === "Gus" || p.name === "Off"));
  check("…today's refused sign-ins counted: 3", people.body.data.summary.failedSignInsToday === 3, people.body.data.summary);
  const logins = await api<LoginEventDTO[]>("GET", "/activity/logins?kind=login_failed", "Admin");
  check("Sign-ins: the refused ones, newest first", logins.status === 200 && logins.body.data.length === 3 && logins.body.data[0]?.reason === "deactivated", logins.body.data.map((l) => l.reason));
  const mine = await api<LoginEventDTO[]>("GET", `/activity/logins?userId=${ids.Zed}`, "Admin");
  check("…one person's: sign-out, wrong password, sign-in", mine.body.data.map((l) => l.kind).join() === "logout,login_failed,login", mine.body.data.map((l) => l.kind));
  const longEmail = `${"x".repeat(195)}@test.local`;
  const long = await api("POST", "/auth/login", null, { email: longEmail, password: "whatever-it-is" });
  const longEv = await LoginEvent.findOne({ kind: "login_failed", email: longEmail.slice(0, 200) }).lean();
  check("a refused sign-in with a 206-character email is still on record (cut to 200)", long.status === 401 && !!longEv, long.status);
}

/* ═══ Case 2 ═══════════════════════════════════════════════════════════════ */

section("Case 2 — idle alerts: only those clocked in");
{
  const T = at(TODAY, "12:00");
  await updateAppSettings({ idleAlerts: { enabled: true, limitMinutes: 30, notifyTeamLeaders: true }, workingHours: { timezone: "Asia/Dubai", days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" } }, String(ids.Admin));
  const quiet = (name: string, minutes: number, extra: Record<string, unknown> = {}) =>
    UserPresence.updateOne({ user: ids[name] }, { $set: { lastSeenAt: new Date(T.getTime() - MIN), lastActiveAt: new Date(T.getTime() - minutes * MIN), lastLoginAt: new Date(T.getTime() - 5 * H), lastLogoutAt: null, idleAlertedAt: null, ...extra } }, { upsert: true });
  for (const n of ["Ann", "Ben", "Cat", "Dan", "Admin", "Gus"]) await quiet(n, 40);
  await quiet("Eve", 40, { lastLogoutAt: new Date(T.getTime() - 30 * MIN) });
  await quiet("Fay", 10);
  // Dan is not in the HRMS at all.
  hrmsNow = { [emailOf("Ann")]: "in", [emailOf("Ben")]: "leave", [emailOf("Cat")]: "out", [emailOf("Eve")]: "in", [emailOf("Fay")]: "in", [emailOf("Admin")]: "in", [emailOf("Gus")]: "in" };
  forgetHrms();
  notices = [];

  const r1 = await activity.sweepIdleUsers(T);
  const stretches = await IdleStretch.find({}).lean();
  check("40 quiet minutes, clocked in → Ann alone is alerted", r1.alerted === 1 && stretches.length === 1 && String(stretches[0]?.user) === String(ids.Ann), [r1, stretches.map((s) => String(s.user))]);
  const notAlerted = ["Ben", "Cat", "Dan", "Eve", "Fay", "Admin", "Gus"].map((n) => String(ids[n]));
  check("…not Ben (on leave), Cat (clocked out), Dan (not in the HRMS), Eve (signed out), Fay (10 min), the Super Admin, Gus (deactivated)", !stretches.some((s) => notAlerted.includes(String(s.user))));
  const notes = notices;
  const to = (name: string, type: string) => notes.some((n) => n.user === String(ids[name]) && n.type === type);
  check("…Ann told (idle_self), the Super Admin and Alpha's leader told (idle_alert) — live, in the bell", to("Ann", "idle_self") && to("Admin", "idle_alert") && to("Lead1", "idle_alert") && !to("Lead2", "idle_alert") && notes.length === 3, notes.map((n) => [n.type, n.user]));
  check("…no email anywhere — the bell and push only", !notes.some((n) => /@/.test(n.body)));

  const r2 = await activity.sweepIdleUsers(new Date(T.getTime() + 5 * MIN));
  check("once per quiet stretch: no second alert five minutes on", r2.alerted === 0 && (await IdleStretch.countDocuments()) === 1, r2);
  await activity.recordHeartbeat(String(ids.Ann), true, new Date(T.getTime() + 6 * MIN));
  check("Ann back → her stretch ends", (await IdleStretch.findOne({ user: ids.Ann }).lean())?.endedAt?.getTime() === T.getTime() + 6 * MIN);
  const r3 = await activity.sweepIdleUsers(new Date(T.getTime() + 40 * MIN));
  check("…and quiet again for 34 minutes → alerted again (Fay too, now 50 minutes quiet and clocked in)", r3.alerted === 2 && (await IdleStretch.countDocuments({ user: ids.Ann })) === 2 && (await IdleStretch.countDocuments({ user: ids.Fay })) === 1, r3);

  // Fay, alerted at 12:40, clocks out at 12:45: her stretch ends there, not when she next shows up.
  const t = (hhmm: string) => at(TODAY, hhmm).toISOString();
  hrmsDays[emailOf("Fay")] = { workDay: true, attendance: { status: "present", firstIn: t("09:00"), lastOut: t("12:45"), sessions: [{ in: t("09:00"), out: t("12:45") }], workedMinutes: 225, lateMinutes: 0 }, leave: null, wfh: false, now: "out" };
  forgetHrms();
  const r5 = await activity.sweepIdleUsers(at(TODAY, "12:50"));
  const fayStretch = await IdleStretch.findOne({ user: ids.Fay }).sort({ alertedAt: -1 }).lean();
  check("a clock-out ends the quiet stretch, at the clock-out (12:45)", fayStretch?.endedAt?.getTime() === at(TODAY, "12:45").getTime() && r5.ended >= 1, [fayStretch?.endedAt, r5]);

  // Ben last used the CRM at 11:52, clocked out for lunch at 11:57 and back in at 12:51: lunch is not idle time.
  hrmsDays[emailOf("Ben")] = { workDay: true, attendance: { status: "present", firstIn: t("09:00"), lastOut: null, sessions: [{ in: t("09:00"), out: t("11:57") }, { in: t("12:51"), out: null }], workedMinutes: 180, lateMinutes: 0 }, leave: null, wfh: false, now: "in" };
  forgetHrms();
  await UserPresence.updateOne({ user: ids.Ben }, { $set: { lastActiveAt: at(TODAY, "11:52"), lastSeenAt: at(TODAY, "11:52"), lastLogoutAt: null, idleAlertedAt: null } });
  notices = [];
  await activity.sweepIdleUsers(at(TODAY, "12:52"));
  check("back from lunch a minute ago → no alert (quiet counts from the clock-in, 12:51)", (await IdleStretch.countDocuments({ user: ids.Ben })) === 0);
  await activity.sweepIdleUsers(at(TODAY, "13:21"));
  const benStretch = await IdleStretch.findOne({ user: ids.Ben }).lean();
  const benNote = notices.find((n) => n.user === String(ids.Ben) && n.type === "idle_self");
  check("…30 minutes after clocking in → alerted, quiet since 12:51, and told so", benStretch?.since.getTime() === at(TODAY, "12:51").getTime() && /since you clocked in at 12:51/.test(benNote?.body ?? ""), [benStretch?.since, benNote?.body]);
  const signOut = await api("POST", "/auth/logout", "Ben");
  check("signing out ends the stretch", signOut.status === 200 && !!(await IdleStretch.findOne({ user: ids.Ben }).lean())?.endedAt);

  // Two sweeps at once (two servers, a deploy): one alert.
  await UserPresence.updateOne({ user: ids.Ann }, { $set: { lastActiveAt: at(TODAY, "14:10"), lastSeenAt: at(TODAY, "14:59"), lastLogoutAt: null } });
  const annBefore = await IdleStretch.countDocuments({ user: ids.Ann });
  await Promise.all([activity.sweepIdleUsers(at(TODAY, "15:00")), activity.sweepIdleUsers(new Date(at(TODAY, "15:00").getTime() + 7))]);
  check("two sweeps at the same moment → one alert", (await IdleStretch.countDocuments({ user: ids.Ann })) === annBefore + 1, (await IdleStretch.countDocuments({ user: ids.Ann })) - annBefore);
  await IdleStretch.updateMany({ endedAt: null }, { $set: { endedAt: at(TODAY, "15:01") } });

  hrmsDown = true;
  forgetHrms();
  await quiet("Cat", 40);
  await quiet("Dan", 40);
  const stretchesBefore = await IdleStretch.countDocuments();
  const r4 = await activity.sweepIdleUsers(T);
  check("the HRMS linked but not answering → nobody alerted: it can't tell who is on leave", r4.alerted === 0 && r4.idle === "hrms unavailable" && (await IdleStretch.countDocuments()) === stretchesBefore, r4);
  hrmsDown = false;
  const linkedTo = env.HRMS_API_URL;
  env.HRMS_API_URL = "";
  forgetHrms();
  const r4b = await activity.sweepIdleUsers(T);
  const latest = await IdleStretch.find({ alertedAt: T }).lean();
  check("the HRMS not linked at all → activity alone: Cat and Dan alerted (no breaks in this CRM)", latest.some((s) => String(s.user) === String(ids.Cat)) && latest.some((s) => String(s.user) === String(ids.Dan)), [r4b, latest.map((s) => String(s.user))]);
  env.HRMS_API_URL = linkedTo;
  forgetHrms();

  // Lead2, alerted at 16:00, clocks out at 16:05 and back in at 16:20 — and no sweep sees it until 16:50.
  await UserPresence.updateOne({ user: ids.Lead2 }, { $set: { lastActiveAt: at(TODAY, "15:20"), lastSeenAt: at(TODAY, "15:59"), lastLogoutAt: null, idleAlertedAt: null } }, { upsert: true });
  hrmsDays[emailOf("Lead2")] = { workDay: true, attendance: { status: "present", firstIn: t("09:00"), lastOut: null, sessions: [{ in: t("09:00"), out: null }], workedMinutes: 400, lateMinutes: 0 }, leave: null, wfh: false, now: "in" };
  forgetHrms();
  await activity.sweepIdleUsers(at(TODAY, "16:00"));
  const first = await IdleStretch.findOne({ user: ids.Lead2, endedAt: null }).lean();
  const peopleAlerted = await api<PeopleResponse>("GET", "/activity/people", "Admin");
  check("People: 'Alerted' while the stretch is open", !!first && peopleAlerted.body.data.items.find((x) => x.name === "Lead2")?.alerted === true, first);
  hrmsDays[emailOf("Lead2")] = { workDay: true, attendance: { status: "present", firstIn: t("09:00"), lastOut: null, sessions: [{ in: t("09:00"), out: t("16:05") }, { in: t("16:20"), out: null }], workedMinutes: 420, lateMinutes: 0 }, leave: null, wfh: false, now: "in" };
  forgetHrms();
  await activity.sweepIdleUsers(at(TODAY, "16:50"));
  const lead2 = await IdleStretch.find({ user: ids.Lead2 }).sort({ alertedAt: 1 }).lean();
  check("a clock-out no sweep saw: the first stretch ends at it (16:05), one new one from the clock-in (16:20)", lead2.length === 2 && lead2[0]!.endedAt?.getTime() === at(TODAY, "16:05").getTime() && lead2[1]!.endedAt === null && lead2[1]!.since.getTime() === at(TODAY, "16:20").getTime(), lead2.map((x) => [x.since, x.endedAt]));
  // Alerts switched off, then Lead2 clocks out at 17:00: the stretch still ends there.
  await updateAppSettings({ idleAlerts: { enabled: false } }, String(ids.Admin));
  hrmsDays[emailOf("Lead2")] = { workDay: true, attendance: { status: "present", firstIn: t("09:00"), lastOut: t("17:00"), sessions: [{ in: t("09:00"), out: t("16:05") }, { in: t("16:20"), out: t("17:00") }], workedMinutes: 445, lateMinutes: 0 }, leave: null, wfh: false, now: "out" };
  forgetHrms();
  const r6 = await activity.sweepIdleUsers(at(TODAY, "17:05"));
  const lead2Last = await IdleStretch.findOne({ user: ids.Lead2 }).sort({ alertedAt: -1 }).lean();
  check("alerts switched off: a clock-out still ends the stretch (at 17:00)", r6.idle === "off" && lead2Last?.endedAt?.getTime() === at(TODAY, "17:00").getTime(), [r6, lead2Last?.endedAt]);
  const peopleAfter = await api<PeopleResponse>("GET", "/activity/people", "Admin");
  check("…and People no longer says 'Alerted'", peopleAfter.body.data.items.find((x) => x.name === "Lead2")?.alerted === false);
  await updateAppSettings({ idleAlerts: { enabled: true } }, String(ids.Admin));

  await updateAppSettings({ idleAlerts: { enabled: false } }, String(ids.Admin));
  const old = await IdleStretch.create({ user: ids.Cat, since: at(YESTERDAY, "15:00"), alertedAt: at(YESTERDAY, "15:30") });
  check("switched off → nothing", (await activity.sweepIdleUsers(T)).idle === "off");
  check("…and a stretch left open from yesterday ends with yesterday", (await IdleStretch.findById(old._id).lean())?.endedAt?.getTime() === at(TODAY, "00:00").getTime());
  await updateAppSettings({ idleAlerts: { enabled: true }, workingHours: { days: [((T.getUTCDay() + 1) % 7)] } }, String(ids.Admin));
  check("outside working hours → nothing", (await activity.sweepIdleUsers(T)).idle === "outside working hours");
  await updateAppSettings({ idleAlerts: { enabled: false }, workingHours: { days: [1, 2, 3, 4, 5, 6] } }, String(ids.Admin));
  const refused = await updateAppSettings({ idleAlerts: { enabled: true, limitMinutes: 600 }, workingHours: { start: "10:00", end: "19:00" } }, String(ids.Admin))
    .then(() => "", (err: Error) => err.message);
  // As long as the day is too long as well: the last check runs before its end.
  const refusedEqual = await updateAppSettings({ idleAlerts: { enabled: true, limitMinutes: 540 }, workingHours: { start: "10:00", end: "19:00" } }, String(ids.Admin))
    .then(() => "", (err: Error) => err.message);
  const savedOff = await updateAppSettings({ idleAlerts: { enabled: false, limitMinutes: 600 }, workingHours: { start: "10:00", end: "19:00" } }, String(ids.Admin))
    .then(() => true, () => false);
  check("an idle limit as long as the working day or longer (9 h, 10 h of 9) is refused while alerts are on — but saved with them off", /shorter than the working day/.test(refused) && /shorter than the working day/.test(refusedEqual) && savedOff, [refused, refusedEqual, savedOff]);
  await updateAppSettings({ idleAlerts: { limitMinutes: 30 }, workingHours: { start: "00:00", end: "23:59" } }, String(ids.Admin));

  const list = await api<IdleStretchDTO[]>("GET", "/activity/idle", "Admin");
  check("the Idle alerts tab lists them, newest first", list.status === 200 && list.body.data.length === (await IdleStretch.countDocuments()), list.body.data.length);
}

/* ═══ Case 3 ═══════════════════════════════════════════════════════════════ */

section("Case 3 — the Attendance tab: the HRMS's shift and the day's clock-ins");
{
  const s = (inAt: string, outAt: string | null) => ({ in: at(TODAY, inAt).toISOString(), out: outAt ? at(TODAY, outAt).toISOString() : null });
  hrmsDays = {
    [emailOf("Ann")]: { workDay: true, attendance: { status: "present", firstIn: s("09:57", null).in, lastOut: null, sessions: [s("09:57", "13:00"), s("13:30", null)], workedMinutes: 183, lateMinutes: 0 }, leave: null, wfh: false, now: "in" },
    [emailOf("Lead1")]: { workDay: true, attendance: { status: "late", firstIn: s("10:25", null).in, lastOut: null, sessions: [s("10:25", null)], workedMinutes: 95, lateMinutes: 25 }, leave: null, wfh: false, now: "in" },
    [emailOf("Ben")]: { workDay: true, attendance: null, leave: { type: "Annual", halfDay: false }, wfh: false, now: "leave" },
    [emailOf("Cat")]: { workDay: true, attendance: { status: "early_out", firstIn: s("10:00", null).in, lastOut: s("10:00", "12:30").out, sessions: [s("10:00", "12:30")], workedMinutes: 150, lateMinutes: 0 }, leave: null, wfh: false, now: "out" },
    [emailOf("Dan")]: { workDay: true, attendance: { status: "present", firstIn: s("09:59", null).in, lastOut: null, sessions: [s("09:59", null)], workedMinutes: 100, lateMinutes: 0 }, leave: null, wfh: false, now: "in" },
    [emailOf("Eve")]: { workDay: true, attendance: null, leave: null, wfh: false, now: "out" },
    // A row the HRMS couldn't read: "now" null today.
    [emailOf("Lead2")]: { workDay: true, attendance: null, leave: null, wfh: false, now: null },
  };
  hrmsNow = {}; // only those above are known to the HRMS here
  forgetHrms();
  const r = await api<AttendanceDayResponse>("GET", "/activity/attendance", "Admin");
  const d = r.body.data;
  const row = (name: string) => d.rows.find((x) => x.name === name);
  check("today, from the HRMS", r.status === 200 && d.day === TODAY && d.today === true && d.available === true, { status: r.status, day: d?.day, available: d?.available });
  const ann = row("Ann");
  check("Ann: shift 10:00–19:00, in at 09:57, two sessions, 183 min worked, in now", ann?.shift?.from === "10:00" && ann.shift.to === "19:00" && ann.firstIn === s("09:57", null).in && ann.sessions.length === 2 && ann.lastOut === null && ann.workedMinutes === 183 && ann.now === "in", ann);
  check("Lead1: in at 10:25, late by 25", row("Lead1")?.lateMinutes === 25 && row("Lead1")?.status === "late", row("Lead1"));
  check("Dan: in at 09:59, in now (no break here)", row("Dan")?.now === "in" && row("Dan")?.breakSince === null, row("Dan"));
  check("Ben: on leave", row("Ben")?.now === "leave" && row("Ben")?.leave?.type === "Annual", row("Ben"));
  check("Cat: in 10:00, out 12:30 — out now", row("Cat")?.lastOut === s("10:00", "12:30").out && row("Cat")?.now === "out", row("Cat"));
  check("Fay: not in the HRMS", row("Fay")?.inHrms === false && row("Fay")?.shift === null, row("Fay"));
  const order = d.rows.map((x) => x.name);
  check("whoever is here first (by clock-in), then not in yet, out again, on leave, not in the HRMS", order.indexOf("Ann") < order.indexOf("Dan") && order.indexOf("Dan") < order.indexOf("Lead1") && order.indexOf("Lead1") < order.indexOf("Eve") && order.indexOf("Eve") < order.indexOf("Cat") && order.indexOf("Cat") < order.indexOf("Ben") && order.indexOf("Ben") < order.indexOf("Fay"), order);
  check("the summary: 3 in, none on a break, 1 on leave, 1 not in yet, 1 late", d.summary.clockedIn === 3 && d.summary.onBreak === 0 && d.summary.onLeave === 1 && d.summary.notIn === 1 && d.summary.late === 1, d.summary);

  check("a row the HRMS couldn't read (Lead2): no 'now', listed with the unknown, not counted as not in yet", row("Lead2")?.now === null && row("Lead2")?.inHrms === true && order.indexOf("Lead2") > order.indexOf("Ben") && d.summary.notIn === 1, [row("Lead2")?.now, order, d.summary.notIn]);

  const team = await api<AttendanceDayResponse>("GET", `/activity/attendance?teamId=${alpha}`, "Admin");
  check("a team: Alpha's leader and members only", team.body.data.rows.map((x) => x.name).sort().join() === "Ann,Ben,Cat,Dan,Eve,Lead1", team.body.data.rows.map((x) => x.name));
  const search = await api<AttendanceDayResponse>("GET", "/activity/attendance?search=ann", "Admin");
  check("a search: Ann", search.body.data.rows.map((x) => x.name).join() === "Ann", search.body.data.rows.map((x) => x.name));
  const yday = await api<AttendanceDayResponse>("GET", `/activity/attendance?day=${YESTERDAY}`, "Admin");
  check("another day: no 'now', no break", yday.status === 200 && yday.body.data.today === false && yday.body.data.rows.every((x) => x.now === null && x.breakSince === null), yday.body.data.rows.map((x) => x.now));
  for (const [label, q] of [["a day that isn't one", "day=2026-02-30"], ["a day in words", "day=today"], ["a day weeks ahead", "day=2099-01-01"], ["a team that isn't an id", "teamId=alpha"]] as const) {
    check(`${label} → 400`, (await api("GET", `/activity/attendance?${q}`, "Admin")).status === 400);
  }
  hrmsDown = true;
  forgetHrms();
  const down = await api<AttendanceDayResponse>("GET", "/activity/attendance", "Admin");
  check("the HRMS not answering → said so, everyone still listed", down.status === 200 && down.body.data.available === false && down.body.data.linked === true && !!down.body.data.message && down.body.data.rows.length > 5 && down.body.data.rows.every((x) => !x.inHrms), down.body.data.message);
  check("…nobody's 'now' is guessed", down.body.data.rows.every((x) => x.now === null), down.body.data.rows.map((x) => [x.name, x.now]));
  const downPeople = await api<PeopleResponse>("GET", "/activity/people", "Admin");
  check("…People too: no badges; alerts still go by the HRMS once it's back", downPeople.body.data.items.every((x) => x.attendance === null) && downPeople.body.data.idleRule.byAttendance === true, downPeople.body.data.items.map((x) => x.attendance));
  await updateAppSettings({ idleAlerts: { enabled: true } }, String(ids.Admin));
  const nobodyDown = await api<PeopleResponse>("GET", "/activity/people?search=zzzz-nobody", "Admin");
  const everyoneDown = await api<PeopleResponse>("GET", "/activity/people", "Admin");
  check("…alerts on: 'paused', also for a search that finds nobody", everyoneDown.body.data.idleRule.paused === true && nobodyDown.body.data.idleRule.paused === true, [everyoneDown.body.data.idleRule.paused, nobodyDown.body.data.idleRule.paused]);
  await updateAppSettings({ idleAlerts: { enabled: false } }, String(ids.Admin));
  hrmsDown = false;
  forgetHrms();

  // An odd row (no shift, a record that isn't one) and a null row: the rest of the page — and the sweep — carry on.
  hrmsExtraRows = [{ email: emailOf("Wes"), schedule: null, attendance: "garbage", leave: 7, now: "in" }, null];
  forgetHrms();
  const odd = await api<AttendanceDayResponse>("GET", "/activity/attendance", "Admin");
  const oddPeople = await api<PeopleResponse>("GET", "/activity/people", "Admin");
  const wes = odd.body.data?.rows.find((x) => x.name === "Wes");
  check("an HRMS row with no shift and a record that isn't one: the page still answers — Wes in, no shift", odd.status === 200 && odd.body.data.available === true && wes?.inHrms === true && wes.shift === null && wes.now === "in" && oddPeople.status === 200, [odd.status, wes]);
  await updateAppSettings({ idleAlerts: { enabled: true } }, String(ids.Admin));
  await UserPresence.updateOne({ user: ids.Wes }, { $set: { lastActiveAt: at(TODAY, "11:00"), lastSeenAt: at(TODAY, "11:59"), lastLogoutAt: null, idleAlertedAt: null } }, { upsert: true });
  const oddSweep = await activity.sweepIdleUsers(at(TODAY, "12:00")).then((r) => r, (err: Error) => err.message);
  check("…and the idle sweep runs (Wes, clocked in and quiet an hour, alerted)", typeof oddSweep === "object" && oddSweep.alerted >= 1, oddSweep);
  await updateAppSettings({ idleAlerts: { enabled: false } }, String(ids.Admin));
  await IdleStretch.updateMany({ endedAt: null }, { $set: { endedAt: at(TODAY, "12:01") } });
  hrmsExtraRows = [];
  forgetHrms();

  // One day the HRMS fails on doesn't make today "can't say".
  hrmsFailDay = YESTERDAY;
  const failedDay = await api<AttendanceDayResponse>("GET", `/activity/attendance?day=${YESTERDAY}`, "Admin");
  const todayAfter = await api<AttendanceDayResponse>("GET", "/activity/attendance", "Admin");
  check("a failure on another day (yesterday) leaves today's answers alone", failedDay.body.data.available === false && todayAfter.body.data.available === true, [failedDay.body.data.available, todayAfter.body.data.available]);
  hrmsFailDay = "";
  forgetHrms();

  hrmsGarbage = true;
  const junk = await api<AttendanceDayResponse>("GET", "/activity/attendance", "Admin");
  check("the HRMS answering a web page instead → can't say (not 'knows nobody')", junk.body.data.available === false && /HRMS_API_URL/.test(junk.body.data.message ?? ""), junk.body.data.message);
  const askedBefore = asked.any;
  const again = await api<AttendanceDayResponse>("GET", "/activity/attendance", "Admin");
  check("…and it isn't asked again for a minute", again.body.data.available === false && asked.any === askedBefore, asked.any - askedBefore);
  hrmsGarbage = false;
  forgetHrms();
}

/* ═══ Case 4 ═══════════════════════════════════════════════════════════════ */

section("Case 4 — who sees what");
{
  for (const path of ["/activity/people", "/activity/logins", "/activity/idle", "/activity/attendance"]) {
    const codes = [(await api("GET", path, null)).status, (await api("GET", path, "Ann")).status, (await api("GET", path, "Wes")).status, (await api("GET", path, "Admin")).status];
    check(`${path}: signed out 401, without the Activity box 403, with it 200, Super Admin 200`, codes.join() === "401,403,200,200", codes);
  }
  const teamPath = `/teams/${alpha}/attendance`;
  const t = {
    out: (await api("GET", teamPath, null)).status,
    ownLeader: (await api<AttendanceDayResponse>("GET", teamPath, "Lead1")).status,
    otherLeader: (await api("GET", teamPath, "Lead2")).status,
    member: (await api("GET", teamPath, "Ann")).status,
    watcher: (await api("GET", teamPath, "Wes")).status,
    admin: (await api("GET", teamPath, "Admin")).status,
  };
  check("a team's attendance: its own leader 200, another team's leader 403, a member 403, the Activity box 200, Super Admin 200, signed out 401", t.ownLeader === 200 && t.otherLeader === 403 && t.member === 403 && t.watcher === 200 && t.admin === 200 && t.out === 401, t);
  const own = await api<AttendanceDayResponse>("GET", teamPath, "Lead1");
  check("…its leader sees the team's six", own.body.data.rows.length === 6, own.body.data.rows.map((x) => x.name));
  check("…a team that doesn't exist → 404", (await api("GET", `/teams/${new Types.ObjectId()}/attendance`, "Admin")).status === 404);
  check("…a bad day → 400", (await api("GET", `${teamPath}?day=nope`, "Lead1")).status === 400);
  check("the heartbeat: anyone signed in 200, signed out 401", (await api("POST", "/activity/heartbeat", "Ann", { active: true })).status === 200 && (await api("POST", "/activity/heartbeat", null, { active: true })).status === 401);
  check("signing out needs signing in → 401", (await api("POST", "/auth/logout", null)).status === 401);
  // Changing the settings needs seeing them too: a role given only "edit" can't.
  const editOnly = new Types.ObjectId();
  await db.collection("roles").insertOne({ _id: editOnly, roleName: "Settings Editor", isSystemRole: false, permissions: perms({ settings: { edit: true } }) });
  await person("Ed", editOnly);
  const edPut = await api("PUT", "/settings/app", "Ed", { idleAlerts: { limitMinutes: 31 } });
  const edGet = await api("GET", "/settings/app", "Ed");
  const adminPut = await api("PUT", "/settings/app", "Admin", { idleAlerts: { limitMinutes: 31 } });
  check("settings: 'edit' without 'view' can't read or change them (403, 403); the Super Admin can (200)", edPut.status === 403 && edGet.status === 403 && adminPut.status === 200, [edPut.status, edGet.status, adminPut.status]);
}

server.close();
hrmsServer.stop(true);
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
