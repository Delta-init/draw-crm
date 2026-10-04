import { Types } from "mongoose";
import { z } from "zod";
import { Student } from "../models/Student.js";
import { Lead } from "../models/Lead.js";
import { Course } from "../models/Course.js";
import type { IStudent, EnrolmentLanguage, EnrolmentPaymentMethod } from "../types/index.js";
import { ENROLMENT_LANGUAGES, ENROLMENT_PAYMENT_METHODS } from "../types/index.js";

function createError(msg: string, status: number) {
  return Object.assign(new Error(msg), { statusCode: status });
}

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
    hasBonus?: boolean;
    bonusAmount?: number;
  }, performedBy?: string) {
    const existing = await Student.findOne({ leadId: data.leadId });
    if (existing) throw createError("A student already exists for this lead", 409);

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
    if (!ENROLMENT_PAYMENT_METHODS.includes(data.paymentMethod as EnrolmentPaymentMethod)) {
      missing.push("payment method");
    }
    if (!data.paymentReceipt?.key || !data.paymentReceipt.url) missing.push("payment receipt");
    // Yes or no, every time — and a yes is only an answer with its amount.
    if (typeof data.hasBonus !== "boolean") missing.push("whether a bonus was given");
    else if (data.hasBonus && !isBonusAmount(data.bonusAmount)) missing.push("the bonus amount");
    if (missing.length) {
      throw createError(
        `A closing needs ${missing.join(", ")}. Pick the course, give the client's email, upload the receipt, choose the language and payment method, and say whether a bonus was given, then close again.`,
        422,
      );
    }

    const enrollmentNumber = await nextEnrollmentNumber();
    const totalFee   = data.totalFee   ?? 0;
    const paidAmount = data.paidAmount ?? 0;

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
      enrollmentDate:   data.enrollmentDate  ? new Date(data.enrollmentDate) : new Date(),
      feeStatus:    this.computeFeeStatus(totalFee, paidAmount, data.feeStatus),
      totalFee,
      paidAmount,
      pendingAmount: Math.max(0, totalFee - paidAmount),
      notes: data.notes,
      language: data.language,
      paymentMethod: data.paymentMethod,
      paymentReceipt: data.paymentReceipt
        ? { ...data.paymentReceipt, uploadedAt: new Date() }
        : undefined,
      hasBonus: data.hasBonus,
      bonusAmount: data.hasBonus ? Number(data.bonusAmount) : 0,
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
      .populate("courses",    "name amount")
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
      .populate("courses", "name amount financeItemId lmsCourseSlug lmsCourseSlugs")
      .populate("assignedTo", "name email")
      .lean();
    if (!student) return null;

    const courseDocs = ((student.courses ?? []) as unknown as {
      name?: string; amount?: number; financeItemId?: string | null; lmsCourseSlug?: string; lmsCourseSlugs?: string[];
    }[]).filter(Boolean);
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
    page?: string;
    limit?: string;
  }) {
    const { FinanceHandover } = await import("../models/FinanceHandover.js");
    const { fetchEnrolmentStatuses } = await import("./financeClient.js");

    const page  = Math.max(1, parseInt(filters.page ?? "1", 10));
    const limit = Math.min(100, parseInt(filters.limit ?? "20", 10));

    const query: Record<string, unknown> = {};
    if (filters.mine !== "false") query.assignedTo = filters.userId;
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
      .select("studentId status attempts lastError invoiceId invoiceNumber flags sentAt approvalState returnedReason returnedAt approvedAt")
      .lean();
    const byStudent = new Map(handovers.map((h) => [String(h.studentId), h]));

    const { stepsOf } = await import("./enrolmentSteps.js");
    const statuses = await fetchEnrolmentStatuses(ids);
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
            }
          : null,
        // Absent rather than guessed when finance could not be reached.
        invoice: f ?? null,
        // Its five steps — finance, LMS, CS, onboarded, MT5 bonus — green / yellow / red on the card.
        steps: stepsOf(f ?? null, h ? { status: h.status, lastError: h.lastError, approvedAt: h.approvedAt } : null),
      };
    });

    const counts = {
      total,
      onThisPage: rows.length,
      approved: rows.filter((r) => r.invoice?.approval === "approved").length,
      pending: rows.filter((r) => r.invoice?.approval === "pending").length,
      returned: rows.filter((r) => (r.invoice?.approval ?? r.handover?.approvalState) === "returned").length,
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
      .select("status attempts lastError invoiceId invoiceNumber flags sentAt approvalState returnedReason returnedAt approvedAt")
      .lean();
    const [st] = await fetchEnrolmentStatuses([id]);
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
            approvedAt: h.approvedAt ?? null,
          }
        : null,
      invoice: st ?? null,
      steps: stepsOf(st ?? null, h ? { status: h.status, lastError: h.lastError, approvedAt: h.approvedAt } : null),
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

    if (existing?.status === "sent" && existing.approvalState !== "returned") {
      return { queued: false, message: `Already invoiced as ${existing.invoiceNumber ?? "an invoice"}` };
    }

    if (existing?.status === "sent" && existing.approvalState === "returned") {
      const payload = await this.buildHandoverPayload(studentId);
      if (!payload) return { queued: false, message: "Enrolment not found" };
      await FinanceHandover.updateOne(
        { studentId },
        {
          $set: {
            payload,
            status: "pending",
            nextAttemptAt: new Date(),
            attempts: 0,
            lastError: "",
            approvalState: "pending",
            returnedReason: "",
          },
          $unset: { returnedNotifiedAt: "", returnedAt: "" },
        },
      );
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
      .populate("courses",    "name amount")
      .populate("team",       "name")
      .populate("assignedTo", "name email designation")
      .populate("leadId",     "name phone status")
      .lean();
  }
}
