/**
 * Checks correcting an enrolment finance sent back (the user, 2026-10-05: "if
 * send it back we can edit the course and amount also, all details"), on a
 * scratch database, through the API, against a stand-in finance — Draw's copy of the Sales CRM's check:
 *
 *   - Case 1: nothing to correct until finance sends it back;
 *   - Case 2: the closer corrects everything — client, course, fee, date,
 *     payments with their receipts, language, bonus, notes — and it goes to
 *     finance again in the same step, as the same enrolment; the lead's
 *     payments follow, its own left alone;
 *   - Case 3: what can't be right is refused, with nothing changed and nothing sent;
 *   - Case 4: who may correct — Students → edit, as "Send again" here always has —
 *     and moving a sale to another counsellor or team;
 *   - Case 5: sent back a moment ago — finance says so before the outbox has heard;
 *   - Case 6: an enrolment from before payments were listed, "Send again" as it
 *     was, and the receipt upload a correction uses;
 *   - Case 7: what the form starts from, and "sent again" shown once it was
 *     (the user, 2026-10-05: "if send again show that also"); the "Sent back" tab;
 *   - Case 8: the academy (the user, 2026-10-10) — a Bangalore close goes to
 *     the Bangalore finance organization, and so does every later call for it
 *     (status, send-back check, correction, resend); statuses are asked per
 *     organization; a correction shows the academy and can't change it.
 *   - Case 9: one email, one client (the user, 2026-10-10) — a correction to an
 *     email another student or lead holds, another person (another number; no
 *     phone → another name), refused 409 naming them, nothing changed or sent;
 *     the same person, and its own lead, taken; the check the dialog asks;
 *     "Send again" of a sent-back one with another client's email refused.
 *
 * Draw's enrolments hold courses as a list (bundles), and the close keeps the
 * client's email on the lead when it had none.
 *
 * Run by enrolment-correction-check.sh. Scratch database only.
 */
import http from "node:http";
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(ok: () => Promise<boolean> | boolean, ms = 4000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ok()) return true;
    await sleep(50);
  }
  return false;
}

// ── A stand-in finance: takes enrolments, and says what became of them ──────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const delivered: any[] = [];
const approvalOf = new Map<string, string>();
/*
 * Which finance organization each enrolment was delivered to (x-delta-org) —
 * and each status question, with the organization it was asked of. Like the
 * real finance, an organization knows only its own invoices: asked of the
 * wrong one, an enrolment has no answer.
 */
