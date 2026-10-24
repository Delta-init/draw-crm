import type { Request } from "express";
import type { Document, Types } from "mongoose";
import type { DisplayCurrency } from "../utils/currencies.js";

// ─── Permission Actions ────────────────────────────────────────────────────────
export type PermissionAction = "view" | "create" | "edit" | "delete" | "approve" | "export";

export interface ModulePermissions {
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  approve: boolean;
  export: boolean;
}

// All available modules in the CRM
export const CRM_MODULES = [
  "dashboard",
  "users",
  "roles",
  "leads",
  "teams",
  "courses",
  "reminders",
  "reports",
  "settings",
  "students",
  "tracker",
  /*
   * Screens that were open to everyone with no row on the Roles screen to
   * change it (the owner, 2026-10-07). Mentors: view the calendar, create a
   * booking, edit one, delete (cancel) one.
   */
  "mentors",
  "commission",
  "leaderboard",
  // My Pay: the salary slabs (salaryService) — open to everyone, as in the Sales CRM.
  "pay",
  /*
   * Calls: the 3CX calls with leads (lead_calls) — view the Calls page, export
   * its CSV. Open to everyone by default; each sees only their own calls, their
   * team's or everyone's (leadCallService).
   */
  "calls",
  /*
   * Balance payments (2026-10-13): part-paid closes, each person's own, a team
   * leader's teams', everyone's for a Super Admin or the Sales Manager. View sees
   * the page, create records a payment for finance. Open by default.
   */
  "balancePayments",
  /*
   * Activity (2026-10-15, as in the Sales CRM): who is here, sign-ins, idle
   * alerts, and the HRMS shift and clock-ins (the Attendance tab). View only.
   * Not open by default — the Super Admin's, until given.
   */
  "activity",
  /*
   * Inactive leads (2026-10-16, as in the Sales CRM): view the page, edit to
   * move leads on. Not open by default — the Super Admin's, until given.
   */
  "inactive-leads",
] as const;

export type CrmModule = (typeof CRM_MODULES)[number];

/**
 * What a role holds on a module it has never been given a value for — today's
 * access for the screens that were open to everyone, so a role saved before
 * these rows existed keeps them until someone unticks the box. Every other
 * module starts with nothing.
 */
export const OPEN_BY_DEFAULT: Partial<Record<CrmModule, Partial<ModulePermissions>>> = {
  mentors: { view: true, create: true, edit: true, delete: true },
  commission: { view: true },
  leaderboard: { view: true },
  pay: { view: true },
  // My Tracker was open to everyone here; its row was never on the Roles screen.
  tracker: { view: true, edit: true },
  // The Calls page was open to everyone with Leads (2026-10-12: 3CX calls, scoped per person).
  calls: { view: true, export: true },
  balancePayments: { view: true, create: true },
};

export type PermissionsMap = {
  [K in CrmModule]?: ModulePermissions;
};

// ─── Role ─────────────────────────────────────────────────────────────────────
export interface IRole extends Document {
  _id: Types.ObjectId;
  roleName: string;
  description?: string;
  permissions: PermissionsMap;
  isSystemRole: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ─── User ─────────────────────────────────────────────────────────────────────
export interface IUser extends Document {
  _id: Types.ObjectId;
  name: string;
  email: string;
  /** The currency they see amounts in (Settings → Currency), on every device; null when never picked. */
  currency?: DisplayCurrency | null;
  /** When it was picked. */
  currencyAt?: Date | null;
  password: string;
  role: Types.ObjectId | IRole;
  designation?: string;
  extension?: string;        // 3CX phone extension number e.g. "101"
  /** Where the extension came from: typed on the Users screen ("manual", never overwritten) or 3CX's users by email. */
  extensionSource?: "manual" | "3cx" | null;
  breakSince?: Date | null;     // on a break since ("Take break", 2026-10-20, as in the Sales CRM)
  breakKind?: BreakKind | null; // what the break is for
  status: "active" | "inactive";
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidatePassword: string): Promise<boolean>;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
export interface JwtPayload {
  userId: string;
  email: string;
  roleId: string;
  /** Only on a super admin's "View as" pass: the session it belongs to and who started it. */
  impersonation?: { id: string; by: string };
}

export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    email: string;
    roleId: string;
    role?: IRole;
    /** Set while a super admin is viewing the CRM as this user (view only). */
    impersonatedBy?: { id: string; name: string; email: string; sessionId: string };
  };
}

