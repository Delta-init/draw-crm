/**
 * Closing a Draw lead the way Delta CRM closes one, end to end, against a real
 * backend process — finance and object storage are stand-ins served here,
 * finance checking every signature the way its own middleware does.
 *
 *   Case 1  happy path   a receipt uploaded, a lead with no email and two
 *                        courses closed, the email kept on the lead, and the
 *                        enrolment finance receives — at once, not a minute on
 *   Case 2  edge         no bonus, paid in full, a lead's own email left alone,
 *                        a second close, correcting the bonus, an old enrolment
 *                        with no course, nothing sent twice
 *   Case 3  errors       each missing piece refused and named, all of them
 *                        named together, bad receipts, a server with no storage
 *   Case 4  permission   no token, a role that cannot create students, a
 *                        switched-off account
 *
 * Run through scripts/enrolment-close-e2e.sh. Refuses anything but a scratch
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
const BARE_API = `http://127.0.0.1:${process.env.E2E_BARE_API_PORT}/api/v1`;
const CLIENT_ID = process.env.E2E_FINANCE_CLIENT_ID ?? "";
const SECRET = process.env.E2E_FINANCE_SECRET ?? "";
const ORG_ID = process.env.E2E_FINANCE_ORG_ID ?? "";
const ORG_BLR = process.env.E2E_FINANCE_ORG_ID_BANGALORE ?? "";
const BUCKET = process.env.E2E_BUCKET ?? "";
const PUBLIC_URL = process.env.E2E_PUBLIC_URL ?? "";

let failures = 0, checks = 0;
function check(label: string, ok: boolean, detail = "") {
  checks++;
  if (ok) console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  else { failures++; console.log(`  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`); }
}
const step = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);

type Json = Record<string, unknown>;
interface Res { status: number; body: { success?: boolean; message?: string; data?: Json } }
/** A value inside an answer, by dotted path — the answers here are read, not typed. */
const at = (o: unknown, path: string): unknown =>
  path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Json)[k] : undefined), o);
const show = (r: Res) => `${r.status} ${JSON.stringify(r.body).slice(0, 240)}`;

async function call(method: string, path: string, body?: unknown, token?: string, base = API): Promise<Res> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Res["body"] };
}

/** A receipt sent the way the dialog sends one: multipart, field "file". */
async function upload(leadId: string, file: { name: string; type: string; bytes: Uint8Array<ArrayBuffer> } | null, token?: string, base = API): Promise<Res> {
  const form = new FormData();
  if (file) form.append("file", new Blob([file.bytes], { type: file.type }), file.name);
  const r = await fetch(`${base}/students/receipts/${leadId}`, {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
    body: form,
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Res["body"] };
}

async function waitFor(test: () => Promise<boolean>, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await test()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return test();
}

/** Read a request's whole body, then answer it. node:http, since this backend carries Node's types, not Bun's. */
function serve(port: number, handle: (req: http.IncomingMessage, raw: Buffer) => { status: number; body?: unknown; headers?: Record<string, string> }) {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const { status, body, headers } = handle(req, Buffer.concat(chunks));
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(body === undefined ? "" : JSON.stringify(body));
    });
  });
  server.listen(port, "127.0.0.1");
  return server;
}

/* ── A stand-in bucket: takes a signed PUT, keeps what it was given. ── */
const stored: { key: string; size: number; type: string; signed: boolean }[] = [];
const s3 = serve(Number(process.env.E2E_FAKE_S3_PORT), (req, raw) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const [, bucket, ...rest] = url.pathname.split("/");
  if (req.method !== "PUT" || bucket !== BUCKET || rest.length === 0) return { status: 404 };
  stored.push({
    key: decodeURIComponent(rest.join("/")),
    size: raw.length,
    type: String(req.headers["content-type"] ?? ""),
    signed: String(req.headers.authorization ?? "").startsWith("AWS4-HMAC-SHA256"),
  });
  return { status: 200, headers: { etag: '"e2e"' } };
});

