/**
 * Checks payments taken more than one way at the close (the user, 2026-10-05:
 * "total 500, paid 300 cash and 200 card … two receipts"), on a scratch
 * database, through the API:
 *
 *   - Case 1: a close with two payments keeps each — method, amount, date,
 *     receipt — and hands every one to finance, adding up to what was paid;
 *   - Case 2: the money already on the lead as a payment of its own, part
 *     paid, pennies, an older screen that sends one method and one receipt,
 *     and ten payments;
 *   - Case 3: payments that don't add up, without a receipt, an unknown method,
 *     nothing, too many — and anything collected above the fee — refused, on a
 *     close and on an edit, with nothing saved;
 *   - Case 4: who may close;
 *   - Case 5: the academy (the user, 2026-10-10) — a Bangalore close in INR:
 *     its course's Bangalore price, finance item and LMS courses, cash taken in
 *     AED carried as `original`, refused without a Bangalore price or with an
 *     AED figure that doesn't match its rate; a Dubai close as before, said.
 *   - Case 6: one email, one client (the user, 2026-10-10) — a close with an
 *     email another student or lead here holds, another person (another
 *     number; a phone missing → another name), refused 409 naming them; the
 *     same person's second course taken; the check the dialogs ask; and the
 *     read-only shared-emails report.
 *
 * Run by split-payments-check.sh. Scratch database only.
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
  JWT_SECRET: "split-payments-check-jwt",
  JWT_REFRESH_SECRET: "split-payments-check-refresh",
  NODE_ENV: "test",
  RUN_SCHEDULERS: "false",
  // Takes Bangalore closes — with the finance handover itself switched off here.
  FINANCE_ORG_ID_BANGALORE: "org-bangalore-split-check",
});

const mongoose = (await import("mongoose")).default;
await mongoose.connect(uri);
await mongoose.connection.dropDatabase();
const db = mongoose.connection.db!;

const { Course } = await import("../src/models/Course.js");
const { Student } = await import("../src/models/Student.js");
const { StudentService } = await import("../src/services/studentService.js");
const { signAccessToken } = await import("../src/utils/jwt.js");
const service = new StudentService();

// ── People, courses ─────────────────────────────────────────────────────────
const superRole = new Types.ObjectId(), bdeRole = new Types.ObjectId(), viewerRole = new Types.ObjectId();
const can = { view: true, create: true, edit: true, delete: false, approve: false, export: false };
await db.collection("roles").insertMany([
  { _id: superRole, roleName: "Super Admin", isSystemRole: true, permissions: {} },
  { _id: bdeRole, roleName: "BDE", isSystemRole: false, permissions: { students: can, leads: can, enrolments: can } },
  { _id: viewerRole, roleName: "Viewer", isSystemRole: false, permissions: { students: { ...can, create: false, edit: false } } },
]);
const people: Record<string, { id: Types.ObjectId; role: Types.ObjectId }> = {};
for (const [name, role] of [["Abrar", superRole], ["Theertha", bdeRole], ["Vera", viewerRole]] as const) {
  const id = new Types.ObjectId();
  await db.collection("users").insertOne({ _id: id, name, email: `${name.toLowerCase()}@test.local`, password: "x", role, status: "active" });
  people[name] = { id, role };
}
const course500 = await Course.create({ name: "COURSE 500", amount: 500, financeItemId: "64b0000000000000000000a1", lmsCourseSlugs: ["market-break-out-trading-program"] });
const course1000 = await Course.create({ name: "COURSE 1000", amount: 1000 });
// Sold in Bangalore too: its INR price and Bangalore product; no LMS courses of its own (the Dubai ones).
await Course.updateOne({ _id: course500._id }, { $set: { bangalore: { price: 45000, financeItemId: "64b0000000000000000000b1", lmsCourseSlugs: [] } } });
// With LMS courses of its own in Bangalore.
const courseBlr = await Course.create({ name: "COURSE BLR", amount: 800, lmsCourseSlugs: ["delta-wave-theory-trading-programme"], bangalore: { price: 30000, financeItemId: null, lmsCourseSlugs: ["bangalore-wave-theory"] } });

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
let n = 0;
/** A lead to close, with whatever was collected on it before. */
async function lead(before: number[] = []) {
  n++;
  const _id = new Types.ObjectId();
  await db.collection("leads").insertOne({
    _id, name: `Client ${n}`, phone: `+97150000${String(n).padStart(4, "0")}`, email: `client${n}@test.local`, status: "closed",
    assignedTo: people.Theertha!.id, payments: before.map((amount) => ({ _id: new Types.ObjectId(), amount, note: "Booking", paidAt: new Date("2026-10-01") })),
  });
  return String(_id);
}
/** A close, as the dialog sends it. */
const close = async (over: Record<string, unknown>, who = "Theertha", before: number[] = []) => {
  const leadId = await lead(before);
  const r = await call("POST", "/students", who, {
    leadId, name: `Client ${n}`, phone: `+97150000${String(n).padStart(4, "0")}`, email: `client${n}@test.local`,
    courses: [String(course500._id)], enrollmentDate: "2026-10-05T00:00:00.000Z", totalFee: 500, language: "English", hasBonus: false,
    ...over,
  });
  return { ...r, leadId };
};
const pay = (method: string, amount: number, name = `${method}-${amount}`, extra: Record<string, unknown> = {}) => ({ method, amount, receipt: receipt(name), paidAt: "2026-10-05T00:00:00.000Z", ...extra });
const studentOf = (r: Answer) => Student.findById(String(r.body.data?._id)).lean();

