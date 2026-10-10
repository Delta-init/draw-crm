"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  GraduationCap, X, User2, Phone, Mail, BookOpen,
  Calendar, DollarSign, StickyNote, CheckCircle2, Gift, MapPin,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { fmtUSD } from "@/lib/currency";
import {
  ENROLMENT_LANGUAGES, PAYMENT_METHOD_LABELS,
  type EnrolmentLanguage, type EnrolmentPaymentMethod,
} from "@/types/student";
import { useCreateStudent, useUpdateStudent } from "@/hooks/useStudents";
import { useAllCourses, useBangaloreOffered } from "@/hooks/useCourses";
import { useAddPayment } from "@/hooks/usePayments";
import { CommissionPreview } from "@/components/commission/CommissionPreview";
import { PaymentRowsEditor, missingInRows, newPaymentRow, rowAedFields, rowAmount, rowsForAcademy, type PaymentRow } from "@/components/students/PaymentRowsEditor";
import { AcademyBadge } from "@/components/students/AcademyBadge";
import { ACADEMIES, ACADEMY_LABELS, academyOf, bangalorePriceOf, fmtFee, priceFor, type Academy } from "@/lib/academy";
import type { Lead } from "@/types/lead";
import type { Course } from "@/types/course";
import type { FeeStatus, Student, StoredReceipt } from "@/types/student";

interface Props {
  open: boolean;
  lead: Lead;
  /**
   * The enrolment this lead already has, when it has one.
   *
   * Closing a lead that was closed before is not a mistake — somebody moved it
   * to follow-up and back, and wants to see the enrolment again. Shown and
   * editable here rather than skipped, so a second close does not look like
   * nothing happened at all.
   */
  existingStudent?: Student | null;
  /** "2 of 5" when this is one of several leads being closed together. */
  progress?: string;
  /** Dismissed: the lead keeps the status it had. */
  onClose: () => void;
  onCreated: () => void;
}

/** The shape the lead model itself accepts; finance's own check is stricter still. */
const EMAIL_RE = /^\S+@\S+\.\S+$/;

/** The populated courses on a lead or an enrolment — ids on their own are no use here. */
const courseObjects = (list?: (Course | string)[] | null): Course[] =>
  (list ?? []).filter((c): c is Course => typeof c === "object" && c !== null);

/** The courses' list prices added up, as the academy sells them. */
const sumOf = (list: Course[], academy: Academy = "dubai") => list.reduce((s, c) => s + priceFor(c, academy), 0);
/** The bonus the courses come with, added up — what a new close starts from. */
const bonusOf = (list: Course[]) => list.reduce((s, c) => s + (c.bonusAmount ?? 0), 0);

