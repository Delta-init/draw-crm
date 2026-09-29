/**
 * Mapping Draw courses onto Delta Finance products and LMS courses, end to end,
 * against a real backend process — finance and the LMS are stand-ins served
 * here, finance checking every signature the way its own middleware does.
 *
 *   Case 1  happy path   the two lists, a course mapped (a bundle to two LMS
 *                        courses), and the enrolment finance receives
 *   Case 2  edge         repeats, order, unmapping, a mapping from before the
 *                        list, an empty LMS
 *   Case 3  errors       malformed ids and slugs, too many, an unknown course,
 *                        finance or the LMS down
 *   Case 4  permission   no token, a role that cannot edit courses, a
 *                        switched-off account
 *
 * Run through scripts/course-mapping-e2e.sh. Refuses anything but a scratch
 * database on 127.0.0.1.
 */
import crypto from "node:crypto";
import http from "node:http";
import mongoose from "mongoose";

const uri = process.env.MONGODB_URI ?? "";
if (!/^mongodb:\/\/127\.0\.0\.1:\d+\/[^/?]*e2e/.test(uri)) {
  console.error(`Refusing to run: MONGODB_URI must be a scratch e2e database on 127.0.0.1, got "${uri}"`);
  process.exit(1);
}
const API = `http://127.0.0.1:${process.env.E2E_API_PORT}/api/v1`;
const INBOUND_SECRET = process.env.FINANCE_INTEGRATION_SECRET ?? "";
const CLIENT_ID = process.env.FINANCE_CLIENT_ID ?? "";
const ORG_ID = process.env.FINANCE_ORG_ID ?? "";

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
/** What this API answers with, as far as the checks read it. */
interface CourseOut { _id: string; amount: number; financeItemId: string | null; lmsCourseSlug: string; lmsCourseSlugs: string[] }
interface Listed { id?: string; sku?: string; slug?: string }
interface Envelope { success?: boolean; message?: string; data?: CourseOut & Listed[] & { accessToken?: string } }
interface Res { status: number; body: Envelope }
/** A course line of the enrolment finance receives. */
interface PayloadCourse { name: string; amountMinor: number; itemId?: string; lmsCourseSlug?: string; lmsCourseSlugs?: string[] }

const show = (r: Res) => `${r.status} ${JSON.stringify(r.body).slice(0, 220)}`;
async function call(method: string, path: string, body?: unknown, token?: string): Promise<Res> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Envelope };
}

const MBT = "market-break-out-trading-program";
const DWT = "delta-wave-theory-trading-programme";
const AI = "ai-academy-english";

/** A small JSON server on a port — node:http, since this backend carries Node's types, not Bun's. */
function serve(port: number, handle: (url: URL, req: http.IncomingMessage) => { status: number; body: unknown }) {
  const server = http.createServer((req, res) => {
    const { status, body } = handle(new URL(req.url ?? "/", `http://127.0.0.1:${port}`), req);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  server.listen(port, "127.0.0.1");
  return server;
}

/* ── A stand-in finance: the catalogue, behind the signature finance checks. ── */
let financeMode: "up" | "down" = "up";
let badSignatures = 0;
const ITEM_C1 = { id: "64b0000000000000000000a1", name: "COURSE 1 - MARKET BREAKOUT THEORY (WITH CREDIT)", sku: "DRAW-C1-WC", unitPriceMinor: 225_000, type: "service" };
const ITEM_C2 = { id: "64b0000000000000000000a2", name: "MBT + DWT (with credit)", sku: "DRAW-C2-WC", unitPriceMinor: 550_000, type: "service" };
const finance = serve(Number(process.env.E2E_FAKE_FINANCE_PORT), (url, req) => {
  if (req.method !== "GET" || url.pathname !== "/api/v1/integrations/items") return { status: 404, body: { error: { message: "Not found" } } };
  const header = (name: string) => String(req.headers[name] ?? "");
  const expected = crypto.createHmac("sha256", INBOUND_SECRET)
    .update(["GET", url.pathname + url.search, header("x-delta-timestamp"), header("x-delta-nonce"), crypto.createHash("sha256").update("").digest("hex")].join("\n"))
    .digest("hex");
  if (header("x-delta-client") !== CLIENT_ID || header("x-delta-signature") !== expected || header("x-delta-org") !== ORG_ID) {
    badSignatures++;
    return { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "Unauthorized" } } };
  }
  if (financeMode === "down") return { status: 503, body: { error: { message: "down" } } };
  return { status: 200, body: { data: [ITEM_C1, ITEM_C2] } };
});