/* ── A stand-in finance: takes an enrolment behind the signature finance checks. ── */
const received: { payload: Json; org: string }[] = [];
let badSignatures = 0;
const finance = serve(Number(process.env.E2E_FAKE_FINANCE_PORT), (req, raw) => {
  const header = (name: string) => String(req.headers[name] ?? "");
  const expected = crypto.createHmac("sha256", SECRET)
    .update([req.method ?? "", req.url ?? "", header("x-delta-timestamp"), header("x-delta-nonce"), crypto.createHash("sha256").update(raw).digest("hex")].join("\n"))
    .digest("hex");
  if (header("x-delta-client") !== CLIENT_ID || header("x-delta-signature") !== expected || ![ORG_ID, ORG_BLR].includes(header("x-delta-org"))) {
    badSignatures++;
    return { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "Unauthorized" } } };
  }
  if (req.method === "POST" && req.url === "/api/v1/integrations/enrolments") {
    received.push({ payload: JSON.parse(raw.toString("utf8")) as Json, org: header("x-delta-org") });
    const n = String(received.length).padStart(4, "0");
    return { status: 201, body: { data: { invoiceId: `inv-${n}`, invoiceNumber: `IN-E2E-${n}`, customerId: "cus-1", duplicate: false, flags: [] } } };
  }
  if (req.method === "POST" && req.url === "/api/v1/integrations/enrolments/status") return { status: 200, body: { data: [] } };
  return { status: 404, body: { error: { message: "Not found" } } };
});

await mongoose.connect(uri);
if (mongoose.connection.host !== "127.0.0.1") { console.error("Refusing: not 127.0.0.1"); process.exit(1); }
for (const c of await mongoose.connection.db!.listCollections().toArray()) await mongoose.connection.db!.collection(c.name).deleteMany({});

const { Role } = await import("../models/Role.js");
const { User } = await import("../models/User.js");
const { Course } = await import("../models/Course.js");
const { Lead } = await import("../models/Lead.js");
const { Student } = await import("../models/Student.js");
const { FinanceHandover } = await import("../models/FinanceHandover.js");

step("Setting up");
const PASSWORD = "E2e-Password-123";
const adminRole = await Role.create({ roleName: "Super Admin", isSystemRole: true });
const counsellorRole = await Role.create({
  roleName: "Counsellor",
  permissions: { leads: { view: true, create: true, edit: true }, students: { view: true, create: true, edit: true } },
});
const viewerRole = await Role.create({ roleName: "Viewer", permissions: { leads: { view: true }, students: { view: true } } });
const adminUser = await User.create({ name: "Draw Admin", email: "admin@draw-e2e.test", password: PASSWORD, role: adminRole._id, status: "active" });
const counsellorUser = await User.create({ name: "Karthika R", email: "counsellor@draw-e2e.test", password: PASSWORD, role: counsellorRole._id, status: "active" });
await User.create({ name: "Draw Viewer", email: "viewer@draw-e2e.test", password: PASSWORD, role: viewerRole._id, status: "active" });
const login = async (email: string) => at((await call("POST", "/auth/login", { email, password: PASSWORD })).body, "data.accessToken") as string | undefined;
const admin = (await login("admin@draw-e2e.test"))!;
const counsellor = (await login("counsellor@draw-e2e.test"))!;
const viewer = (await login("viewer@draw-e2e.test"))!;
check("an admin, a counsellor and a viewer can sign in", !!admin && !!counsellor && !!viewer);

const c1 = await Course.create({ name: "COURSE 1 - MARKET BREAKOUT THEORY (WITH CREDIT)", amount: 2250, status: "active" });
const c2 = await Course.create({ name: "COURSE 2 - MBT + DWT (WITH CREDIT)", amount: 5500, status: "active" });
const c3 = await Course.create({ name: "MENTOR'S MASTERY COURSE", amount: 1837, status: "active" });
const lead = async (name: string, phone: string, email?: string) =>
  String((await Lead.create({ name, phone, reporter: adminUser._id, assignedTo: counsellorUser._id, ...(email ? { email } : {}) }))._id);
const L1 = await lead("Abdul Sathar", "+971509000001");
const L2 = await lead("Priya Nair", "+971509000002", "priya@draw-e2e.test");
const L3 = await lead("Refused Client", "+971509000003");
const L4 = await lead("Own Email", "+971509000004", "own@draw-e2e.test");
check("three courses and four leads, two of them with no email", !!c1._id && !!c2._id && !!c3._id && !!L4);

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 120 }, (_, i) => i)]);
/** The stored receipt every close below names, once Case 1 has uploaded it. */
let receipt: Json = {};

/** A close with everything finance needs, with whatever is passed laid over it. */
const closeBody = (leadId: string, over: Json = {}): Json => ({
  leadId, name: "Client", phone: "+971509000000", email: "client@draw-e2e.test",
  courses: [String(c1._id)], totalFee: 2250, paidAmount: 0, feeStatus: "pending",
  language: "English", paymentMethod: "cash", paymentReceipt: receipt, hasBonus: false,
  enrollmentDate: "2026-10-02T00:00:00.000Z",
  ...over,
});

