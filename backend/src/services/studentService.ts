import { Types } from "mongoose";
import { z } from "zod";
import { Student } from "../models/Student.js";
import { Lead } from "../models/Lead.js";
import { Course } from "../models/Course.js";
import type { Academy, IRole, IStudent, IStudentPayment, EnrolmentLanguage, EnrolmentPaymentMethod } from "../types/index.js";
import { ACADEMIES, ACADEMY_LABELS, ENROLMENT_LANGUAGES, ENROLMENT_PAYMENT_METHODS, PAYMENT_METHOD_LABELS, academyOf } from "../types/index.js";

function createError(msg: string, status: number) {
  return Object.assign(new Error(msg), { statusCode: status });
}

/** Whole fils, so 300.10 + 199.90 is 500 and never 499.9999. */
const minor = (n: number) => Math.round(n * 100);
const money = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 2 });

type ReceiptInput = { name?: string; url?: string; key?: string; size?: number; mimeType?: string } | null | undefined;
type PaymentInput = {
  method?: string;
  amount?: number | string;
  receipt?: ReceiptInput;
  paidAt?: string;
  collectedBefore?: boolean;
  /** A Bangalore close's payment taken in AED: "AED", the amount in AED, and 1 AED = exchangeRate INR. */
  currency?: string;
  amountInCurrency?: number | string;
  exchangeRate?: number | string;
} | null;

/** The currency a close's money is in: INR for Bangalore, AED for Dubai. */
const currencyOf = (academy: Academy) => (academy === "bangalore" ? "INR" : "AED");

/**
 * A Bangalore close's payment taken in AED (the user, 2026-10-10: cash is
 * sometimes taken in AED): the amount in AED and the rate — 1 AED = so many
 * INR — checked against the INR amount the close converted it to, within half
 * a percent for rounding. A figure typed in the wrong currency is refused
 * rather than billed. Nothing for a payment in the close's own currency.
 *
 * A Dubai close is in AED throughout, so it takes nothing else; a Bangalore
 * close takes INR, or AED with its rate.
 */
function foreignPart(raw: PaymentInput, amount: number, n: string, academy: Academy): Pick<IStudentPayment, "currency" | "amountInCurrency" | "exchangeRate"> {
  const currency = typeof raw?.currency === "string" ? raw.currency.trim().toUpperCase() : "";
  const own = currencyOf(academy);
  if (!currency || currency === own) return {};
  if (academy !== "bangalore" || currency !== "AED") {
    throw createError(
      academy === "bangalore"
        ? `${n} is in ${currency} — a Bangalore close takes INR, or AED with its rate.`
        : `${n} is in ${currency} — a Dubai close is in AED.`,
      422,
    );
  }
  const inAed = Number(raw?.amountInCurrency);
  if (!Number.isFinite(inAed) || inAed <= 0) throw createError(`${n} needs the amount paid in AED.`, 422);
  const rate = Number(raw?.exchangeRate);
  if (!Number.isFinite(rate) || rate <= 0) throw createError(`${n} needs its rate: 1 AED = how many INR.`, 422);
  const expected = Math.round(inAed * rate * 100);
  if (Math.abs(minor(amount) - expected) > Math.max(1, Math.round(expected * 0.005))) {
    throw createError(
      `${n}: ${money(inAed)} AED at 1 AED = ${rate} INR comes to ${money(expected / 100)} INR, not ${money(amount)}.`,
      422,
    );
  }
  return { currency: "AED", amountInCurrency: minor(inAed) / 100, exchangeRate: rate };
}

/** What the lead's own money is counted as on a payment: the AED handed over when it says so, else its amount. */
const ownFigure = (p: Pick<IStudentPayment, "amount" | "currency" | "amountInCurrency">) =>
  p.currency === "AED" && p.amountInCurrency ? p.amountInCurrency : p.amount;

/**
 * The payments a close sends, checked (the user, 2026-10-05: a client may pay
 * part in cash and part by card, each with its own receipt): every one with a
 * method this CRM takes, an amount above zero and its receipt, and together
 * exactly what was paid. Null when the close sent none — an older screen, with
 * one method, one receipt and the total.
 */
function checkedPayments(list: unknown, paidAmount: number, enrolledOn: Date, academy: Academy = "dubai"): IStudentPayment[] | null {
  if (list === undefined || list === null) return null;
  if (!Array.isArray(list) || list.length === 0 || list.length > 10) throw createError("A closing takes between one and ten payments.", 422);
  const payments = (list as PaymentInput[]).map((raw, i) => {
    const n = list.length > 1 ? `Payment ${i + 1}` : "The payment";
    if (!ENROLMENT_PAYMENT_METHODS.includes(raw?.method as EnrolmentPaymentMethod)) throw createError(`${n} needs a payment method.`, 422);
    const amount = Number(raw?.amount);
    if (!Number.isFinite(amount) || amount <= 0) throw createError(`${n} needs an amount above zero.`, 422);
    if (!raw?.receipt?.key || !raw.receipt.url) throw createError(`${n} needs its receipt.`, 422);
    const paidAt = raw.paidAt ? new Date(raw.paidAt) : enrolledOn;
    return {
      method: raw.method as EnrolmentPaymentMethod,
      amount: minor(amount) / 100,
      receipt: {
        name: raw.receipt.name || "Receipt",
        url: raw.receipt.url,
        key: raw.receipt.key,
        ...(raw.receipt.size ? { size: raw.receipt.size } : {}),
        ...(raw.receipt.mimeType ? { mimeType: raw.receipt.mimeType } : {}),
        uploadedAt: new Date(),
      },
      paidAt: Number.isNaN(paidAt.getTime()) ? enrolledOn : paidAt,
      ...(raw.collectedBefore ? { collectedBefore: true } : {}),
      ...foreignPart(raw, amount, n, academy),
    };
  });
  const sum = payments.reduce((s, p) => s + minor(p.amount), 0);
  if (sum !== minor(paidAmount)) {
    throw createError(`The payments come to ${money(sum / 100)}, but ${money(paidAmount)} was paid — they must match.`, 422);
  }
  return payments;
}

/*
 * Collecting more than the fee is taken (the owner, 2026-10-06: more is
 * sometimes collected and it must still go through). The close and correction
 * forms say so in amber, the balance stays at zero, never negative, and finance
 * leaves payments above its invoice for accounts to record by hand.
 */

/**
 * A bonus amount that can be recorded: a real number of at least one minor
 * unit — finance counts in fils, and refuses a bonus that rounds to none.
 */
function isBonusAmount(v: unknown): boolean {
  const n = Number(v);
  return v !== null && v !== "" && Number.isFinite(n) && Math.round(n * 100) > 0;
}

/** An email finance will take: its intake refuses an enrolment without a valid one. */
const isEmail = (v: string): boolean => z.email().safeParse(v).success;

/**
 * A payment on the lead that the close recorded — "Collected at enrolment —
 * <courses> · <method>" — as opposed to one the lead held of its own. Only the
 * close's are replaced when the enrolment is corrected.
 */