// ─── API Response ─────────────────────────────────────────────────────────────
export interface ApiResponse<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
  errors?: unknown;
  pagination?: PaginationMeta;
}

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface PaginationQuery {
  page?: string;
  limit?: string;
  search?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  status?: string;
  role?: string;
  isSystemRole?: string;
  team?: string;
}

// ─── Team ─────────────────────────────────────────────────────────────────────
export interface ITeamSettings {
  autoAssign: boolean;
  splitMode: "round_robin" | "equal_load";
  roundRobinIndex: number;
  includedMembers: Types.Array<Types.ObjectId | IUser>;
  splitTime?: string | null;           // "HH:mm" AED/GST, e.g. "09:00"
  roundRobinStartDate?: Date | null;   // count leads from this date for fair round-robin
  lastSplitAt?: Date | null;           // cron dedup — last time scheduled split ran
}

export interface IAbsentToday {
  userId: Types.ObjectId | IUser;
  date: Date;  // midnight UTC of the AED calendar day
}

export interface ITeam extends Document {
  _id: Types.ObjectId;
  name: string;
  description?: string;
  leaders: Types.Array<Types.ObjectId | IUser>;
  members: Types.Array<Types.ObjectId | IUser>;
  status: "active" | "inactive";
  inactiveMembers: Types.Array<Types.ObjectId | IUser>;
  absentToday: Types.Array<IAbsentToday>;
  settings: ITeamSettings;
  createdAt: Date;
  updatedAt: Date;
}

export interface TeamFilters {
  search?: string;
  status?: string;
  page?: string;
  limit?: string;
}

