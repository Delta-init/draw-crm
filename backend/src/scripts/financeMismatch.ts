/**
 * READ ONLY (the user, 2026-11-23): enrolments whose course or fee here isn't what finance has — like the close put on
 * a cheaper course here after finance approved it, whose invoice kept the old course and price while the lead said
 * "100% paid". Every student with a finance enrolment is asked of finance, in batches of 200, in the organization its
 * academy is billed in; printed are those whose course or fee differs from finance's invoice (a void invoice is left
 * out), and the leads whose courses differ from their enrolment's. Writes nothing. Run it from the API folder on the
 * server (it reads MONGODB_URI and the finance settings from the .env):
 *
 *   bun src/scripts/financeMismatch.ts
 *
 * Draw: an enrolment of several courses is one invoice with a line each, and finance names it by its first line — so
 * its first course is what is compared, and the fee is the whole invoice's.
 *
 * Each one is put right with Change course on the enrolment (finance approves it), or in finance itself.
 */
import "dotenv/config";
import mongoose from "mongoose";

export interface EnrolmentMismatch {
  studentId: string;
  enrollmentNumber: string;
  name: string;
  invoiceNumber: string;
  /** "course", "fee" or both. */
  differs: string[];
  crm: { course: string; fee: number };
  finance: { course: string; fee: number; currency: string };
}

export interface LeadMismatch {
  leadId: string;
  name: string;
  leadCourse: string;
  enrolmentCourse: string;
}

/** Course names compared as finance compares them: case and spaces aside. */
const sameName = (a: unknown, b: unknown) =>
  String(a ?? "").trim().replace(/\s+/g, " ").toLowerCase() === String(b ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const money = (n: number, currency: string) => `${currency} ${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** A list of course ids, in any order, as one key. */
const idsKey = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).filter(Boolean).map(String))].sort().join(",");

export async function financeMismatches(): Promise<{ enrolments: EnrolmentMismatch[]; leads: LeadMismatch[]; asked: number; answered: number }> {
  const { FinanceHandover } = await import("../models/FinanceHandover.js");
  const { Student } = await import("../models/Student.js");
  const { Course } = await import("../models/Course.js");
  const { Lead } = await import("../models/Lead.js");
  const { fetchEnrolmentStatusesFor } = await import("../services/financeClient.js");

  const handovers = await FinanceHandover.find({ status: "sent" }).select("studentId academy invoiceNumber").lean();
  const handoverOf = new Map(handovers.map((h) => [String(h.studentId), h]));
  const students = await Student.find({ _id: { $in: handovers.map((h) => h.studentId) } })
    .select("name enrollmentNumber courses totalFee academy leadId")
    .lean();
  const leads = await Lead.find({ _id: { $in: students.map((s) => s.leadId) } }).select("name courses").lean();
  const courseIds = [...students.flatMap((s) => s.courses ?? []), ...leads.flatMap((l) => l.courses ?? [])].filter(Boolean);
  const courseName = new Map((await Course.find({ _id: { $in: courseIds } }).select("name").lean()).map((c) => [String(c._id), c.name]));
  const nameOf = (id: unknown) => (id ? courseName.get(String(id)) ?? "(a course no longer here)" : "no course");
  const namesOf = (ids: unknown) => (Array.isArray(ids) && ids.length ? ids.map(nameOf).join(" + ") : "no course");

  // In batches of 200 — finance answers at most that many a call — each asked of its academy's organization.
  const statuses: Awaited<ReturnType<typeof fetchEnrolmentStatusesFor>> = [];
  for (let i = 0; i < students.length; i += 200) {
    statuses.push(...(await fetchEnrolmentStatusesFor(students.slice(i, i + 200).map((s) => ({
      id: String(s._id), academy: handoverOf.get(String(s._id))?.academy ?? s.academy,
    })))));
  }
  const statusOf = new Map(statuses.map((st) => [st.externalId, st as typeof st & { course?: string }]));

  const enrolments: EnrolmentMismatch[] = [];
  for (const s of students) {
    const st = statusOf.get(String(s._id));
    if (!st || st.status === "void") continue;
    const differs: string[] = [];
    // A finance from before it said its course has nothing to compare. Finance names the invoice by its first line.
    if (typeof st.course === "string" && !sameName(st.course, nameOf(s.courses?.[0]))) differs.push("course");
    if (Math.round((s.totalFee ?? 0) * 100) !== (st.totalMinor ?? 0)) differs.push("fee");
    if (!differs.length) continue;
    enrolments.push({
      studentId: String(s._id),
      enrollmentNumber: s.enrollmentNumber ?? "",
      name: s.name ?? "",
      invoiceNumber: st.invoiceNumber || handoverOf.get(String(s._id))?.invoiceNumber || "",
      differs,
      crm: { course: namesOf(s.courses), fee: s.totalFee ?? 0 },
      finance: { course: st.course ?? "", fee: (st.totalMinor ?? 0) / 100, currency: st.currency || "AED" },
    });
  }

  const studentOfLead = new Map(students.map((s) => [String(s.leadId), s]));
  const leadMismatches: LeadMismatch[] = leads.flatMap((l) => {
    const s = studentOfLead.get(String(l._id));
    if (!s || idsKey(l.courses) === idsKey(s.courses)) return [];
    return [{ leadId: String(l._id), name: l.name ?? "", leadCourse: namesOf(l.courses), enrolmentCourse: namesOf(s.courses) }];
  });

  return { enrolments, leads: leadMismatches, asked: students.length, answered: statuses.length };
}

export function printMismatches(r: Awaited<ReturnType<typeof financeMismatches>>): string[] {
  return [
    `Enrolments whose course or fee isn't finance's: ${r.enrolments.length}`,
    ...r.enrolments.map((m) => `  ${m.enrollmentNumber} ${m.name} · ${m.invoiceNumber || "no invoice number"} — `
      + [
        ...(m.differs.includes("course") ? [`course: here "${m.crm.course}", finance "${m.finance.course}"`] : []),
        ...(m.differs.includes("fee") ? [`fee: here ${money(m.crm.fee, m.finance.currency)}, finance ${money(m.finance.fee, m.finance.currency)}`] : []),
      ].join("; ")),
    "",
    `Leads whose courses aren't their enrolment's: ${r.leads.length}`,
    ...r.leads.map((m) => `  ${m.name} (${m.leadId}) — lead "${m.leadCourse}", enrolment "${m.enrolmentCourse}"`),
    "",
    `Asked finance about ${r.asked} enrolment(s); it answered for ${r.answered}.${r.asked && !r.answered ? " Is finance reachable with this .env?" : ""}`,
  ];
}

if (import.meta.main) {
  await mongoose.connect(process.env.MONGODB_URI!, { authSource: "admin" });
  try {
    for (const l of printMismatches(await financeMismatches())) console.log(l);
    console.log("\nNothing written.");
  } catch (e) {
    console.error((e as Error).message);
    process.exitCode = 1;
  }
  await mongoose.disconnect();
}