// ── Case 1 ──────────────────────────────────────────────────────────────────
step("Case 1 — happy path: the receipt, the close, the email kept, and finance told at once");
let r = await upload(L1, { name: "receipt photo.png", type: "image/png", bytes: PNG }, counsellor);
receipt = (r.body.data ?? {}) as Json;
const key = String(receipt.key ?? "");
check("a receipt is taken and stored under the lead, its name made safe", r.status === 200
  && key.startsWith(`enrolment-receipts/${L1}/`) && key.endsWith("-receipt_photo.png") && receipt.url === `${PUBLIC_URL}/${key}`
  && receipt.name === "receipt photo.png" && receipt.mimeType === "image/png" && receipt.size === PNG.length, show(r));
check("...in the bucket, signed, with its own bytes and type", stored.length === 1 && stored[0]?.key === key
  && stored[0]?.size === PNG.length && stored[0]?.type === "image/png" && stored[0]?.signed === true, JSON.stringify(stored));

const t0 = Date.now();
r = await call("POST", "/students", closeBody(L1, {
  name: "Abdul Sathar", phone: "+971509000001", email: "Abdul76Sathar@Draw-e2e.test",
  courses: [String(c2._id)], totalFee: 7000, paidAmount: 2000, feeStatus: "partial",
  language: "Malayalam", paymentMethod: "tabby", hasBonus: true, bonusAmount: 250,
}), counsellor);
check("a complete close is saved", r.status === 201, show(r));
const s1 = await Student.findOne({ leadId: L1 }).lean();
check("...with its one course, the email lower-cased, language, method and receipt", (s1?.courses ?? []).length === 1
  && s1?.email === "abdul76sathar@draw-e2e.test" && s1?.language === "Malayalam" && s1?.paymentMethod === "tabby"
  && s1?.paymentReceipt?.key === key, JSON.stringify({ c: s1?.courses, e: s1?.email, l: s1?.language }));
check("...and the bonus, beside a balance it is not part of", s1?.hasBonus === true && s1?.bonusAmount === 250 && s1?.pendingAmount === 5000,
  JSON.stringify({ h: s1?.hasBonus, a: s1?.bonusAmount, p: s1?.pendingAmount }));
const lead1 = await Lead.findById(L1).lean();
const lastLog = (lead1?.activityLogs ?? []).at(-1) as { action?: string; description?: string; performedBy?: unknown } | undefined;
check("the lead had no email: it now has the one given at the close", lead1?.email === "abdul76sathar@draw-e2e.test", String(lead1?.email));
check("...and its history says so, and who did it", lastLog?.action === "lead_updated" && /Email added at the close/.test(lastLog?.description ?? "")
  && String(lastLog?.performedBy) === String(counsellorUser._id), JSON.stringify(lastLog));

const sentFast = await waitFor(async () => (await FinanceHandover.findOne({ studentId: s1?._id }).lean())?.status === "sent", 8_000);
check("finance has it within seconds — sent at the close, not on the next minute's pass", sentFast && Date.now() - t0 < 8_000, `${Date.now() - t0}ms`);
const p1 = received[0]?.payload ?? {};
check("signed as finance checks, for the organization configured", badSignatures === 0 && received[0]?.org === ORG_ID, `bad=${badSignatures}`);
check("tagged as sold through Draw, for finance, the LMS and Tetra Commission to show", p1.crm === "draw", String(p1.crm));
check("from draw-crm, to the client by email and phone", p1.source === "draw-crm" && at(p1, "customer.email") === "abdul76sathar@draw-e2e.test"
  && at(p1, "customer.phone") === "+971509000001" && p1.externalId === String(s1?._id), JSON.stringify(p1.customer));
const lines = (p1.courses ?? []) as { name: string; amountMinor: number }[];
check("one line: the course at the agreed fee", lines.length === 1 && lines[0]?.amountMinor === 700_000, JSON.stringify(lines));
check("what was paid, and the balance — fee less paid, in fils", p1.declaredPaidMinor === 200_000 && p1.balanceMinor === 500_000,
  JSON.stringify({ paid: p1.declaredPaidMinor, balance: p1.balanceMinor }));
check("the bonus, for information, in US cents — an MT5 bonus, USD whatever the fee's currency", at(p1, "bonus.given") === true
  && at(p1, "bonus.amountMinor") === 25_000 && at(p1, "bonus.currency") === "USD", JSON.stringify(p1.bonus));
