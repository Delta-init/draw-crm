import type { User } from "@/types";
import type { Course } from "@/types/course";
import type { Team } from "@/types/team";
import type { InitialLeadResponse, PrimaryConcern, FollowupStrategyType } from "@/types/lead";

export type StudentStatus  = "active" | "inactive" | "graduated" | "dropped";
export type FeeStatus      = "paid" | "partial" | "pending";

/** Same list finance's own schema accepts, so a closing here reaches the
    outbox in a shape finance will not refuse. */
export const ENROLMENT_LANGUAGES = ["English", "Malayalam", "Hindi/Urdu", "Tamil"] as const;
export type EnrolmentLanguage = (typeof ENROLMENT_LANGUAGES)[number];

export const ENROLMENT_PAYMENT_METHODS = [
  "cash", "bank_transfer", "cheque", "card", "easebuzz_emi", "tabby", "tamara", "billexpro",
] as const;
export type EnrolmentPaymentMethod = (typeof ENROLMENT_PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABELS: Record<EnrolmentPaymentMethod, string> = {
  cash: "Cash", bank_transfer: "Bank Transfer", cheque: "Cheque", card: "Card",
  easebuzz_emi: "Easebuzz EMI", tabby: "Tabby", tamara: "Tamara", billexpro: "BillExPro",
};

export interface Student {
  _id: string;
  enrollmentNumber: string;
  name: string;
  phone?: string;
  email?: string;
  courses?: (Course | string)[] | null;
  team?:   Team   | string | null;
  assignedTo?: User | string | null;
  leadId?: { _id: string; name: string; phone?: string; status: string } | string | null;

  initialLeadResponse?:  InitialLeadResponse  | null;
  primaryConcern?:       PrimaryConcern        | null;
  followupStrategyType?: FollowupStrategyType  | null;
  demoScheduled: boolean;
  demoAttended:  boolean;
  firstContactTime?: string | null;
  lastFollowupDate?: string | null;

  enrollmentDate: string;
  feeStatus:      FeeStatus;
  totalFee:       number;
  paidAmount:     number;
  pendingAmount:  number;
  status:         StudentStatus;
  language?: EnrolmentLanguage;
  paymentMethod?: EnrolmentPaymentMethod;
  /** Taken at the close, and required there. Absent on older enrolments. */
  paymentReceipt?: StoredReceipt | null;
  /** Each payment taken at the close, when the client paid in more than one way. Absent on older enrolments. */
  payments?: StudentPayment[];
  notes?: string;
  /** Whether a bonus was given at the close. Absent on enrolments from before it was asked. */
  hasBonus?: boolean | null;
  /** The bonus, in the fee's currency; 0 when none. Never part of the balance. */
  bonusAmount?: number;
  createdAt: string;
  updatedAt: string;
}

/** A receipt, once it is in storage. */
export interface StoredReceipt {
  name: string;
  url: string;
  key: string;
  size?: number;
  mimeType?: string;
}

/** What the outbox knows: whether the enrolment reached finance at all. */
export interface Handover {
  status: "pending" | "sent" | "failed";
  attempts: number;
  lastError: string;
  invoiceId: string;
  invoiceNumber: string;
  flags: string[];
  sentAt: string | null;
  approvalState: "pending" | "approved" | "returned" | "not_required" | "unknown";
  returnedReason: string;
  returnedAt: string | null;
  /** When it was last sent again after a send-back, and how many times; absent from a server from before. */
  resentAt?: string | null;
  resends?: number;
}

/** What finance knows: whether anybody has approved it. Null when finance
    could not be reached — different from "nobody has looked yet". */
export interface InvoiceState {
  externalId: string;
  invoiceId: string;
  invoiceNumber: string;
  status: string;
  approval: "pending" | "approved" | "returned" | "not_required";
  returnedReason: string;
  issueDate: string;
  currency: string;
  totalMinor: number;
  amountPaidMinor: number;
  balanceMinor: number;
  /** Once approved, what the Delta LMS made of the student. Null before; absent from a finance that did not say. */
  lms?: EnrolmentLms | null;
  /** …and who looks after them in Tetra Commission: their code, CS and CS team. */
  commission?: EnrolmentCommission | null;
}

/** Whether the LMS took the student — a new account or theirs — and on which courses, or why not yet. */
export interface EnrolmentLms {
  state: "created" | "existing" | "waiting" | "unmapped" | "failed";
  detail?: string;
  courses: string[];
}

/** Whether they went on to Tetra Commission, and who looks after them there (asked of it live unless `live` is false). */
export interface EnrolmentCommission {
  state: "sent" | "waiting" | "skipped" | "failed" | "not_sent";
  detail?: string;
  code?: string;
  /** Their CS; "" while they wait in Delta Open Students. */
  cs?: string;
  team?: string;
  live?: boolean;
  /** Their welcome went (Tetra Commission onboarded them); absent when it couldn't be asked. */
  onboarded?: { done: boolean; at?: string; by?: string };
  /** The MT5 bonus promised at the close, and its broker-admin approval ("none": no bonus, nothing to approve). */
  bonus?: { state: "none" | "not_requested" | "pending" | "approved" | "rejected" | "unknown"; amount?: number; currency?: string; at?: string; by?: string; reason?: string };
}

/**
 * One of an enrolment's five steps after the close — finance approved, LMS
 * account, CS assigned, onboarded, MT5 bonus — as the server works them out.
 * done green, waiting yellow, failed red; unknown and skipped grey.
 */
export interface EnrolmentStep {
  key: "finance" | "lms" | "cs" | "onboarded" | "bonus";
  label: string;
  state: "done" | "waiting" | "failed" | "unknown" | "skipped";
  detail?: string;
  at?: string;
  by?: string;
}

export interface Enrolment extends Student {
  handover: Handover | null;
  invoice: InvoiceState | null;
  /** Its five steps; absent from a server from before they were shown. */
  steps?: EnrolmentStep[];
}

/** One enrolment, for its own page: its steps, and its commission as the viewer may see it. */
export interface EnrolmentDetail extends Enrolment {
  commission: {
    state: "progress" | "counted" | "waiting" | "excluded" | "reversed";
    reason: string;
    month: string;
    countedAt: string | null;
    lines: { role: "sales" | "tl" | "sm"; userName: string; amount: number; note: string }[];
  } | null;
}

/**
 * What correcting a sent-back enrolment starts from: the enrolment, whether
 * finance has it sent back and why, the money the lead holds of its own (a
 * payment of its own on the form, at that figure), and — for whoever may move
 * a sale — the counsellors and teams.
 */
export interface EnrolmentCorrectionStart {
  sentBack: boolean;
  returnedReason: string;
  invoiceNumber: string;
  /** What the outbox last heard, and when it was last sent again — for the student page. */
  approvalState?: Handover["approvalState"];
  resentAt?: string | null;
  resends?: number;
  mayMove: boolean;
  ownOnLead: number;
  counsellors?: { _id: string; name: string }[];
  teams?: { _id: string; name: string }[];
  student: Student;
}

/** Everything a close took, sent again as the correction. */
export interface EnrolmentCorrectionInput {
  name: string;
  phone: string;
  email: string;
  courses: string[];
  team?: string | null;
  assignedTo?: string | null;
  enrollmentDate: string;
  feeStatus: string;
  totalFee: number;
  paidAmount: number;
  notes: string;
  language: string;
  payments: { method: string; amount: number; receipt: StoredReceipt | null; paidAt: string; collectedBefore?: boolean }[];
  hasBonus: boolean;
  bonusAmount: number;
}

export interface EnrolmentCounts {
  total: number;
  onThisPage: number;
  approved: number;
  pending: number;
  returned: number;
  notInvoiced: number;
  failed: number;
  flagged: number;
}

export interface StudentFilters {
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
  page?: number;
  limit?: number;
}

export interface CreateStudentInput {
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
  status?: StudentStatus;
  feeStatus?: FeeStatus;
  totalFee?: number;
  paidAmount?: number;
  notes?: string;
  language?: string;
  paymentMethod?: string;
  paymentReceipt?: StoredReceipt | null;
  /** Each payment taken now (and the money already on the lead, as one). They add up to paidAmount. */
  payments?: StudentPayment[];
  hasBonus?: boolean;
  bonusAmount?: number;
}

/**
 * One payment taken at the close — a client may pay part in cash and part by
 * card, each with its own receipt. They add up to the enrolment's paidAmount.
 */
export interface StudentPayment {
  method: string;
  amount: number;
  receipt: StoredReceipt;
  paidAt: string;
  /** The money already on the lead before the close, as one payment. */
  collectedBefore?: boolean;
}
