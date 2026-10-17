/**
 * Inactive leads and calls (the user, 2026-10-17: "inactive leads only marks leads not called — a lead that was
 * called is an active lead"), on a scratch database: an assigned lead nobody acted on for two hours of working time
 * is inactive — unless anyone has ever called it:
 *   - the Call button (call_logs): the owner, a colleague, before it was theirs; out unanswered counts, a missed call
 *     in does not;
 *   - 3CX (lead_calls): out answered or not, in answered — by anyone, before or after; in missed does not.
 * Run by inactive-leads-calls-check.sh. Scratch database only.
 */
import { Types } from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/127\.0\.0\.1|localhost/.test(uri) || !/e2e|test|scratch/i.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch database, got "${uri}"`);
  process.exit(1);
}
const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, { VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, JWT_SECRET: "inactive-calls-jwt", JWT_REFRESH_SECRET: "inactive-calls-refresh", NODE_ENV: "test", RUN_SCHEDULERS: "false", SMTP_HOST: "" });

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail: unknown = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail !== "" ? ` — ${JSON.stringify(detail)}` : ""}\x1b[0m`); }
}

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;
const { CallLog } = await import("../src/models/CallLog.js");
const { LeadCall } = await import("../src/models/LeadCall.js");
const svc = await import("../src/services/inactiveLeadService.js");

// Monday 12 Oct 2026, noon in Dubai; leads assigned at 10:00 — two hours of working time, past the 45-minute default.
const gst = (hhmm: string) => new Date(`2026-10-12T${hhmm}:00+04:00`);
const NOW = gst("12:00");
const ann = new Types.ObjectId(), ben = new Types.ObjectId();
const team = new Types.ObjectId();
await db.collection("users").insertMany([
  { _id: ann, name: "Ann", email: "ann@test.local", password: "x", status: "active" },
  { _id: ben, name: "Ben", email: "ben@test.local", password: "x", status: "active" },
]);
await db.collection("teams").insertOne({ _id: team, name: "Alpha", members: [ann, ben] });
const L: Record<string, Types.ObjectId> = {};
let n = 0;
for (const name of ["idle", "callOwn", "callOther", "callBefore", "callOutNoAnswer", "callInMissed", "tcxOther", "tcxBefore", "tcxOutNoAnswer", "tcxInAnswered", "tcxInMissed"]) {
  const _id = new Types.ObjectId();
  L[name] = _id;
  await db.collection("leads").insertOne({
    _id, name, phone: `+97150000${String(++n).padStart(4, "0")}`, status: "assigned", assignedTo: ann, assignedAt: gst("10:00"),
    team, createdAt: gst("10:00"), updatedAt: gst("10:00"), notes: [], followUps: [], reminders: [], activityLogs: [],
  });
}
const log = (lead: string, o: Record<string, unknown>) => ({ leadId: L[lead], phoneNumber: "+971500000000", callDuration: 30, ...o });
await CallLog.create([
  log("callOwn", { callType: "Outbound", callDirection: "outbound", callDate: gst("10:10"), initiatedBy: ann }),
  log("callOther", { callType: "Outbound", callDirection: "outbound", callDate: gst("10:11"), initiatedBy: ben }),
  log("callBefore", { callType: "Outbound", callDirection: "outbound", callDate: gst("09:00"), initiatedBy: ben }),
  log("callOutNoAnswer", { callType: "Notanswered", callDirection: "outbound", callDate: gst("10:12"), initiatedBy: ben }),
  log("callInMissed", { callType: "Missed", callDirection: "inbound", callDate: gst("10:13") }),
]);
const tcx = (lead: string, user: Types.ObjectId | null, direction: "in" | "out", status: "answered" | "missed" | "no_answer", hhmm: string) =>
  ({ key: `${lead}-${hhmm}`, startedAt: gst(hhmm), direction, status, answered: status === "answered", lead: L[lead], user });
await LeadCall.create([
  tcx("tcxOther", ben, "out", "answered", "10:20"),
  tcx("tcxBefore", ben, "out", "answered", "09:30"),
  tcx("tcxOutNoAnswer", null, "out", "no_answer", "10:21"),
  tcx("tcxInAnswered", null, "in", "answered", "10:22"),
  tcx("tcxInMissed", ann, "in", "missed", "10:23"),
]);

const list = await svc.listInactiveLeads({ page: 1, limit: 100 }, NOW);
const names = new Set(list.items.map((i) => i.name));
const inactive: Record<string, string> = {
  idle: "never called, nothing done",
  callInMissed: "the client rang and nobody answered — not called",
  tcxInMissed: "a 3CX call in nobody answered — not called",
};
const active: Record<string, string> = {
  callOwn: "the owner pressed Call",
  callOther: "a colleague pressed Call",
  callBefore: "called before it was theirs",
  callOutNoAnswer: "called out, nobody answered — somebody tried",
  tcxOther: "a colleague's 3CX call",
  tcxBefore: "a 3CX call from before it was theirs",
  tcxOutNoAnswer: "a 3CX call out nobody answered, not linked to a person",
  tcxInAnswered: "a 3CX call in that was answered",
};
for (const [k, why] of Object.entries(inactive)) check(`inactive: ${k} — ${why}`, names.has(k));
for (const [k, why] of Object.entries(active)) check(`not inactive: ${k} — ${why}`, !names.has(k));
check("nothing else listed", list.items.length === Object.keys(inactive).length, [...names]);
check("the summary counts the same", list.summary.total === Object.keys(inactive).length, list.summary);

console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
await mongoose.disconnect();
process.exit(failures ? 1 : 0);