check("the language, how it was paid, and the receipt by key", p1.language === "Malayalam" && p1.declaredPaymentMethod === "tabby"
  && at(p1, "receipt.key") === key && at(p1, "receipt.url") === receipt.url && at(p1, "receipt.mimeType") === "image/png", JSON.stringify(p1.receipt));
const h1 = await FinanceHandover.findOne({ studentId: s1?._id }).lean();
check("the invoice number is kept against the enrolment", h1?.invoiceNumber === "IN-E2E-0001", String(h1?.invoiceNumber));

// ── Case 2 ──────────────────────────────────────────────────────────────────
step("Case 2 — edge: no bonus, paid in full, a lead's own email, a second close, corrections");
// Collecting more than the fee is taken now (the owner, 2026-10-06): a close over its fee that is short of its
// language is refused for the language, never for the money — and nothing is saved, so L2 stays free.
r = await call("POST", "/students", closeBody(L2, {
  name: "Priya Nair", email: "priya@draw-e2e.test", courses: [String(c3._id)], totalFee: 1837, paidAmount: 2000,
  hasBonus: false, language: "",
}), counsellor);
check("over the fee is no reason to refuse: only the missing language is named, nothing saved", r.status === 422 && /language/.test(r.body.message ?? "")
  && !/more than the fee/.test(r.body.message ?? "") && !(await Student.findOne({ leadId: L2 }).lean()), show(r));
r = await call("POST", "/students", closeBody(L2, {
  name: "Priya Nair", email: "priya@draw-e2e.test", courses: [String(c3._id)], totalFee: 1837, paidAmount: 1837,
  hasBonus: false, bonusAmount: 99,
}), counsellor);
const s2 = await Student.findOne({ leadId: L2 }).lean();
check("no bonus is stored as no, with no amount whatever was sent", r.status === 201 && s2?.hasBonus === false && s2?.bonusAmount === 0,
  `${show(r)} ${JSON.stringify({ h: s2?.hasBonus, a: s2?.bonusAmount })}`);
await waitFor(async () => received.length >= 2, 8_000);
const p2 = received[1]?.payload ?? {};
check("...and finance is told \"no\"", at(p2, "bonus.given") === false && at(p2, "bonus.amountMinor") === 0, JSON.stringify(p2.bonus));
check("paid in full: the balance is zero", p2.balanceMinor === 0 && at(p2, "courses.0.amountMinor") === 183_700,
  JSON.stringify({ balance: p2.balanceMinor, lines: p2.courses }));

r = await call("POST", "/students", closeBody(L4, { name: "Own Email", email: "other@draw-e2e.test" }), counsellor);
const lead4 = await Lead.findById(L4).lean();
check("a lead with its own email keeps it — the close never overwrites one", r.status === 201 && lead4?.email === "own@draw-e2e.test"
  && !(lead4?.activityLogs ?? []).some((l) => /Email added/.test(String((l as { description?: string }).description))), `${show(r)} ${lead4?.email}`);

r = await call("POST", "/students", closeBody(L1), counsellor);
check("closing the same lead again is refused: it already has its enrolment", r.status === 409, show(r));

const id1 = String(s1?._id);
r = await call("PUT", `/students/${id1}`, { hasBonus: true, bonusAmount: 0 }, counsellor);
check("a bonus corrected to no amount is refused", r.status === 422 && /bonus/i.test(r.body.message ?? ""), show(r));
check("...and the stored bonus is unchanged", (await Student.findById(id1).lean())?.bonusAmount === 250);
r = await call("PUT", `/students/${id1}`, { bonusAmount: 300 }, counsellor);
check("the amount can be corrected", r.status === 200 && (await Student.findById(id1).lean())?.bonusAmount === 300, show(r));
r = await call("PUT", `/students/${id1}`, { hasBonus: false }, counsellor);
const off = await Student.findById(id1).lean();
check("changed to no bonus, the amount goes with it", r.status === 200 && off?.hasBonus === false && off?.bonusAmount === 0, show(r));
r = await call("PUT", `/students/${id1}`, { feeStatus: "paid" }, counsellor);
check("a fee status set by hand is kept, not recomputed away", r.status === 200 && (await Student.findById(id1).lean())?.feeStatus === "paid", show(r));