// ─── Course ───────────────────────────────────────────────────────────────────
export interface ICourse extends Document {
  _id: Types.ObjectId;
  name: string;
  description?: string;
  amount: number;
  /** The bonus a client gets with it, in the amount's currency; 0 for none. A new close starts from it. */
  bonusAmount?: number;
  status: "active" | "inactive";
  /** The finance catalogue item this course bills against, once mapped. */
  financeItemId?: string | null;
  /** Which course this is in the LMS, for provisioning a student on approval — the first of `lmsCourseSlugs`. */
  lmsCourseSlug?: string;
  /** Every LMS course it opens, in order (a bundle opens more than one). */
  lmsCourseSlugs?: string[];
  /** Selling it for the Bangalore academy: its INR price, finance item there, and LMS courses (none = the Dubai ones). */
  bangalore?: ICourseBangalore;
  /** What selling it earns (AED per approved sale) — set on the Commission plan. */
  commission?: ICourseCommission;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A course as the Bangalore academy sells it. No price means it can't be
 * closed for Bangalore. No LMS courses of its own means the Dubai ones — the
 * Forex courses are shared between the academies.
 */
export interface ICourseBangalore {
  /** In INR; null (or 0) when it has none. */
  price?: number | null;
  /** The item in the Bangalore finance organization's catalogue. */
  financeItemId?: string | null;
  lmsCourseSlugs?: string[];
}

// ─── Commission ───────────────────────────────────────────────────────────────
/** One course's row of the commission plan: AED per approved sale, by role. */
export interface ICourseCommission {
  sales: number;
  tl: number;
  sm: number;
  /** The MT5 credit (USD) the course comes with — shown beside the plan, earns nobody anything. */
  creditUsd: number;
  updatedAt?: Date;
  updatedBy?: Types.ObjectId;
}

export type CommissionRole = "sales" | "tl" | "sm";

/**
 * Where a sale's commission stands.
 *  progress  its five steps aren't all done yet (finance, LMS, CS, onboarded,
 *            MT5 bonus) — `reason` says which it waits on
 *  counted   its lines are final: who earns what, as approved
 *  waiting   approved, but who earns it is not settled yet (a team with no
 *            leader or two, a closer in no team, no Sales Manager set) —
 *            settled by itself once that is fixed
 *  excluded  closed under a login excluded from commission; nobody earns it
 *  reversed  finance voided the invoice; it no longer counts
 */
export type CommissionSaleState = "progress" | "counted" | "waiting" | "excluded" | "reversed";

export interface ICommissionLine {
  role: CommissionRole;
  user: Types.ObjectId;
  userName: string;
  amount: number;
  note?: string;
}

export interface ICommissionSale extends Document {
  _id: Types.ObjectId;
  student: Types.ObjectId;
  studentName: string;
  enrollmentNumber?: string;
  invoiceNumber?: string;
  course: Types.ObjectId | null;
  courseName: string;
  closer: Types.ObjectId | null;
  closerName: string;
  team: Types.ObjectId | null;
  teamName: string;
  /** When it was sold — the enrolment date; `month` is its month in UAE time. */
  saleDate: Date;
  month: string;
  approvedAt?: Date;
  /** When its five steps were all done and who earns what was decided. */
  stepsDoneAt?: Date;
  /**
   * The course fee in AED — finance's invoice total, kept up to date by the
   * sweep; absent on a sale it hasn't reached yet. What the sale adds to a
   * salary-slab target (salaryService).
   */
  fee?: number;
  /** The plan row as it was when decided — what the lines are paid from. */
  plan: { sales: number; tl: number; sm: number; creditUsd: number };
  state: CommissionSaleState;
  /** Why it is waiting, excluded or reversed. */
  reason: string;
  lines: ICommissionLine[];
  countedAt?: Date;
  reversedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ICommissionSettings extends Document {
  key: string;
  /** The one Sales Manager: earns the SM amount on every sale. */
  salesManager: Types.ObjectId | null;
  /** Shared logins whose sales earn nobody commission. */
  excludedUsers: Types.ObjectId[];
  /** The salary slabs, one version per month they were changed in (salaryService). */
  salarySlabs?: ISalarySlabsVersion[];
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

/** Whose slab a person is paid on: Sales Staff, Team Leader or Sales Manager. */
export type SlabRole = CommissionRole;

/**
 * One level of a salary slab: reach `target` AED of approved sales in a month
 * and the month pays `salary`, plus `percent` of the commission earned. The
 * first row of each slab is its base, at target 0.
 */
export interface ISlabRow {
  name: string;
  target: number;
  salary: number;
  percent: number;
}

export type ISlabs = Record<SlabRole, ISlabRow[]>;

/** The slabs as changed in a month ("YYYY-MM") — in force from it until the next change. */
export interface ISalarySlabsVersion extends ISlabs {
  from: string;
  updatedAt?: Date;
  updatedBy?: Types.ObjectId;
}

/*
 * What a course is taught in.
 *
 * A fixed list rather than a typed box — finance counts enrolments by
 * language, and "Malayalam", "MALAYALAM" and "malayalam" would each be a
 * different answer to the same question. Same list Delta CRM uses, so a
 * shared finance organization reads one vocabulary from both.
 */
export const ENROLMENT_LANGUAGES = ["English", "Malayalam", "Hindi/Urdu", "Tamil"] as const;
export type EnrolmentLanguage = (typeof ENROLMENT_LANGUAGES)[number];

/** How the money was taken at the close — spelled the way finance's
    declaredPaymentMethod expects, or it is refused at the far end. */
export const ENROLMENT_PAYMENT_METHODS = [
  "cash",
  "bank_transfer",
  "cheque",
  "card",
  "easebuzz_emi",
  "tabby",
  "tamara",
  "billexpro",
  // Rupees into the INR account (the user, 2026-10-13) — finance's "INR Bank Account".
  "inr_bank_account",
] as const;
export type EnrolmentPaymentMethod = (typeof ENROLMENT_PAYMENT_METHODS)[number];

export const PAYMENT_METHOD_LABELS: Record<EnrolmentPaymentMethod, string> = {
  cash: "Cash",
  bank_transfer: "Bank Transfer",
  cheque: "Cheque",
  card: "Card",
  easebuzz_emi: "Easebuzz EMI",
  tabby: "Tabby",
  tamara: "Tamara",
  billexpro: "BillExPro",
  inr_bank_account: "INR Transfer",
};

/**
 * Which academy a close is for (the user, 2026-10-10): Dubai — billed in AED
 * into the finance organization FINANCE_ORG_ID names, as every close was before
 * — or Bangalore, billed in INR into FINANCE_ORG_ID_BANGALORE's. Picked at the
 * close and fixed from then on: every later call to finance for that close —
 * resend, correction, status — goes to the organization it was closed into.
 */
export const ACADEMIES = ["dubai", "bangalore"] as const;
export type Academy = (typeof ACADEMIES)[number];
export const ACADEMY_LABELS: Record<Academy, string> = { dubai: "Dubai", bangalore: "Bangalore" };
/** What a stored value means: Bangalore only when it says so — absent (every close from before) is Dubai. */
export const academyOf = (v: unknown): Academy => (v === "bangalore" ? "bangalore" : "dubai");

/**
 * A Bangalore close's money is INR, and cash is sometimes taken in AED: such a
 * payment carries what was handed over, in AED, and the rate — 1 AED = so many
 * INR. Its `amount` is the INR figure, the one that counts.
 */
// AED on a Bangalore close; INR on a Dubai one (the user, 2026-10-13).
export const PAYMENT_ORIGINAL_CURRENCIES = ["AED", "INR"] as const;
export type PaymentOriginalCurrency = (typeof PAYMENT_ORIGINAL_CURRENCIES)[number];

/** A file kept in object storage, as the enrolment records it. */
export interface StoredFile {
  name: string;
  url: string;
  key: string;
  size?: number;
  mimeType?: string;
  uploadedAt?: Date;
}

// ─── Lead ──────────────────────────────────────────────────────────────────────
export type LeadStatus = "new" | "assigned" | "pending_response" | "followup" | "closed" | "lost" | "not_connected" | "mia" | "repeated" | "callback" | "cnc";

export type InitialLeadResponse = "very_interested" | "not_interested" | "let_me_think";
export type PrimaryConcern      = "risk" | "price" | "time" | "trust" | "exact_concern";
export type FollowupStrategyType = "risk_based" | "price_based" | "time_based" | "trust_based";

export type ActivityAction =
  | "lead_created"
  | "lead_updated"
  | "status_changed"
  | "lead_assigned"
  | "team_assigned"
  | "note_added"
  | "note_updated"
  | "note_deleted"
  | "inactive_reassigned"
  | "repeat_enquiry"
  | "repeat_verified";

export interface ILeadNote {
  _id: Types.ObjectId;
  content: string;
  author: Types.ObjectId | IUser;
  createdAt: Date;
  updatedAt: Date;
}

export interface IPayment {
  _id: Types.ObjectId;
  amount: number;
  note?: string;
  paidAt: Date;
  addedBy: Types.ObjectId | IUser;
  /** How it was paid and its receipt (2026-10-23); absent on payments from before. */
  method?: EnrolmentPaymentMethod;
  receipt?: { name?: string; url: string; key: string; size?: number; mimeType?: string; uploadedAt?: Date };
  /** Sent to finance as a balance payment (2026-10-23). */
  finance?: { externalId: string; method: string; sentAt: Date };
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IReminder {
  _id: Types.ObjectId;
  title?: string;
  note?: string;
  remindAt: Date;
  createdBy: Types.ObjectId | IUser;
  isDone: boolean;
  /** Set when the server sends the on-time push/socket notification */
  notifiedAt?: Date;
  /** Set when the server sends the 30-min advance-warning notification */
  warnedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IActivityLog {
  _id: Types.ObjectId;
  action: ActivityAction;
  description: string;
  /** Absent when the CRM did it on its own (a lead moved on for inactivity) — shown as "System". */
  performedBy?: Types.ObjectId | IUser;
  changes?: Record<string, { from: unknown; to: unknown }>;
  createdAt: Date;
}

export interface ILead extends Document {
  _id: Types.ObjectId;
  name: string;
  email?: string;
  phone: string;
  hasWhatsapp?: boolean;
  source?: string;
  status: LeadStatus;
  courses?: (Types.ObjectId | ICourse)[];
  assignedTo?: Types.ObjectId | IUser;
  assignedAt?: Date | null;
  /** The first created date, kept when the lead is first handed over (createdAt then moves to the hand-over). */
  originalCreatedAt?: Date | null;
  team?: Types.ObjectId | ITeam;
  reporter: Types.ObjectId | IUser;
  notes: Types.DocumentArray<ILeadNote & Document>;
  reminders: Types.DocumentArray<IReminder & Document>;
  payments: Types.DocumentArray<IPayment & Document>;
  activityLogs: Types.DocumentArray<IActivityLog & Document>;
  platform?: string;
  campaign?: string;
  callNotConnected: number;
  callCount: number;
  callConnected: number;
  firstContactTime?: Date | null;
  initialLeadResponse?: InitialLeadResponse | null;
  primaryConcern?: PrimaryConcern | null;
  followupStrategyType?: FollowupStrategyType | null;
  sellingAmount?: number | null;
  // Legacy import fields
  leadReceivedTime?: string | null;
  exactConcern?: string | null;
  demoScheduled?: boolean | null;
  demoAttended?: boolean | null;
  lastFollowupDate?: Date | null;
  comments?: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Moves for inactivity — absent until the first one. */
  inactivity?: ILeadInactivity;
  /** How many times the same number came in again from the ads (services/repeatLeadService.ts). */
  repeatCount?: number;
  /** The last time it came again, and the team leader's verification of it. */
  repeat?: ILeadRepeat | null;
}

/** A lead whose number came in again (2026-10-23): with its team leader until they verify it and give it out. */
export interface ILeadRepeat {
  waiting: boolean;
  at: Date;
  team?: Types.ObjectId | null;
  previousOwner?: Types.ObjectId | null;
  previousStatus?: string | null;
  /** Already a client (closed) — it stays with its owner; the leader only verifies. */
  alreadyClient?: boolean;
  /** Who holds it while it waits (a leader of its team, else a Super Admin). */
  holder?: Types.ObjectId | null;
  source?: string | null;
  campaign?: string | null;
  decidedBy?: Types.ObjectId | null;
  decidedAt?: Date | null;
  givenTo?: Types.ObjectId | null;
}

export interface LeadFilters {
  status?: LeadStatus;
  assignedTo?: string;
  team?: string;
  reporter?: string;
  course?: string;
  source?: string;
  search?: string;
  /** ISO date string – filter leads created on or after this date (inclusive) */
  dateFrom?: string;
  /** ISO date string – filter leads created on or before this date (inclusive, end of day) */
  dateTo?: string;
  page?: string;
  limit?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

export interface LeadStats {
  total: number;
  new: number;
  assigned: number;
  pending_response: number;
  followup: number;
  closed: number;
  lost: number;
  not_connected: number;
  mia: number;
  repeated: number;
  callback: number;
  cnc: number;
}

// ─── Student ───────────────────────────────────────────────────────────────────
/** One payment taken at the close: how, how much, when, and its receipt. */
export interface IStudentPayment {
  method: EnrolmentPaymentMethod;
  amount: number;
  receipt: StoredFile;
  paidAt: Date;
  /** The money already on the lead before the close, as one payment. */
  collectedBefore?: boolean;
  /**
   * Handed over in the other currency: on a Bangalore close "AED", how much of it, and 1 AED = `exchangeRate` INR;
   * on a Dubai close "INR", how much, and 1 INR = `exchangeRate` AED (the user, 2026-10-13). Absent otherwise.
   */
  currency?: PaymentOriginalCurrency;
  amountInCurrency?: number;
  exchangeRate?: number;
}

export interface IStudent extends Document {
  _id: Types.ObjectId;
  enrollmentNumber: string;
  name: string;
  phone?: string;
  email?: string;
  courses?: (Types.ObjectId | ICourse)[];
  team?: Types.ObjectId | ITeam;
  assignedTo?: Types.ObjectId | IUser;
  leadId: Types.ObjectId | ILead;
  initialLeadResponse?: InitialLeadResponse | null;
  primaryConcern?: PrimaryConcern | null;
  followupStrategyType?: FollowupStrategyType | null;
  demoScheduled: boolean;
  demoAttended: boolean;
  firstContactTime?: Date | null;
  lastFollowupDate?: Date | null;
  enrollmentDate: Date;
  feeStatus: "paid" | "partial" | "pending";
  totalFee: number;
  paidAmount: number;
  pendingAmount: number;
  status: "active" | "inactive" | "graduated" | "dropped";
  /** What the courses are taught in, taken at the close. */
  language?: EnrolmentLanguage;
  /** How the money was taken at the close. */
  paymentMethod?: EnrolmentPaymentMethod;
  /** Proof the money was taken, handed on to finance with the enrolment. */
  paymentReceipt?: StoredFile | null;
  /**
   * Each payment taken at the close, when the client paid in more than one way
   * (cash and card, each with its own receipt). They add up to paidAmount; the
   * first is also paymentMethod / paymentReceipt, for whatever reads only one.
   * Absent on enrolments from before.
   */
  payments?: IStudentPayment[];
  notes?: string;
  /** Which academy it was closed for — fixed at the close; unset on closes from before, which are Dubai. */
  academy?: Academy;
  /** Whether a bonus was given at the close — unset on enrolments from before it was asked. */
  hasBonus?: boolean | null;
  /** The bonus, in the same currency as the fee; 0 when none. Never part of the balance. */
  bonusAmount?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ParsedLead {
  name: string;
  email?: string;
  phone: string;
  source?: string;
  notes?: string;
}

export interface ExcelParseResult {
  valid: ParsedLead[];
  invalid: { row: number; data: Record<string, unknown>; errors: string[] }[];
  /** Rows whose number is already a lead: that lead came in again (2026-10-23) — held for its team leader, not created. */
  repeats?: { row: number; leadId: string; phone: string; name?: string; source?: string }[];
}

export interface AutoAssignResult {
  assigned: number;
  results: { leadId: string; assignedTo: string }[];
}

/** A super admin viewing the CRM as someone else ("View as"): 30 minutes, view only. */
export interface IImpersonation {
  _id: Types.ObjectId;
  admin: Types.ObjectId;
  adminEmail: string;
  target: Types.ObjectId;
  targetEmail: string;
  startedAt: Date;
  expiresAt: Date;
  /** "Back to my account" (or signing out while viewing); null if it ran out instead. */
  endedAt: Date | null;
  ip: string;
  userAgent: string;
  device: string;
  createdAt: Date;
}

// ─── The CRM's own settings (2026-10-15): Settings → Automation & alerts ───
export interface IAppSettings {
  key: "app";
  inactiveLeads: {
    /** Move a lead nobody acted on to the next team member. Ships off. */
    autoReassign: boolean;
    /** How long after assignment, in minutes, a lead with no action counts as inactive. */
    limitMinutes: number;
    /**
     * When automatic moves were last switched on. Only leads assigned since then
     * move on their own — switching it on never sweeps up the whole backlog.
     */
    enabledAt: Date | null;
    /** Lead sources the automatic mover never moves (matched without regard to case). */
    excludedSources?: string[];
  };
  idleAlerts: {
    enabled: boolean;
    /** Minutes without activity in the app, while signed in during working hours. */
    limitMinutes: number;
    notifyTeamLeaders: boolean;
  };
  workingHours: {
    /** IANA zone the times below are in, e.g. "Asia/Dubai". */
    timezone: string;
    /** 0 = Sunday … 6 = Saturday. */
    days: number[];
    /** "HH:MM", 24-hour. */
    start: string;
    end: string;
  };
  updatedBy: Types.ObjectId | null;
  updatedAt?: Date;
}

// ─── Activity: sign-ins, presence, idle (2026-10-15, as in the Sales CRM) ────
export type LoginEventKind = "login" | "login_failed" | "logout";
export type LoginFailReason = "wrong_password" | "unknown_email" | "deactivated" | "no_account";

/** One sign-in, refused sign-in or sign-out — the Activity page's sign-in history. */
export interface ILoginEvent {
  _id: Types.ObjectId;
  user: Types.ObjectId | null;
  email: string;
  kind: LoginEventKind;
  method: "password" | "sso" | null;
  reason: LoginFailReason | null;
  ip: string;
  userAgent: string;
  device: string;
  deviceType: "desktop" | "mobile" | "tablet" | "app" | "unknown";
  createdAt: Date;
}

/** Where each person is, one document per user — refreshed by the web app's heartbeat. */
export interface IUserPresence {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  /** Any heartbeat: the app was open. */
  lastSeenAt: Date | null;
  /** A heartbeat after someone used the app. */
  lastActiveAt: Date | null;
  lastLoginAt: Date | null;
  lastLogoutAt: Date | null;
  lastIp: string;
  lastDevice: string;
  /** An idle alert was sent for the quiet stretch that began at lastActiveAt (or at a later clock-in). */
  idleAlertedAt: Date | null;
}

/** Active minutes per person per day (in the working hours' time zone). */
export interface IActivityDay {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  day: string;
  activeMinutes: number;
  firstActiveAt: Date | null;
  lastActiveAt: Date | null;
  /** Epoch minute last counted: one active minute per minute, however many tabs are open. */
  lastMinute: number;
  createdAt: Date;
}

/** A stretch of no activity that raised an idle alert; ends when the person is back, signs out or stops working. */
export interface IIdleStretch {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  since: Date;
  alertedAt: Date;
  endedAt: Date | null;
  createdAt: Date;
}

// ─── Inactive leads (2026-10-16, as in the Sales CRM) ─────────────────────────
export interface ILeadInactivity {
  /** Everyone who lost this lead for not acting on it. */
  lostBy: Types.ObjectId[];
  moves: number;
  lastMovedAt: Date | null;
  /** Nobody left in the team to move it to, for the current assignment. */
  stuckAt: Date | null;
}

/** One lead moved on because its owner did not act on it — automatically, or by hand from the Inactive leads page. */
export interface ILeadMove {
  _id: Types.ObjectId;
  lead: Types.ObjectId;
  leadName: string;
  team: Types.ObjectId | null;
  from: Types.ObjectId;
  to: Types.ObjectId;
  kind: "automatic" | "manual";
  /** Who moved it by hand; null when the CRM did. */
  by: Types.ObjectId | null;
  /** Working minutes the lead had waited without action when it moved. */
  inactiveMinutes: number;
  createdAt: Date;
}

// ─── Notifications kept for the bell (2026-10-16, as in the Sales CRM) ────────
/**
 * A notice kept for one person, so the bell still has it after a reload.
 * The live copy goes out on the socket as before; this is the record.
 */
export interface INotification {
  _id: Types.ObjectId;
  user: Types.ObjectId;
  type: string;
  title: string;
  body: string;
  url: string;
  readAt: Date | null;
  createdAt: Date;
}

export interface NotificationDTO {
  id: string;
  type: string;
  title: string;
  body: string;
  url: string;
  read: boolean;
  createdAt: string;
}

/** What a break is for — picked when "Take break" is pressed (2026-10-20, as in the Sales CRM). Every kind is a break the same. */
export const BREAK_KINDS = ["meeting", "lunch", "tea", "washroom"] as const;
export type BreakKind = (typeof BREAK_KINDS)[number];
