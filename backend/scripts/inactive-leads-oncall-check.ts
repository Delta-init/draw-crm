/**
 * Checks that time on calls doesn't count towards a lead going inactive, and that nothing moves while its owner is on a
 * call (the user, 2026-10-19), on a scratch database with a stand-in 3CX (a token, and each extension's live
 * participants):
 *
 *   - Case 1: a 20-minute call by the owner's account comes off the clock (list and mover);
 *   - Case 2: a call matched only by the extension, unanswered, counts too; two overlapping calls are taken off once;
 *   - Case 3: the owner on a call right now — listed as on a call, the mover leaves it, a super admin can still move it
 *     by hand; off the call it moves;
 *   - Case 4: 3CX not answering, or not connected — nobody counts as on a call, the mover carries on;
 *   - Case 5: the page lists only leads that came in from 1 October 2026 (Dubai) on; the mover is unchanged;
 *   - Case 6: breaks ("Take break", 2026-10-20, as in the Sales CRM) — an ended break comes off the clock, somebody
 *     else's doesn't, a break and a call overlapping come off once; on a break now: listed as on a break, the mover
 *     leaves it, by hand still can; a break left on from an earlier day ends with that day;
 *   - Case 7: the Take break button (GET/POST /break) — signed in only, everyone's own, what it's for, bad input
 *     refused, a second start keeps the first, End pressed twice at once writes it once, one left on from yesterday
 *     is written to its midnight.
 *
 * Run by inactive-leads-oncall-check.sh. Scratch database only.
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

// A stand-in 3CX.
let liveOn = new Set<string>();
let threecxDown = false;
const fake3cx = Bun.serve({
  port: 0, hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/connect/token") return Response.json({ access_token: "stand-in", expires_in: 3600 });
    const m = url.pathname.match(/^\/callcontrol\/(\d+)$/);
    if (m) {
      if (threecxDown) return new Response("down", { status: 503 });
      return Response.json({ dn: m[1], devices: [], participants: liveOn.has(m[1]) ? [{ id: 7, status: "Connected", callid: 99 }] : [] });
    }
    return new Response("not here", { status: 404 });
  },
});

const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "oncall-check-jwt-secret-0123456789", JWT_REFRESH_SECRET: "oncall-check-refresh-secret-0123456789",
  NODE_ENV: "test", RUN_SCHEDULERS: "false", HRMS_API_URL: "", HRMS_CLIENT_ID: "", HRMS_INTEGRATION_SECRET: "", HRMS_ORG_ID: "",
  THREECX_URL: `http://127.0.0.1:${fake3cx.port}`, THREECX_CLIENT_ID: "stand-in", THREECX_API_KEY: "stand-in-key",
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;
const { Lead } = await import("../src/models/Lead.js");
const { LeadCall } = await import("../src/models/LeadCall.js");
const { AppSetting } = await import("../src/models/AppSetting.js");
const { updateAppSettings } = await import("../src/services/settingsService.js");
const svc = await import("../src/services/inactiveLeadService.js");
const { forgetLiveCalls } = await import("../src/services/callClock.js");

const ids: Record<string, Types.ObjectId> = {};
const role = new Types.ObjectId(), admin = new Types.ObjectId();
await db.collection("roles").insertMany([{ _id: admin, roleName: "Super Admin", isSystemRole: true, permissions: {} }, { _id: role, roleName: "Sales Staff", isSystemRole: false, permissions: {} }]);
for (const [name, ext, r] of [["Admin", "", admin], ["Ann", "101", role], ["Ben", "102", role], ["Cat", "103", role], ["Dan", "104", role]] as const) {
  ids[name] = new Types.ObjectId();
  await db.collection("users").insertOne({ _id: ids[name], name, email: `${name.toLowerCase()}@test.local`, password: "x", role: r, status: "active", extension: ext || null });
}
const alpha = new Types.ObjectId();
await db.collection("teams").insertOne({
  _id: alpha, name: "Alpha", leaders: [], members: [ids.Ann, ids.Ben, ids.Cat, ids.Dan], inactiveMembers: [], absentToday: [], status: "active",
  settings: { autoAssign: true, splitMode: "round_robin", splitStrategy: "scheduled", splitTime: null, roundRobinIndex: 0, includedMembers: [], roundRobinStartDate: null,
    sourceRoundRobinIndices: {}, sourceExclusions: {}, attendanceSplit: false },
  createdAt: new Date(), updatedAt: new Date(),
});
await AppSetting.init();
await updateAppSettings({ inactiveLeads: { autoReassign: true, limitMinutes: 45 } }, String(ids.Admin));
await AppSetting.collection.updateOne({ key: "app" }, { $set: { "inactiveLeads.enabledAt": new Date("2026-10-19T08:00:00+04:00") } });
await updateAppSettings({}, String(ids.Admin));

// Monday 19 October 2026, Gulf time — inside the working hours here (10:00–19:00 Draw, 09:00–18:00 Remote).
const gst = (hhmm: string) => new Date(`2026-10-19T${hhmm}:00+04:00`);
let seq = 0;
async function lead(name: string, owner: Types.ObjectId, assigned: string) {
  const _id = new Types.ObjectId(), at = gst(assigned);
  await Lead.collection.insertOne({
    _id, name, phone: `+9715${String(10_000_000 + ++seq)}`, email: `l${seq}@test.local`, source: "META", status: "assigned", assignedTo: owner, assignedAt: at,
    team: alpha, reporter: ids.Admin, notes: [], reminders: [], payments: [], activityLogs: [], followUps: [], callCount: 0, firstContactTime: null, createdAt: at, updatedAt: at,
  });
  return _id;
}
let k = 0;
const call = (startHHMM: string, seconds: number, o: Record<string, unknown>) => LeadCall.collection.insertOne({
  key: `c-${++k}`, callId: String(k), segmentId: "", startedAt: gst(startHHMM), direction: "out", status: "answered", answered: true, talkSeconds: seconds, ringSeconds: 0,
  number: "971500000000", numberKey: "500000000", extension: "", agentName: "", recordingIds: [], recordingUrl: "", reason: "", rows: 1, lead: new Types.ObjectId(),
  leadName: "", user: null, userName: "", syncedAt: new Date(), createdAt: new Date(), updatedAt: new Date(), ...o,
});
const ownerOf = async (id: Types.ObjectId) => String((await Lead.findById(id).lean())?.assignedTo ?? "");
const listed = async (at: string) => (await svc.listInactiveLeads({ page: 1, limit: 100 } as never, gst(at))).items;

section("Case 1 — a call by the owner's account");
const annLead = await lead("Ann Busy", ids.Ann, "11:00");
await call("11:10", 1200, { user: ids.Ann, extension: "101" });
check("11:45: 45 min less a 20-min call = 25 — not inactive", !(await listed("11:45")).some((i) => i.id === String(annLead)));
check("…and the mover leaves it", (await svc.sweepInactiveLeads(gst("11:45"))).moved === 0 && (await ownerOf(annLead)) === String(ids.Ann));
check("12:05: 65 − 20 = 45 — inactive", (await listed("12:05")).find((i) => i.id === String(annLead))?.waitingMinutes === 45, (await listed("12:05")).map((i) => [i.name, i.waitingMinutes]));

section("Case 2 — by the extension only, unanswered; overlapping calls");
const benLead = await lead("Ben Busy", ids.Ben, "11:00");
await call("11:10", 1200, { extension: "102", user: null, status: "no_answer", answered: false });
check("a call on Ben's extension with no person on it, unanswered, counts: 45 at 12:05", (await listed("12:05")).find((i) => i.id === String(benLead))?.waitingMinutes === 45);
const catLead = await lead("Cat Busy", ids.Cat, "11:00");
await call("11:10", 1200, { user: ids.Cat, extension: "103" });
await call("11:20", 1200, { user: ids.Cat, extension: "103" });
check("calls 11:10–11:30 and 11:20–11:40 take off 30, not 40: 75 − 30 = 45 at 12:15", (await listed("12:15")).find((i) => i.id === String(catLead))?.waitingMinutes === 45,
  (await listed("12:15")).map((i) => [i.name, i.waitingMinutes]));

section("Case 3 — on a call right now");
const danLead = await lead("Dan On Call", ids.Dan, "11:00");
liveOn = new Set(["104"]);
forgetLiveCalls();
check("shown as on a call", (await listed("13:00")).find((i) => i.id === String(danLead))?.autoMove === "on_call", (await listed("13:00")).map((i) => [i.name, i.autoMove]));
await svc.sweepInactiveLeads(gst("13:00"));
check("…the mover leaves Dan's lead", (await ownerOf(danLead)) === String(ids.Dan));
check("…others' due leads still move", (await ownerOf(annLead)) !== String(ids.Ann));
const danHand = await lead("Dan By Hand", ids.Dan, "11:00");
const byHand = await svc.reassignInactiveLeads({ leadIds: [String(danHand)], to: String(ids.Cat) }, String(ids.Admin), gst("13:00"));
check("…a super admin can still move one of his by hand", byHand.moved.length === 1 && (await ownerOf(danHand)) === String(ids.Cat), byHand);
liveOn = new Set();
forgetLiveCalls();
await svc.sweepInactiveLeads(gst("13:01"));
check("off the call: it moves", (await ownerOf(danLead)) !== String(ids.Dan));

section("Case 4 — 3CX down, or not connected");
const downLead = await lead("Dan 3CX Down", ids.Dan, "11:00");
liveOn = new Set(["104"]);
threecxDown = true;
forgetLiveCalls();
await svc.sweepInactiveLeads(gst("13:02"));
check("3CX not answering: not held — moved as before", (await ownerOf(downLead)) !== String(ids.Dan));
threecxDown = false;
delete process.env.THREECX_API_KEY;
const offLead = await lead("Dan No 3CX", ids.Dan, "11:00");
forgetLiveCalls();
check("3CX not connected: due as usual", (await listed("13:03")).find((i) => i.id === String(offLead))?.autoMove === "due", (await listed("13:03")).map((i) => [i.name, i.autoMove]));

section("Case 5 — the page lists leads that came in from 1 October 2026 (Dubai) on (the user, 2026-10-19)");
{
  const at = (iso: string) => new Date(iso);
  const old = async (name: string, created: string, original?: string) => {
    const _id = new Types.ObjectId();
    await Lead.collection.insertOne({
      _id, name, phone: `+9715${String(10_000_000 + ++seq)}`, email: `l${seq}@test.local`, source: "META", status: "assigned", assignedTo: ids.Ann, assignedAt: gst("11:00"),
      team: alpha, reporter: ids.Admin, notes: [], reminders: [], payments: [], activityLogs: [], followUps: [], callCount: 0, firstContactTime: null,
      createdAt: at(created), updatedAt: at(created), ...(original ? { originalCreatedAt: at(original) } : {}),
    });
    return String(_id);
  };
  const sept = await old("Came in 30 Sep 23:50", "2026-09-30T23:50:00+04:00");
  const oct1 = await old("Came in 1 Oct 00:10", "2026-10-01T00:10:00+04:00");
  const handed = await old("Came in Sep, handed over Oct", "2026-10-19T11:00:00+04:00", "2026-09-25T10:00:00+04:00");
  const back = await old("Came in Oct, handed over again", "2026-10-19T11:00:00+04:00", "2026-10-05T10:00:00+04:00");
  const shown = new Set((await listed("13:10")).map((i) => i.id));
  check("30 September 23:50 Dubai: hidden", !shown.has(sept));
  check("1 October 00:10 Dubai: shown", shown.has(oct1));
  check("first came in on 25 September, handed over in October: hidden", !shown.has(handed));
  check("first came in on 5 October, handed over later: shown", shown.has(back));
  const list = await svc.listInactiveLeads({ page: 1, limit: 100 } as never, gst("13:10"));
  check("the page's count follows the list", list.summary.total === list.items.length && !list.items.some((i) => i.id === sept || i.id === handed), list.summary);
  await svc.sweepInactiveLeads(gst("13:10"));
  check("the automatic mover is unchanged: the hidden September lead still moves", (await ownerOf(new Types.ObjectId(sept))) !== String(ids.Ann));
}

section("Case 6 — breaks: an ended break off the clock, on a break now, a break left on (2026-10-20)");
{
  const { BreakLog } = await import("../src/models/BreakLog.js");
  await BreakLog.init();
  for (const [name, ext] of [["Eve", "105"], ["Fay", "106"], ["Gus", "107"], ["Hal", "108"], ["Ivy", "109"]] as const) {
    ids[name] = new Types.ObjectId();
    await db.collection("users").insertOne({ _id: ids[name], name, email: `${name.toLowerCase()}@test.local`, password: "x", role, status: "active", extension: ext });
  }
  await db.collection("teams").updateOne({ _id: alpha }, { $push: { members: { $each: [ids.Eve, ids.Fay, ids.Gus, ids.Hal, ids.Ivy] } } } as never);
  liveOn = new Set();
  forgetLiveCalls();

  // Eve took a break 11:10–11:30 (ended, written down).
  const eveLead = await lead("Eve Break", ids.Eve, "11:00");
  await BreakLog.create({ user: ids.Eve, start: gst("11:10"), end: gst("11:30"), kind: "tea" });
  check("11:45: 45 min less a 20-min break = 25 — not inactive", !(await listed("11:45")).some((i) => i.id === String(eveLead)));
  await svc.sweepInactiveLeads(gst("11:45"));
  check("…and the mover leaves it", (await ownerOf(eveLead)) === String(ids.Eve));
  check("12:05: 65 − 20 = 45 — inactive", (await listed("12:05")).find((i) => i.id === String(eveLead))?.waitingMinutes === 45, (await listed("12:05")).map((i) => [i.name, i.waitingMinutes]));
  const fayLead = await lead("Fay Unbroken", ids.Fay, "11:00");
  check("somebody else's break doesn't stop Fay's clock: 65 min at 12:05", (await listed("12:05")).find((i) => i.id === String(fayLead))?.waitingMinutes === 65);

  // Gus: a break 11:10–11:30 and a call 11:20–11:40 — 30 min off, not 40.
  const gusLead = await lead("Gus Break And Call", ids.Gus, "11:00");
  await BreakLog.create({ user: ids.Gus, start: gst("11:10"), end: gst("11:30") });
  await call("11:20", 1200, { user: ids.Gus, extension: "107" });
  check("a break 11:10–11:30 and a call 11:20–11:40 take off 30, not 40: 75 − 30 = 45 at 12:15", (await listed("12:15")).find((i) => i.id === String(gusLead))?.waitingMinutes === 45,
    (await listed("12:15")).map((i) => [i.name, i.waitingMinutes]));

  // Hal on a break since 13:00: past the limit, listed as on a break, never moved while it lasts; the break doesn't count.
  const halLead = await lead("Hal On Break", ids.Hal, "11:00");
  await db.collection("users").updateOne({ _id: ids.Hal }, { $set: { breakSince: gst("13:00"), breakKind: "lunch" } });
  const halRow = (await listed("13:20")).find((i) => i.id === String(halLead));
  check("on a break since 13:00, at 13:20: 120 min counted (the break's 20 not), shown as on a break", halRow?.waitingMinutes === 120 && halRow?.autoMove === "on_break", halRow);
  await svc.sweepInactiveLeads(gst("13:20"));
  check("…the mover leaves it while the break lasts", (await ownerOf(halLead)) === String(ids.Hal));
  check("…others' due leads still move (Fay's)", (await ownerOf(fayLead)) !== String(ids.Fay));
  const halHand = await lead("Hal By Hand", ids.Hal, "11:00");
  const byHandBreak = await svc.reassignInactiveLeads({ leadIds: [String(halHand)], to: String(ids.Cat) }, String(ids.Admin), gst("13:20"));
  check("…a super admin can still move one of his by hand", byHandBreak.moved.length === 1 && (await ownerOf(halHand)) === String(ids.Cat), byHandBreak);
  const { inactiveNow } = await import("../src/services/inactiveLeadService.js");
  check("…the Workflow's \"inactive now\" says on a break too", (await inactiveNow(gst("13:20"), [halLead])).get(String(halLead))?.state === "on_break");
  await db.collection("users").updateOne({ _id: ids.Hal }, { $set: { breakSince: null, breakKind: null } });
  await svc.sweepInactiveLeads(gst("13:21"));
  check("back from the break: it moves", (await ownerOf(halLead)) !== String(ids.Hal));

  // Ivy left a break on from Monday 18:40 and never ended it: it ended with Monday, not on into Tuesday.
  const ivyId = new Types.ObjectId(), ivyAt = gst("18:30");
  await Lead.collection.insertOne({
    _id: ivyId, name: "Ivy Left On", phone: `+9715${String(10_000_000 + ++seq)}`, email: `l${seq}@test.local`, source: "META", status: "assigned", assignedTo: ids.Ivy, assignedAt: ivyAt,
    team: alpha, reporter: ids.Admin, notes: [], reminders: [], payments: [], activityLogs: [], followUps: [], callCount: 0, firstContactTime: null, createdAt: ivyAt, updatedAt: ivyAt,
  });
  await db.collection("users").updateOne({ _id: ids.Ivy }, { $set: { breakSince: gst("18:40") } });
  const ivyAt1034 = (await svc.listInactiveLeads({ page: 1, limit: 100 } as never, new Date("2026-10-20T10:34:00+04:00"))).items.find((i) => i.id === String(ivyId));
  check("a break left on Monday ends with Monday: Tuesday 10:34 is 10 min Mon + 34 Tue = 44 — not inactive yet", ivyAt1034 === undefined, ivyAt1034);
  const ivyAt1035 = (await svc.listInactiveLeads({ page: 1, limit: 100 } as never, new Date("2026-10-20T10:35:00+04:00"))).items.find((i) => i.id === String(ivyId));
  check("…10:35: 45 — inactive, due, not on a break (it didn't run on into Tuesday)", ivyAt1035?.waitingMinutes === 45 && ivyAt1035?.autoMove === "due", ivyAt1035);
  await db.collection("users").updateOne({ _id: ids.Ivy }, { $set: { breakSince: null } });
}

section("Case 7 — the Take break button (GET/POST /api/v1/break)");
{
  const { BreakLog } = await import("../src/models/BreakLog.js");
  const { drawMidnight } = await import("../src/services/breakClock.js");
  const { signAccessToken } = await import("../src/utils/jwt.js");
  const express = (await import("express")).default;
  const routes = (await import("../src/routes/index.js")).default;
  const { errorHandler } = await import("../src/middleware/errorHandler.js");
  const app = express();
  app.use(express.json());
  app.use("/api/v1", routes);
  app.use(errorHandler);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;
  const token = (name: string) => signAccessToken({ userId: String(ids[name]), email: `${name.toLowerCase()}@test.local`, roleId: String(role) });
  type MyBreak = { onBreak: boolean; since: string | null; kind: string | null };
  async function brk(method: "GET" | "POST", who: string | null, body?: unknown): Promise<{ status: number; data?: MyBreak }> {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/break`, {
      method, headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${token(who)}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await res.json().catch(() => ({}))) as { data?: MyBreak };
    return { status: res.status, data: json.data };
  }
  await BreakLog.collection.deleteMany({});

  check("not signed in: GET and POST → 401", (await brk("GET", null)).status === 401 && (await brk("POST", null, { on: true })).status === 401);
  const before = await brk("GET", "Ben");
  check("Ben, not on a break: onBreak false", before.status === 200 && before.data?.onBreak === false && before.data?.since === null, before);
  const bad = [await brk("POST", "Ben", {}), await brk("POST", "Ben", { on: "yes" }), await brk("POST", "Ben", { on: true, kind: "nap" })];
  check("no on, on not a boolean, a kind it doesn't know → 400, nothing started", bad.every((r) => r.status === 400) && (await brk("GET", "Ben")).data?.onBreak === false, bad.map((r) => r.status));
  const on1 = await brk("POST", "Ben", { on: true, kind: "lunch" });
  check("Take break (lunch) → on a break, since now, what it's for; none written yet", on1.status === 200 && on1.data?.onBreak === true && on1.data?.kind === "lunch" && !!on1.data?.since
    && (await BreakLog.countDocuments({ user: ids.Ben })) === 0, on1);
  const on2 = await brk("POST", "Ben", { on: true, kind: "tea" });
  check("…pressed again: keeps when it began and what it's for", on2.data?.since === on1.data?.since && on2.data?.kind === "lunch", on2);
  check("…it's his alone: Ann isn't on one", (await brk("GET", "Ann")).data?.onBreak === false);
  await Bun.sleep(1100);
  const offs = await Promise.all([brk("POST", "Ben", { on: false }), brk("POST", "Ben", { on: false })]);
  const logs = await BreakLog.find({ user: ids.Ben }).lean();
  check("End break (pressed twice at once) → ended, written once, start before end, the kind kept", offs.every((o) => o.status === 200 && o.data?.onBreak === false) && logs.length === 1
    && logs[0].end > logs[0].start && logs[0].kind === "lunch", logs);
  const benNow = await db.collection("users").findOne({ _id: ids.Ben });
  check("…and off his account", benNow?.breakSince === null && benNow?.breakKind === null, benNow);
  const leftDay = new Date(drawMidnight().getTime() - 3 * 3_600_000);
  await db.collection("users").updateOne({ _id: ids.Ben }, { $set: { breakSince: leftDay, breakKind: "meeting" } });
  const stale = await brk("GET", "Ben");
  check("a break left on from yesterday: not on a break today", stale.data?.onBreak === false && stale.data?.since === null, stale);
  await brk("POST", "Ben", { on: true });
  const leftLog = await BreakLog.findOne({ user: ids.Ben, start: leftDay }).lean();
  check("…a new one → yesterday's written to its midnight (Dubai), with its kind", leftLog?.end.getTime() === drawMidnight().getTime() && leftLog?.kind === "meeting", leftLog);
  const fresh = await brk("GET", "Ben");
  check("…and the new one is today's, no kind said", fresh.data?.onBreak === true && Date.parse(fresh.data?.since ?? "") >= drawMidnight().getTime() && fresh.data?.kind === null, fresh);
  await brk("POST", "Ben", { on: false });
  server.close();
}

fake3cx.stop(true);
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