const old = await Student.collection.insertOne({
  enrollmentNumber: "STU-OLD-1", name: "Older Client", leadId: new mongoose.Types.ObjectId(), courses: [],
  enrollmentDate: new Date(), totalFee: 0, paidAmount: 0, pendingAmount: 0, feeStatus: "pending", status: "active",
});
r = await call("POST", `/students/${String(old.insertedId)}/invoice`, undefined, admin);
check("an older enrolment with no course says there is nothing to invoice, not \"queued\"", r.status === 409
  && /no course/i.test(r.body.message ?? ""), show(r));
await new Promise((res) => setTimeout(res, 300));
check("one enrolment to finance per close and none twice — edits send nothing", received.length === 3
  && new Set(received.map((x) => x.payload.externalId)).size === 3, `received ${received.length}`);

// ── Case 3 ──────────────────────────────────────────────────────────────────
step("Case 3 — errors: what finance needs, refused when missing and named");
const refusals: [string, Json, RegExp][] = [
  ["no course", { courses: [] }, /a course/],
  ["two courses — a close is one", { courses: [String(c1._id), String(c2._id)] }, /one course/],
  ["an unknown course", { courses: [String(new mongoose.Types.ObjectId())] }, /a course/],
  ["a course id that is not one", { courses: ["not-an-id"] }, /a course/],
  ["no email", { email: "" }, /email/],
  ["an email that is not one", { email: "someone@" }, /email/],
  ["no language", { language: "" }, /language/],
  ["a language outside the list", { language: "Klingon" }, /language/],
  ["a payment method finance does not know", { paymentMethod: "barter" }, /payment method/],
  ["no receipt", { paymentReceipt: null }, /receipt/],
  ["a receipt pointing at nothing", { paymentReceipt: { name: "x.jpg", url: "", key: "" } }, /receipt/],
  ["the bonus unanswered", { hasBonus: undefined }, /whether a bonus was given/],
  ["a bonus with no amount", { hasBonus: true }, /the bonus amount/],
  ["a bonus that rounds to nothing", { hasBonus: true, bonusAmount: 0.001 }, /the bonus amount/],
];
for (const [label, over, expect] of refusals) {
  r = await call("POST", "/students", closeBody(L3, over), counsellor);
  check(`${label} is refused, saying so`, r.status === 422 && expect.test(r.body.message ?? ""), show(r));
}
r = await call("POST", "/students", { leadId: L3, name: "Refused Client", phone: "+971509000003" }, counsellor);
const all = r.body.message ?? "";
check("everything missing is named in one refusal", r.status === 422 && ["a course", "email", "language", "payment method", "receipt", "bonus"].every((w) => all.includes(w)), show(r));
const lead3 = await Lead.findById(L3).lean();
check("...and none of that made an enrolment, or touched the lead", (await Student.countDocuments({ leadId: L3 })) === 0 && !lead3?.email
  && (lead3?.activityLogs ?? []).length === 0);

const storedBefore = stored.length;
r = await upload(L3, null, counsellor);
check("an upload with no file is refused", r.status === 400 && /No file/i.test(r.body.message ?? ""), show(r));
r = await upload(L3, { name: "receipt.gif", type: "image/gif", bytes: new Uint8Array([0x47, 0x49, 0x46, 0x38]) }, counsellor);
check("a GIF is refused, naming what is taken — not a 500", r.status === 415 && /JPG, PNG, WebP, HEIC or PDF/.test(r.body.message ?? ""), show(r));
r = await upload(L3, { name: "huge.pdf", type: "application/pdf", bytes: new Uint8Array(10 * 1024 * 1024 + 1) }, counsellor);
check("a receipt over 10 MB is refused, saying the limit — not a 500", r.status === 413 && /10 MB/.test(r.body.message ?? ""), show(r));
r = await upload(L3, { name: "receipt.png", type: "image/png", bytes: PNG }, counsellor, BARE_API);
check("a server with no storage settings says so, rather than losing the file", r.status === 503 && /storage is not configured/i.test(r.body.message ?? ""), show(r));
check("...and none of those reached the bucket", stored.length === storedBefore, `${storedBefore} → ${stored.length}`);

