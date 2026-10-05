/**
 * Checks "View as" end to end on a scratch database: a super admin sees the
 * CRM as one of their people for 30 minutes, view only.
 *
 *   - Case 1: the super admin starts it (a session record, a 30-minute pass,
 *     the person's own user record and permissions), reads as them, and "Back
 *     to my account" ends the session — and the pass with it;
 *   - Case 2: the pass stops at once when its time is up, when the admin is no
 *     longer an active super admin, or when the person is deactivated; it can't
 *     start another, and ending twice is refused;
 *   - Case 3: bad targets (not an id, nobody, yourself, a super admin, someone
 *     deactivated) and every change made with the pass are refused, and nothing
 *     changes; a forged pass is refused;
 *   - Case 4: only an active super admin may start it; and signing in, refreshing
 *     and changing things with your own sign-in work as before.
 *
 * Run by view-as-check.sh. Scratch database only.
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

// The routes load the push service, which wants VAPID keys the moment it loads.
const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "view-as-check-jwt",
  JWT_REFRESH_SECRET: "view-as-check-refresh",
  NODE_ENV: "test",
  RUN_SCHEDULERS: "false",
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;

const { User } = await import("../src/models/User.js");
const { Impersonation } = await import("../src/models/Impersonation.js");
// Not User.init(): the User model declares its email index twice, which only an explicit build trips over.
await Impersonation.init();
const { signAccessToken, signImpersonationToken } = await import("../src/utils/jwt.js");

// ── People ──────────────────────────────────────────────────────────────────
const superRole = new Types.ObjectId(), bdeRole = new Types.ObjectId(), managerRole = new Types.ObjectId();
const all = { view: true, create: true, edit: true, delete: true, approve: true, export: true };
await db.collection("roles").insertMany([
  { _id: superRole, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  { _id: bdeRole, roleName: "BDE", isSystemRole: false, permissions: { leads: { view: true, create: true }, enrolments: { view: true } } },
  { _id: managerRole, roleName: "Manager", isSystemRole: false, permissions: { users: all, leads: all } },
]);
const PASSWORD = "Check-Pass-123!";
const people: Record<string, { id: string; email: string; role: Types.ObjectId }> = {};
async function person(name: string, role: Types.ObjectId, status: "active" | "inactive" = "active") {
  const email = `${name.toLowerCase().replace(/\s+/g, ".")}@test.local`;
  const u = await User.create({ name, email, password: PASSWORD, role, status });
  people[name] = { id: String(u._id), email, role };
}
await person("Abrar", superRole);
await person("Ria", superRole);
await person("Old Admin", superRole, "inactive");
await person("Theertha", bdeRole);
await person("Neethu", bdeRole);
await person("Gone", bdeRole, "inactive");
await person("Manny", managerRole);

// ── The API ─────────────────────────────────────────────────────────────────
const express = (await import("express")).default;
const routes = (await import("../src/routes/index.js")).default;
const { errorHandler } = await import("../src/middleware/errorHandler.js");
const app = express();
app.use(express.json());
app.use("/api/v1", routes);
app.use(errorHandler);
const server = app.listen(0);
const port = (server.address() as { port: number }).port;

/** Your own sign-in, as the app would have it. */
const own = (name: string) => signAccessToken({ userId: people[name]!.id, email: people[name]!.email, roleId: String(people[name]!.role) });
type Answer = { status: number; body: { data?: Record<string, unknown> & { user?: Record<string, unknown> }; message?: string } };
async function call(method: string, path: string, token?: string, body?: unknown): Promise<Answer> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Answer["body"] };
}
/** Abrar starts viewing as `name`: the pass, or "" when refused. */
async function viewAs(name: string, by = "Abrar"): Promise<string> {
  const r = await call("POST", `/users/${people[name]!.id}/impersonate`, own(by));
  return r.status === 201 ? String(r.body.data?.accessToken ?? "") : "";
}
const latestSession = () => Impersonation.findOne().sort({ _id: -1 }).lean();