const orgOfDelivery = new Map<string, string>();
const statusAsks: { org: string; ids: string[] }[] = [];
const finance = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = raw ? JSON.parse(raw) : {};
    const org = String(req.headers["x-delta-org"] ?? "");
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/v1/integrations/enrolments") {
      delivered.push({ ...body, _org: org });
      orgOfDelivery.set(String(body.externalId), org);
      res.end(JSON.stringify({ data: { invoiceId: `inv-${body.externalId}`, invoiceNumber: `INV-${String(body.externalId).slice(-4)}`, customerId: "cust", duplicate: false, flags: [] } }));
      return;
    }
    if (req.url === "/api/v1/integrations/enrolments/status") {
      statusAsks.push({ org, ids: (body.externalIds ?? []) as string[] });
      const ids = ((body.externalIds ?? []) as string[]).filter((id) => approvalOf.has(id) && (orgOfDelivery.get(id) ?? "org-correction-check") === org);
      res.end(JSON.stringify({
        data: ids.map((id) => ({
          externalId: id, invoiceId: `inv-${id}`, invoiceNumber: `INV-${id.slice(-4)}`, status: "sent",
          approval: approvalOf.get(id), returnedReason: approvalOf.get(id) === "returned" ? "Wrong course" : "",
          issueDate: "2026-10-05", currency: "AED", totalMinor: 0, amountPaidMinor: 0, balanceMinor: 0,
        })),
      }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
});
await new Promise<void>((r) => finance.listen(0, "127.0.0.1", () => r()));
const financePort = (finance.address() as { port: number }).port;
const sendsFor = (id: string) => delivered.filter((d) => d.externalId === id);

// The routes load the push service, which wants VAPID keys the moment it loads.
const vapid = (await import("web-push")).default.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  JWT_SECRET: "enrolment-correction-check-jwt",
  JWT_REFRESH_SECRET: "enrolment-correction-check-refresh",
  NODE_ENV: "test",
  RUN_SCHEDULERS: "false",
  FINANCE_API_URL: `http://127.0.0.1:${financePort}`,
  FINANCE_CLIENT_ID: "crm-correction-check",
  FINANCE_INTEGRATION_SECRET: "correction-check-secret-correction-check-secret",
  FINANCE_ORG_ID: "org-correction-check",
  FINANCE_ORG_ID_BANGALORE: "org-bangalore-check",
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;

const { Course } = await import("../src/models/Course.js");
const { Student } = await import("../src/models/Student.js");
const { Lead } = await import("../src/models/Lead.js");
const { FinanceHandover } = await import("../src/models/FinanceHandover.js");
const { signAccessToken } = await import("../src/utils/jwt.js");

// ── People, teams, courses ──────────────────────────────────────────────────
const superRole = new Types.ObjectId(), bdeRole = new Types.ObjectId(), managerRole = new Types.ObjectId(), viewerRole = new Types.ObjectId();
const all = { view: true, create: true, edit: true, delete: false, approve: false, export: false };
await db.collection("roles").insertMany([
  { _id: superRole, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  // Closes leads; may not edit students — so here, neither corrects nor sends again.
  { _id: bdeRole, roleName: "BDE", isSystemRole: false, permissions: { students: { ...all, edit: false }, leads: all } },
  // Edits any student, adds none.
  { _id: managerRole, roleName: "Manager", isSystemRole: false, permissions: { students: { ...all, create: false } } },
  { _id: viewerRole, roleName: "Viewer", isSystemRole: false, permissions: { students: { ...all, create: false, edit: false } } },
]);
const people: Record<string, { id: Types.ObjectId; role: Types.ObjectId }> = {};
for (const [name, role] of [["Abrar", superRole], ["Theertha", bdeRole], ["Nikhil", bdeRole], ["Maya", managerRole], ["Vera", viewerRole]] as const) {
  const id = new Types.ObjectId();
  await db.collection("users").insertOne({ _id: id, name, email: `${name.toLowerCase()}@test.local`, password: "x", role, status: "active" });
  people[name] = { id, role };
}
const teamA = new Types.ObjectId(), teamB = new Types.ObjectId();
await db.collection("teams").insertMany([
  { _id: teamA, name: "Team A", status: "active", leaders: [], members: [people.Theertha!.id, people.Nikhil!.id] },
  { _id: teamB, name: "Team B", status: "active", leaders: [], members: [] },
]);
const course500 = await Course.create({ name: "COURSE 500", amount: 500 });
const course1000 = await Course.create({ name: "COURSE 1000", amount: 1000 });
// Sold in Bangalore: 45,000 INR, its own product there, the Dubai LMS course.
const courseBlr = await Course.create({ name: "COURSE BLR", amount: 2000, lmsCourseSlugs: ["market-break-out-trading-program"], bangalore: { price: 45000, financeItemId: "64b0000000000000000000b1", lmsCourseSlugs: [] } });

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
const token = (name: string) => signAccessToken({ userId: String(people[name]!.id), email: `${name.toLowerCase()}@test.local`, roleId: String(people[name]!.role) });
type Answer = { status: number; body: { data?: Record<string, unknown>; message?: string } };
async function call(method: string, path: string, who?: string, body?: unknown): Promise<Answer> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
    method,
    headers: { "content-type": "application/json", ...(who ? { authorization: `Bearer ${token(who)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Answer["body"] };
}

const receipt = (name: string) => ({ name: `${name}.jpg`, url: `https://files.test.local/receipts/${name}.jpg`, key: `receipts/${name}.jpg`, size: 1000, mimeType: "image/jpeg" });
const pay = (method: string, amount: number, name = `${method}-${amount}`, extra: Record<string, unknown> = {}) =>
  ({ method, amount, receipt: receipt(name), paidAt: "2026-10-05T00:00:00.000Z", ...extra });

let n = 0;
/**
 * A lead closed by Theertha the way the dialog does it: 200 already on the
 * lead of its own, 300 in cash at the close — recorded on the lead by the
 * dialog — and delivered to finance.
 */
async function closedSale() {
  n++;
  const leadId = new Types.ObjectId();
  await db.collection("leads").insertOne({
    _id: leadId, name: `Client ${n}`, phone: `+97150000${String(n).padStart(4, "0")}`, status: "closed",
    assignedTo: people.Theertha!.id,
    payments: [
      { _id: new Types.ObjectId(), amount: 200, note: "Booking", paidAt: new Date("2026-10-01"), addedBy: people.Theertha!.id },
      { _id: new Types.ObjectId(), amount: 300, note: "Collected at enrolment — COURSE 500 · Cash", paidAt: new Date("2026-10-05"), addedBy: people.Theertha!.id },
    ],
  });
  const r = await call("POST", "/students", "Theertha", {
    leadId: String(leadId), name: `Client ${n}`, phone: `+97150000${String(n).padStart(4, "0")}`, email: `client${n}@test.local`,
    courses: [String(course500._id)], team: String(teamA), assignedTo: String(people.Theertha!.id),
    enrollmentDate: "2026-10-05T00:00:00.000Z", totalFee: 500, paidAmount: 500, language: "English", hasBonus: false,
    payments: [pay("bank_transfer", 200, `own-${n}`, { collectedBefore: true }), pay("cash", 300, `cash-${n}`)],
  });
  const id = String(r.body.data?._id ?? "");
  const out = await waitFor(async () => (await FinanceHandover.findOne({ studentId: id }).lean())?.status === "sent");
  if (r.status !== 201 || !out) throw new Error(`could not set up a sale: ${r.status} ${r.body.message}`);
  approvalOf.set(id, "pending");
  return { id, leadId: String(leadId) };
}
/** Finance sends it back — and the outbox has heard, as its poll would. */
async function sendBack(id: string) {
  approvalOf.set(id, "returned");
  await FinanceHandover.updateOne({ studentId: id }, { $set: { approvalState: "returned", returnedReason: "Wrong course", returnedAt: new Date() } });
}
/** Everything, corrected. */
const correction = (over: Record<string, unknown> = {}) => ({
  name: "Abdul Hakeem", phone: "+971501112233", email: "Hakeem@Example.com",
  courses: [String(course1000._id)], enrollmentDate: "2026-10-04T00:00:00.000Z",
  totalFee: 1000, paidAmount: 800, language: "Malayalam", hasBonus: true, bonusAmount: 150, notes: "Corrected after finance sent it back",
  payments: [pay("cash", 200, "own-cash", { collectedBefore: true }), pay("card", 500, "card-new"), pay("tabby", 100, "tabby-new")],
  ...over,
});
// Leaving out what the outbox writes on the student once finance answers an
// earlier send, which can land in the middle of a refused request.
const snapshot = async (id: string) =>
  JSON.stringify(await Student.findById(id).select("-__v -updatedAt -financeInvoiceId -financeInvoiceNumber -financeSyncedAt").lean());

section("Case 1 — nothing to correct until finance sends it back");
const sale = await closedSale();
let r = await call("PUT", `/students/${sale.id}/correction`, "Maya", correction());
check("waiting for approval: 409, and nothing changed", r.status === 409 && /hasn't sent this enrolment back/.test(r.body.message ?? "") && (await Student.findById(sale.id).lean())?.name === `Client ${n}`, `${r.status} ${r.body.message}`);
let form = await call("GET", `/students/${sale.id}/correction`, "Maya");
check("the form's starting point says it isn't sent back yet", form.status === 200 && form.body.data?.sentBack === false, `${form.status} ${JSON.stringify(form.body.data?.sentBack)}`);
approvalOf.set(sale.id, "approved");
await FinanceHandover.updateOne({ studentId: sale.id }, { $set: { approvalState: "approved" } });
r = await call("PUT", `/students/${sale.id}/correction`, "Maya", correction());
check("approved: 409 — a change then goes through finance", r.status === 409, `${r.status} ${r.body.message}`);
approvalOf.set(sale.id, "pending");
await FinanceHandover.updateOne({ studentId: sale.id }, { $set: { approvalState: "pending" } });

section("Case 2 — someone with Students → edit corrects everything, and it goes to finance again in the same step");
await sendBack(sale.id);
form = await call("GET", `/students/${sale.id}/correction`, "Maya");
check("the form starts from: sent back, why, the invoice, the lead's own 200, and whom it may move to",
  form.status === 200 && form.body.data?.sentBack === true && form.body.data?.returnedReason === "Wrong course" && form.body.data?.invoiceNumber === `INV-${sale.id.slice(-4)}`
    && form.body.data?.ownOnLead === 200 && form.body.data?.mayMove === true
    && (form.body.data?.counsellors as { name: string }[])?.some((u) => u.name === "Nikhil") && (form.body.data?.teams as { name: string }[])?.length === 2
    && (form.body.data?.student as { enrollmentNumber?: string })?.enrollmentNumber !== undefined,
  JSON.stringify({ ...form.body.data, student: undefined, counsellors: undefined }));
form = await call("GET", `/students/${sale.id}/correction`, "Theertha");
check("…and none of it for a role without Students → edit, the closer included: 403", form.status === 403, `${form.status}`);
let leadNow = await Lead.findById(sale.leadId).lean();
check("(the close kept the email on the lead, which had none)", leadNow?.email === `client${n}@test.local`, leadNow?.email);
const sendsBefore = sendsFor(sale.id).length;
r = await call("PUT", `/students/${sale.id}/correction`, "Maya", correction());
check("corrected: 200, \"sent to finance\"", r.status === 200 && /Corrected and sent to finance/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
let s = await Student.findById(sale.id).lean();
check("the client: name, phone, email (kept lower case)", s?.name === "Abdul Hakeem" && s?.phone === "+971501112233" && s?.email === "hakeem@example.com", `${s?.name} ${s?.phone} ${s?.email}`);
check("the course, and the date", s?.courses?.map(String).join(",") === String(course1000._id) && s?.enrollmentDate?.toISOString().slice(0, 10) === "2026-10-04");
check("the money: fee 1000, paid 800, 200 to collect, part paid", s?.totalFee === 1000 && s?.paidAmount === 800 && s?.pendingAmount === 200 && s?.feeStatus === "partial", `${s?.totalFee}/${s?.paidAmount}/${s?.pendingAmount}/${s?.feeStatus}`);
check("each payment, with its receipt; the first is the one method and receipt",
  s?.payments?.map((p) => `${p.method}:${p.amount}:${p.receipt?.key}${p.collectedBefore ? ":own" : ""}`).join(",") === "cash:200:receipts/own-cash.jpg:own,card:500:receipts/card-new.jpg,tabby:100:receipts/tabby-new.jpg"
    && s?.paymentMethod === "cash" && s?.paymentReceipt?.key === "receipts/own-cash.jpg", JSON.stringify(s?.payments));
check("language, bonus and notes", s?.language === "Malayalam" && s?.hasBonus === true && s?.bonusAmount === 150 && s?.notes === "Corrected after finance sent it back");
check("…and the closer and team stay as they were", String(s?.assignedTo) === String(people.Theertha!.id) && String(s?.team) === String(teamA));
leadNow = await Lead.findById(sale.leadId).lean();
check("…the lead's email, already there, is not replaced by the correction's", leadNow?.email === `client${n}@test.local`, leadNow?.email);
let lead = await Lead.findById(sale.leadId).lean();
check("the lead: its own 200 left alone, the close's 300 cash replaced by 500 card and 100 Tabby",
  lead?.payments?.map((p) => `${p.note}:${p.amount}`).join(" | ") === "Booking:200 | Collected at enrolment — COURSE 1000 · Card:500 | Collected at enrolment — COURSE 1000 · Tabby:100",
  lead?.payments?.map((p) => `${p.note}:${p.amount}`).join(" | "));
check("…so the lead holds what the enrolment says was paid", (lead?.payments ?? []).reduce((t, p) => t + p.amount, 0) === 800);
const delivered2 = await waitFor(() => sendsFor(sale.id).length === sendsBefore + 1);
const sent = sendsFor(sale.id).at(-1);
check("finance is sent it again at once, as the same enrolment", delivered2 && sent?.externalId === sale.id && sent?.source === "draw-crm" && sent?.crm === "draw", `${sendsFor(sale.id).length} sends`);
check("…with the client as corrected", sent?.customer?.name === "Abdul Hakeem" && sent?.customer?.email === "hakeem@example.com" && sent?.customer?.phone === "+971501112233", JSON.stringify(sent?.customer));
check("…the course, its fee in fils, the date", sent?.courses?.length === 1 && sent?.courses?.[0]?.name === "COURSE 1000" && sent?.courses?.[0]?.amountMinor === 100000 && sent?.enrolledOn === "2026-10-04", JSON.stringify(sent?.courses));
check("…what was paid, what is left, each payment with its receipt",
  sent?.declaredPaidMinor === 80000 && sent?.balanceMinor === 20000
    && sent?.payments?.map((p: { method: string; amountMinor: number; receipt?: { key: string } }) => `${p.method}:${p.amountMinor}:${p.receipt?.key}`).join(",") === "cash:20000:receipts/own-cash.jpg,card:50000:receipts/card-new.jpg,tabby:10000:receipts/tabby-new.jpg",
  JSON.stringify(sent?.payments));
check("…the language and the bonus", sent?.language === "Malayalam" && sent?.bonus?.given === true && sent?.bonus?.amountMinor === 15000);
let h = await FinanceHandover.findOne({ studentId: sale.id }).lean();
check("the outbox: delivered, waiting for approval again, the send-back reason cleared", h?.status === "sent" && h?.approvalState === "pending" && !h?.returnedReason && !h?.returnedAt, `${h?.status} ${h?.approvalState} ${h?.returnedReason}`);
check("…and it says it was sent again, once, just now", h?.resends === 1 && Date.now() - new Date(h?.resentAt ?? 0).getTime() < 60_000, `${h?.resends} ${h?.resentAt}`);

section("Case 3 — what can't be right is refused, with nothing changed and nothing sent");
approvalOf.set(sale.id, "pending");
r = await call("PUT", `/students/${sale.id}/correction`, "Maya", correction());
check("once resent, it can't be corrected again until finance sends it back again: 409", r.status === 409, `${r.status} ${r.body.message}`);
await sendBack(sale.id);
const refused = async (label: string, body: Record<string, unknown>, status: number, pattern: RegExp, who = "Maya") => {
  const before = await snapshot(sale.id);
  const sends = sendsFor(sale.id).length;
  const leadBefore = JSON.stringify((await Lead.findById(sale.leadId).lean())?.payments);
  const x = await call("PUT", `/students/${sale.id}/correction`, who, body);
  await sleep(100);
  const same = (await snapshot(sale.id)) === before && sendsFor(sale.id).length === sends
    && JSON.stringify((await Lead.findById(sale.leadId).lean())?.payments) === leadBefore;
  check(label, x.status === status && pattern.test(x.body.message ?? "") && same, `${x.status} ${x.body.message}${same ? "" : " — something changed"}`);
};
await refused("no email and no language: 422, both named", correction({ email: "", language: "" }), 422, /the client's email, language/);
await refused("an email finance can't take: 422", correction({ email: "hakeem@example" }), 422, /the client's email/);
await refused("no name, no phone: 422", correction({ name: " ", phone: "" }), 422, /the client's name, the client's phone/);
await refused("no course: 422", correction({ courses: [] }), 422, /a course/);
await refused("a course that no longer exists: 422", correction({ courses: [String(course1000._id), String(new Types.ObjectId())] }), 422, /no longer exists/);
await refused("no fee: 422", correction({ totalFee: "" }), 422, /the fee/);
await refused("payments that don't add up to what was paid: 422", correction({ paidAmount: 900 }), 422, /must match/);
await refused("a payment without its receipt: 422", correction({ payments: [pay("cash", 200, "own", { collectedBefore: true }), { method: "card", amount: 600, paidAt: "2026-10-05" }] }), 422, /Payment 2 needs its receipt/);
await refused("no payments at all: 422", correction({ payments: undefined }), 422, /needs its payments/);
await refused("the lead's own 200 left out: 422", correction({ paidAmount: 600, payments: [pay("card", 500), pay("tabby", 100)] }), 422, /holds 200 of its own/);
await refused("the lead's own money at another figure: 409, open it again", correction({ paidAmount: 750, payments: [pay("cash", 150, "own", { collectedBefore: true }), pay("card", 500), pay("tabby", 100)] }), 409, /changed while this was open/);
await refused("two payments both the lead's own: 422", correction({ paidAmount: 900, payments: [pay("cash", 200, "a", { collectedBefore: true }), pay("cash", 200, "b", { collectedBefore: true }), pay("card", 500)] }), 422, /Only one payment/);
await refused("a bonus without its amount: 422", correction({ bonusAmount: 0 }), 422, /the bonus amount/);
await refused("not said whether a bonus was given: 422", correction({ hasBonus: undefined }), 422, /whether a bonus was given/);

section("Case 4 — who may correct (Students → edit), and moving a sale");
await refused("the closer, without Students → edit: 403", correction(), 403, /Access denied/, "Theertha");
await refused("another BDE: 403", correction(), 403, /Access denied/, "Nikhil");
await refused("a role that only views students: 403", correction(), 403, /Access denied/, "Vera");
r = await call("PUT", `/students/${sale.id}/correction`, undefined, correction());
check("not signed in: 401", r.status === 401, `${r.status}`);
let sends = sendsFor(sale.id).length;
r = await call("PUT", `/students/${sale.id}/correction`, "Maya", correction({ assignedTo: String(people.Nikhil!.id), team: String(teamB) }));
s = await Student.findById(sale.id).lean();
check("a manager who may edit students corrects it and moves it to Nikhil in Team B: 200", r.status === 200 && String(s?.assignedTo) === String(people.Nikhil!.id) && String(s?.team) === String(teamB), `${r.status} ${r.body.message}`);
await waitFor(() => sendsFor(sale.id).length === sends + 1);
check("…and finance is told who closed it now", sendsFor(sale.id).at(-1)?.salespersonEmail === "nikhil@test.local", sendsFor(sale.id).at(-1)?.salespersonEmail);
await sendBack(sale.id);
sends = sendsFor(sale.id).length;
r = await call("PUT", `/students/${sale.id}/correction`, "Abrar", correction({ assignedTo: String(people.Theertha!.id), team: String(teamA) }));
check("a super admin may correct any, and move it back", r.status === 200 && String((await Student.findById(sale.id).lean())?.assignedTo) === String(people.Theertha!.id), `${r.status} ${r.body.message}`);
await waitFor(() => sendsFor(sale.id).length === sends + 1);

section("Case 5 — sent back a moment ago: finance says so before the outbox has heard");
const fresh = await closedSale();
approvalOf.set(fresh.id, "returned"); // the outbox still says "pending"
r = await call("PUT", `/students/${fresh.id}/correction`, "Maya", correction({ name: "Fresh Client" }));
check("corrected all the same: 200", r.status === 200 && (await Student.findById(fresh.id).lean())?.name === "Fresh Client", `${r.status} ${r.body.message}`);

section("Case 6 — an enrolment from before payments were listed; \"Send again\"; the receipt upload");
const oldLead = new Types.ObjectId();
await db.collection("leads").insertOne({ _id: oldLead, name: "Old Client", phone: "+971509999999", status: "closed", assignedTo: people.Theertha!.id, payments: [] });
const old = await Student.create({
  enrollmentNumber: "STU-9000", name: "Old Client", phone: "+971509999999", leadId: oldLead, courses: [course500._id], team: teamA,
  assignedTo: people.Theertha!.id, totalFee: 500, paidAmount: 500, pendingAmount: 0, feeStatus: "paid", enrollmentDate: new Date("2026-09-20"),
  paymentMethod: "cash", paymentReceipt: receipt("old-cash"),
});
await FinanceHandover.create({ studentId: old._id, leadId: oldLead, payload: {}, status: "sent", invoiceNumber: "INV-OLD", approvalState: "returned", returnedReason: "No email" });
approvalOf.set(String(old._id), "returned");
r = await call("PUT", `/students/${String(old._id)}/correction`, "Maya", correction({
  name: "Old Client", phone: "+971509999999", email: "old.client@test.local", courses: [String(course500._id)], totalFee: 500, paidAmount: 500,
  language: "English", hasBonus: false, bonusAmount: 0, payments: [pay("cash", 500, "old-cash")],
}));
s = await Student.findById(old._id).lean();
lead = await Lead.findById(oldLead).lean();
check("an older enrolment — one method, one receipt, no list — is corrected into a list: 200",
  r.status === 200 && s?.email === "old.client@test.local" && s?.payments?.length === 1 && s?.hasBonus === false, `${r.status} ${r.body.message}`);
check("…and its lead, which held nothing, now holds what was collected at the close",
  lead?.payments?.map((p) => `${p.note}:${p.amount}`).join(" | ") === "Collected at enrolment — COURSE 500 · Cash:500", lead?.payments?.map((p) => `${p.note}:${p.amount}`).join(" | "));
check("…and the email it was corrected with, which the lead never had", lead?.email === "old.client@test.local", lead?.email);
await waitFor(async () => (await FinanceHandover.findOne({ studentId: old._id }).lean())?.status === "sent");
await sendBack(String(old._id));
r = await call("POST", `/students/${String(old._id)}/invoice`, "Maya");
check("\"Send again\" still resends a sent-back enrolment as it stands", r.status === 200 && /Correction sent/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
await waitFor(async () => (await FinanceHandover.findOne({ studentId: old._id }).lean())?.status === "sent");
approvalOf.set(String(old._id), "pending");
r = await call("POST", `/students/${String(old._id)}/invoice`, "Maya");
check("…and refuses one waiting for approval: 409", r.status === 409 && /Already invoiced/.test(r.body.message ?? ""), `${r.status} ${r.body.message}`);
check("…counting each time it went again: corrected once, sent again once", (await FinanceHandover.findOne({ studentId: old._id }).lean())?.resends === 2);

const upload = async (who: string) => {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }), "receipt.jpg");
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/students/receipts/${sale.leadId}`, { method: "POST", headers: { authorization: `Bearer ${token(who)}` }, body: form });
  return res.status;
};
const managerUpload = await upload("Maya");
check("a receipt for a correction can be taken by someone who edits students but adds none (not 403)", managerUpload !== 403, `${managerUpload}`);
check("…but not by a role with neither: 403", (await upload("Vera")) === 403);

section("Case 7 — \"sent again\" shown once it was");
approvalOf.set(sale.id, "pending");
const mine = await call("GET", "/students/enrolments/mine", "Theertha");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const row = ((mine.body as any).data as any[])?.find((x) => String(x._id) === sale.id);
check("My Enrolments carries when it was sent again, and how many times (corrected three times)", Boolean(row?.handover?.resentAt) && row?.handover?.resends === 3, JSON.stringify(row?.handover));
check("…and its finance step says \"Sent again …, waiting for accounts\"", row?.steps?.[0]?.state === "waiting" && /^Sent again \d{1,2} \w{3}, .* — waiting for accounts to approve it$/.test(row?.steps?.[0]?.detail ?? ""), row?.steps?.[0]?.detail);
const one = await call("GET", `/students/enrolments/${sale.id}`, "Abrar");
await sendBack(fresh.id);
const tab = await call("GET", "/students/enrolments/mine?state=returned", "Theertha");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tabIds = (((tab.body as any).data ?? []) as any[]).map((x) => String(x._id));
check("the \"Sent back\" tab lists only what finance sent back", tab.status === 200 && tabIds.length === 1 && tabIds[0] === fresh.id, JSON.stringify(tabIds));
check("…its own page too", (one.body.data as any)?.handover?.resends === 3 && /^Sent again/.test((one.body.data as any)?.steps?.[0]?.detail ?? ""), JSON.stringify((one.body.data as any)?.steps?.[0]));
const { stepsOf } = await import("../src/services/enrolmentSteps.js");
const returned = { externalId: "x", invoiceId: "i", invoiceNumber: "INV-1", status: "sent", approval: "returned", returnedReason: "Wrong course", issueDate: "", currency: "AED", totalMinor: 0, amountPaidMinor: 0, balanceMinor: 0 };
let st = stepsOf(returned, { status: "pending", resentAt: new Date() })[0]!;
check("on its way back — finance still says \"returned\" — it shows as sent again, not sent back", st.state === "waiting" && /^Sent again .* — on its way to finance$/.test(st.detail ?? ""), st.detail);
st = stepsOf(returned, { status: "failed", resentAt: new Date(), lastError: "Invalid email" })[0]!;
check("sent again but refused by finance: says so, with why", st.state === "failed" && /^Sent again .*, but finance didn't take it — Invalid email$/.test(st.detail ?? ""), st.detail);
st = stepsOf(returned, { status: "sent" })[0]!;
check("sent back, never sent again: as before", st.state === "failed" && st.detail === "Sent back: Wrong course — correct it and send it again", st.detail);

section("Case 8 — the academy: a Bangalore close, and every call after it, in the Bangalore organization");
const { env } = await import("../src/config/env.js");
const { pollFinanceOutcomes, drainFinanceHandovers } = await import("../src/services/financeHandoverWorker.js");
n++;
const blrLead = new Types.ObjectId();
await db.collection("leads").insertOne({
  _id: blrLead, name: `Client ${n}`, phone: "+919800000001", status: "closed", assignedTo: people.Theertha!.id,
  payments: [{ _id: new Types.ObjectId(), amount: 200, note: "Booking", paidAt: new Date("2026-10-01"), addedBy: people.Theertha!.id }],
});
const blrClose = (over: Record<string, unknown> = {}) => call("POST", "/students", "Theertha", {
  leadId: String(blrLead), name: `Client ${n}`, phone: "+919800000001", email: `blr${n}@test.local`,
  courses: [String(courseBlr._id)], team: String(teamA), assignedTo: String(people.Theertha!.id), academy: "bangalore",
  enrollmentDate: "2026-10-05T00:00:00.000Z", totalFee: 45000, paidAmount: 45000, language: "English", hasBonus: false,
  payments: [pay("bank_transfer", 4500, "blr-own", { collectedBefore: true, currency: "AED", amountInCurrency: 200, exchangeRate: 22.5 }), pay("cash", 40500, "blr-cash")],
  ...over,
});
// Not switched on: the Bangalore organization unset refuses the close, and saves nothing.
env.FINANCE_ORG_ID_BANGALORE = "";
const studentsBefore = await Student.countDocuments();
r = await blrClose();
check("Bangalore organization not set: the close is refused (422), nothing saved", r.status === 422 && /Bangalore finance organization isn't set/.test(r.body.message ?? "") && (await Student.countDocuments()) === studentsBefore, `${r.status} ${r.body.message}`);
env.FINANCE_ORG_ID_BANGALORE = "org-bangalore-check";
r = await blrClose();
const blrId = String(r.body.data?._id ?? "");
await waitFor(async () => (await FinanceHandover.findOne({ studentId: blrId }).lean())?.status === "sent");
const blrSent = sendsFor(blrId).at(-1);
let blrH = await FinanceHandover.findOne({ studentId: blrId }).lean();
check("closed for Bangalore: delivered to the Bangalore organization", r.status === 201 && blrSent?._org === "org-bangalore-check" && blrH?.status === "sent", `${r.status} ${r.body.message} → ${blrSent?._org}`);
check("…the outbox row and the student both say Bangalore", blrH?.academy === "bangalore" && (await Student.findById(blrId).lean())?.academy === "bangalore", `${blrH?.academy}`);
check("…the payload says academy \"bangalore\", in paise, at the Bangalore item, AED cash as original", blrSent?.academy === "bangalore" && blrSent?.courses?.[0]?.amountMinor === 4500000
  && blrSent?.courses?.[0]?.itemId === "64b0000000000000000000b1" && blrSent?.payments?.[0]?.original?.currency === "AED" && blrSent?.payments?.[0]?.original?.rate === 22.5, JSON.stringify({ c: blrSent?.courses, p: blrSent?.payments?.[0] }));
check("…and a Dubai close still goes to the Dubai organization", sendsFor(sale.id).every((d) => d._org === "org-correction-check"), JSON.stringify(sendsFor(sale.id).map((d) => d._org)));

// The decision poll: one question per organization, each with only its own enrolments.
approvalOf.set(blrId, "pending");
approvalOf.set(sale.id, "pending");
await FinanceHandover.updateOne({ studentId: sale.id }, { $set: { approvalState: "pending" } });
statusAsks.length = 0;
await pollFinanceOutcomes();
const blrAsk = statusAsks.find((a) => a.ids.includes(blrId));
const dubaiAsk = statusAsks.find((a) => a.ids.includes(sale.id));
check("the poll asks the Bangalore organization about the Bangalore close", blrAsk?.org === "org-bangalore-check" && !blrAsk.ids.includes(sale.id), JSON.stringify(statusAsks));
check("…and the Dubai organization about the Dubai ones, never the other way round", dubaiAsk?.org === "org-correction-check" && !dubaiAsk.ids.includes(blrId), JSON.stringify(statusAsks));
blrH = await FinanceHandover.findOne({ studentId: blrId }).lean();
check("…so the Bangalore close's answer is heard: waiting for approval", blrH?.approvalState === "pending", blrH?.approvalState);

// My Enrolments asks each organization about its own, and the page shows Bangalore's invoice.
statusAsks.length = 0;
const mineNow = await call("GET", "/students/enrolments/mine?mine=false", "Abrar");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const blrRow = ((mineNow.body as any).data as any[])?.find((x) => String(x._id) === blrId);
check("My Enrolments: statuses asked per organization, the Bangalore row answered", statusAsks.length === 2 && statusAsks.every((a) => a.org === "org-bangalore-check" ? a.ids.every((id) => id === blrId) : !a.ids.includes(blrId))
  && blrRow?.invoice?.approval === "pending" && blrRow?.academy === "bangalore", JSON.stringify(statusAsks));
statusAsks.length = 0;
const blrOne = await call("GET", `/students/enrolments/${blrId}`, "Abrar");
check("its own page asks the Bangalore organization", statusAsks.length === 1 && statusAsks[0]?.org === "org-bangalore-check" && (blrOne.body.data as any)?.invoice?.approval === "pending", JSON.stringify(statusAsks));

// Sent back a moment ago — the outbox hasn't heard: finance is asked, the Bangalore organization.
approvalOf.set(blrId, "returned");
statusAsks.length = 0;
const blrForm = await call("GET", `/students/${blrId}/correction`, "Maya");
check("the correction form: sent back (asked of the Bangalore organization), and the academy, fixed", blrForm.status === 200 && blrForm.body.data?.sentBack === true && blrForm.body.data?.academy === "bangalore"
  && statusAsks.every((a) => a.org === "org-bangalore-check"), `${blrForm.status} ${JSON.stringify({ sentBack: blrForm.body.data?.sentBack, academy: blrForm.body.data?.academy, asks: statusAsks })}`);
const blrCorrection = (over: Record<string, unknown> = {}) => ({
  name: "Bangalore Client", phone: "+919800000001", email: "blr.client@test.local", courses: [String(courseBlr._id)],
  enrollmentDate: "2026-10-05T00:00:00.000Z", totalFee: 45000, paidAmount: 30000, language: "Malayalam", hasBonus: false, academy: "bangalore",
  payments: [pay("bank_transfer", 4600, "blr-own2", { collectedBefore: true, currency: "AED", amountInCurrency: 200, exchangeRate: 23 }), pay("card", 25400, "blr-card")],
  ...over,
});
const blrSends = sendsFor(blrId).length;
let x = await call("PUT", `/students/${blrId}/correction`, "Maya", blrCorrection({ academy: "dubai" }));
check("a correction that moves it to Dubai: 422, nothing sent", x.status === 422 && /closed for Bangalore — a correction can't move it/.test(x.body.message ?? "") && sendsFor(blrId).length === blrSends, `${x.status} ${x.body.message}`);
x = await call("PUT", `/students/${blrId}/correction`, "Maya", blrCorrection({ courses: [String(course1000._id)], totalFee: 1000, paidAmount: 1000, payments: [pay("bank_transfer", 4600, "o", { collectedBefore: true, currency: "AED", amountInCurrency: 200, exchangeRate: 23 })] }));
check("…onto a course with no Bangalore price: 422", x.status === 422 && /COURSE 1000 has no Bangalore price/.test(x.body.message ?? ""), `${x.status} ${x.body.message}`);
x = await call("PUT", `/students/${blrId}/correction`, "Maya", blrCorrection({ payments: [pay("bank_transfer", 4600, "o", { collectedBefore: true, currency: "AED", amountInCurrency: 150, exchangeRate: 30.6667 }), pay("card", 25400)] }));
check("…the lead's own money at another AED figure: 409", x.status === 409 && /come to 200 now, not 150/.test(x.body.message ?? ""), `${x.status} ${x.body.message}`);
const blrLeadBefore = JSON.stringify((await Lead.findById(blrLead).lean())?.payments);
x = await call("PUT", `/students/${blrId}/correction`, "Maya", blrCorrection());
await waitFor(() => sendsFor(blrId).length === blrSends + 1);
const blrResent = sendsFor(blrId).at(-1);
s = await Student.findById(blrId).lean();
check("corrected (200) and sent again — to the Bangalore organization", x.status === 200 && blrResent?._org === "org-bangalore-check" && blrResent?.academy === "bangalore", `${x.status} ${x.body.message} → ${blrResent?._org}`);
check("…as corrected: INR, the new rate on the AED, still Bangalore", s?.academy === "bangalore" && s?.paidAmount === 30000 && s?.payments?.[0]?.exchangeRate === 23
  && blrResent?.payments?.[0]?.original?.rate === 23 && blrResent?.declaredPaidMinor === 3000000 && blrResent?.balanceMinor === 1500000, JSON.stringify(blrResent?.payments));
check("…and the lead's (AED) payments left as they were", JSON.stringify((await Lead.findById(blrLead).lean())?.payments) === blrLeadBefore);
// "Send again" checks the send-back with the Bangalore organization too.
approvalOf.set(blrId, "returned");
await FinanceHandover.updateOne({ studentId: blrId }, { $set: { approvalState: "pending" } });
statusAsks.length = 0;
x = await call("POST", `/students/${blrId}/invoice`, "Maya");
check("\"Send again\" asks the Bangalore organization whether it was sent back, and resends", x.status === 200 && statusAsks.some((a) => a.org === "org-bangalore-check" && a.ids.includes(blrId)), `${x.status} ${x.body.message} ${JSON.stringify(statusAsks)}`);
await waitFor(async () => (await FinanceHandover.findOne({ studentId: blrId }).lean())?.status === "sent");
check("…to the Bangalore organization", sendsFor(blrId).at(-1)?._org === "org-bangalore-check");
// A Bangalore row whose organization is unset waits, rather than going to Dubai or failing for good.
env.FINANCE_ORG_ID_BANGALORE = "";
await FinanceHandover.updateOne({ studentId: blrId }, { $set: { status: "pending", nextAttemptAt: new Date(0) } });
const sendsNow = delivered.length;
await drainFinanceHandovers();
blrH = await FinanceHandover.findOne({ studentId: blrId }).lean();
check("its organization unset: not sent anywhere, still pending, saying why", delivered.length === sendsNow && blrH?.status === "pending" && /FINANCE_ORG_ID_BANGALORE/.test(blrH?.lastError ?? ""), `${blrH?.status} ${blrH?.lastError}`);
env.FINANCE_ORG_ID_BANGALORE = "org-bangalore-check";
await FinanceHandover.updateOne({ studentId: blrId }, { $set: { nextAttemptAt: new Date(0) } });
await drainFinanceHandovers();
check("…and goes, to Bangalore, once it is set", (await FinanceHandover.findOne({ studentId: blrId }).lean())?.status === "sent" && delivered.at(-1)?._org === "org-bangalore-check");

// Collecting more than the fee is taken now (the owner, 2026-10-06) — last, so nothing above depends on it.
await sendBack(sale.id);
const overRes = await call("PUT", `/students/${sale.id}/correction`, "Maya", correction({ totalFee: 700 }));
const overSaved = await Student.findById(sale.id).lean();
check("collected more than the fee: taken (200), balance 0", overRes.status === 200 && overSaved?.totalFee === 700 && overSaved?.pendingAmount === 0, `${overRes.status} ${overRes.body.message}`);

section("Case 9 — one email, one client (2026-10-10): a correction can't take an email another client here holds");
{
  const other = await closedSale();
  await sendBack(other.id);
  const hakeem = await Student.findById(sale.id).lean(); // Abdul Hakeem, +971501112233, hakeem@example.com
  const lead = async (name: string, phone: string | null, email: string) => {
    const _id = new Types.ObjectId();
    await db.collection("leads").insertOne({ _id, name, ...(phone ? { phone } : {}), email, status: "followup", assignedTo: people.Theertha!.id, payments: [] });
    return String(_id);
  };
  await lead("mohammed lebbie", "+971524445566", "lebbie@test.local");
  await lead("Sara  Khan", null, "sara@test.local");
  const halif = { name: "Halif", phone: "+971559998877" };
  /** A correction of `other` that must be refused, changing nothing and sending nothing. */
  const refusedOther = async (label: string, body: Record<string, unknown>, message: string) => {
    const before = await snapshot(other.id);
    const sends = sendsFor(other.id).length;
    const x = await call("PUT", `/students/${other.id}/correction`, "Maya", body);
    await sleep(100);
    const same = (await snapshot(other.id)) === before && sendsFor(other.id).length === sends;
    check(label, x.status === 409 && x.body.message === message && same, `${x.status} ${x.body.message}${same ? "" : " — something changed"}`);
  };
  /** A correction of `other` that must go through — and be sent back again for the next. */
  const takenOther = async (label: string, body: Record<string, unknown>) => {
    const sends = sendsFor(other.id).length;
    const x = await call("PUT", `/students/${other.id}/correction`, "Maya", body);
    const out = await waitFor(() => sendsFor(other.id).length === sends + 1);
    check(label, x.status === 200 && out && (await Student.findById(other.id).lean())?.email === String(body.email).toLowerCase(), `${x.status} ${x.body.message}`);
    await waitFor(async () => (await FinanceHandover.findOne({ studentId: other.id }).lean())?.status === "sent");
    await sendBack(other.id);
  };

  await refusedOther("another student's email, another number: 409, naming them and their enrolment, nothing changed or sent",
    correction({ ...halif, email: "Hakeem@Example.com" }),
    `This email is already used by Abdul Hakeem (${hakeem?.enrollmentNumber}), a different client — enter Halif's own email.`);
  await refusedOther("another lead's email, another number: 409, naming the lead",
    correction({ ...halif, email: "lebbie@test.local" }),
    "This email is already used by mohammed lebbie (a lead), a different client — enter Halif's own email.");
  await refusedOther("held by a lead with no phone, another name: 409",
    correction({ ...halif, email: "sara@test.local" }),
    "This email is already used by Sara  Khan (a lead), a different client — enter Halif's own email.");
  await takenOther("…the same name, case and spaces aside: the same person — corrected (200) and sent",
    correction({ name: "SARA khan", phone: "+971559998877", email: "sara@test.local" }));
  await takenOther("the same number as the student holding it (written another way): the same person — 200",
    correction({ name: "Abdul Hakeem", phone: "00971 50 111 2233", email: "hakeem@example.com" }));
  const ownLead = await Lead.findById(other.leadId).lean();
  await takenOther("its own lead's email, whatever the lead's phone says: its own — 200",
    correction({ ...halif, email: String(ownLead?.email) }));

  // What the correction dialog asks before it saves: for the enrolment, as the form has the client now.
  const ask = (q: Record<string, string>, who = "Maya") => call("GET", `/students/email-check?${new URLSearchParams({ studentId: other.id, ...q }).toString()}`, who);
  let c = await ask({ email: "lebbie@test.local" });
  check("the check, for an enrolment: another lead's email — not ok, the lead named, the client by the enrolment's name",
    c.status === 200 && c.body.data?.ok === false && JSON.stringify(c.body.data?.takenBy) === JSON.stringify({ kind: "lead", name: "mohammed lebbie" })
      && c.body.data?.message === "This email is already used by mohammed lebbie (a lead), a different client — enter Halif's own email.", `${c.status} ${JSON.stringify(c.body.data)}`);
  c = await ask({ email: "lebbie@test.local", name: "M. Lebbie", phone: "+971 52 444 5566" });
  check("…with the name and phone the form now has — the holder's number: ok", c.body.data?.ok === true, JSON.stringify(c.body.data));
  c = await ask({ email: "hakeem@example.com" });
  check("…another student's email: not ok, with their enrolment number", c.body.data?.ok === false && (c.body.data?.takenBy as { code?: string })?.code === hakeem?.enrollmentNumber, JSON.stringify(c.body.data));
  c = await ask({ email: String(ownLead?.email) });
  check("…its own lead's email: ok", c.body.data?.ok === true, JSON.stringify(c.body.data));
  c = await ask({ email: "lebbie@test.local" }, "Theertha");
  check("…asked by a role that closes but can't correct: answered (the close dialog asks too)", c.status === 200, `${c.status}`);
  c = await ask({ email: "lebbie@test.local" }, "Vera");
  check("…by a role that does neither: 403", c.status === 403, `${c.status}`);

  // "Send again" of a sent-back enrolment is a correction too: as it stands, with another client's email (a close from before the rule), refused.
  await db.collection("students").updateOne({ _id: new Types.ObjectId(other.id) }, { $set: { email: "lebbie@test.local" } });
  const sendsNow = sendsFor(other.id).length;
  let again = await call("POST", `/students/${other.id}/invoice`, "Maya");
  await sleep(100);
  check("\"Send again\" with another client's email: 409, naming them, nothing sent",
    again.status === 409 && again.body.message === "This email is already used by mohammed lebbie (a lead), a different client — enter Halif's own email."
      && sendsFor(other.id).length === sendsNow, `${again.status} ${again.body.message}`);
  await db.collection("students").updateOne({ _id: new Types.ObjectId(other.id) }, { $set: { email: String(ownLead?.email) } });
  again = await call("POST", `/students/${other.id}/invoice`, "Maya");
  check("…with the client's own: sent again (200)", again.status === 200 && (await waitFor(() => sendsFor(other.id).length === sendsNow + 1)), `${again.status} ${again.body.message}`);
}

server.close();
finance.close();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