section("Case 1 — 500 paid as 300 cash and 200 card, each with its receipt");
let r = await close({ paidAmount: 500, payments: [pay("cash", 300, "cash-a"), pay("card", 200, "card-b")] });
check("closed: 201", r.status === 201, `${r.status} ${r.body.message}`);
let s = await studentOf(r);
check("both payments kept, method and amount each", s?.payments?.map((p) => `${p.method}:${p.amount}`).join(",") === "cash:300,card:200", JSON.stringify(s?.payments));
check("…each with its own receipt", s?.payments?.[0]?.receipt?.key === "receipts/cash-a.jpg" && s?.payments?.[1]?.receipt?.key === "receipts/card-b.jpg");
check("…the first also as the one method and receipt", s?.paymentMethod === "cash" && s?.paymentReceipt?.key === "receipts/cash-a.jpg");
check("…paid in full", s?.paidAmount === 500 && s?.pendingAmount === 0 && s?.feeStatus === "paid", `${s?.paidAmount}/${s?.pendingAmount}/${s?.feeStatus}`);
let payload = await service.buildHandoverPayload(String(s!._id)) as Record<string, any>;
check("finance is sent each payment, in fils, dated, with its receipt",
  payload?.payments?.map((p: any) => `${p.method}:${p.amountMinor}:${p.paidOn}:${p.receipt?.key}`).join(",") === "cash:30000:2026-10-05:receipts/cash-a.jpg,card:20000:2026-10-05:receipts/card-b.jpg", JSON.stringify(payload?.payments));
check("…adding up to what was declared paid, with nothing left to collect", payload?.declaredPaidMinor === 50000 && payload?.balanceMinor === 0);
check("…and the first as the one method and receipt, for whatever reads only that", payload?.declaredPaymentMethod === "cash" && payload?.receipt?.key === "receipts/cash-a.jpg");

section("Case 2 — money already on the lead, part paid, pennies, an older screen, ten payments");
r = await close({ paidAmount: 500, payments: [pay("bank_transfer", 200, "before", { collectedBefore: true }), pay("cash", 300)] }, "Theertha", [200]);
s = await studentOf(r);
check("200 already on the lead + 300 cash: its own payment, marked as before", r.status === 201 && s?.payments?.[0]?.collectedBefore === true && s?.paidAmount === 500, `${r.status} ${r.body.message}`);
r = await close({ courses: [String(course1000._id)], totalFee: 1000, paidAmount: 500, payments: [pay("cash", 300), pay("card", 200)] });
s = await studentOf(r);
payload = await service.buildHandoverPayload(String(s!._id)) as Record<string, any>;
check("part paid: 500 of 1000, half still to collect", r.status === 201 && s?.pendingAmount === 500 && s?.feeStatus === "partial" && payload?.balanceMinor === 50000, `${r.status} ${s?.pendingAmount} ${s?.feeStatus}`);
r = await close({ paidAmount: 500, payments: [pay("cash", 300.1), pay("card", 199.9)] });
s = await studentOf(r);
payload = r.status === 201 ? await service.buildHandoverPayload(String(s!._id)) as Record<string, any> : null;
check("300.10 + 199.90 make 500, to the fil", r.status === 201 && payload?.payments?.map((p: any) => p.amountMinor).join(",") === "30010,19990" && payload?.declaredPaidMinor === 50000, `${r.status} ${r.body.message}`);
r = await close({ paidAmount: 500, paymentMethod: "tabby", paymentReceipt: receipt("tabby-only") });
s = await studentOf(r);
payload = r.status === 201 ? await service.buildHandoverPayload(String(s!._id)) as Record<string, any> : null;
check("an older screen — one method, one receipt — still closes, with no list", r.status === 201 && !s?.payments?.length && payload?.payments === undefined && payload?.declaredPaymentMethod === "tabby", `${r.status} ${r.body.message}`);
r = await close({ paidAmount: 500, payments: Array.from({ length: 10 }, (_, i) => pay("cash", 50, `cash-${i}`)) });
check("ten payments of 50", r.status === 201, `${r.status} ${r.body.message}`);