const fromTheClose = (note?: string | null) => /^Collected at enrolment\b/.test(note ?? "");

/** Everything a close took, sent again as a correction once finance has sent the enrolment back. */
export interface EnrolmentCorrection {
  name?: string;
  phone?: string;
  email?: string;
  courses?: string[] | null;
  team?: string | null;
  assignedTo?: string | null;
  enrollmentDate?: string;
  feeStatus?: string;
  totalFee?: number | string;
  paidAmount?: number | string;
  notes?: string;
  language?: string;
  payments?: unknown;
  hasBonus?: boolean;
  bonusAmount?: number | string;
  /** Never changes in a correction: sent only to be checked against the one it was closed for. */
  academy?: string;
}

/**
 * The academy a close asks for: Dubai or Bangalore, Dubai when it says nothing
 * (a screen from before the choice). Anything else is refused.
 */
function askedAcademy(v: unknown): Academy {
  if (v === undefined || v === null || v === "") return "dubai";
  if (!ACADEMIES.includes(v as Academy)) throw createError("The academy is Dubai or Bangalore.", 422);
  return v as Academy;
}

/** A course's Bangalore INR price, when it has one above zero. */
const bangalorePrice = (c: { bangalore?: { price?: number | null } | null } | null | undefined): number | null => {
  const p = Number(c?.bangalore?.price);
  return Number.isFinite(p) && p > 0 ? p : null;
};

/**
 * A Bangalore close's courses must each have a Bangalore price (the user,
 * 2026-10-10) — the fee starts from it and finance bills it in INR — and the
 * Bangalore finance organization must be set, whether or not the handover is
 * on: a server without it doesn't take Bangalore closes at all (and doesn't
 * offer them — academiesOffered), rather than keep one it can never bill.
 */
async function assertBangaloreReady(courseIds: string[]): Promise<void> {
  const { academiesOffered } = await import("./financeClient.js");
  if (!academiesOffered().includes("bangalore")) {
    throw createError("Bangalore closes aren't switched on yet — the Bangalore finance organization isn't set. Close it as Dubai, or ask an admin.", 422);
  }
  const found = await Course.find({ _id: { $in: courseIds } }).select("name bangalore").lean();
  const unpriced = found.filter((c) => bangalorePrice(c) === null).map((c) => c.name);
  if (unpriced.length) {
    throw createError(
      `${unpriced.join(", ")} ${unpriced.length > 1 ? "have" : "has"} no Bangalore price yet — set it under Courses → Map, then close again.`,
      422,
    );
  }
}

// Auto-generate enrollment number: STU-0001, STU-0002, ...
async function nextEnrollmentNumber(): Promise<string> {
  const last = await Student.findOne().sort({ createdAt: -1 }).select("enrollmentNumber").lean();
  if (!last) return "STU-0001";
  const match = last.enrollmentNumber.match(/\d+$/);
  const num = match ? parseInt(match[0], 10) + 1 : 1;
  return `STU-${String(num).padStart(4, "0")}`;
}

export class StudentService {

  // ── Create ───────────────────────────────────────────────────────────────────

  async createStudent(data: {
    leadId: string;
    name: string;
    phone?: string;
    email?: string;
    courses?: string[] | null;
    team?: string | null;
    assignedTo?: string | null;
    initialLeadResponse?: string | null;
    primaryConcern?: string | null;
    followupStrategyType?: string | null;
    demoScheduled?: boolean;
    demoAttended?: boolean;
    firstContactTime?: string | null;
    lastFollowupDate?: string | null;
    enrollmentDate?: string;
    feeStatus?: string;
    totalFee?: number;
    paidAmount?: number;
    notes?: string;
    language?: string;
    paymentMethod?: string;
    paymentReceipt?: { name: string; url: string; key: string; size?: number; mimeType?: string } | null;
    /** Each payment taken, when the client paid in more than one way. */
    payments?: unknown;
    hasBonus?: boolean;
    bonusAmount?: number;
    /** Dubai or Bangalore (the user, 2026-10-10); Dubai when not said. Fixed from the close on. */
    academy?: string;
  }, performedBy?: string) {
    const existing = await Student.findOne({ leadId: data.leadId });
    if (existing) throw createError("A student already exists for this lead", 409);

    const academy    = askedAcademy(data.academy);
    const totalFee   = data.totalFee   ?? 0;
    const paidAmount = data.paidAmount ?? 0;
    const enrolledOn = data.enrollmentDate ? new Date(data.enrollmentDate) : new Date();
    // One payment or several; the first is also the one method and receipt.
    const payments = checkedPayments(data.payments, paidAmount, enrolledOn, academy);
    const paymentMethod = payments?.[0]?.method ?? data.paymentMethod;
    const paymentReceipt = payments?.[0]?.receipt ?? data.paymentReceipt;

    /*
     * Required here rather than on the model.
     *
     * Enrolments predating these fields exist and have to keep loading, so
     * the schema leaves them optional; the requirement belongs at the moment
     * of closing, which is the only moment somebody is in a position to
     * answer. The same list Delta CRM's close holds, and two more that only
     * this one needed:
     *
     *   - a course. An enrolment with none was saved and then dropped without
     *     a word: there is nothing to put on an invoice, so nothing went to
     *     finance, and the sale was never heard of again.
     *   - the client's email. Finance's intake refuses an enrolment without a
     *     valid one, so a close without it failed there, permanently, where
     *     nobody closing the lead could see it.
     *
     * All asked for at once and refused as one list — rejecting them one at a
     * time means a round trip each to learn what the form could have said.
     */
    const courseIds = [...new Set((data.courses ?? []).filter(Boolean).map(String))];
    const coursesFound =
      courseIds.length > 0 && courseIds.every((id) => Types.ObjectId.isValid(id))
        ? await Course.countDocuments({ _id: { $in: courseIds } })
        : 0;
    const email = String(data.email ?? "").trim().toLowerCase();

    const missing: string[] = [];
    if (courseIds.length === 0 || coursesFound !== courseIds.length) missing.push("a course");
    if (!isEmail(email)) missing.push("the client's email");
    if (!ENROLMENT_LANGUAGES.includes(data.language as EnrolmentLanguage)) missing.push("language");
    if (!ENROLMENT_PAYMENT_METHODS.includes(paymentMethod as EnrolmentPaymentMethod)) {
      missing.push("payment method");
    }
    if (!paymentReceipt?.key || !paymentReceipt.url) missing.push("payment receipt");
    // Yes or no, every time — and a yes is only an answer with its amount.
    if (typeof data.hasBonus !== "boolean") missing.push("whether a bonus was given");
    else if (data.hasBonus && !isBonusAmount(data.bonusAmount)) missing.push("the bonus amount");
    // One course a close, as in the other sales CRMs (the user, 2026-10-09).
    if (courseIds.length > 1) {
      throw createError("A closing is one course — pick the one that was sold, then close again.", 422);
    }
    if (missing.length) {
      throw createError(
        `A closing needs ${missing.join(", ")}. Pick the course, give the client's email, upload the receipt, choose the language and payment method, and say whether a bonus was given, then close again.`,
        422,
      );
    }
    if (academy === "bangalore") await assertBangaloreReady(courseIds);

    const enrollmentNumber = await nextEnrollmentNumber();

    const student = await Student.create({
      enrollmentNumber,
      name: data.name,
      phone: data.phone,
      email,
      courses: courseIds,
      team:   data.team   || undefined,
      assignedTo: data.assignedTo || undefined,
      leadId: data.leadId,
      initialLeadResponse:  data.initialLeadResponse  ?? null,
      primaryConcern:       data.primaryConcern        ?? null,
      followupStrategyType: data.followupStrategyType  ?? null,
      demoScheduled:    data.demoScheduled  ?? false,
      demoAttended:     data.demoAttended   ?? false,
      firstContactTime: data.firstContactTime ? new Date(data.firstContactTime) : null,
      lastFollowupDate: data.lastFollowupDate ? new Date(data.lastFollowupDate) : null,
      enrollmentDate:   enrolledOn,
      feeStatus:    this.computeFeeStatus(totalFee, paidAmount, data.feeStatus),
      totalFee,
      paidAmount,
      pendingAmount: Math.max(0, totalFee - paidAmount),
      notes: data.notes,
      language: data.language,
      paymentMethod,
      paymentReceipt: paymentReceipt
        ? { ...paymentReceipt, uploadedAt: new Date() }
        : undefined,
      ...(payments ? { payments } : {}),
      hasBonus: data.hasBonus,
      bonusAmount: data.hasBonus ? Number(data.bonusAmount) : 0,
      academy,
      status: "active",
    });

    await this.fillLeadEmail(data.leadId, email, performedBy);

    // Queued, not sent. The sale is recorded the moment this returns; the
    // invoice follows when finance is reachable. See financeHandoverWorker.
    await this.queueFinanceHandover(String(student._id), data.leadId);

    return this.populateStudent(String(student._id));
  }