// ── Case 1 ──────────────────────────────────────────────────────────────────
section("Case 1 — a super admin views the CRM as someone, then goes back");
let r = await call("POST", `/users/${people.Theertha!.id}/impersonate`, own("Abrar"));
check("Abrar starts viewing as Theertha: 201", r.status === 201, `${r.status} ${r.body.message}`);
const pass = String(r.body.data?.accessToken ?? "");
const endsIn = new Date(String(r.body.data?.expiresAt)).getTime() - Date.now();
check("…a pass that lasts 30 minutes", pass.length > 20 && endsIn > 29 * 60_000 && endsIn <= 30 * 60_000 + 5_000, `${Math.round(endsIn / 1000)}s`);
const signedInAs = r.body.data?.user as { email?: string; password?: unknown; role?: { roleName?: string } } | undefined;
check("…with Theertha's own user record and role, and no password", signedInAs?.email === people.Theertha!.email && signedInAs?.role?.roleName === "BDE" && signedInAs?.password === undefined);
let session = await latestSession();
check("…and a session on record: who, as whom, open", String(session?.admin) === people.Abrar!.id && String(session?.target) === people.Theertha!.id
  && session?.adminEmail === people.Abrar!.email && session?.targetEmail === people.Theertha!.email && session?.endedAt === null && !!session?.ip);
r = await call("GET", "/auth/profile", pass);
check("reading with the pass is reading as Theertha", r.status === 200 && (r.body.data as { email?: string } | undefined)?.email === people.Theertha!.email, `${r.status}`);
r = await call("GET", `/users/${people.Theertha!.id}`, pass);
check("…her own user page opens", r.status === 200, `${r.status}`);
r = await call("GET", "/users", pass);
check("…with her permissions, not Abrar's: the Users list is refused (403)", r.status === 403, `${r.status}`);
r = await call("POST", "/auth/impersonation/stop", pass);
check("\"Back to my account\" ends it: 200", r.status === 200, `${r.status} ${r.body.message}`);
session = await latestSession();
check("…the session is marked ended", session?.endedAt instanceof Date);
r = await call("GET", "/auth/profile", pass);
check("…and the pass stops working at once: 401", r.status === 401, `${r.status}`);