section("Case 3 — what can't be right is refused, and nothing is saved");
const refused = async (label: string, over: Record<string, unknown>, pattern: RegExp) => {
  const before = await Student.countDocuments();
  const x = await close(over);
  check(label, x.status === 422 && pattern.test(x.body.message ?? "") && (await Student.countDocuments()) === before, `${x.status} ${x.body.message}`);
};
await refused("payments that don't add up to what was paid: 422", { paidAmount: 500, payments: [pay("cash", 300), pay("card", 100)] }, /must match/);
await refused("a payment without its receipt: 422", { paidAmount: 500, payments: [pay("cash", 300), { method: "card", amount: 200, paidAt: "2026-10-05" }] }, /Payment 2 needs its receipt/);
await refused("a method this CRM doesn't take: 422", { paidAmount: 500, payments: [pay("gold", 500)] }, /payment method/);
await refused("a payment of nothing: 422", { paidAmount: 500, payments: [pay("cash", 500), pay("card", 0)] }, /above zero/);
await refused("eleven payments: 422", { paidAmount: 550, totalFee: 600, payments: Array.from({ length: 11 }, (_, i) => pay("cash", 50, `c${i}`)) }, /between one and ten/);
await refused("an empty list: 422", { paidAmount: 0, payments: [] }, /between one and ten/);
// Collecting more than the fee is taken (the owner, 2026-10-06): the balance is zero, never negative.
{
  const over = await close({ paidAmount: 600, payments: [pay("cash", 300), pay("card", 300)] });
  const saved = over.status === 201 ? await Student.findById(String(over.body.data?._id)).lean() : null;
  check("collected 600 on a 500 fee: taken (201), balance 0", over.status === 201 && saved?.pendingAmount === 0, `${over.status} ${over.body.message}`);
  const older = await close({ paidAmount: 600, paymentMethod: "cash", paymentReceipt: receipt("over") });
  check("…from an older screen too: taken (201)", older.status === 201, `${older.status} ${older.body.message}`);
}
const ok = await close({ paidAmount: 300, payments: [pay("cash", 300)] });
r = await call("PUT", `/students/${String(ok.body.data?._id)}`, "Theertha", { paidAmount: 700 });
s = await Student.findById(String(ok.body.data?._id)).lean();
check("an edit taking it above the fee: taken (200), balance 0", r.status === 200 && s?.paidAmount === 700 && s?.pendingAmount === 0, `${r.status} ${s?.paidAmount}`);
r = await call("PUT", `/students/${String(ok.body.data?._id)}`, "Theertha", { totalFee: 200 });
check("…or lowering the fee below what was paid: taken (200)", r.status === 200, `${r.status}`);
const legacy = await Student.create({ enrollmentNumber: "STU-9999", name: "Legacy", leadId: new Types.ObjectId(), totalFee: 1000, paidAmount: 2250, pendingAmount: 0, feeStatus: "paid", enrollmentDate: new Date() });
r = await call("PUT", `/students/${String(legacy._id)}`, "Theertha", { notes: "Checked with accounts" });
check("an enrolment over its fee from before still takes an edit that leaves the money alone", r.status === 200, `${r.status} ${r.body.message}`);

section("Case 4 — who may close");
r = await call("POST", "/students", undefined, { leadId: await lead(), name: "No one", totalFee: 500, paidAmount: 500, payments: [pay("cash", 500)] });
check("not signed in: 401", r.status === 401, `${r.status}`);
r = await close({ paidAmount: 500, payments: [pay("cash", 500)] }, "Vera");
check("a role that can't add students: 403", r.status === 403, `${r.status}`);
r = await close({ paidAmount: 500, payments: [pay("cash", 300), pay("card", 200)] }, "Abrar");
check("a super admin closes too", r.status === 201, `${r.status} ${r.body.message}`);