  /**
   * The email asked for at the close, kept on the lead too — when it had none.
   *
   * The lead is where this CRM keeps a client's details, so an address learnt
   * at the close belongs there rather than only on the enrolment. One the
   * lead already holds is never replaced from here: correcting it is the
   * lead's own edit, with its own history. Logged on the lead when somebody
   * is known to have done it. Never fails the close, which is already saved.
   *
   * An update rather than a save, so a lead carrying some older value its
   * schema would now refuse still gets the email instead of quietly not.
   */
  private async fillLeadEmail(leadId: string, email: string, performedBy?: string): Promise<void> {
    try {
      await Lead.updateOne(
        { _id: leadId, $or: [{ email: { $exists: false } }, { email: null }, { email: "" }] },
        {
          $set: { email },
          ...(performedBy
            ? {
                $push: {
                  activityLogs: {
                    action: "lead_updated",
                    description: `Email added at the close: ${email}`,
                    performedBy,
                    changes: { email: { from: null, to: email } },
                    createdAt: new Date(),
                  },
                },
              }
            : {}),
        },
      );
    } catch (err) {
      console.error("[students] could not keep the email on the lead", err);
    }
  }

  // ── Read ─────────────────────────────────────────────────────────────────────

  async getStudents(filters: {
    search?: string;
    status?: string;
    feeStatus?: string;
    course?: string;
    team?: string;
    assignedTo?: string;
    initialLeadResponse?: string;
    primaryConcern?: string;
    followupStrategyType?: string;
    demoScheduled?: string;
    demoAttended?: string;
    enrollmentFrom?: string;
    enrollmentTo?: string;
    page?: string;
    limit?: string;
  }) {
    const page  = Math.max(1, parseInt(filters.page  ?? "1",  10));
    const limit = Math.min(100, parseInt(filters.limit ?? "20", 10));
    const skip  = (page - 1) * limit;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: Record<string, any> = {};

    if (filters.search) {
      const re = new RegExp(filters.search, "i");
      query.$or = [{ name: re }, { phone: re }, { email: re }, { enrollmentNumber: re }];
    }
    if (filters.status)               query.status     = filters.status;
    if (filters.feeStatus)            query.feeStatus  = filters.feeStatus;
    if (filters.course)               query.courses    = filters.course;
    if (filters.team)                 query.team       = filters.team;
    if (filters.assignedTo)           query.assignedTo = filters.assignedTo;
    if (filters.initialLeadResponse)  query.initialLeadResponse  = filters.initialLeadResponse;
    if (filters.primaryConcern)       query.primaryConcern       = filters.primaryConcern;
    if (filters.followupStrategyType) query.followupStrategyType = filters.followupStrategyType;
    if (filters.demoScheduled !== undefined) query.demoScheduled = filters.demoScheduled === "true";
    if (filters.demoAttended  !== undefined) query.demoAttended  = filters.demoAttended  === "true";
    if (filters.enrollmentFrom || filters.enrollmentTo) {
      query.enrollmentDate = {};
      if (filters.enrollmentFrom) query.enrollmentDate.$gte = new Date(filters.enrollmentFrom + "T00:00:00.000Z");
      if (filters.enrollmentTo)   query.enrollmentDate.$lte = new Date(filters.enrollmentTo   + "T23:59:59.999Z");
    }

    const [students, total] = await Promise.all([
      Student.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("courses",    "name amount")
        .populate("team",       "name")
        .populate("assignedTo", "name email designation")
        .populate("leadId",     "name phone status")
        .lean(),
      Student.countDocuments(query),
    ]);

    return {
      students,
      pagination: {
        total, page, limit,
        totalPages:  Math.ceil(total / limit),
        hasNextPage: page * limit < total,
        hasPrevPage: page > 1,
      },
    };
  }

  async getStudentById(id: string) {
    const student = await this.populateStudent(id);
    if (!student) throw createError("Student not found", 404);
    return student;
  }

  async getStudentByLeadId(leadId: string) {
    return Student.findOne({ leadId })
      .populate("courses",    "name amount bangalore")
      .populate("team",       "name")
      .populate("assignedTo", "name email designation")
      .lean();
  }

  // ── Update ───────────────────────────────────────────────────────────────────