/* ── A stand-in LMS: its public course list. ── */
let lmsMode: "up" | "empty" | "down" = "up";
let lmsPerPage = "";
const lms = serve(Number(process.env.E2E_FAKE_LMS_PORT), (url) => {
  if (url.pathname !== "/api/v1/courses") return { status: 404, body: { success: false } };
  lmsPerPage = url.searchParams.get("per_page") ?? "";
  if (lmsMode === "down") return { status: 500, body: { success: false, error: { message: "down" } } };
  const data = lmsMode === "empty" ? [] : [
    { slug: MBT, title: "MARKET BREAK-OUT TRADING PROGRAM", organizationId: "dubai" },
    { slug: DWT, title: "DELTA WAVE THEORY TRADING PROGRAMME", organizationId: "dubai" },
    { slug: AI, title: "Ai Academy English", organizationId: "bangalore" },
  ];
  return { status: 200, body: { success: true, data, meta: { page: 1, per_page: 100, total: data.length } } };
});

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
for (const c of await mongoose.connection.db!.listCollections().toArray()) await mongoose.connection.db!.collection(c.name).deleteMany({});

const { Role } = await import("../models/Role.js");
const { User } = await import("../models/User.js");
const { Course } = await import("../models/Course.js");
const { Student } = await import("../models/Student.js");
const { StudentService } = await import("../services/studentService.js");

step("Setting up");
const PASSWORD = "E2e-Password-123";
const adminRole = await Role.create({ roleName: "Super Admin", isSystemRole: true });
const viewerRole = await Role.create({ roleName: "Viewer", permissions: { leads: { view: true, edit: false } } });
await User.create({ name: "Draw Admin", email: "admin@draw-e2e.test", password: PASSWORD, role: adminRole._id, status: "active" });
await User.create({ name: "Draw Viewer", email: "viewer@draw-e2e.test", password: PASSWORD, role: viewerRole._id, status: "active" });
const login = async (email: string) => (await call("POST", "/auth/login", { email, password: PASSWORD })).body?.data?.accessToken as string | undefined;
const admin = (await login("admin@draw-e2e.test"))!;
const viewer = (await login("viewer@draw-e2e.test"))!;
check("an admin and a viewer can sign in", !!admin && !!viewer);

const make = async (name: string, amount: number): Promise<CourseOut> => {
  const r = await call("POST", "/courses", { name, amount, status: "active" }, admin);
  if (!r.body.data?._id) throw new Error(`could not create "${name}": ${show(r)}`);
  return r.body.data;
};
const c1 = await make("COURSE 1 - MARKET BREAKOUT THEORY (WITH CREDIT)", 2250);
const c2 = await make("COURSE 2 - MBT + DWT (WITH CREDIT)", 5500);
const c3 = await make("MENTOR'S MASTERY COURSE", 1837);
// Mapped the old way, before the list: one slug and nothing else.
const legacy = await Course.create({ name: "DELTA WAVE THEORY", amount: 4000, status: "active", lmsCourseSlug: DWT });
check("four courses, one mapped the old way", !!c1?._id && !!c2?._id && !!c3?._id && !!legacy._id);

