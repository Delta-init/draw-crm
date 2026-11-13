import { Lead } from "../models/Lead.js";
import { PAYMENT_METHOD_LABELS, RUPEE_METHODS, isRupeeMethod, type EnrolmentPaymentMethod } from "../types/index.js";

/*
 * The money actually received on each enrolment, payment by payment, with the day it came in (the user, 2026-10-31:
 * "that month collected payment only count" — for the closing book's Collected and for commission, a payment counts
 * in the month it was received, and never in another).
 *
 * In the enrolment's own currency, so it can be set against its fee:
 *   - a Dubai close: the lead's payments in AED, as every revenue figure counts them (utils/countedPayments.ts) —
 *     taken before the close, at it, and balance payments once finance approves them;
 *   - a Bangalore close: the rupees taken at the close (the enrolment's own list, those already on the lead before
 *     it left out), and its balance payments in rupees on the lead once approved.
 */

/**
 * `amount` in the enrolment's own currency (set against its fee).
 *
 * `inr` (the user, 2026-11-13: "INR payment only gets commission in INR"): the client handed it over in rupees — so
 * that share of the sale's commission is earned at the course's rupee amount (commissionService splitByCurrency).
 * Only where that was said: INR Transfer as the method, or a payment typed in INR with its rate at the close; never
 * guessed. A Bangalore close's payments are rupees unless taken in AED cash.
 *
 * Razorpay pays out in rupees (the owner, 2026-11-13): wherever INR Transfer is named here, Razorpay is taken the
 * same — both asked of RUPEE_METHODS (types/index.ts).
 */
export type Collection = { paidAt: Date; amount: number; inr?: boolean };

/** A method as the close writes it in its note on the lead ("… · INR Transfer"). */
const labelOf = (method?: string) => (method ? PAYMENT_METHOD_LABELS[method as EnrolmentPaymentMethod] ?? method : "");
/** The rupee methods as such a note names them: "INR Transfer", "Razorpay". */
const RUPEE_LABELS = RUPEE_METHODS.map((m) => labelOf(m));

type StudentLike = {
  _id: unknown;
  leadId?: unknown;
  academy?: string;
  enrollmentDate?: Date;
  /** `currency` + `amountInCurrency`: handed over in the other currency — "INR" on a Dubai close, "AED" (cash) on a Bangalore one. */
  payments?: { amount?: number; paidAt?: Date; collectedBefore?: boolean; method?: string; currency?: string; amountInCurrency?: number }[];
};
type LeadPayment = {
  amount: number; paidAt: Date; currency?: string; method?: string; note?: string;
  finance?: { externalId?: string; state?: string; method?: string } | null;
};

const counts = (p: LeadPayment) => !p.finance?.externalId || p.finance.state === "approved";

/**
 * Which of a Dubai enrolment's payments on the lead were rupees. A balance payment says so by the method it was sent
 * to finance with, one added on the lead by its own method. One the close put there ("Collected at enrolment —
 * <courses> · <method>") names its method — on the row since 2026-10-23, in its note always (a correction rewrites
 * the rows with the note alone) — but never its currency: it is rupees when it is one of the close's own rupee
 * payments (INR Transfer, or typed in INR with its rate under any method), matched by its amount and method — each
 * once, so a cash payment of the same amount beside it stays dirhams — or when the method it names is INR Transfer.
 * A row that names no method (an older one) is matched by its amount alone.
 */
function rupeeMarker(s: StudentLike): (p: LeadPayment) => boolean {
  const left = (s.payments ?? [])
    .filter((p) => !p.collectedBefore && (isRupeeMethod(p.method) || p.currency === "INR"))
    .map((p) => ({ amount: p.amount ?? 0, method: labelOf(p.method) }));
  return (p) => {
    if (isRupeeMethod(p.finance?.method)) return true;
    if (!/^Collected at enrolment\b/.test(p.note ?? "")) return isRupeeMethod(p.method);
    const said = p.method ? labelOf(p.method) : (/·\s*([^·]+?)\s*$/.exec(p.note ?? "")?.[1] ?? "");
    const i = left.findIndex((c) => Math.abs(c.amount - p.amount) < 0.005 && (!said || c.method === said));
    if (i >= 0) { left.splice(i, 1); return true; }
    return RUPEE_LABELS.includes(said);
  };
}

/** Each enrolment's payments received, oldest first, by student id. */
export async function collectionsOf(students: StudentLike[]): Promise<Map<string, Collection[]>> {
  const leads = await Lead.find({ _id: { $in: students.map((s) => s.leadId).filter(Boolean) } })
    .select("payments.amount payments.paidAt payments.currency payments.finance payments.method payments.note")
    .lean<{ _id: unknown; payments?: LeadPayment[] }[]>();
  const paysOf = new Map(leads.map((l) => [String(l._id), l.payments ?? []]));
  const out = new Map<string, Collection[]>();
  for (const s of students) {
    const pays = paysOf.get(String(s.leadId)) ?? [];
    const rupees = rupeeMarker(s);
    const list: Collection[] =
      s.academy === "bangalore"
        ? [
            ...(s.payments ?? [])
              .filter((p) => !p.collectedBefore && (p.amount ?? 0) > 0)
              .map((p) => {
                // Rupees, unless taken in AED cash (kept as currency "AED" with its AED; `amount` is then its rupees).
                const aedCash = p.currency === "AED" && (p.amountInCurrency ?? 0) > 0;
                return { paidAt: new Date(p.paidAt ?? s.enrollmentDate ?? 0), amount: p.amount ?? 0, ...(aedCash ? {} : { inr: true }) };
              }),
            ...pays.filter((p) => p.currency === "INR" && counts(p) && p.amount > 0).map((p) => ({ paidAt: new Date(p.paidAt), amount: p.amount, inr: true })),
          ]
        : pays.filter((p) => p.currency !== "INR" && counts(p) && p.amount > 0)
          .map((p) => ({ paidAt: new Date(p.paidAt), amount: p.amount, ...(rupees(p) ? { inr: true } : {}) }));
    out.set(String(s._id), list.sort((a, b) => a.paidAt.getTime() - b.paidAt.getTime()));
  }
  return out;
}

/** What came in between two instants (inclusive). */
export const collectedBetween = (list: Collection[] | undefined, from: Date, to: Date): number =>
  Math.round((list ?? []).filter((c) => c.paidAt >= from && c.paidAt <= to).reduce((s, c) => s + c.amount, 0) * 100) / 100;