  async updateStudent(id: string, data: Partial<IStudent & { courses?: string[]; team?: string; assignedTo?: string }>) {
    const student = await Student.findById(id);
    if (!student) throw createError("Student not found", 404);

    const allowed: Array<keyof typeof data> = [
      "name", "phone", "email", "courses", "team", "assignedTo",
      "initialLeadResponse", "primaryConcern", "followupStrategyType",
      "demoScheduled", "demoAttended", "firstContactTime", "lastFollowupDate",
      "enrollmentDate", "feeStatus", "totalFee", "paidAmount", "notes", "status",
    ];
    for (const field of allowed) {
      if (data[field] !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (student as any)[field] = data[field];
      }
    }

    /*
     * The bonus, corrected after the close. Kept here: an enrolment already
     * with finance is not re-sent for an edit — the bonus reaches finance with
     * a correction only after finance sends the enrolment back.
     */
    if (typeof data.hasBonus === "boolean") student.hasBonus = data.hasBonus;
    if (data.bonusAmount !== undefined) student.bonusAmount = Number(data.bonusAmount);
    if (student.hasBonus === true && !isBonusAmount(student.bonusAmount)) {
      throw createError("A bonus needs an amount above zero — or choose no bonus.", 422);
    }
    if (student.hasBonus !== true) student.bonusAmount = 0;

    // Recompute pendingAmount and feeStatus if fee fields changed
    const total   = (student as unknown as Record<string, number>).totalFee   as number ?? 0;
    const paid    = (student as unknown as Record<string, number>).paidAmount  as number ?? 0;
    student.pendingAmount = Math.max(0, total - paid);
    // An explicitly sent status is honoured, as it is on create. The figures
    // decide when nobody says otherwise — but a counsellor who marks an
    // enrolment paid against a part payment has a reason, and discarding it
    // made the dropdown on the enrolment dialog do nothing at all.
    student.feeStatus     = this.computeFeeStatus(total, paid, data.feeStatus);

    await student.save();
    return this.populateStudent(id);
  }

  // ── Finance, and what became of an enrolment there ──────────────────────────

  /**
   * The enrolment as finance needs to read it.
   *
   * Every course on the student, one line each — Draw's enrolments hold an
   * array from the start, unlike Delta's single course, so a sale of three
   * courses is one invoice with three lines rather than three invoices for
   * one sale. Each course carries every LMS course it opens (two for a
   * bundle), and finance's approval opens them all.
   *
   * Built from the student as it stands right now, which is a snapshot at
   * the close and the current record for a correction after finance sends
   * an enrolment back — the same double duty Delta CRM's version of this
   * has, for the same reason.
   *
   * Null when the student, or every one of its courses, has gone.
   */
  async buildHandoverPayload(studentId: string): Promise<Record<string, unknown> | null> {
    const student = await Student.findById(studentId)
      .populate("courses", "name amount financeItemId lmsCourseSlug lmsCourseSlugs bangalore")
      .populate("assignedTo", "name email")
      .lean();
    if (!student) return null;

    /*
     * The academy it was closed for (the user, 2026-10-10). A Bangalore close
     * is billed in INR, into the Bangalore finance organization: each course
     * as the Bangalore academy sells it — its INR price weighs the split below,
     * its Bangalore finance item, and its Bangalore LMS courses, or the Dubai
     * ones when it has none of its own (the Forex courses are shared). The
     * amounts are paise, as the Dubai ones are fils: the fee as it was agreed.
     */
    const academy = academyOf(student.academy);
    const bangalore = academy === "bangalore";
    const courseDocs = ((student.courses ?? []) as unknown as {
      name?: string; amount?: number; financeItemId?: string | null; lmsCourseSlug?: string; lmsCourseSlugs?: string[];
      bangalore?: { price?: number | null; financeItemId?: string | null; lmsCourseSlugs?: string[] } | null;
    }[]).filter(Boolean).map((c) => (bangalore
      ? {
          name: c.name,
          amount: bangalorePrice(c) ?? 0,
          financeItemId: c.bangalore?.financeItemId ?? null,
          ...((c.bangalore?.lmsCourseSlugs ?? []).some((x) => x.trim())
            ? { lmsCourseSlug: undefined, lmsCourseSlugs: c.bangalore!.lmsCourseSlugs }
            : { lmsCourseSlug: c.lmsCourseSlug, lmsCourseSlugs: c.lmsCourseSlugs }),
        }
      : c));
    if (courseDocs.length === 0) return null;

    const rep = student.assignedTo as unknown as { name?: string; email?: string } | undefined;

    /*
     * The whole fee is split across the courses in proportion to their own
     * listed price, rather than each course billed at its own catalogue
     * price regardless of what was actually agreed — a counsellor's
     * negotiated total is what the client agreed to pay, and that is what
     * has to reach finance, the same principle Delta's single-course
     * handover already holds.
     */
    const listTotal = courseDocs.reduce((sum, c) => sum + (c.amount ?? 0), 0) || 1;
    const totalFee = Math.round((student.totalFee ?? 0) * 100);
    let allocated = 0;
    const courses = courseDocs.map((c, i) => {
      const isLast = i === courseDocs.length - 1;
      // The last line takes whatever rounding left over, so the lines always
      // add up to the whole fee rather than drifting a cent short or long.
      const amountMinor = isLast
        ? totalFee - allocated
        : Math.round((totalFee * (c.amount ?? 0)) / listTotal);
      allocated += amountMinor;
      // Every LMS course this one opens — the list where it was mapped as one,
      // the single slug from before otherwise.
      const listed = (c.lmsCourseSlugs ?? []).map((s) => s.trim()).filter(Boolean);
      const lms = listed.length ? listed : c.lmsCourseSlug?.trim() ? [c.lmsCourseSlug.trim()] : [];
      return {
        name: c.name ?? "Course",
        amountMinor,
        ...(c.financeItemId ? { itemId: c.financeItemId } : {}),
        ...(lms.length ? { lmsCourseSlug: lms[0], lmsCourseSlugs: lms } : {}),
      };
    });

    return {
      externalId: String(student._id),
      source: "draw-crm",
      // Which sales CRM sold it, shown as a tag in finance, the LMS and
      // Tetra Commission — the same field Delta's and the Remote CRM send.
      crm: "draw",
      // Which academy, always said: finance keeps it on the invoice and passes
      // it to the LMS (the student's academy there) and Tetra Commission.
      academy,
      customer: {
        name: student.name,
        email: student.email ?? "",
        phone: student.phone ?? "",
      },
      courses,
      ...(rep?.email ? { salespersonEmail: rep.email } : {}),
      ...(rep?.name ? { salespersonName: rep.name } : {}),
      enrolledOn: (student.enrollmentDate ?? new Date()).toISOString().slice(0, 10),
      declaredPaidMinor: Math.round((student.paidAmount ?? 0) * 100),
      // The fee less what was paid, in the same minor units as the lines and
      // the paid figure, so finance sees exactly the difference of what it was
      // sent. The bonus is never in it.
      balanceMinor: Math.max(0, totalFee - Math.round((student.paidAmount ?? 0) * 100)),
      // Whether a bonus was given at the close, for information. Not sent for
      // an enrolment from before it was asked: unknown is not "no".
      ...(typeof student.hasBonus === "boolean"
        ? {
            bonus: {
              given: student.hasBonus,
              amountMinor: student.hasBonus ? Math.round((student.bonusAmount ?? 0) * 100) : 0,
              // The course bonus is an MT5 bonus, in US dollars in every sales CRM (2026-10-09) —
              // whatever the fee's currency. Cents.
              currency: "USD",
            },
          }
        : {}),
      modeOfStudy: "online" as const,
      language: student.language ?? "",
      ...(student.paymentMethod ? { declaredPaymentMethod: student.paymentMethod } : {}),
      ...(student.paymentReceipt?.key
        ? {
            receipt: {
              name: student.paymentReceipt.name,
              url: student.paymentReceipt.url,
              key: student.paymentReceipt.key,
              ...(student.paymentReceipt.size ? { size: student.paymentReceipt.size } : {}),
              ...(student.paymentReceipt.mimeType ? { mimeType: student.paymentReceipt.mimeType } : {}),
            },
          }
        : {}),
      // Each payment on its own, with its own method, date and receipt — they
      // add up to declaredPaidMinor, and finance records them on approval. The
      // fields above stay for whatever reads only the total.
      ...(student.payments?.length
        ? {
            payments: student.payments.map((p) => ({
              method: p.method,
              amountMinor: Math.round(p.amount * 100),
              paidOn: new Date(p.paidAt).toISOString().slice(0, 10),
              // Cash a Bangalore close took in AED: what was handed over, and
              // how many INR one AED bought — finance's own field for it.
              ...(bangalore && p.currency === "AED" && p.amountInCurrency && p.exchangeRate
                ? { original: { currency: "AED", amountMinor: Math.round(p.amountInCurrency * 100), rate: p.exchangeRate } }
                : {}),
              ...(p.receipt?.key && p.receipt.url
                ? {
                    receipt: {
                      name: p.receipt.name,
                      url: p.receipt.url,
                      key: p.receipt.key,
                      ...(p.receipt.size ? { size: p.receipt.size } : {}),
                      ...(p.receipt.mimeType ? { mimeType: p.receipt.mimeType } : {}),
                    },
                  }
                : {}),
            })),
          }
        : {}),
    };
  }

