/**
 * Editing a reminder's time (the user, 2026-10-22: "follow-up reminder edit"): a reminder moved to a new time alerts
 * again then — the scheduler sends one only while notifiedAt / warnedAt are empty, and an edit used to leave them set.
 *   Case 1  happy path   a new time clears both stamps and saves the time
 *   Case 2  edge         the same time again (a title edit) clears nothing; other reminders untouched
 *   Case 3  errors       a past time is refused, nothing changed
 *   Case 4  permission   no session 401; a role without reminders.edit 403
 *
 * Run by reminder-edit-check.sh. Scratch database only.
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
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail !== "" ? ` — ${JSON.stringify(detail)}` : ""}\x1b[0m`); }
}
const section = (s: string) => console.log(`\n${s}`);

const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "reminder-edit-check-jwt-0123456789", JWT_REFRESH_SECRET: "reminder-edit-check-refresh-0123456789",
  NODE_ENV: "test", RUN_SCHEDULERS: "false", HRMS_API_URL: "", HRMS_CLIENT_ID: "", HRMS_INTEGRATION_SECRET: "", HRMS_ORG_ID: "",
  THREECX_URL: "", THREECX_CLIENT_ID: "", THREECX_API_KEY: "",
});
const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
if (!["127.0.0.1", "localhost"].includes(mongoose.connection.host)) throw new Error("not a local database");
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;
const { Lead } = await import("../src/models/Lead.js");
const { signAccessToken } = await import("../src/utils/jwt.js");
const express = (await import("express")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");

const admin = new Types.ObjectId(), viewer = new Types.ObjectId();
await db.collection("roles").insertMany([
  { _id: admin, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  { _id: viewer, roleName: "Viewer", isSystemRole: false, permissions: { leads: { view: true, edit: false }, reminders: { view: true, edit: false } } },
]);
const ann = new Types.ObjectId(), vic = new Types.ObjectId();
await db.collection("users").insertMany([
  { _id: ann, name: "Ann", email: "ann@test.local", password: "x", role: admin, status: "active" },
  { _id: vic, name: "Vic", email: "vic@test.local", password: "x", role: viewer, status: "active" },
]);

const H = 3_600_000;
const past = new Date(Date.now() - 30 * 86_400_000);
const at = (hours: number) => new Date(Math.floor((Date.now() + hours * H) / 60_000) * 60_000);
const reminderRow = (o: Record<string, unknown>) => ({ _id: new Types.ObjectId(), title: "Call back", note: "", createdBy: ann, isDone: false, notifiedAt: null, warnedAt: null, createdAt: past, updatedAt: past, ...o });
async function lead(reminders: unknown[]) {
  const _id = new Types.ObjectId();
  await Lead.collection.insertOne({
    _id, name: "L", phone: `+97150${Math.floor(Math.random() * 9_000_000) + 1_000_000}`, email: `l${_id}@test.local`, source: "META", status: "assigned",
    assignedTo: ann, assignedAt: past, reporter: ann, notes: [], reminders, payments: [], activityLogs: [], callCount: 0, createdAt: past, updatedAt: past,
  });
  return _id;
}
const one = async (id: Types.ObjectId, rid: Types.ObjectId) =>
  (await Lead.collection.findOne({ _id: id }))!.reminders.find((x: { _id: Types.ObjectId }) => String(x._id) === String(rid));
const same = (a: unknown, b: Date) => !!a && new Date(a as Date).getTime() === b.getTime();

const app = express();
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;
const ANN = signAccessToken({ userId: String(ann), email: "ann@test.local", roleId: String(admin) });
const VIC = signAccessToken({ userId: String(vic), email: "vic@test.local", roleId: String(viewer) });
async function put(id: Types.ObjectId, rid: Types.ObjectId, body: unknown, token: string | null = ANN) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`http://127.0.0.1:${port}/api/v1/leads/${id}/reminders/${rid}`, { method: "PUT", headers, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

const fired = new Date();
const a = reminderRow({ remindAt: at(1), notifiedAt: fired, warnedAt: fired });
const b = reminderRow({ title: "Send the brochure", remindAt: at(2), notifiedAt: fired, warnedAt: fired });
const id = await lead([a, b]);

section("Case 1 — a new time alerts again");
{
  const to = at(20);
  const r = await put(id, a._id, { remindAt: to.toISOString() });
  const x = await one(id, a._id);
  check("200, the new time saved", r.status === 200 && same(x.remindAt, to), r);
  check("both alert stamps cleared, so the scheduler sends it again", x.notifiedAt === null && x.warnedAt === null, x);
}

section("Case 2 — the same time again");
{
  const r = await put(id, b._id, { remindAt: at(2).toISOString(), title: "Send the brochure (PDF)" });
  const x = await one(id, b._id);
  check("a title edit with the same time: saved, stamps kept", r.status === 200 && x.title === "Send the brochure (PDF)" && same(x.notifiedAt, fired) && same(x.warnedAt, fired), x);
  const y = await one(id, a._id);
  check("the other reminder untouched", same(y.remindAt, at(20)) && y.notifiedAt === null);
}

section("Case 3 — errors");
{
  const r = await put(id, b._id, { remindAt: new Date(Date.now() - 6 * H).toISOString() });
  const x = await one(id, b._id);
  check("a past time: 400, nothing changed", r.status === 400 && same(x.remindAt, at(2)) && same(x.notifiedAt, fired), [r.status, x]);
}

section("Case 4 — permission");
{
  let r = await put(id, b._id, { remindAt: at(30).toISOString() }, null);
  check("no session: 401", r.status === 401, r.status);
  r = await put(id, b._id, { remindAt: at(30).toISOString() }, VIC);
  check("a role without reminders.edit: 403", r.status === 403, r.status);
  check("…nothing changed", same((await one(id, b._id)).remindAt, at(2)));
}

server.close();
await mongoose.connection.dropDatabase();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed${failures ? ` — ${failures} FAILED` : ""}`);
process.exit(failures ? 1 : 0);