const payloadFor = async (courseIds: unknown[], totalFee: number) => {
  const student = await new Student({
    enrollmentNumber: `E2E-${crypto.randomUUID().slice(0, 8)}`, name: "Priya Draw", email: "priya@draw-e2e.test",
    phone: "+971500000001", leadId: new mongoose.Types.ObjectId(), courses: courseIds, totalFee, paidAmount: 1000, language: "English",
  }).save();
  return (await new StudentService().buildHandoverPayload(String(student._id))) as { courses?: PayloadCourse[] } | null;
};

// ── Case 1 ──────────────────────────────────────────────────────────────────
step("Case 1 — happy path: the lists, a course mapped, what finance receives");
let r = await call("GET", "/courses/finance-items", undefined, admin);
check("finance's products are listed — read live, signed as finance checks", r.status === 200 && r.body?.data?.length === 2
  && r.body.data[1]?.sku === "DRAW-C2-WC" && badSignatures === 0, show(r));
r = await call("GET", "/courses/lms-courses", undefined, admin);
check("the LMS's courses are listed, by title, all of them asked for", r.status === 200 && r.body?.data?.length === 3
  && r.body.data[0]?.slug === AI && r.body.data[2]?.slug === MBT && lmsPerPage === "100", show(r));
r = await call("PUT", `/courses/${c2._id}`, { financeItemId: ITEM_C2.id, lmsCourseSlugs: [MBT, DWT] }, admin);
check("a bundle is mapped to its product and both its LMS courses", r.status === 200 && r.body?.data?.financeItemId === ITEM_C2.id
  && JSON.stringify(r.body.data?.lmsCourseSlugs) === JSON.stringify([MBT, DWT]) && r.body.data?.lmsCourseSlug === MBT, show(r));
r = await call("PUT", `/courses/${c1._id}`, { financeItemId: ITEM_C1.id, lmsCourseSlugs: [MBT] }, admin);
check("a single course is mapped the same way", r.status === 200 && r.body?.data?.lmsCourseSlug === MBT, show(r));
r = await call("GET", `/courses/${c2._id}`, undefined, admin);
check("...and it is kept", r.body?.data?.lmsCourseSlugs?.length === 2 && r.body.data?.financeItemId === ITEM_C2.id, show(r));
r = await call("PUT", `/courses/${c2._id}`, { name: "COURSE 2 - MBT + DWT (WITH CREDIT)", amount: 5600 }, admin);
check("editing the course's name or fee leaves its mapping alone", r.status === 200 && r.body?.data?.amount === 5600
  && r.body.data?.lmsCourseSlugs?.length === 2 && r.body.data?.financeItemId === ITEM_C2.id, show(r));
let payload = await payloadFor([c2._id, c1._id, c3._id], 9687);
const [l2, l1, l3] = payload?.courses ?? [];
check("the enrolment carries each course's product", l2?.itemId === ITEM_C2.id && l1?.itemId === ITEM_C1.id && !l3?.itemId, JSON.stringify(payload?.courses));
check("...and every LMS course each one opens — two for the bundle", JSON.stringify(l2?.lmsCourseSlugs) === JSON.stringify([MBT, DWT])
  && l2?.lmsCourseSlug === MBT && JSON.stringify(l1?.lmsCourseSlugs) === JSON.stringify([MBT]), JSON.stringify(payload?.courses));
check("...and nothing for a course nobody has mapped", !l3?.lmsCourseSlug && !l3?.lmsCourseSlugs, JSON.stringify(l3));
check("...still billed for the whole fee", (payload?.courses ?? []).reduce((sum, c) => sum + c.amountMinor, 0) === 968_700);

// ── Case 2 ──────────────────────────────────────────────────────────────────
step("Case 2 — edge: repeats, order, unmapping, the old single slug, an empty LMS");
r = await call("PUT", `/courses/${c2._id}`, { lmsCourseSlugs: [DWT, DWT, MBT] }, admin);
check("a course named twice is kept once, in the order given", JSON.stringify(r.body?.data?.lmsCourseSlugs) === JSON.stringify([DWT, MBT])
  && r.body.data?.lmsCourseSlug === DWT, show(r));
