/** Where someone is right now (GET /activity/people). */
export type PresenceStatus =
  | "active" //      used the app in the last 2 minutes
  | "idle" //        app open, nobody using it
  | "away" //        was here today, app closed
  | "signed_out" //  signed out today
  | "offline"; //    not seen today

export interface PersonActivity {
  id: string;
  name: string;
  email: string;
  designation: string | null;
  role: string;
  superAdmin: boolean;
  teams: string[];
  status: PresenceStatus;
  lastSeenAt: string | null;
  lastActiveAt: string | null;
  /** Minutes since they last used the app (today), when not active now. */
  quietMinutes: number | null;
  /** An idle alert has gone out for the current quiet stretch. */
  alerted: boolean;
  activeMinutesToday: number;
  firstActiveToday: string | null;
  lastLogin: { at: string; ip: string; device: string } | null;
  lastLogoutAt: string | null;
  /** Where the HRMS has them, this CRM's break first; null when the HRMS can't say (a break still shows). */
  attendance: AttendanceState | null;
  /** Today is one of their shift's working days — optional for an older server. */
  workDay?: boolean | null;
  /** Their HRMS shift and today's first clock-in / last clock-out (null while still in) — optional for an older server. */
  shift?: AttendanceShift | null;
  clockedInAt?: string | null;
  clockedOutAt?: string | null;
}

/** The HRMS's word (by email), with this CRM's own "Take break" (2026-10-20). */
export type AttendanceState = "in" | "break" | "out" | "leave" | "unknown";

export interface PeopleResponse {
  items: PersonActivity[];
  summary: Record<PresenceStatus, number> & { alertsToday: number; failedSignInsToday: number };
  idleRule: {
    enabled: boolean;
    limitMinutes: number;
    notifyTeamLeaders: boolean;
    inWorkingHours: boolean;
    timezone: string;
    /** The HRMS is linked: idle alerts go only to those clocked in and not on a break. */
    byAttendance: boolean;
    /** Switched on but waiting: the HRMS is linked and isn't answering — optional for an older server. */
    paused?: boolean;
  };
}

export type LoginEventKind = "login" | "login_failed" | "logout";
export type LoginFailReason = "wrong_password" | "unknown_email" | "deactivated" | "no_account";

/** GET /activity/logins — one sign-in, refused sign-in or sign-out. */
export interface LoginEventEntry {
  id: string;
  kind: LoginEventKind;
  method: "password" | "sso" | null;
  reason: LoginFailReason | null;
  email: string;
  user: { id: string; name: string } | null;
  ip: string;
  device: string;
  deviceType: string;
  createdAt: string;
}

/** GET /activity/idle — one idle alert and how long the person stayed away. */
export interface IdleStretchEntry {
  id: string;
  user: { id: string; name: string } | null;
  since: string;
  alertedAt: string;
  endedAt: string | null;
  /** Working minutes without activity. */
  minutes: number;
}

export interface PeopleFilters {
  search?: string;
  teamId?: string;
}

export interface LoginEventFilters {
  page?: number;
  limit?: number;
  userId?: string;
  kind?: LoginEventKind;
}

export interface IdleStretchFilters {
  page?: number;
  limit?: number;
  userId?: string;
}

/** Somebody's HRMS shift (GET /activity/attendance). */
export interface AttendanceShift {
  name: string;
  /** "HH:mm" in `timeZone`. */
  from: string;
  to: string;
  timeZone: string;
  workDays: number[];
  /** False: nobody assigned one in the HRMS — its default. */
  assigned: boolean;
  mode: "fixed" | "duration";
  requiredHours: number | null;
}

/** Where someone is now (today only): this CRM's break, the HRMS's clock-in, approved leave, or none of those. */
export type AttendanceNow = "in" | "break" | "out" | "leave";

/** One person's day: their shift and their clock-ins and clock-outs (GET /activity/attendance, /teams/:id/attendance). */
export interface AttendancePerson {
  id: string;
  name: string;
  email: string;
  designation: string | null;
  teams: string[];
  inHrms: boolean;
  shift: AttendanceShift | null;
  workDay: boolean | null;
  /** present, late, half_day, early_out, on_leave, absent, holiday, weekend, wfh. */
  status: string | null;
  firstIn: string | null;
  /** Null while still clocked in. */
  lastOut: string | null;
  sessions: Array<{ in: string; out: string | null }>;
  workedMinutes: number;
  lateMinutes: number;
  leave: { type: string; halfDay: boolean } | null;
  wfh: boolean;
  now: AttendanceNow | null;
  breakSince: string | null;
  /** What the break going on now is for: meeting, lunch, tea, washroom (null when not said). */
  breakKind?: string | null;
}

export interface AttendanceDay {
  day: string;
  today: boolean;
  /** This CRM is linked to the HRMS at all — optional for an older server. */
  linked?: boolean;
  /** The HRMS answered; when not, `message` says why. */
  available: boolean;
  message?: string;
  summary: { people: number; clockedIn: number; onBreak: number; onLeave: number; notIn: number; late: number; notInHrms: number };
  rows: AttendancePerson[];
}

export interface AttendanceFilters {
  /** YYYY-MM-DD; today when not given. */
  day?: string;
  teamId?: string;
  search?: string;
}