// ── Case 5 (before Case 4 switches the counsellor off) ─────────────────────
step("Case 5 — academy: a Bangalore close goes to the Bangalore organization, in INR");
await Course.updateOne({ _id: c1._id }, { $set: { bangalore: { price: 45000, financeItemId: "64b0000000000000000000b1", lmsCourseSlugs: [] } } });
const L5 = await lead("Bangalore Client", "+919800000005", "blr@draw-e2e.test");
const L6 = await lead("Bangalore Unpriced", "+919800000006", "blr2@draw-e2e.test");
const receivedBefore = received.length;
r = await call("POST", "/students", closeBody(L5, {
  name: "Bangalore Client", phone: "+919800000005", email: "blr@draw-e2e.test", academy: "bangalore",
  totalFee: 45000, paidAmount: 45000, feeStatus: "paid", paymentMethod: "cash",
  payments: [
    { method: "cash", amount: 40500, receipt, paidAt: "2026-10-02T00:00:00.000Z" },
    { method: "cash", amount: 4500, receipt, paidAt: "2026-10-02T00:00:00.000Z", currency: "AED", amountInCurrency: 200, exchangeRate: 22.5 },
  ],
}), counsellor);
check("a Bangalore close is saved", r.status === 201 && at(r.body, "data.academy") === "bangalore", show(r));
await waitFor(async () => received.length > receivedBefore, 8_000);
const blr = received.at(-1);
check("...and finance has it at once, from the Bangalore organization, signed", blr?.org === ORG_BLR && blr?.payload.academy === "bangalore" && badSignatures === 0, `${blr?.org} bad=${badSignatures}`);
check("...in paise, at the course's Bangalore product, the AED cash as original",
  JSON.stringify(blr?.payload.courses) === JSON.stringify([{ name: "COURSE 1 - MARKET BREAKOUT THEORY (WITH CREDIT)", amountMinor: 4_500_000, itemId: "64b0000000000000000000b1" }])
    && (blr?.payload.payments as Json[] | undefined)?.[1]?.original !== undefined && blr?.payload.declaredPaidMinor === 4_500_000, JSON.stringify(blr?.payload.courses));
check("...its outbox row Bangalore too", (await FinanceHandover.findOne({ studentId: at(r.body, "data._id") }).lean())?.academy === "bangalore");
r = await call("POST", "/students", closeBody(L6, { academy: "bangalore", courses: [String(c2._id)], totalFee: 5500 }), counsellor);
check("a Bangalore close of a course with no Bangalore price is refused, naming it", r.status === 422 && /COURSE 2 - MBT \+ DWT \(WITH CREDIT\) has no Bangalore price/.test(String(at(r.body, "message"))), show(r));
r = await call("GET", "/courses/academies", undefined, counsellor);
check("this server lists Dubai and Bangalore for the close dialog", r.status === 200 && JSON.stringify(at(r.body, "data.academies")) === JSON.stringify(["dubai", "bangalore"]), show(r));
r = await call("GET", "/courses/academies", undefined, counsellor, BARE_API);
check("...a server without the Bangalore organization lists only Dubai", r.status === 200 && JSON.stringify(at(r.body, "data.academies")) === JSON.stringify(["dubai"]), show(r));
r = await call("POST", "/students", closeBody(L6, { academy: "bangalore", totalFee: 45000 }), counsellor, BARE_API);
check("...and refuses a Bangalore close, even with finance switched off", r.status === 422 && /Bangalore finance organization isn't set/.test(String(at(r.body, "message"))), show(r));

// ── Case 4 ──────────────────────────────────────────────────────────────────
step("Case 4 — permission: no token, a role that cannot create students, a switched-off account");
let anon = await upload(L3, { name: "r.png", type: "image/png", bytes: PNG });
let denied = await upload(L3, { name: "r.png", type: "image/png", bytes: PNG }, viewer);
check("uploading a receipt: no token is 401, a viewer is 403", anon.status === 401 && denied.status === 403, `${show(anon)} | ${show(denied)}`);
anon = await call("POST", "/students", closeBody(L3));
denied = await call("POST", "/students", closeBody(L3), viewer);
check("closing: no token is 401, a viewer is 403", anon.status === 401 && denied.status === 403, `${show(anon)} | ${show(denied)}`);
check("...and neither reached the bucket or made an enrolment", stored.length === storedBefore && (await Student.countDocuments({ leadId: L3 })) === 0);
await User.updateOne({ _id: counsellorUser._id }, { $set: { status: "inactive" } });
r = await call("POST", "/students", closeBody(L3), counsellor);
const relogin = await call("POST", "/auth/login", { email: "counsellor@draw-e2e.test", password: PASSWORD });
check("a switched-off account is turned away, token or not", r.status === 403 && relogin.status >= 400 && !at(relogin.body, "data.accessToken"),
  `${show(r)} | ${show(relogin)}`);

s3.close();
finance.close();
await mongoose.disconnect();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