check("...and saying nothing about finance leaves its product alone", r.body?.data?.financeItemId === ITEM_C2.id, show(r));
r = await call("PUT", `/courses/${c1._id}`, { financeItemId: "", lmsCourseSlugs: [] }, admin);
check("unmapping clears both", r.status === 200 && r.body?.data?.financeItemId === null && r.body.data?.lmsCourseSlug === ""
  && r.body.data?.lmsCourseSlugs?.length === 0, show(r));
payload = await payloadFor([legacy._id], 4000);
check("a course mapped before the list still sends its course", JSON.stringify(payload?.courses?.[0]?.lmsCourseSlugs) === JSON.stringify([DWT])
  && payload?.courses?.[0]?.lmsCourseSlug === DWT, JSON.stringify(payload?.courses));
lmsMode = "empty";
r = await call("GET", "/courses/lms-courses", undefined, admin);
check("an LMS with nothing published lists nothing, not an error", r.status === 200 && r.body?.data?.length === 0, show(r));
lmsMode = "up";

// ── Case 3 ──────────────────────────────────────────────────────────────────
step("Case 3 — errors: bad input, an unknown course, finance or the LMS down");
r = await call("PUT", `/courses/${c1._id}`, { financeItemId: "not-an-id" }, admin);
check("a finance id that is not one is refused", r.status === 400, show(r));
r = await call("PUT", `/courses/${c1._id}`, { lmsCourseSlugs: ["Not A Slug"] }, admin);
check("an LMS slug that is not one is refused", r.status === 400, show(r));
r = await call("PUT", `/courses/${c1._id}`, { lmsCourseSlugs: Array.from({ length: 11 }, (_, i) => `course-${i}`) }, admin);
check("more than ten LMS courses is refused", r.status === 400, show(r));
r = await call("PUT", `/courses/${new mongoose.Types.ObjectId()}`, { lmsCourseSlugs: [MBT] }, admin);
check("an unknown course is not found", r.status === 404, show(r));
const c1Now = await Course.findById(c1._id).lean();
check("...and none of that changed anything", c1Now?.lmsCourseSlug === "" && (c1Now?.lmsCourseSlugs ?? []).length === 0 && !c1Now?.financeItemId);
financeMode = "down";
r = await call("GET", "/courses/finance-items", undefined, admin);
check("finance down: an error the screen can show, not an empty catalogue", r.status >= 500 && r.body?.success === false, show(r));
financeMode = "up";
lmsMode = "down";
r = await call("GET", "/courses/lms-courses", undefined, admin);
check("the LMS down: the same", r.status >= 500 && r.body?.success === false, show(r));
lmsMode = "up";

// ── Case 4 ──────────────────────────────────────────────────────────────────
step("Case 4 — permission: no token, a role that cannot edit courses, a switched-off account");
for (const [label, method, path, body] of [
  ["finance's products", "GET", "/courses/finance-items", undefined],
  ["the LMS's courses", "GET", "/courses/lms-courses", undefined],
  ["saving a mapping", "PUT", `/courses/${c1._id}`, { lmsCourseSlugs: [MBT] }],
] as const) {
  const anon = await call(method, path, body);
  const denied = await call(method, path, body, viewer);
  check(`${label}: no token is 401, a viewer is 403`, anon.status === 401 && denied.status === 403, `${show(anon)} | ${show(denied)}`);
}
check("...and the viewer's attempt changed nothing", ((await Course.findById(c1._id).lean())?.lmsCourseSlugs ?? []).length === 0);
await User.updateOne({ email: "viewer@draw-e2e.test" }, { $set: { status: "inactive" } });
const off = await call("POST", "/auth/login", { email: "viewer@draw-e2e.test", password: PASSWORD });
check("a switched-off account cannot sign in to try", off.status >= 400 && !off.body?.data?.accessToken, show(off));

finance.close();
lms.close();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