  /**
   * Put this enrolment in the queue for Delta Finance.
   *
   * Deliberately swallows its own failures. The student exists by the time
   * this runs, and a salesperson should not see an error — still less lose
   * the enrolment — because a queue row could not be written or because the
   * integration is switched off. A missing row is visible on the student,
   * which shows no invoice number.
   */
  async queueFinanceHandover(studentId: string, leadId: string): Promise<void> {
    try {
      const { financeConfigured } = await import("./financeClient.js");
      if (!financeConfigured()) return;

      const { FinanceHandover } = await import("../models/FinanceHandover.js");

      /*
       * A snapshot, not a reference.
       *
       * What is delivered is what was true when the sale happened. If
       * somebody renames a course or reprices it tomorrow, the invoice that
       * goes out should still say what the client actually agreed to.
       * $setOnInsert below is what holds that: a row that exists keeps the
       * payload it was made with.
       */
      const payload = await this.buildHandoverPayload(studentId);
      if (!payload) return;

      await FinanceHandover.updateOne(
        { studentId },
        {
          $setOnInsert: {
            studentId,
            leadId,
            payload,
            // The organization every call about it goes to, from now on.
            academy: academyOf(payload.academy),
            status: "pending",
            nextAttemptAt: new Date(),
          },
        },
        { upsert: true },
      );

      // Out now, in the background; the worker's timer retries whatever this cannot send.
      const { kickFinanceHandover } = await import("./financeHandoverWorker.js");
      kickFinanceHandover();
    } catch (err) {
      console.error("[finance] could not queue the handover", err);
    }
  }

