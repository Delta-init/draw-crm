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
  notes?: string;
  createdAt: string;
  updatedAt: string;
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
}

export interface Enrolment extends Student {
  handover: Handover | null;
  invoice: InvoiceState | null;
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
}