section("Case 5 — the academy: Dubai as before, Bangalore in INR");
{
  // What the close dialog reads before it offers the choice.
  const { env } = await import("../src/config/env.js");
  let a = await call("GET", "/courses/academies", "Theertha");
  check("the server lists Dubai and Bangalore once the Bangalore organization is set (finance itself off)",
    a.status === 200 && JSON.stringify(a.body.data?.academies) === JSON.stringify(["dubai", "bangalore"]), `${a.status} ${JSON.stringify(a.body.data)}`);
  env.FINANCE_ORG_ID_BANGALORE = "";
  a = await call("GET", "/courses/academies", "Theertha");
  check("…and only Dubai without it — the dialog then offers no choice", a.status === 200 && JSON.stringify(a.body.data?.academies) === JSON.stringify(["dubai"]), JSON.stringify(a.body.data));
  const before = await Student.countDocuments();
  const off = await close({ academy: "bangalore", totalFee: 45000, paidAmount: 45000, payments: [pay("cash", 45000)] });
  check("…and a Bangalore close is refused there (422), finance off or not, nothing saved",
    off.status === 422 && /Bangalore finance organization isn't set/.test(off.body.message ?? "") && (await Student.countDocuments()) === before, `${off.status} ${off.body.message}`);
  const dubai = await close({ paidAmount: 500, payments: [pay("cash", 500)] });
  check("…while a Dubai close goes through as before", dubai.status === 201, `${dubai.status} ${dubai.body.message}`);
  env.FINANCE_ORG_ID_BANGALORE = "org-bangalore-split-check";
  a = await call("GET", "/courses/academies");
  check("asking without signing in: 401", a.status === 401, `${a.status}`);
}
r = await close({ paidAmount: 500, payments: [pay("cash", 500)] });
s = await studentOf(r);
payload = await service.buildHandoverPayload(String(s!._id)) as Record<string, any>;
check("not said: a Dubai close, kept as such and said to finance", r.status === 201 && s?.academy === "dubai" && payload?.academy === "dubai", `${r.status} ${s?.academy} ${payload?.academy}`);
check("…billed as before: the Dubai item, the Dubai LMS course, fils", payload?.courses?.[0]?.itemId === "64b0000000000000000000a1"
  && JSON.stringify(payload?.courses?.[0]?.lmsCourseSlugs) === JSON.stringify(["market-break-out-trading-program"]) && payload?.courses?.[0]?.amountMinor === 50000, JSON.stringify(payload?.courses));
r = await close({ academy: "dubai", paidAmount: 500, payments: [pay("cash", 500, "aed-said", { currency: "AED" })] });
check("Dubai said outright, a payment saying AED (its own currency): 201", r.status === 201 && (await studentOf(r))?.payments?.[0]?.currency === undefined, `${r.status} ${r.body.message}`);

// 45,000 INR: 40,500 in cash taken as INR, 200 AED at 22.5 → 4,500 INR.
r = await close({
  academy: "bangalore", totalFee: 45000, paidAmount: 45000,
  payments: [pay("cash", 40500, "inr-cash"), pay("cash", 4500, "aed-cash", { currency: "AED", amountInCurrency: 200, exchangeRate: 22.5 })],
});
s = await studentOf(r);
check("a Bangalore close: 201, kept as Bangalore, in INR", r.status === 201 && s?.academy === "bangalore" && s?.totalFee === 45000 && s?.paidAmount === 45000, `${r.status} ${r.body.message}`);
check("…the payment taken in AED keeps the AED and its rate, its amount the INR", s?.payments?.[1]?.currency === "AED" && s?.payments?.[1]?.amountInCurrency === 200
  && s?.payments?.[1]?.exchangeRate === 22.5 && s?.payments?.[1]?.amount === 4500 && s?.payments?.[0]?.currency === undefined, JSON.stringify(s?.payments));
payload = await service.buildHandoverPayload(String(s!._id)) as Record<string, any>;
check("finance is told: academy \"bangalore\"", payload?.academy === "bangalore" && payload?.crm === "draw" && payload?.source === "draw-crm", `${payload?.academy}`);
check("…the course at its Bangalore item, the fee in paise", payload?.courses?.length === 1 && payload?.courses?.[0]?.itemId === "64b0000000000000000000b1"
  && payload?.courses?.[0]?.amountMinor === 4500000 && payload?.declaredPaidMinor === 4500000 && payload?.balanceMinor === 0, JSON.stringify(payload?.courses));
check("…opening the Dubai LMS course, the course having none of its own in Bangalore",
  JSON.stringify(payload?.courses?.[0]?.lmsCourseSlugs) === JSON.stringify(["market-break-out-trading-program"]), JSON.stringify(payload?.courses?.[0]));
check("…the AED cash as `original` — 200 AED (20000 fils) at 22.5 INR each — and the INR one without",
  JSON.stringify(payload?.payments?.[1]?.original) === JSON.stringify({ currency: "AED", amountMinor: 20000, rate: 22.5 })
    && payload?.payments?.[1]?.amountMinor === 450000 && payload?.payments?.[0]?.original === undefined, JSON.stringify(payload?.payments));
check("…the bonus still in US dollars", payload?.bonus?.currency === "USD");
r = await close({ academy: "bangalore", courses: [String(courseBlr._id)], totalFee: 30000, paidAmount: 10000, payments: [pay("card", 10000)] });
s = await studentOf(r);
payload = r.status === 201 ? await service.buildHandoverPayload(String(s!._id)) as Record<string, any> : null;
check("a course with Bangalore LMS courses of its own opens those, not the Dubai ones; no Bangalore item, none sent",
  r.status === 201 && JSON.stringify(payload?.courses?.[0]?.lmsCourseSlugs) === JSON.stringify(["bangalore-wave-theory"]) && payload?.courses?.[0]?.itemId === undefined
    && payload?.balanceMinor === 2000000, `${r.status} ${JSON.stringify(payload?.courses)}`);
// The lead's own money is AED: in a Bangalore close it is a payment taken in AED, at a rate.
r = await close({ academy: "bangalore", totalFee: 45000, paidAmount: 45000,
  payments: [pay("bank_transfer", 4500, "own-aed", { collectedBefore: true, currency: "AED", amountInCurrency: 200, exchangeRate: 22.5 }), pay("cash", 40500)] }, "Theertha", [200]);
s = await studentOf(r);
check("the lead's own 200 AED in a Bangalore close: its own payment, in AED at a rate", r.status === 201 && s?.payments?.[0]?.collectedBefore === true && s?.payments?.[0]?.amountInCurrency === 200, `${r.status} ${r.body.message}`);
const leadAfter = await db.collection("leads").findOne({ _id: new Types.ObjectId(r.leadId) });
check("…and the close wrote nothing to the lead's (AED) payments", (leadAfter?.payments ?? []).length === 1, JSON.stringify(leadAfter?.payments));

await refused("a Bangalore close of a course with no Bangalore price: 422", { academy: "bangalore", courses: [String(course1000._id)], totalFee: 1000, paidAmount: 500, payments: [pay("cash", 500)] }, /COURSE 1000 has no Bangalore price/);
await refused("an academy that isn't one: 422", { academy: "mumbai", paidAmount: 500, payments: [pay("cash", 500)] }, /Dubai or Bangalore/);
await refused("AED that doesn't come to its INR at the rate: 422", { academy: "bangalore", totalFee: 45000, paidAmount: 45000,
  payments: [pay("cash", 40500), pay("cash", 4500, "bad-rate", { currency: "AED", amountInCurrency: 200, exchangeRate: 20 })] }, /200 AED at 1 AED = 20 INR comes to 4,000 INR, not 4,500/);
await refused("AED without its rate: 422", { academy: "bangalore", totalFee: 45000, paidAmount: 45000,
  payments: [pay("cash", 40500), pay("cash", 4500, "no-rate", { currency: "AED", amountInCurrency: 200 })] }, /needs its rate: 1 AED = how many INR/);
await refused("a Bangalore payment in another currency: 422", { academy: "bangalore", totalFee: 45000, paidAmount: 45000,
  payments: [pay("cash", 45000, "usd", { currency: "USD", amountInCurrency: 540, exchangeRate: 83.3333 })] }, /USD — a Bangalore close takes INR, or AED with its rate/);
await refused("a Dubai payment in INR: 422", { paidAmount: 500, payments: [pay("cash", 500, "inr", { currency: "INR", amountInCurrency: 11250, exchangeRate: 0.0444 })] }, /a Dubai close is in AED/);
{
  // An edit never changes the academy.
  const blr = await close({ academy: "bangalore", totalFee: 45000, paidAmount: 45000, payments: [pay("cash", 45000)] });
  r = await call("PUT", `/students/${String(blr.body.data?._id)}`, "Theertha", { academy: "dubai", notes: "Tried to move it" });
  s = await Student.findById(String(blr.body.data?._id)).lean();
  check("editing a Bangalore enrolment leaves it Bangalore", r.status === 200 && s?.academy === "bangalore" && s?.notes === "Tried to move it", `${r.status} ${s?.academy}`);
}

section("Case 6 — one email, one client (2026-10-10): an email another client here holds is refused at the close, and by the check");
{
  /** A lead as a sheet or a counsellor left it — no phone, no email, when so. */
  const person = async (name: string, phone: string | null, email: string | null) => {
    const _id = new Types.ObjectId();
    await db.collection("leads").insertOne({
      _id, name, ...(phone !== null ? { phone } : {}), ...(email !== null ? { email } : {}),
      status: "followup", assignedTo: people.Theertha!.id, payments: [], createdAt: new Date(),
    });
    return String(_id);
  };
  /** A close of that lead, as the dialog sends it — the phone left out when it is undefined. */
  const closeAs = (leadId: string, name: string, phone: string | undefined, email: string, over: Record<string, unknown> = {}) =>
    call("POST", "/students", "Theertha", {
      leadId, name, ...(phone !== undefined ? { phone } : {}), email, courses: [String(course500._id)],
      enrollmentDate: "2026-10-05T00:00:00.000Z", totalFee: 500, paidAmount: 500, language: "English", hasBonus: false,
      payments: [pay("cash", 500, `one-email-${leadId}`)], ...over,
    });
  const emailCheck = (q: Record<string, string>, who = "Theertha") => call("GET", `/students/email-check?${new URLSearchParams(q).toString()}`, who);
  const leadEmail = async (id: string) => (await db.collection("leads").findOne({ _id: new Types.ObjectId(id) }))?.email;

  // najad ahmed closes with his own email.
  const najadLead = await person("najad ahmed", "+971 50 111 2233", "najad@example.com");
  let x = await closeAs(najadLead, "najad ahmed", "+971 50 111 2233", "najad@example.com");
  const najad = x.status === 201 ? await studentOf(x) : null;
  check("najad ahmed closes with his own email: 201", x.status === 201 && Boolean(najad?.enrollmentNumber), `${x.status} ${x.body.message}`);
  const najadSays = `This email is already used by najad ahmed (${najad?.enrollmentNumber}), a different client — enter Halif's own email.`;

  // Halif — another number — closes with it: refused, naming najad and his enrolment.
  const halifLead = await person("Halif", "+971 55 999 8877", null);
  let before = await Student.countDocuments();
  x = await closeAs(halifLead, "Halif", "+971 55 999 8877", " Najad@Example.COM ");
  check("another student holds it, another number (any case, stray spaces): 409, naming him and his enrolment, nothing saved",
    x.status === 409 && x.body.message === najadSays && (await Student.countDocuments()) === before, `${x.status} ${x.body.message}`);
  check("…never a phone number in it", !/\d{5,}/.test((x.body.message ?? "").replace(/STU-\d+/g, "")), x.body.message);
  check("…and the lead, which had no email, isn't given his", !(await leadEmail(halifLead)), String(await leadEmail(halifLead)));
  x = await closeAs(halifLead, "Halif", "+971 55 999 8877", "halif@example.com");
  check("…Halif's own email: 201, and it is kept on his lead", x.status === 201 && (await leadEmail(halifLead)) === "halif@example.com", `${x.status} ${x.body.message}`);

  // Held by a lead nobody closed: mohammed lebbie's. yfscghs's own lead says so too — it is still lebbie's.
  await person("mohammed lebbie", "+971 52 444 5566", "lebbie@example.com");
  const yLead = await person("yfscghs", "+971 56 777 0000", "lebbie@example.com");
  before = await Student.countDocuments();
  x = await closeAs(yLead, "yfscghs", "+971 56 777 0000", "lebbie@example.com");
  check("another lead holds it, another number: 409, naming the lead",
    x.status === 409 && x.body.message === "This email is already used by mohammed lebbie (a lead), a different client — enter yfscghs's own email."
      && (await Student.countDocuments()) === before, `${x.status} ${x.body.message}`);

  // The same person, a second course: the same number, however it is written.
  const najad2 = await person("Najad Ahmed", "00971501112233", "najad@example.com");
  x = await closeAs(najad2, "Najad Ahmed", "00971501112233", "najad@example.com", { courses: [String(course1000._id)], totalFee: 1000 });
  check("najad again from another lead, a second course — his number written another way: 201", x.status === 201, `${x.status} ${x.body.message}`);

  // A phone missing on either side: the names decide, case and spaces aside.
  await person("Sara  Khan ", null, "sara@example.com");
  const saraLead = await person("sara khan", "+971 50 333 4444", null);
  x = await closeAs(saraLead, "sara khan", "+971 50 333 4444", "sara@example.com");
  check("held by a lead with no phone, the same name: the same person — 201", x.status === 201, `${x.status} ${x.body.message}`);
  await person("Ali Hassan", null, "ali@example.com");
  const aliLead = await person("Ali Hasan", null, null);
  x = await closeAs(aliLead, "Ali Hasan", undefined, "ali@example.com");
  check("no phone on either, another name: 409", x.status === 409 && x.body.message === "This email is already used by Ali Hassan (a lead), a different client — enter Ali Hasan's own email.", `${x.status} ${x.body.message}`);
  const ali2Lead = await person("ALI  HASSAN", null, null);
  x = await closeAs(ali2Lead, "ALI  HASSAN", undefined, "ali@example.com");
  check("no phone on either, the same name: 201", x.status === 201, `${x.status} ${x.body.message}`);

  // The lead's own email, held by nobody else — the ordinary close.
  const zedLead = await person("Zed", "+971 50 888 9999", "zed@example.com");
  x = await closeAs(zedLead, "Zed", "+971 50 888 9999", "zed@example.com");
  check("an email only this lead holds: 201", x.status === 201, `${x.status} ${x.body.message}`);

  // The check the close dialog asks before it saves: the same rule, the same message.
  let c = await emailCheck({ email: "najad@example.com", leadId: yLead });
  check("the check: another student holds it — not ok, naming him, his enrolment, the same message",
    c.status === 200 && c.body.data?.ok === false && JSON.stringify(c.body.data?.takenBy) === JSON.stringify({ kind: "student", name: "najad ahmed", code: najad?.enrollmentNumber })
      && c.body.data?.message === "This email is already used by najad ahmed (" + najad?.enrollmentNumber + "), a different client — enter yfscghs's own email.", `${c.status} ${JSON.stringify(c.body.data)}`);
  c = await emailCheck({ email: "LEBBIE@example.com", leadId: yLead });
  check("…another lead holds it: the lead, by name, no code", c.body.data?.ok === false && JSON.stringify(c.body.data?.takenBy) === JSON.stringify({ kind: "lead", name: "mohammed lebbie" }), JSON.stringify(c.body.data));
  c = await emailCheck({ email: "zed@example.com", leadId: zedLead });
  check("…its own lead and its own student are the same person: ok", c.status === 200 && c.body.data?.ok === true && !c.body.data?.takenBy, JSON.stringify(c.body.data));
  c = await emailCheck({ email: "nobody@example.com", leadId: yLead });
  check("…an email nobody has: ok", c.body.data?.ok === true, JSON.stringify(c.body.data));
  // A student of the lead, its phone not the lead's (given another at the close): still the same person.
  const joLead = await person("Joseph", "+971 50 121 2121", "jo@example.com");
  x = await closeAs(joLead, "Joseph", "+971 50 343 4343", "jo@example.com");
  c = await emailCheck({ email: "jo@example.com", leadId: joLead });
  check("…a student of the same lead, whatever its phone, is the same person: ok", x.status === 201 && c.body.data?.ok === true, `${x.status} ${JSON.stringify(c.body.data)}`);
  // From the correction form: the enrolment, and the name and phone it now has.
  const saraStudent = await Student.findOne({ leadId: new Types.ObjectId(saraLead) }).lean();
  c = await emailCheck({ email: "najad@example.com", studentId: String(saraStudent?._id) });
  check("…for an enrolment: another number holds it — not ok, named for the enrolment's client", c.body.data?.ok === false && /enter sara khan's own email\.$/.test(c.body.data?.message as string ?? ""), JSON.stringify(c.body.data));
  c = await emailCheck({ email: "najad@example.com", studentId: String(saraStudent?._id), name: "Najad A", phone: "+971501112233" });
  check("…the same, with the name and phone the form now has — his number: ok", c.body.data?.ok === true, JSON.stringify(c.body.data));
  check("…never a phone in an answer", [c, await emailCheck({ email: "najad@example.com", leadId: yLead })].every((a) => !/\d{5,}/.test(JSON.stringify(a.body).replace(/STU-\d+/g, ""))));
  c = await emailCheck({ email: "najad@example.com" });
  check("…which lead or enrolment it is for, required: 422", c.status === 422, `${c.status} ${c.body.message}`);
  c = await emailCheck({ email: "najad@", leadId: yLead });
  check("…something that isn't an email: 422", c.status === 422, `${c.status} ${c.body.message}`);
  c = await emailCheck({ email: "najad@example.com", leadId: String(new Types.ObjectId()) });
  check("…a lead that doesn't exist: 404", c.status === 404, `${c.status} ${c.body.message}`);
  c = await emailCheck({ email: "najad@example.com", studentId: "not-an-id" });
  check("…an enrolment that doesn't exist: 404", c.status === 404, `${c.status} ${c.body.message}`);
  c = await call("GET", `/students/email-check?email=najad%40example.com&leadId=${yLead}`);
  check("…not signed in: 401", c.status === 401, `${c.status}`);
  c = await emailCheck({ email: "najad@example.com", leadId: yLead }, "Vera");
  check("…a role that can neither close nor correct: 403", c.status === 403, `${c.status}`);
  c = await emailCheck({ email: "najad@example.com", leadId: yLead }, "Abrar");
  check("…a super admin may ask", c.status === 200 && c.body.data?.ok === false, `${c.status}`);

  // The report, read only, of what is shared already: a client closed with another's email before this rule.
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const backendDir = fileURLToPath(new URL("..", import.meta.url));
  // Closed before the rule, its lead gone since.
  await db.collection("students").insertOne({
    enrollmentNumber: "STU-0900", name: "Halif", phone: "+971559998877", email: "najad@example.com",
    leadId: new Types.ObjectId(), status: "active", createdAt: new Date(), updatedAt: new Date(),
  });
  const counts = async () => JSON.stringify([await db.collection("leads").countDocuments(), await db.collection("students").countDocuments(),
    (await db.listCollections().toArray()).map((x) => x.name).sort(), (await db.collection("leads").indexes()).length, (await db.collection("students").indexes()).length]);
  const stateBefore = await counts();
  // Run as it is documented: bun --no-env-file, the database given outright — this scratch one.
  const report = (args: string[], env: Record<string, string | undefined> = { MONGODB_URI: uri }) =>
    spawnSync(process.execPath, ["--no-env-file", "scripts/shared-emails-report.ts", ...args], {
      cwd: backendDir,
      encoding: "utf8",
      env: Object.fromEntries(Object.entries({ PATH: process.env.PATH, HOME: process.env.HOME, DOTENV_CONFIG_PATH: "/nonexistent", ...env })
        .filter((e): e is [string, string] => e[1] !== undefined)),
    });
  const asJson = report(["--json"]);
  let parsed: { groups?: { email: string; count: number; records: { kind: string; name: string; code?: string; id?: string; status: string }[] }[] } = {};
  try { parsed = JSON.parse(asJson.stdout); } catch { /* checked below */ }
  const groupOf = (masked: string) => parsed.groups?.find((g) => g.email === masked);
  const na = groupOf("na***@example.com");
  check("the report (--json) lists najad's email, masked, with every record holding it",
    asJson.status === 0 && na?.count === 5 && na.records.filter((r) => r.kind === "student").map((r) => r.code).sort().join(",") === [najad?.enrollmentNumber, (await Student.findOne({ leadId: new Types.ObjectId(najad2) }).lean())?.enrollmentNumber, "STU-0900"].sort().join(",")
      && na.records.filter((r) => r.kind === "lead").every((r) => /^[0-9a-f]{24}$/.test(r.id ?? "") && Boolean(r.status)), `${asJson.status} ${asJson.stderr} ${JSON.stringify(na)}`);
  check("…and lebbie's — two leads, two numbers", groupOf("le***@example.com")?.count === 2 && groupOf("le***@example.com")?.records.every((r) => r.kind === "lead") === true, JSON.stringify(groupOf("le***@example.com")));
  check("…but not an email only one person holds (sara: one phone missing, the same name; jo: a lead and its own student; ali: the same name)",
    !groupOf("sa***@example.com") && !groupOf("jo***@example.com") && !groupOf("al***@example.com") && !groupOf("ze***@example.com"), JSON.stringify(parsed.groups?.map((g) => g.email)));
  check("…never a full email or a phone number", !/najad@|lebbie@|\+971|501112233|559998877/.test(asJson.stdout), asJson.stdout.slice(0, 200));
  const asText = report([]);
  check("the report as text: the masked email, the count, each record by name and enrolment number",
    asText.status === 0 && /na\*\*\*@example\.com — 5 records/.test(asText.stdout) && asText.stdout.includes("STU-0900") && !/najad@example|\+971/.test(asText.stdout), `${asText.status} ${asText.stderr}`);
  const write = report(["--write"]);
  check("…refuses anything but --json (no --write): exit 2", write.status === 2 && /only reads/.test(write.stderr), `${write.status} ${write.stderr}`);
  const noUri = report(["--json"], { MONGODB_URI: undefined });
  check("…refuses to guess the database: no MONGODB_URI, exit 2", noUri.status === 2 && /MONGODB_URI/.test(noUri.stderr), `${noUri.status} ${noUri.stderr}`);
  check("…and wrote nothing: the same records, collections and indexes", (await counts()) === stateBefore, `${stateBefore} → ${await counts()}`);
}

server.close();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