  /**
   * A counsellor's own enrolments, each with the state of its invoice.
   *
   * Three things live in three places: the enrolment here, the delivery in
   * the outbox, and the approval in finance. Somebody who wants to know
   * whether their sale went through had to be given a finance login and
   * told to go and look. This joins them so the question is answered where
   * it is asked.
   *
   * Finance is asked once for the whole page. When it cannot be reached the
   * rows still come back — without an approval state, which is the honest
   * answer rather than a wrong one.
   */
  async listEnrolments(filters: {
    mine?: string;
    userId: string;
    search?: string;
    state?: string;
    page?: string;
    limit?: string;
  }) {
    const { FinanceHandover } = await import("../models/FinanceHandover.js");
    const { fetchEnrolmentStatusesFor } = await import("./financeClient.js");

    const page  = Math.max(1, parseInt(filters.page ?? "1", 10));
    const limit = Math.min(100, parseInt(filters.limit ?? "20", 10));

    const query: Record<string, unknown> = {};
    if (filters.mine !== "false") query.assignedTo = filters.userId;
    // The "Sent back" tab: only what finance sent back, by what the outbox
    // last heard — the screen has asked for this all along; it was never applied.
    if (filters.state === "returned") {
      const sentBack = await FinanceHandover.find({ approvalState: "returned" }).select("studentId").lean();
      query._id = { $in: sentBack.map((h) => h.studentId) };
    }
    if (filters.search?.trim()) {
      const rx = new RegExp(filters.search.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      query.$or = [{ name: rx }, { email: rx }, { phone: rx }, { enrollmentNumber: rx }];
    }

    const [students, total] = await Promise.all([
      Student.find(query)
        .sort({ enrollmentDate: -1, createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("courses", "name amount")
        .populate("assignedTo", "name email")
        .populate("leadId", "name phone status")
        .lean(),
      Student.countDocuments(query),
    ]);

    const ids = students.map((s) => String(s._id));
    const handovers = await FinanceHandover.find({ studentId: { $in: ids } })
      .select("studentId status attempts lastError invoiceId invoiceNumber flags sentAt approvalState returnedReason returnedAt approvedAt resentAt resends")
      .lean();
    const byStudent = new Map(handovers.map((h) => [String(h.studentId), h]));

    const { stepsOf } = await import("./enrolmentSteps.js");
    // Each asked of the organization it was closed into: Dubai's and Bangalore's apart.
    const statuses = await fetchEnrolmentStatusesFor(students.map((s) => ({ id: String(s._id), academy: s.academy })));
    const byExternal = new Map(statuses.map((s) => [s.externalId, s]));

    const rows = students.map((s) => {
      const h = byStudent.get(String(s._id));
      const f = byExternal.get(String(s._id));
      return {
        ...s,
        handover: h
          ? {
              status: h.status,
              attempts: h.attempts,
              lastError: h.lastError ?? "",
              invoiceId: h.invoiceId ?? "",
              invoiceNumber: h.invoiceNumber ?? "",
              flags: h.flags ?? [],
              sentAt: h.sentAt ?? null,
              approvalState: h.approvalState ?? "unknown",
              returnedReason: h.returnedReason ?? "",
              returnedAt: h.returnedAt ?? null,
              // Sent again after a send-back: when last, and how many times.
              resentAt: h.resentAt ?? null,
              resends: h.resends ?? 0,
            }
          : null,
        // Absent rather than guessed when finance could not be reached.
        invoice: f ?? null,
        // Its five steps — finance, LMS, CS, onboarded, MT5 bonus — green / yellow / red on the card.
        steps: stepsOf(f ?? null, h ? { status: h.status, lastError: h.lastError, approvedAt: h.approvedAt, resentAt: h.resentAt } : null),
      };
    });

    const counts = {
      total,
      onThisPage: rows.length,
      approved: rows.filter((r) => r.invoice?.approval === "approved").length,
      pending: rows.filter((r) => r.invoice?.approval === "pending").length,
      // Not one already on its way back: finance still says "returned" until it arrives.
      returned: rows.filter((r) => (r.invoice?.approval ?? r.handover?.approvalState) === "returned"
        && !(r.handover?.status === "pending" && r.handover.resentAt)).length,
      notInvoiced: rows.filter((r) => !r.invoice).length,
      failed: rows.filter((r) => r.handover?.status === "failed").length,
      flagged: rows.filter((r) => (r.handover?.flags?.length ?? 0) > 0).length,
    };

    return { rows, counts, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
  }

  /**
   * One enrolment, for its own page: the student, what finance and the outbox
   * know of it, its five steps with who did each and when, and its commission
   * as the viewer may see it — their own lines; everyone's for a Super Admin
   * or the Sales Manager.
   *
   * The closer sees their own; anyone who may view students sees any.
   */
  async getEnrolment(id: string, viewer: { userId: string; role?: { isSystemRole?: boolean; roleName?: string; permissions?: Record<string, { view?: boolean } | undefined> } }) {
    const { FinanceHandover } = await import("../models/FinanceHandover.js");
    const { CommissionSale } = await import("../models/CommissionSale.js");
    const { fetchEnrolmentStatuses } = await import("./financeClient.js");
    const { stepsOf } = await import("./enrolmentSteps.js");
    const { isSuperAdmin, loadConfig } = await import("./commissionService.js");

    if (!Types.ObjectId.isValid(id)) throw createError("Enrolment not found", 404);
    const student = await Student.findById(id)
      .populate("courses", "name amount")
      .populate("assignedTo", "name email")
      .populate("team", "name")
      .lean();
    if (!student) throw createError("Enrolment not found", 404);
    const closer = student.assignedTo && typeof student.assignedTo === "object" && "_id" in student.assignedTo
      ? String((student.assignedTo as { _id: unknown })._id)
      : String(student.assignedTo ?? "");
    const all = isSuperAdmin(viewer.role as never) || viewer.role?.permissions?.students?.view === true;
    if (closer !== viewer.userId && !all) throw createError("This enrolment isn't yours", 403);

    const h = await FinanceHandover.findOne({ studentId: student._id })
      .select("status attempts lastError invoiceId invoiceNumber flags sentAt approvalState returnedReason returnedAt approvedAt resentAt resends")
      .lean();
    const [st] = await fetchEnrolmentStatuses([id], academyOf(student.academy));
    const sale = await CommissionSale.findOne({ student: student._id }).lean();
    const config = sale ? await loadConfig() : null;
    const everything = isSuperAdmin(viewer.role as never) || (config?.salesManager ? String(config.salesManager) === viewer.userId : false);

    return {
      ...student,
      handover: h
        ? {
            status: h.status, attempts: h.attempts, lastError: h.lastError ?? "", invoiceId: h.invoiceId ?? "",
            invoiceNumber: h.invoiceNumber ?? "", flags: h.flags ?? [], sentAt: h.sentAt ?? null,
            approvalState: h.approvalState ?? "unknown", returnedReason: h.returnedReason ?? "", returnedAt: h.returnedAt ?? null,
            approvedAt: h.approvedAt ?? null, resentAt: h.resentAt ?? null, resends: h.resends ?? 0,
          }
        : null,
      invoice: st ?? null,
      steps: stepsOf(st ?? null, h ? { status: h.status, lastError: h.lastError, approvedAt: h.approvedAt, resentAt: h.resentAt } : null),
      commission: sale
        ? {
            state: sale.state,
            reason: sale.reason,
            month: sale.month,
            countedAt: sale.countedAt ?? null,
            lines: (sale.lines ?? [])
              .filter((l) => everything || String(l.user) === viewer.userId)
              .map((l) => ({ role: l.role, userName: l.userName, amount: l.amount, note: l.note ?? "" })),
          }
        : null,
    };
  }

  /**
   * Send this enrolment to finance, or send it again.
   *
   * Delivered once is usually the end of it — except when finance sent it
   * back. Then the counsellor has corrected something and this is the
   * correction on its way, with a *fresh* payload built from the record as
   * it stands now: the queue row keeps the snapshot from the close, which
   * is right for a retry after a timeout and wrong for a resubmission — it
   * would redeliver the very figures somebody was just asked to fix.
   *
   * Finance recognises the same externalId on a returned invoice and
   * updates it rather than raising a second one, keeping its number.
   */
  async requestInvoice(studentId: string): Promise<{ queued: boolean; message: string }> {
    const { FinanceHandover } = await import("../models/FinanceHandover.js");
    const { financeConfigured } = await import("./financeClient.js");

    if (!financeConfigured()) {
      return { queued: false, message: "The finance integration is not configured" };
    }

    const student = await Student.findById(studentId).lean();
    if (!student) return { queued: false, message: "Enrolment not found" };
    // Said plainly rather than answered "queued": an enrolment with no course
    // has no line to invoice, and nothing would ever have gone out.
    if (!(student.courses ?? []).length) {
      return { queued: false, message: "This enrolment has no course, so there is nothing to invoice — add its course first" };
    }

    const existing = await FinanceHandover.findOne({ studentId }).lean();

    if (existing?.status === "sent") {
      if (!(await this.sendBackOf(studentId, existing, academyOf(student.academy))).sentBack) {
        return { queued: false, message: `Already invoiced as ${existing.invoiceNumber ?? "an invoice"}` };
      }
      if (!(await this.resendCorrected(studentId))) return { queued: false, message: "Enrolment not found" };
      return { queued: true, message: "Correction sent to finance" };
    }

    if (existing) {
      await FinanceHandover.updateOne(
        { studentId },
        { $set: { status: "pending", nextAttemptAt: new Date(), lastError: "" } },
      );
      return { queued: true, message: "Sending to finance again" };
    }

    await this.queueFinanceHandover(String(student._id), String(student.leadId ?? ""));
    return { queued: true, message: "Queued for finance" };
  }

  /**
   * Whether finance has this delivered enrolment sent back, and why — by what
   * the outbox last heard, or else by asking finance now: it may have been
   * sent back in the minute before the outbox next asks, and the screens, which
   * ask finance live, already offer the correction.
   */
  private async sendBackOf(
    studentId: string,
    h: { status?: string; approvalState?: string; returnedReason?: string } | null,
    academy: Academy,
  ): Promise<{ sentBack: boolean; reason: string }> {
    if (h?.status !== "sent") return { sentBack: false, reason: "" };
    if (h.approvalState === "returned") return { sentBack: true, reason: h.returnedReason ?? "" };
    // Decided already: an approved enrolment is not sent back, so finance isn't asked.
    if (h.approvalState === "approved" || h.approvalState === "not_required") return { sentBack: false, reason: "" };
    const { fetchEnrolmentStatuses } = await import("./financeClient.js");
    // Of the organization it was closed into.
    const [st] = await fetchEnrolmentStatuses([studentId], academy);
    return st?.approval === "returned" ? { sentBack: true, reason: st.returnedReason ?? "" } : { sentBack: false, reason: "" };
  }

  /**
   * Send a sent-back enrolment to finance again, as it stands now — with a
   * fresh payload, not the snapshot from the close, which would redeliver the
   * very figures somebody was just asked to fix. Finance updates the invoice it
   * sent back rather than raising another. Recorded as sent again (the user,
   * 2026-10-05: "if send again show that also"), and out at once. False when
   * the student, or every one of its courses, has gone.
   */
  private async resendCorrected(studentId: string): Promise<boolean> {
    const { FinanceHandover } = await import("../models/FinanceHandover.js");
    const payload = await this.buildHandoverPayload(studentId);
    if (!payload) return false;
    await FinanceHandover.updateOne(
      { studentId },
      {
        $set: {
          payload,
          // Unchanged — the academy is the close's — but said on rows from before it was kept.
          academy: academyOf(payload.academy),
          status: "pending",
          nextAttemptAt: new Date(),
          attempts: 0,
          lastError: "",
          approvalState: "pending",
          returnedReason: "",
          resentAt: new Date(),
        },
        $inc: { resends: 1 },
        $unset: { returnedNotifiedAt: "", returnedAt: "" },
      },
    );
    const { kickFinanceHandover } = await import("./financeHandoverWorker.js");
    kickFinanceHandover();
    return true;
  }

  // ── Correcting what finance sent back ────────────────────────────────────────

  /**
   * The enrolment, if this viewer may correct it: the closer their own; anyone
   * who may edit students — or a super admin — any, and only they may move a
   * sale to another counsellor or team (`mayMove`). (The routes ask for
   * Students → edit as well, as "Send again" always has here.)
   */
  private async correctable(id: string, viewer: { userId: string; role?: IRole | null }) {
    const { isSuperAdmin } = await import("./commissionService.js");
    if (!Types.ObjectId.isValid(id)) throw createError("Enrolment not found", 404);
    const student = await Student.findById(id);
    if (!student) throw createError("Enrolment not found", 404);
    const mayMove = isSuperAdmin(viewer.role) || viewer.role?.permissions?.students?.edit === true;
    if (String(student.assignedTo ?? "") !== viewer.userId && !mayMove) {
      throw createError("This enrolment isn't yours to correct", 403);
    }
    return { student, mayMove };
  }

  /** What the lead holds of its own, in fils: every payment on it but the ones the close recorded. */
  private async ownOnLead(leadId: unknown): Promise<number> {
    const lead = await Lead.findById(leadId).select("payments").lean();
    return (lead?.payments ?? []).filter((p) => !fromTheClose(p.note)).reduce((s, p) => s + minor(p.amount), 0);
  }

  /**
   * What the correction form starts from: the enrolment as it stands, whether
   * finance has it sent back and why, the money the lead holds of its own — a
   * payment of its own on the form, at that figure, as at the close — and, for
   * whoever may move a sale, the counsellors and teams it may move to.
   */
  async getCorrection(id: string, viewer: { userId: string; role?: IRole | null }) {
    const { FinanceHandover } = await import("../models/FinanceHandover.js");
    const { student, mayMove } = await this.correctable(id, viewer);
    const h = await FinanceHandover.findOne({ studentId: student._id }).lean();
    const academy = academyOf(student.academy);
    const { sentBack, reason } = await this.sendBackOf(id, h, academy);
    let options = {};
    if (mayMove) {
      const { Team } = await import("../models/Team.js");
      const { User } = await import("../models/User.js");
      const [counsellors, teams] = await Promise.all([
        User.find({ status: "active" }).select("name").sort({ name: 1 }).lean(),
        Team.find({ status: "active" }).select("name").sort({ name: 1 }).lean(),
      ]);
      options = { counsellors, teams };
    }
    return {
      sentBack,
      returnedReason: reason,
      invoiceNumber: h?.invoiceNumber ?? "",
      // What became of it otherwise: sent again, and when; approved or waiting.
      approvalState: h?.approvalState ?? "unknown",
      resentAt: h?.resentAt ?? null,
      resends: h?.resends ?? 0,
      mayMove,
      // Fixed at the close: the form shows it, and can't change it.
      academy,
      ownOnLead: (await this.ownOnLead(student.leadId)) / 100,
      ...options,
      student: await this.populateStudent(id),
    };
  }

  /**
   * Correct an enrolment finance sent back, and send it again — one step (the
   * user, 2026-10-05: "if send it back we can edit the course and amount, all
   * details"). Everything the close took can change: the client's name, phone
   * and email, the courses, the date, the fee, each payment with its receipt,
   * the language, the bonus and the notes — and who closed it and for which
   * team. Checked as a close is, then sent to finance as the correction of the
   * invoice it sent back: the same invoice, the same number.
   *
   * Only while finance has it sent back.
   */
  async correctEnrolment(
    id: string,
    data: EnrolmentCorrection,
    viewer: { userId: string; role?: IRole | null },
  ): Promise<{ student: unknown; message: string }> {
    const { FinanceHandover } = await import("../models/FinanceHandover.js");
    const { Team } = await import("../models/Team.js");
    const { User } = await import("../models/User.js");

    const { student, mayMove } = await this.correctable(id, viewer);
    const academy = academyOf(student.academy);

    const h = await FinanceHandover.findOne({ studentId: student._id }).lean();
    if (!(await this.sendBackOf(id, h, academy)).sentBack) {
      throw createError(
        "Finance hasn't sent this enrolment back, so there is nothing to correct. A change once it is approved goes through finance.",
        409,
      );
    }

    // Asked for all at once and refused as one list, as the close does.
    const name = String(data.name ?? "").trim();
    const phone = String(data.phone ?? "").trim();
    const email = String(data.email ?? "").trim().toLowerCase();
    const courseIds = [...new Set((data.courses ?? []).filter(Boolean).map(String))];
    const enrolledOn = data.enrollmentDate ? new Date(data.enrollmentDate) : null;
    const totalFee = data.totalFee === "" || data.totalFee === null ? NaN : Number(data.totalFee);
    const paidAmount = Number(data.paidAmount ?? NaN);
    const missing: string[] = [];
    if (!name) missing.push("the client's name");
    if (!phone) missing.push("the client's phone");
    if (!isEmail(email)) missing.push("the client's email");
    if (courseIds.length === 0 || !courseIds.every((c) => Types.ObjectId.isValid(c))) missing.push("a course");
    if (!enrolledOn || Number.isNaN(enrolledOn.getTime())) missing.push("the enrolment date");
    if (!Number.isFinite(totalFee) || totalFee < 0) missing.push("the fee");
    if (!Number.isFinite(paidAmount) || paidAmount < 0) missing.push("what was paid");
    if (!ENROLMENT_LANGUAGES.includes(data.language as EnrolmentLanguage)) missing.push("language");
    if (typeof data.hasBonus !== "boolean") missing.push("whether a bonus was given");
    else if (data.hasBonus && !isBonusAmount(data.bonusAmount)) missing.push("the bonus amount");
    if (missing.length) throw createError(`A correction needs ${missing.join(", ")}.`, 422);
    // The academy is the close's, for good (the user, 2026-10-10): a correction shows it and never moves it.
    if (data.academy !== undefined && data.academy !== null && data.academy !== "" && data.academy !== academy) {
      throw createError(
        `This enrolment was closed for ${ACADEMY_LABELS[academy]} — a correction can't move it to another academy.`,
        422,
      );
    }

    const courses = await Course.find({ _id: { $in: courseIds } }).select("name").lean();
    if (courses.length !== courseIds.length) throw createError("A course on it no longer exists — choose again.", 422);
    if (academy === "bangalore") await assertBangaloreReady(courseIds);
    // In the order they were chosen, for the lead's payment notes.
    const soldAs = courseIds.map((c) => courses.find((x) => String(x._id) === c)?.name ?? "").filter(Boolean).join(", ");

    // Who closed it, and for which team: kept unless somebody who may edit
    // students moves it.
    const idOrNull = (v: unknown) => (typeof v === "string" && v ? v : null);
    const team = data.team === undefined ? String(student.team ?? "") || null : idOrNull(data.team);
    const closer = data.assignedTo === undefined ? String(student.assignedTo ?? "") || null : idOrNull(data.assignedTo);
    if ((team ?? "") !== String(student.team ?? "") || (closer ?? "") !== String(student.assignedTo ?? "")) {
      if (!mayMove) throw createError("Only someone who may edit students can move a sale to another counsellor or team.", 403);
      if (team && (!Types.ObjectId.isValid(team) || !(await Team.exists({ _id: team })))) {
        throw createError("That team no longer exists — choose another.", 422);
      }
      if (closer && (!Types.ObjectId.isValid(closer) || !(await User.exists({ _id: closer })))) {
        throw createError("That counsellor no longer exists — choose another.", 422);
      }
    }

    const payments = checkedPayments(data.payments, paidAmount, enrolledOn!, academy);
    if (!payments) throw createError("A correction needs its payments, each with its method, amount and receipt.", 422);

    /*
     * The money the lead held of its own — every payment on it but the ones the
     * close recorded — is a payment of its own here, as at the close, and at
     * what it comes to now: the close's own payments on the lead are about to
     * be replaced by these, and the two must not count the same money twice
     * or lose any.
     */
    const own = await this.ownOnLead(student.leadId);
    const ownRows = payments.filter((p) => p.collectedBefore);
    if (ownRows.length > 1) throw createError("Only one payment can be the money already on the lead.", 422);
    if (own > 0 && !ownRows.length) {
      throw createError(
        `This lead already holds ${money(own / 100)} of its own — it stays as a payment of its own, with its method and receipt.`,
        422,
      );
    }
    // The lead's own money is what it was recorded as — in a Bangalore close,
    // the AED handed over when the payment says so, its INR worked out at a rate.
    if (ownRows.length && minor(ownFigure(ownRows[0]!)) !== own) {
      throw createError(
        `The lead's own payments come to ${money(own / 100)} now, not ${money(ownFigure(ownRows[0]!))} — they changed while this was open. Close the correction and open it again.`,
        409,
      );
    }

    student.set({
      name,
      phone,
      email,
      courses: courseIds,
      team,
      assignedTo: closer,
      enrollmentDate: enrolledOn,
      totalFee,
      paidAmount,
      pendingAmount: Math.max(0, totalFee - paidAmount),
      feeStatus: this.computeFeeStatus(totalFee, paidAmount, data.feeStatus),
      ...(typeof data.notes === "string" ? { notes: data.notes } : {}),
      language: data.language,
      // The first payment's, for whatever reads only one; every one below.
      paymentMethod: payments[0]!.method,
      paymentReceipt: payments[0]!.receipt,
      payments,
      hasBonus: data.hasBonus,
      bonusAmount: data.hasBonus ? Number(data.bonusAmount) : 0,
    });
    await student.save();

    // An email the lead never had is kept there too, as at the close.
    await this.fillLeadEmail(String(student.leadId), email, viewer.userId);

    /*
     * The lead's payment list follows: what the close recorded there is
     * replaced by the payments as corrected, so the lead and the enrolment
     * keep counting the same money — the lead's own payments are left as they
     * are. Not worth failing the correction over; it says so instead.
     *
     * Not for a Bangalore close: its payments are INR, and the lead's payment
     * list — what the dashboards and reports add up — is AED, so a Bangalore
     * close records none there (the close dialog adds none) and its correction
     * leaves the list as it is.
     */
    let leadNote = "";
    if (academy !== "bangalore") {
      try {
        const lead = await Lead.findById(student.leadId).select("payments").lean();
        if (lead) {
          const kept = (lead.payments ?? []).filter((p) => !fromTheClose(p.note));
          const taken = payments.filter((p) => !p.collectedBefore).map((p) => ({
            amount: p.amount,
            note: `Collected at enrolment${soldAs ? ` — ${soldAs}` : ""} · ${PAYMENT_METHOD_LABELS[p.method] ?? p.method}`,
            paidAt: p.paidAt,
            addedBy: new Types.ObjectId(viewer.userId),
          }));
          await Lead.updateOne({ _id: lead._id }, { $set: { payments: [...kept, ...taken] } });
        }
      } catch (err) {
        console.error(`[enrolments] could not bring the lead's payments in line with corrected enrolment ${id}`, err);
        leadNote = " The lead's own payment list could not be updated — check it on the lead.";
      }
    }

    if (!(await this.resendCorrected(id))) {
      throw createError("This enrolment has no course, so there is nothing to invoice — add its course first", 409);
    }
    return { student: await this.populateStudent(id), message: `Corrected and sent to finance.${leadNote}` };
  }

  // ── Delete ───────────────────────────────────────────────────────────────────

  async deleteStudent(id: string) {
    const student = await Student.findByIdAndDelete(id);
    if (!student) throw createError("Student not found", 404);
    return { deleted: String(student._id) };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  private computeFeeStatus(total: number, paid: number, override?: string): "paid" | "partial" | "pending" {
    if (override && ["paid", "partial", "pending"].includes(override)) return override as "paid" | "partial" | "pending";
    if (total <= 0 || paid <= 0) return "pending";
    if (paid >= total) return "paid";
    return "partial";
  }

  private populateStudent(id: string) {
    return Student.findById(id)
      // With the Bangalore price, for a Bangalore enrolment's fee to follow its course.
      .populate("courses",    "name amount bangalore")
      .populate("team",       "name")
      .populate("assignedTo", "name email designation")
      .populate("leadId",     "name phone status")
      .lean();
  }
}