// ── Case 2 ──────────────────────────────────────────────────────────────────
section("Case 2 — when the pass stops on its own");
let p = await viewAs("Theertha");
await Impersonation.updateOne({ _id: (await latestSession())!._id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
r = await call("GET", "/auth/profile", p);
check("its time is up: 401", r.status === 401, `${r.status}`);
const s0 = await latestSession();
const late = signImpersonationToken(
  { userId: people.Theertha!.id, email: people.Theertha!.email, roleId: String(bdeRole), impersonation: { id: String(s0!._id), by: people.Abrar!.id } },
  Math.floor(Date.now() / 1000) - 31 * 60,
);
r = await call("GET", "/auth/profile", late);
check("a pass issued 31 minutes ago: 401", r.status === 401, `${r.status}`);
p = await viewAs("Theertha");
await User.updateOne({ _id: people.Abrar!.id }, { $set: { role: bdeRole } });
r = await call("GET", "/auth/profile", p);
check("the admin is no longer a super admin: 401", r.status === 401 && /super admin/i.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
await User.updateOne({ _id: people.Abrar!.id }, { $set: { role: superRole, status: "inactive" } });
r = await call("GET", "/auth/profile", p);
check("the admin is deactivated: 401", r.status === 401, `${r.status}`);
await User.updateOne({ _id: people.Abrar!.id }, { $set: { status: "active" } });
p = await viewAs("Theertha");
await User.updateOne({ _id: people.Theertha!.id }, { $set: { status: "inactive" } });
r = await call("GET", "/auth/profile", p);
check("the person viewed is deactivated: 401 (back to the admin), not 403", r.status === 401, `${r.status}`);
await User.updateOne({ _id: people.Theertha!.id }, { $set: { status: "active" } });
p = await viewAs("Theertha");
r = await call("POST", `/users/${people.Neethu!.id}/impersonate`, p);
check("a pass can't start another view-as: 403", r.status === 403, `${r.status}`);
r = await call("POST", "/auth/impersonation/stop", p);
const again = await call("POST", "/auth/impersonation/stop", p);
check("ending it twice: the second is refused (401)", r.status === 200 && again.status === 401, `${r.status}/${again.status}`);

// ── Case 3 ──────────────────────────────────────────────────────────────────
section("Case 3 — bad targets, and changes made with the pass");
r = await call("POST", "/users/not-an-id/impersonate", own("Abrar"));
check("not an id: 404", r.status === 404, `${r.status}`);
r = await call("POST", `/users/${new Types.ObjectId()}/impersonate`, own("Abrar"));
check("nobody by that id: 404", r.status === 404, `${r.status}`);
r = await call("POST", `/users/${people.Abrar!.id}/impersonate`, own("Abrar"));
check("yourself: 400", r.status === 400, `${r.status}`);
r = await call("POST", `/users/${people.Ria!.id}/impersonate`, own("Abrar"));
check("another super admin: 403", r.status === 403, `${r.status}`);
r = await call("POST", `/users/${people.Gone!.id}/impersonate`, own("Abrar"));
check("someone deactivated: 409", r.status === 409, `${r.status}`);
const before = await Impersonation.countDocuments();
p = await viewAs("Theertha");
check("(a refused start leaves no session behind)", (await Impersonation.countDocuments()) === before + 1);
r = await call("PUT", `/users/${people.Theertha!.id}`, p, { name: "Changed" });
const still = await User.findById(people.Theertha!.id).select("name").lean();
check("changing her user with the pass: 403 View only, and nothing changed", r.status === 403 && /view only/i.test(r.body.message ?? "") && still?.name === "Theertha", `${r.status} ${still?.name}`);
const leads = await db.collection("leads").countDocuments();
r = await call("POST", "/leads", p, { name: "Lead", phone: "+971500000001" });
check("adding a lead with the pass: 403, no lead added", r.status === 403 && (await db.collection("leads").countDocuments()) === leads, `${r.status}`);
r = await call("DELETE", `/users/${people.Neethu!.id}`, p);
check("deleting with the pass: 403", r.status === 403, `${r.status}`);
r = await call("PUT", "/auth/change-password", p, { currentPassword: PASSWORD, newPassword: "Other-Pass-456!" });
check("changing her password with the pass: 403", r.status === 403, `${r.status}`);
await call("POST", "/auth/impersonation/stop", p);
r = await call("POST", "/auth/impersonation/stop", own("Abrar"));
check("\"Back to my account\" when not viewing as anyone: 400", r.status === 400, `${r.status}`);
const forged = signImpersonationToken(
  { userId: people.Theertha!.id, email: people.Theertha!.email, roleId: String(bdeRole), impersonation: { id: String(new Types.ObjectId()), by: people.Abrar!.id } },
  Math.floor(Date.now() / 1000),
);
r = await call("GET", "/auth/profile", forged);
check("a pass for a session that doesn't exist: 401", r.status === 401, `${r.status}`);
p = await viewAs("Theertha");
const s1 = await latestSession();
const swapped = signImpersonationToken(
  { userId: people.Neethu!.id, email: people.Neethu!.email, roleId: String(bdeRole), impersonation: { id: String(s1!._id), by: people.Abrar!.id } },
  Math.floor(Date.now() / 1000),
);
r = await call("GET", "/auth/profile", swapped);
check("a session's id on a pass for somebody else: 401", r.status === 401, `${r.status}`);
await call("POST", "/auth/impersonation/stop", p);

// ── Case 4 ──────────────────────────────────────────────────────────────────
section("Case 4 — who may start it, and your own sign-in as before");
r = await call("POST", `/users/${people.Theertha!.id}/impersonate`);
check("no sign-in: 401", r.status === 401, `${r.status}`);
r = await call("POST", `/users/${people.Neethu!.id}/impersonate`, own("Theertha"));
check("a BDE: 403", r.status === 403, `${r.status}`);
r = await call("POST", `/users/${people.Theertha!.id}/impersonate`, own("Manny"));
check("a role with every Users permission, but not Super Admin: 403", r.status === 403, `${r.status}`);
r = await call("POST", `/users/${people.Theertha!.id}/impersonate`, own("Old Admin"));
check("a deactivated super admin: 403", r.status === 403, `${r.status}`);
r = await call("POST", "/auth/impersonation/stop");
check("ending without a sign-in: 401", r.status === 401, `${r.status}`);
r = await call("POST", "/auth/login", undefined, { email: people.Abrar!.email, password: PASSWORD });
const loginData = r.body.data as { accessToken?: string; refreshToken?: string } | undefined;
check("signing in works as before", r.status === 200 && !!loginData?.accessToken && !!loginData?.refreshToken, `${r.status}`);
r = await call("POST", "/auth/refresh-token", undefined, { refreshToken: loginData?.refreshToken });
check("…and refreshing", r.status === 200, `${r.status}`);
r = await call("PUT", `/users/${people.Neethu!.id}`, String(loginData?.accessToken), { name: "Neethu K" });
check("…and making changes with your own sign-in", r.status === 200 && (await User.findById(people.Neethu!.id).lean())?.name === "Neethu K", `${r.status}`);
const ttl = (await Impersonation.collection.indexes()).find((i) => i.expireAfterSeconds !== undefined);
check("sessions are kept a year", ttl?.expireAfterSeconds === 365 * 24 * 60 * 60);

server.close();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