export function CreateStudentModal({ open, lead, existingStudent, progress, onClose, onCreated }: Props) {
  const editing = Boolean(existingStudent);

  /*
   * The course already named — on the enrolment when there is one, else on
   * the lead, picked during the sale. A close is one course, as in the other
   * sales CRMs (the user, 2026-10-09): a lead naming several is asked which
   * one was sold. An enrolment from before, with several, keeps them.
   */
  const studentCourses = courseObjects(existingStudent?.courses);
  const leadCourses = courseObjects(lead.courses);
  const knownCourses = studentCourses.length ? studentCourses : leadCourses.length === 1 ? leadCourses : [];
  const severalOnLead = !studentCourses.length && leadCourses.length > 1;

  // Only needed when nothing is named, which is the only time the list shows.
  const { data: courses = [], isLoading: coursesLoading } = useAllCourses();
  const [courseIds, setCourseIds] = useState<string[]>([]);
  // The course as the list has it when it can — with its Bangalore price — else as the lead named it.
  const pickedCourses = (knownCourses.length ? knownCourses : courses.filter((c) => courseIds.includes(c._id)))
    .map((c) => courses.find((x) => x._id === c._id) ?? c);

  /*
   * Which academy (the user, 2026-10-10): Dubai, in AED as before, or
   * Bangalore, in INR — the fee starts from the course's Bangalore price, the
   * payments are in rupees (cash taken in AED at a rate), and it goes to the
   * Bangalore finance organization. Chosen at the close, fixed after it.
   */
  const [academy, setAcademy] = useState<Academy>(editing ? academyOf(existingStudent?.academy) : "dubai");
  const bangalore = academy === "bangalore";
  // Offered only when the server says it takes Bangalore closes; otherwise no choice — Dubai, as before.
  const { data: bangaloreOffered = false } = useBangaloreOffered(!editing);
  const fee = (n: number) => fmtFee(n, academy);

  /*
   * The fee, and it can be argued with.
   *
   * Seeded from what the enrolment already stores, else the price agreed on
   * the lead, else the courses' list prices added up — an enrolment created
   * before a course was picked has a fee of zero, and showing that beside a
   * course priced at 5,200 makes every figure under it wrong. Editable
   * because the price on the brochure is not always the price that was agreed.
   */
  const [feeInput, setFeeInput] = useState(
    String(existingStudent?.totalFee || lead.sellingAmount || sumOf(knownCourses) || ""),
  );
  const totalFee = Number(feeInput) || 0;

  /*
   * Switching academy switches the money: the fee to the course's price in
   * that academy (Bangalore's in INR — the price agreed on the lead is AED),
   * and the payments to that currency.
   */
  function pickAcademy(next: Academy) {
    if (next === academy) return;
    setAcademy(next);
    const listed = sumOf(pickedCourses, next);
    setFeeInput(next === "bangalore" ? (listed > 0 ? String(listed) : "") : String(lead.sellingAmount || listed || ""));
    setPaymentRows((rows) => rowsForAcademy(rows, next));
  }

  function pickCourse(id: string) {
    const next = id ? [id] : [];
    setCourseIds(next);
    // The fee follows what was just chosen, rather than leaving the old
    // number under another course.
    const listed = sumOf(courses.filter((c) => next.includes(c._id)), academy);
    if (listed > 0) setFeeInput(String(listed));
    // So does the bonus they come with, until the seller has answered it.
    if (!editing && !bonusTouched) {
      const bonus = bonusOf(courses.filter((c) => next.includes(c._id)));
      setBonusChoice(bonus > 0 ? "yes" : "");
      setBonusInput(bonus > 0 ? String(bonus) : "");
    }
  }

  /** What was collected before today, from the payments already on the lead (AED: the lead's own list is). */
  const alreadyPaid = (lead.payments ?? []).reduce((s, p) => s + p.amount, 0);
  /*
   * A new close takes each payment as a row — method, amount and receipt, a
   * client may pay part in cash and part by card (PaymentRowsEditor) — with
   * what the lead already holds as the first, at the amount it had when this
   * opened: the payments this close then adds to the lead must not count
   * twice. Editing an enrolment keeps the one "collected now" figure.
   */
  const [paymentRows, setPaymentRows] = useState<PaymentRow[]>(() =>
    alreadyPaid > 0 ? [newPaymentRow({ collectedBefore: true, amountInput: String(alreadyPaid) })] : [newPaymentRow()],
  );
  const [paidNowInput, setPaidNowInput] = useState("");
  const paidNow = editing
    ? Math.max(0, Number(paidNowInput) || 0)
    : paymentRows.filter((r) => !r.collectedBefore).reduce((s, r) => s + rowAmount(r), 0);
  /*
   * A Bangalore enrolment's money is INR and never on the lead's (AED) list,
   * so editing one adds to what it already says was paid, and records nothing
   * on the lead.
   */
  const paidBefore = editing && bangalore ? existingStudent?.paidAmount ?? 0 : alreadyPaid;
  const paidAmount = editing ? paidBefore + paidNow : paymentRows.reduce((s, r) => s + rowAmount(r), 0);
  const pending = Math.max(0, totalFee - paidAmount);
  /** Collected more than the fee: taken (the owner, 2026-10-06) and said so in amber, not refused. */
  const overFee = Math.round(paidAmount * 100) > Math.round(totalFee * 100);
  const overBy = Math.max(0, paidAmount - totalFee);
  const uploading = paymentRows.some((r) => r.uploading);

  const computedFeeStatus: FeeStatus =
    totalFee <= 0 || paidAmount <= 0 ? "pending"
    : paidAmount >= totalFee         ? "paid"
    :                                  "partial";

  const [notes, setNotes] = useState(existingStudent?.notes ?? "");
  const [enrollmentDate, setEnrollmentDate] = useState(
    (existingStudent?.enrollmentDate ?? new Date().toISOString()).slice(0, 10),
  );
  const [feeStatus, setFeeStatus] = useState<FeeStatus>(existingStudent?.feeStatus ?? computedFeeStatus);
  const [feeStatusTouched, setFeeStatusTouched] = useState(false);
  // Follows the numbers until somebody sets it by hand, then stays put.
  const effectiveFeeStatus = feeStatusTouched ? feeStatus : computedFeeStatus;

  const createMut = useCreateStudent();
  const updateMut = useUpdateStudent();
  const addPayment = useAddPayment(lead._id);
  const saving = createMut.isPending || updateMut.isPending || addPayment.isPending;

  // An enrolment with no course bills nothing — it was saved and then never
  // reached finance at all. Where the lead never named one it is chosen here.
  const courseMissing = pickedCourses.length === 0;
  // A Bangalore close needs the course's Bangalore price: the server refuses one without.
  const unpriced = bangalore && !coursesLoading ? pickedCourses.filter((c) => bangalorePriceOf(c) === null) : [];

  /*
   * The client's email, asked for only when the lead has none that works.
   * Finance refuses an enrolment without one, so a close without it failed
   * there, out of sight. Kept on the lead too once saved.
   */
  const leadEmail = (lead.email ?? "").trim();
  const leadEmailOk = EMAIL_RE.test(leadEmail);
  const askEmail = !editing && !leadEmailOk;
  const [emailInput, setEmailInput] = useState(leadEmailOk ? "" : leadEmail);
  const email = leadEmailOk ? leadEmail : emailInput.trim();
  const emailMissing = askEmail && !EMAIL_RE.test(email);

  /*
   * What a close cannot be made without, because finance needs it: what the
   * courses are taught in, how the money was taken and proof that it was.
   *
   * Only for a new close. Editing an enrolment made before these existed must
   * not be blocked on filling in what nobody was asked for at the time.
   */
  const [language, setLanguage] = useState<EnrolmentLanguage | "">(existingStudent?.language ?? "");

  /*
   * Whether a bonus was given, and how much.
   *
   * Asked at every close — yes or no, with the amount when yes — because the
   * people who approve, teach and mentor this client all need to know what was
   * promised. Beside the money, never in it: the balance above is the fee less
   * what was paid, whatever the bonus. An enrolment from before this was asked
   * starts unanswered, and can be answered here.
   *
   * A new close starts from the bonus its courses come with (set on the
   * Courses page): yes, with that amount, until the seller answers otherwise.
   * An enrolment being edited keeps what it has.
   */
  const coursesBonus = editing ? 0 : bonusOf(knownCourses);
  const [bonusChoice, setBonusChoice] = useState<"" | "yes" | "no">(
    existingStudent?.hasBonus === true ? "yes"
    : existingStudent?.hasBonus === false ? "no"
    : coursesBonus > 0 ? "yes" : "",
  );
  const [bonusInput, setBonusInput] = useState(
    existingStudent?.hasBonus ? String(existingStudent.bonusAmount || "")
    : coursesBonus > 0 ? String(coursesBonus) : "",
  );
  const [bonusTouched, setBonusTouched] = useState(false);
  /** The bonus shown is the courses' own, not one the seller set. */
  const bonusFromCourses = !editing && !bonusTouched && bonusChoice === "yes" && bonusOf(pickedCourses) > 0;
  const bonusAmount = Math.max(0, Number(bonusInput) || 0);
  // At least one fils: finance refuses a bonus that rounds to nothing.
  const bonusAmountMissing = bonusChoice === "yes" && !(Math.round(bonusAmount * 100) > 0);
  /** Only what was answered is sent: unanswered stays unanswered, not "no". */
  const bonusFields = bonusChoice
    ? { hasBonus: bonusChoice === "yes", bonusAmount: bonusChoice === "yes" ? bonusAmount : 0 }
    : {};

  const missing = editing
    ? [courseMissing && "a course", bonusAmountMissing && "the bonus amount"].filter(Boolean) as string[]
    : [
        courseMissing && "a course",
        unpriced.length > 0 && `a Bangalore price for ${unpriced.map((c) => c.name).join(", ")}`,
        emailMissing && "the client's email",
        !language && "language",
        ...missingInRows(paymentRows),
        !bonusChoice && "whether a bonus was given",
        bonusAmountMissing && "the bonus amount",
      ].filter(Boolean) as string[];

  function toIST(iso?: string | null) {
    if (!iso) return null;
    return new Date(iso).toLocaleString("en-AE", {
      timeZone: "Asia/Dubai", day: "2-digit", month: "short",
      year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true,
    }) + " GST";
  }

  async function handleCreate() {
    /*
     * The money is recorded on the lead, not just on the enrolment.
     *
     * The lead's payment list is where the CRM already counts what a client
     * has handed over, and it is what the fee summary above reads. Writing the
     * figure only onto the student would leave two records of the same money
     * that drift apart the moment anybody adds a payment the ordinary way.
     *
     * Done before the enrolment is saved: a payment that failed to record is
     * worth stopping for, whereas one recorded against an enrolment that then
     * failed can be finished by hand.
     */
    const soldAs = pickedCourses.length ? ` — ${pickedCourses.map((c) => c.name).join(", ")}` : "";
    if (editing && paidNow > 0 && !bangalore) {
      await addPayment.mutateAsync({
        amount: paidNow,
        note: `Collected at enrolment${soldAs}`,
        paidAt: new Date(enrollmentDate).toISOString(),
      });
      // Counted once: a second press after a failed save must not add it again.
      setPaidNowInput("");
    }
    // Each payment taken now, one by one, saying how it was paid. One that an
    // attempt already recorded before failing is not recorded again. Not for a
    // Bangalore close: its payments are INR, the lead's list is AED.
    if (!editing && !bangalore) {
      for (const row of paymentRows) {
        if (row.collectedBefore || row.addedToLead) continue;
        await addPayment.mutateAsync({
          amount: rowAmount(row),
          note: `Collected at enrolment${soldAs} · ${PAYMENT_METHOD_LABELS[row.method as EnrolmentPaymentMethod] ?? row.method}`,
          paidAt: new Date(enrollmentDate).toISOString(),
        });
        setPaymentRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, addedToLead: true } : r)));
      }
    }

    if (editing && existingStudent) {
      // The enrolment exists; this is the second visit to it. Only the fields
      // this dialog actually owns are sent, so nothing recorded elsewhere is
      // overwritten by a stale copy of the lead.
      await updateMut.mutateAsync({
        id: existingStudent._id,
        data: {
          courses: pickedCourses.map((c) => c._id),
          enrollmentDate: new Date(enrollmentDate).toISOString(),
          feeStatus: effectiveFeeStatus,
          totalFee,
          paidAmount,
          notes: notes || undefined,
          ...bonusFields,
        },
      });
      onCreated();
      return;
    }

    await createMut.mutateAsync({
      language: language || undefined,
      // The first payment's, for whatever reads only one; every one below.
      paymentMethod: (paymentRows[0]?.method || undefined) as EnrolmentPaymentMethod | undefined,
      paymentReceipt: paymentRows[0]?.receipt,
      payments: paymentRows.map((r) => ({
        method: r.method,
        amount: rowAmount(r),
        receipt: r.receipt as StoredReceipt,
        paidAt: new Date(enrollmentDate).toISOString(),
        ...(r.collectedBefore ? { collectedBefore: true } : {}),
        ...(bangalore ? rowAedFields(r) : {}),
      })),
      academy,
      leadId: lead._id,
      name:   lead.name,
      phone:  lead.phone ?? undefined,
      email:  email || undefined,
      courses: pickedCourses.map((c) => c._id),
      team:   lead.team
        ? typeof lead.team === "object" ? (lead.team as { _id: string })._id : lead.team
        : null,
      assignedTo: lead.assignedTo
        ? typeof lead.assignedTo === "object" ? (lead.assignedTo as { _id: string })._id : lead.assignedTo
        : null,
      initialLeadResponse:  lead.initialLeadResponse  ?? null,
      primaryConcern:       lead.primaryConcern        ?? null,
      followupStrategyType: lead.followupStrategyType  ?? null,
      demoScheduled:    lead.demoScheduled  ?? false,
      demoAttended:     lead.demoAttended   ?? false,
      firstContactTime: lead.firstContactTime  ?? null,
      lastFollowupDate: lead.lastFollowupDate  ?? null,
      enrollmentDate: new Date(enrollmentDate).toISOString(),
      feeStatus: effectiveFeeStatus,
      totalFee,
      paidAmount,
      notes: notes || undefined,
      ...bonusFields,
    });
    onCreated();
  }

  const assignedName = lead.assignedTo
    ? typeof lead.assignedTo === "object"
      ? (lead.assignedTo as { name: string }).name
      : lead.assignedTo
    : null;

  const courseLine = knownCourses.length
    ? pickedCourses.map((c) => {
        const listed = priceFor(c, academy);
        return `${c.name}${listed ? ` · ${fee(listed)}` : bangalore ? " · no Bangalore price" : ""}`;
      }).join(", ")
    : null;

  // Whose sale it is, for the commission it earns: the enrolment's own team
  // and counsellor once it has them, the lead's before.
  const idOf = (v: unknown) =>
    v ? (typeof v === "object" ? (v as { _id: string })._id : String(v)) : null;
  const saleTeamId = idOf(existingStudent?.team) ?? idOf(lead.team);
  const closerId = idOf(existingStudent?.assignedTo) ?? idOf(lead.assignedTo);

  return (
    <AnimatePresence>
      {open && (
        <Dialog open={open} onOpenChange={onClose}>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto p-0 gap-0">
            {/* Header */}
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-border/50 bg-card px-5 py-4"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/10">
                  <GraduationCap className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <DialogHeader>
                    <DialogTitle className="text-base font-bold">{editing ? "Enrolment" : "Create Student Profile"}</DialogTitle>
                  </DialogHeader>
                  <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span>
                      {lead.name} · {editing ? `Enrolled ${existingStudent?.enrollmentNumber ?? ""}`.trim() : "Closing the lead"}
                      {progress ? ` · ${progress}` : ""}
                    </span>
                    {/* Fixed at the close: shown, not chosen again. */}
                    {editing && <AcademyBadge academy={academy} />}
                  </p>
                </div>
              </div>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={onClose}>
                <X className="h-4 w-4" />
              </Button>
            </motion.div>

            <div className="px-5 py-4 space-y-5">
              {/* Personal details strip */}
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Personal Details</p>
                <div className="rounded-xl border border-border/50 bg-muted/20 divide-y divide-border/30">
                  {[
                    { icon: User2, label: "Name",    value: lead.name },
                    { icon: Phone, label: "Phone",   value: lead.phone },
                    { icon: Mail,  label: "Email",   value: askEmail ? null : (leadEmail || existingStudent?.email) },
                    { icon: BookOpen, label: knownCourses.length > 1 ? "Courses" : "Course", value: courseLine },
                    { icon: User2, label: "Counsellor", value: assignedName },
                  ].filter((r) => r.value).map(({ icon: Icon, label, value }) => (
                    <div key={label} className="flex items-center gap-3 px-3 py-2.5">
                      <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="text-[11px] text-muted-foreground w-20 shrink-0">{label}</span>
                      {/* min-w-0, or a long course name widens the whole dialog
                          past its edge. The courses wrap rather than truncate:
                          a bundle's second course is the one that would be cut. */}
                      <span className={cn(
                        "min-w-0 flex-1 text-xs font-medium text-foreground",
                        label.startsWith("Course") ? "line-clamp-3 break-words" : "truncate",
                      )}>{value}</span>
                    </div>
                  ))}
                  {/* Asked here, where it would have shown, when the lead has
                      none that works — finance cannot invoice without it. */}
                  {askEmail && (
                    <div className="flex items-start gap-3 px-3 py-2">
                      <Mail className="mt-2 h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="mt-1.5 text-[11px] text-muted-foreground w-20 shrink-0">Email *</span>
                      <div className="flex-1 space-y-1">
                        <Input
                          type="email" value={emailInput}
                          onChange={(e) => setEmailInput(e.target.value)}
                          placeholder="client@example.com" className="h-8 text-xs"
                          aria-label="Client email"
                        />
                        <p className={cn("text-[10px]", emailMissing && emailInput ? "text-amber-400" : "text-muted-foreground")}>
                          {emailMissing && emailInput
                            ? "That is not an email address finance will take."
                            : "This lead has no email. Finance needs one for the invoice; it is saved on the lead too."}
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </motion.div>

              {/* Lead insight badges */}
              {(lead.initialLeadResponse || lead.primaryConcern || lead.followupStrategyType ||
                lead.demoScheduled || lead.firstContactTime || lead.lastFollowupDate) && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Lead Insights</p>
                  <div className="flex flex-wrap gap-2 rounded-xl border border-border/50 bg-muted/20 p-3">
                    {lead.initialLeadResponse && (
                      <span className="inline-flex items-center rounded-full bg-violet-500/10 border border-violet-500/20 px-2.5 py-1 text-[10px] font-medium text-violet-400">
                        {lead.initialLeadResponse.replace(/_/g, " ")}
                      </span>
                    )}
                    {lead.primaryConcern && (
                      <span className="inline-flex items-center rounded-full bg-amber-500/10 border border-amber-500/20 px-2.5 py-1 text-[10px] font-medium text-amber-400">
                        Concern: {lead.primaryConcern.replace(/_/g, " ")}
                      </span>
                    )}
                    {lead.followupStrategyType && (
                      <span className="inline-flex items-center rounded-full bg-sky-500/10 border border-sky-500/20 px-2.5 py-1 text-[10px] font-medium text-sky-400">
                        {lead.followupStrategyType.replace(/_/g, " ")}
                      </span>
                    )}
                    {lead.demoScheduled && (
                      <span className="inline-flex items-center rounded-full bg-violet-500/10 border border-violet-500/20 px-2.5 py-1 text-[10px] font-medium text-violet-400">
                        Demo {lead.demoAttended ? "Attended" : "Scheduled"}
                      </span>
                    )}
                    {lead.firstContactTime && (
                      <span className="text-[10px] text-muted-foreground">1st contact: {toIST(lead.firstContactTime)}</span>
                    )}
                  </div>
                </motion.div>
              )}

              {/* Which academy — chosen here, at the close, and fixed after it. Only
                  where the server takes Bangalore closes; elsewhere every close is Dubai. */}
              {!editing && (bangaloreOffered || bangalore) && (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.11 }} className="space-y-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                    <MapPin className="h-3 w-3" /> Academy *
                  </p>
                  <div className="flex items-center gap-2" role="radiogroup" aria-label="Academy">
                    {ACADEMIES.map((a) => (
                      <button
                        key={a}
                        type="button"
                        role="radio"
                        aria-checked={academy === a}
                        onClick={() => pickAcademy(a)}
                        className={cn(
                          "h-8 rounded-md border px-3 text-xs font-medium transition-colors",
                          academy === a
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border/60 text-muted-foreground hover:border-primary/40 hover:text-foreground",
                        )}
                      >
                        {ACADEMY_LABELS[a]}{a === "bangalore" ? " · ₹" : ""}
                      </button>
                    ))}
                  </div>
                  {bangalore && (
                    <p className="text-[10px] text-muted-foreground">
                      In rupees: the fee is the course&apos;s Bangalore price, payments in ₹ (cash taken in AED at its rate), billed by the Bangalore finance team.
                    </p>
                  )}
                  {unpriced.length > 0 && (
                    <p className="text-[10px] text-amber-400">
                      {unpriced.map((c) => c.name).join(", ")} {unpriced.length > 1 ? "have" : "has"} no Bangalore price yet — set it under Courses → Map, or close it as Dubai.
                    </p>
                  )}
                </motion.div>
              )}

              {/* Fee section */}
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 }}>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Fee Summary</p>
                <div className="rounded-xl border border-border/50 bg-muted/20 p-3 space-y-2">
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-lg bg-card p-2 border border-border/30">
                      <p className="text-sm font-bold text-foreground">{fee(totalFee)}</p>
                      <p className="text-[10px] text-muted-foreground">Total Fee</p>
                    </div>
                    <div className="rounded-lg bg-card p-2 border border-border/30">
                      <p className="text-sm font-bold text-green-400">{fee(paidAmount)}</p>
                      <p className="text-[10px] text-muted-foreground">Paid</p>
                    </div>
                    <div className="rounded-lg bg-card p-2 border border-border/30">
                      <p className={cn("text-sm font-bold", pending > 0 ? "text-amber-400" : "text-green-400")}>{fee(pending)}</p>
                      <p className="text-[10px] text-muted-foreground">Balance</p>
                    </div>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    Balance = total fee − paid. A bonus is never part of it.
                  </p>
                  <div className={cn("grid gap-2", editing ? "grid-cols-2" : "grid-cols-1")}>
                    <div className="space-y-1">
                      <p className="text-[11px] text-muted-foreground">Total fee{bangalore ? " (₹)" : ""}</p>
                      <Input
                        type="number" min="0" step="0.01" value={feeInput}
                        onChange={(e) => setFeeInput(e.target.value)}
                        placeholder="0" className="h-8 text-xs"
                      />
                    </div>
                    {/* A new close takes its payments one by one, below. */}
                    {editing && (
                      <div className="space-y-1">
                        <p className="text-[11px] text-muted-foreground">
                          Collected now{paidBefore > 0 ? ` · ${fee(paidBefore)} already` : ""}
                        </p>
                        <Input
                          type="number" min="0" step="0.01" value={paidNowInput}
                          onChange={(e) => setPaidNowInput(e.target.value)}
                          placeholder="0" className="h-8 text-xs"
                        />
                      </div>
                    )}
                  </div>
                  {/* What is collected here becomes a payment on the lead, so
                      the money is recorded in one place rather than two that
                      can disagree. */}
                  {paidNow > 0 && (
                    <p className="text-[10px] text-muted-foreground">
                      {bangalore
                        ? `${fee(paidNow)} stays on the enrolment — in rupees, so not added to the lead's payments (they're in AED).`
                        : `${fee(paidNow)} will be added to this lead's payments.`}
                    </p>
                  )}
                  {overFee && (
                    <p className="text-[11px] font-medium text-amber-400">
                      Collected ({fee(paidAmount)}) is {fee(overBy)} more than the fee ({fee(totalFee)}) — fine if it was taken: it goes to finance as collected.
                    </p>
                  )}
                  {totalFee > 0 && (
                    <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                      <motion.div
                        className="h-full rounded-full bg-green-500"
                        initial={{ width: 0 }}
                        animate={{ width: `${Math.min(100, (paidAmount / totalFee) * 100)}%` }}
                        transition={{ delay: 0.3, duration: 0.6 }}
                      />
                    </div>
                  )}

                  {/* The bonus: asked, answered, and kept beside the money. */}
                  <div className="space-y-1.5 border-t border-border/30 pt-2">
                    <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                      <Gift className="h-3 w-3" /> Bonus given?{!editing && " *"}
                    </p>
                    <div className="flex items-center gap-2">
                      {(["no", "yes"] as const).map((choice) => (
                        <button
                          key={choice}
                          type="button"
                          onClick={() => { setBonusChoice(choice); setBonusTouched(true); }}
                          className={cn(
                            "h-8 rounded-md border px-3 text-xs font-medium transition-colors",
                            bonusChoice === choice
                              ? "border-primary bg-primary/10 text-primary"
                              : "border-border/60 text-muted-foreground hover:border-primary/40 hover:text-foreground",
                          )}
                        >
                          {choice === "yes" ? "Yes" : "No"}
                        </button>
                      ))}
                      <AnimatePresence>
                        {bonusChoice === "yes" && (
                          <motion.div
                            initial={{ opacity: 0, x: -6 }}
                            animate={{ opacity: 1, x: 0 }}
                            exit={{ opacity: 0, x: -6 }}
                            className="flex-1"
                          >
                            <Input
                              type="number" min="0" step="0.01" value={bonusInput}
                              onChange={(e) => { setBonusInput(e.target.value); setBonusTouched(true); }}
                              placeholder="Bonus amount (USD $)" className="h-8 text-xs"
                              aria-label="Bonus amount"
                            />
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                    {bonusFromCourses && (
                      <p className="text-[10px] text-primary">
                        From the course{pickedCourses.length > 1 ? "s" : ""} — change it if this sale differs.
                      </p>
                    )}
                    {/* Where the answer goes. After the close an edit stays in
                        the CRM: finance only takes a changed enrolment when it
                        has sent it back to be corrected. */}
                    {bonusChoice && (
                      <p className="text-[10px] text-muted-foreground">
                        {editing
                          ? "Saved here. Finance sees a change only if it sends this enrolment back for correction."
                          : bonusChoice === "yes"
                            ? `${bonusAmount > 0 ? fmtUSD(bonusAmount) : "The"} bonus goes to finance with the enrolment, and on to the LMS — outside the fee and balance.`
                            : "No bonus — recorded as such with the enrolment."}
                      </p>
                    )}
                  </div>
                </div>
              </motion.div>

              {/* What this sale earns the counsellor, by the commission plan. */}
              <CommissionPreview courseIds={pickedCourses.map((c) => c._id)} teamId={saleTeamId} closerId={closerId} />

              {/* Editable fields */}
              <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className="space-y-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Enrollment</p>

                {/* Only when nothing names a course. One that does shows it in
                    the details strip above; asking again there would be two
                    answers to the same question. One course a close, as in the
                    other sales CRMs. */}
                {!knownCourses.length && (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <BookOpen className="h-3 w-3" /> Course *
                    </p>
                    <Select value={courseIds[0] ?? ""} onValueChange={pickCourse} disabled={coursesLoading}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder={coursesLoading ? "Loading courses…" : "Select a course"} />
                      </SelectTrigger>
                      <SelectContent>
                        {(severalOnLead ? leadCourses : courses).map((c) => (
                          <SelectItem key={c._id} value={c._id} className="text-xs">
                            {c.name}{priceFor(c, academy) ? ` · ${fee(priceFor(c, academy))}` : bangalore ? " · no Bangalore price" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {severalOnLead && !courseIds.length && (
                      <p className="text-[10px] text-amber-400">
                        This lead names {leadCourses.length} courses. A close is one — pick the one sold.
                      </p>
                    )}
                    {courseMissing && !coursesLoading && !severalOnLead && (
                      <p className="text-[10px] text-amber-400">
                        This lead has no course. Pick one — the fee and the invoice come from it.
                      </p>
                    )}
                  </div>
                )}

                {/* What finance is given about the sale: what it is taught in,
                    and how it was paid for — each payment with its receipt. */}
                {!editing && (
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground">Language *</p>
                    <Select value={language} onValueChange={(v) => setLanguage(v as EnrolmentLanguage)}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Taught in…" />
                      </SelectTrigger>
                      <SelectContent>
                        {ENROLMENT_LANGUAGES.map((l) => (
                          <SelectItem key={l} value={l} className="text-xs">{l}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}

                {!editing && (
                  <div className="space-y-1.5">
                    <p className="text-xs text-muted-foreground">
                      Payments * <span className="text-[10px]">— one for each way the client paid, each with its receipt</span>
                    </p>
                    <PaymentRowsEditor leadId={lead._id} rows={paymentRows} onChange={setPaymentRows} academy={academy} />
                    {bangalore && (
                      <p className="text-[10px] text-muted-foreground">
                        In ₹. These stay on the enrolment and go to finance — they aren&apos;t added to the lead&apos;s payments, which are in AED.
                      </p>
                    )}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Calendar className="h-3 w-3" /> Enrollment Date
                    </p>
                    <Input
                      type="date"
                      value={enrollmentDate}
                      onChange={(e) => setEnrollmentDate(e.target.value)}
                      className="h-8 text-xs [color-scheme:dark]"
                    />
                  </div>
                  <div className="space-y-1">
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <DollarSign className="h-3 w-3" /> Fee Status
                    </p>
                    <Select value={effectiveFeeStatus} onValueChange={(v) => { setFeeStatus(v as FeeStatus); setFeeStatusTouched(true); }}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="paid"    className="text-xs"><span className="text-green-400">Paid</span></SelectItem>
                        <SelectItem value="partial" className="text-xs"><span className="text-amber-400">Partial</span></SelectItem>
                        <SelectItem value="pending" className="text-xs"><span className="text-muted-foreground">Pending</span></SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <StickyNote className="h-3 w-3" /> Notes (optional)
                  </p>
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Any additional notes about the student…"
                    className="resize-none text-xs min-h-[64px]"
                    rows={2}
                  />
                </div>
              </motion.div>
            </div>

            {/* Footer */}
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2 }}
              /*
               * No "skip". Closing a lead used to be reachable without filling
               * in the enrolment — the lead moved to "closed" anyway, with no
               * student record behind it, which is a sale nobody downstream
               * (finance, the LMS) can ever be told about. Cancelling still
               * works, by the ✕ or the backdrop; it leaves the lead exactly
               * where it was, which is the one thing a cancel should do.
               */
              className="sticky bottom-0 flex items-center justify-between gap-3 border-t border-border/50 bg-card px-5 py-3"
            >
              {/* Named rather than left to a greyed-out button: a control that
                  will not respond and does not say why is the worst of both. */}
              <span className={cn("text-[11px]", !missing.length && overFee ? "text-amber-400" : "text-muted-foreground")}>
                {missing.length
                  ? `Still needed: ${missing.join(", ")}.`
                  : overFee
                    ? `Collected is ${fee(overBy)} more than the fee — it goes to finance as collected.`
                    : editing
                      ? "Changes apply to this enrolment."
                      : "Saving closes the lead and sends it to finance for approval."}
              </span>
              <motion.div whileTap={{ scale: 0.97 }} className="shrink-0">
                <Button
                  size="sm"
                  className="gap-2"
                  // A failed save has already said why, in its own toast.
                  onClick={() => void handleCreate().catch(() => undefined)}
                  disabled={saving || missing.length > 0 || uploading}
                >
                  {saving ? (
                    <span className="flex items-center gap-1.5"><span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" /> {editing ? "Saving…" : "Creating…"}</span>
                  ) : (
                    <><CheckCircle2 className="h-4 w-4" /> {editing ? "Save enrolment" : "Create Student"}</>
                  )}
                </Button>
              </motion.div>
            </motion.div>
          </DialogContent>
        </Dialog>
      )}
    </AnimatePresence>
  );
}
