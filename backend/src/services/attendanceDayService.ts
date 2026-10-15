import { Types } from "mongoose";
import { User } from "../models/User.js";
import { Team } from "../models/Team.js";
import { env } from "../config/env.js";
import { hrmsConfigured, hrmsGet } from "../lib/hrms.js";

/*
 * The HRMS's shift and a day's clock-ins and clock-outs, for the Activity page's Attendance tab and a team's page
 * (the user, 2026-10-15: "show the HRMS shift and the clock-in and clock-out times"). By email, from the HRMS's
 * GET /integrations/directory/attendance-day, kept a minute per person and day. For today it also says where each
 * person is now — on leave, clocked in or out (this CRM has no "Take break" of its own; the shape keeps `break` and
 * `breakSince` so the page is the Sales CRM's). An HRMS that is not linked, or does not answer, leaves the rows with
 * who they are and says why.
 */

const CACHE_MS = 60_000;
const GST_OFFSET_MS = 4 * 3_600_000; // Dubai keeps no summer time
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Today in Dubai, "YYYY-MM-DD" — the sales floor's day. */
export const dubaiToday = (at = new Date()): string => new Date(at.getTime() + GST_OFFSET_MS).toISOString().slice(0, 10);

/** A real calendar day, written YYYY-MM-DD, no more than a day ahead of Dubai's today. */
export function isAttendanceDay(v: unknown): v is string {
  if (typeof v !== "string" || !DAY.test(v)) return false;
  const at = Date.parse(`${v}T00:00:00Z`);
  return !Number.isNaN(at) && new Date(at).toISOString().slice(0, 10) === v && v <= dubaiToday(new Date(Date.now() + 86_400_000));
}

interface HrmsSchedule {
  name: string;
  timeZone: string;
  loginTime: string;
  logoutTime: string;
  workDays: number[];
  halfDays: number[];
  mode: "fixed" | "duration";
  requiredHours: number | null;
  assigned: boolean;
}

interface HrmsDayRow {
  email: string;
  name: string;
  /** Null when the HRMS sent none (or not one) — the row still says where they are. */
  schedule: HrmsSchedule | null;
  workDay: boolean;
  attendance: {
    status: string;
    firstIn: string | null;
    lastOut: string | null;
    sessions: Array<{ in: string; out: string | null }>;
    workedMinutes: number;
    lateMinutes: number;
  } | null;
  leave: { type: string; halfDay: boolean } | null;
  wfh: boolean;
  now: "in" | "out" | "leave" | null;
}

/** Where someone is now (today only): the HRMS's clock-in, approved leave, or neither. ("break" is the Sales CRM's.) */
export type AttendanceNow = "in" | "break" | "out" | "leave";

export interface AttendanceShiftDTO {
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

export interface AttendancePersonDTO {
  id: string;
  name: string;
  email: string;
  designation: string | null;
  teams: string[];
  /** Found in the HRMS by email (when the HRMS answered). */
  inHrms: boolean;
  shift: AttendanceShiftDTO | null;
  /** The day is one of their shift's working days. */
  workDay: boolean | null;
  /** The HRMS's word for the day: present, late, half_day, early_out, on_leave, absent, holiday, weekend, wfh. */
  status: string | null;
  firstIn: string | null;
  /** Null while still clocked in. */
  lastOut: string | null;
  sessions: Array<{ in: string; out: string | null }>;
  workedMinutes: number;
  lateMinutes: number;
  leave: { type: string; halfDay: boolean } | null;
  wfh: boolean;
  /** Today only; null for another day, or when the HRMS can't say. */
  now: AttendanceNow | null;
  breakSince: string | null;
}

export interface AttendanceDayResponse {
  day: string;
  today: boolean;
  /** This server has the HRMS's address and key (HRMS_API_URL, HRMS_CLIENT_ID, HRMS_INTEGRATION_SECRET). */
  linked: boolean;
  /** The HRMS answered. When not, `message` says why and the rows only say who they are. */
  available: boolean;
  message?: string;
  summary: { people: number; clockedIn: number; onBreak: number; onLeave: number; notIn: number; late: number; notInHrms: number };
  rows: AttendancePersonDTO[];
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");
const instant = (v: unknown): string | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const weekdays = (v: unknown): number[] => (Array.isArray(v) ? v.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6) : []);
const objectOr = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" ? (v as Record<string, unknown>) : null);

/**
 * One row as the HRMS sent it, made safe to read: fields that aren't what they should be are left empty, never
 * trusted — so one odd row (an older HRMS, bad data) can't break the page or the idle alerts for everyone. Null when
 * it isn't a row at all (no email).
 */
function cleanRow(raw: unknown): HrmsDayRow | null {
  const r = objectOr(raw);
  const email = text(r?.email).trim().toLowerCase();
  if (!r || !email) return null;
  const sch = objectOr(r.schedule);
  const att = objectOr(r.attendance);
  const lv = objectOr(r.leave);
  return {
    email,
    name: text(r.name),
    schedule: sch
      ? {
        name: text(sch.name), timeZone: text(sch.timeZone) || "Asia/Dubai", loginTime: text(sch.loginTime), logoutTime: text(sch.logoutTime),
        workDays: weekdays(sch.workDays), halfDays: weekdays(sch.halfDays), mode: sch.mode === "duration" ? "duration" : "fixed",
        requiredHours: typeof sch.requiredHours === "number" && Number.isFinite(sch.requiredHours) ? sch.requiredHours : null, assigned: sch.assigned === true,
      }
      : null,
    workDay: r.workDay === true,
    attendance: att
      ? {
        status: text(att.status) || "present",
        firstIn: instant(att.firstIn),
        lastOut: instant(att.lastOut),
        sessions: (Array.isArray(att.sessions) ? att.sessions : []).flatMap((x) => {
          const sn = objectOr(x);
          const at = instant(sn?.in);
          return at ? [{ in: at, out: instant(sn?.out) }] : [];
        }),
        workedMinutes: count(att.workedMinutes),
        lateMinutes: count(att.lateMinutes),
      }
      : null,
    leave: lv ? { type: text(lv.type), halfDay: lv.halfDay === true } : null,
    wfh: r.wfh === true,
    now: r.now === "in" || r.now === "out" || r.now === "leave" ? r.now : null,
  };
}

const cache = new Map<string, { at: number; row: HrmsDayRow | null }>();
/**
 * When the HRMS last couldn't say, per day, and why — remembered a minute, so an HRMS that hangs costs one wait a
 * minute, not one per request (People and Attendance ask every 30–60 s for every viewer). Per day, and only in the way
 * of asking again: one bad day asked for doesn't make today's fresh answers "can't say".
 */
const failures = new Map<string, { at: number; message: string }>();
/** Forget what the HRMS said — for the checks, which change its answers between cases. */
export const forgetAttendanceDays = (): void => {
  cache.clear();
  failures.clear();
};

/** The HRMS failed on this day in the last minute — for People's "paused" when its list matched nobody. */
export const hrmsDayFailing = (day: string): boolean => {
  const failed = failures.get(day);
  return Boolean(failed && Date.now() - failed.at < CACHE_MS);
};

/** The HRMS's day for these emails — kept a minute; null for an email it does not know. Throws when it can't say. */
async function hrmsDays(day: string, emails: string[]): Promise<Map<string, HrmsDayRow | null>> {
  const now = Date.now();
  if (cache.size > 2000) for (const [k, v] of cache) if (v.at < now - CACHE_MS) cache.delete(k);
  const key = (e: string) => `${day}|${e}`;
  const stale = emails.filter((e) => (cache.get(key(e))?.at ?? 0) < now - CACHE_MS);
  const failed = failures.get(day);
  if (stale.length && failed && now - failed.at < CACHE_MS) throw new Error(failed.message);
  for (let i = 0; i < stale.length; i += 200) {
    const batch = stale.slice(i, i + 200);
    let rows: HrmsDayRow[];
    try {
      const answer = await hrmsGet<unknown>("/directory/attendance-day", {
        emails: batch.join(","),
        day,
        ...(env.HRMS_ORG_ID ? { organizationId: env.HRMS_ORG_ID } : {}),
      });
      // Anything but a list is not an answer — never "the HRMS knows nobody". Each row is read with care.
      if (!Array.isArray(answer)) throw new Error("The HRMS's answer wasn't a list of people");
      rows = answer.map(cleanRow).filter((r): r is HrmsDayRow => r !== null);
    } catch (err) {
      failures.set(day, { at: Date.now(), message: (err as Error).message });
      if (failures.size > 50) failures.delete(failures.keys().next().value!);
      throw err;
    }
    failures.delete(day);
    // Two HRMS employee records can share an address (one per organization, or imported twice): the one with a record
    // that day wins, then one with a shift of its own.
    const rank = (r: HrmsDayRow) => (r.attendance ? 2 : 0) + (r.schedule?.assigned ? 1 : 0);
    const byEmail = new Map<string, HrmsDayRow>();
    for (const r of rows) {
      const e = r.email;
      const had = byEmail.get(e);
      if (!had || rank(r) > rank(had)) byEmail.set(e, r);
    }
    for (const e of batch) cache.set(key(e), { at: now, row: byEmail.get(e) ?? null });
  }
  return new Map(emails.map((e) => [e, cache.get(key(e))?.row ?? null]));
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Who a team holds: its leaders and its members. */
export async function teamPeople(teamId: string): Promise<Types.ObjectId[] | null> {
  if (!Types.ObjectId.isValid(teamId)) return null;
  const team = await Team.findById(teamId).select("leaders members").lean<{ leaders: Types.ObjectId[]; members: Types.ObjectId[] } | null>();
  return team ? [...team.leaders, ...team.members] : null;
}

/** Whether this user leads that team. */
export async function leadsTeam(userId: string, teamId: string): Promise<boolean> {
  if (!Types.ObjectId.isValid(teamId) || !Types.ObjectId.isValid(userId)) return false;
  return Boolean(await Team.exists({ _id: teamId, leaders: userId }));
}

// The order the tab lists people in: here now, not in yet, out again, on leave, a day off, unknown ("break" is the
// Sales CRM's, never given here).
const ORDER: Record<string, number> = { in: 0, break: 1, notIn: 2, out: 3, leave: 4, off: 5, unknown: 6 };

/**
 * The day for the active people — everyone, or a team's leaders and members, or those matching a search. Sorted with
 * whoever is here first.
 */
export async function attendanceForDay(q: { day: string; teamId?: string; search?: string; userIds?: string[] }): Promise<AttendanceDayResponse> {
  const today = q.day === dubaiToday();
  const filter: Record<string, unknown> = { status: { $ne: "inactive" } };
  if (q.teamId) {
    const ids = await teamPeople(q.teamId);
    filter._id = { $in: ids ?? [] };
  } else if (q.userIds) {
    filter._id = { $in: q.userIds.filter((id) => Types.ObjectId.isValid(id)) };
  }
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), "i");
    filter.$or = [{ name: rx }, { email: rx }];
  }
  const users = await User.find(filter)
    .select("name email designation")
    .lean<Array<{ _id: Types.ObjectId; name: string; email: string; designation?: string }>>();
  const ids = users.map((u) => u._id);
  const teams = ids.length
    ? await Team.find({ $or: [{ members: { $in: ids } }, { leaders: { $in: ids } }] }).select("name members leaders")
      .lean<Array<{ name: string; members: Types.ObjectId[]; leaders: Types.ObjectId[] }>>()
    : [];
  const teamsOf = new Map<string, string[]>();
  for (const t of teams) {
    for (const m of [...t.leaders, ...t.members].map(String)) {
      const list = teamsOf.get(m) ?? [];
      if (!list.includes(t.name)) list.push(t.name);
      teamsOf.set(m, list);
    }
  }

  let available = hrmsConfigured();
  let message: string | undefined = available ? undefined : "The HRMS is not linked to this server (HRMS_API_URL, HRMS_CLIENT_ID, HRMS_INTEGRATION_SECRET)";
  let byEmail = new Map<string, HrmsDayRow | null>();
  if (available && users.length) {
    try {
      byEmail = await hrmsDays(q.day, [...new Set(users.map((u) => String(u.email ?? "").toLowerCase()).filter(Boolean))]);
    } catch (err) {
      available = false;
      message = (err as Error).message;
    }
  }

  const rows: Array<AttendancePersonDTO & { order: number }> = users.map((u) => {
    const id = String(u._id);
    const h = available ? byEmail.get(String(u.email ?? "").toLowerCase()) ?? null : null;
    const now: AttendanceNow | null = !today
      ? null
      : h?.now === "leave" ? "leave"
        : h?.now === "in" ? "in"
          : h?.now === "out" ? "out" : null; // a row the HRMS couldn't read says nothing
    const a = h?.attendance ?? null;
    const order = !h || (today && now === null) ? ORDER.unknown
      : now === "in" ? ORDER.in
          : (now === "leave" || h.leave) ? ORDER.leave
            : a?.firstIn ? ORDER.out
              : h.workDay ? ORDER.notIn : ORDER.off;
    return {
      id,
      name: u.name,
      email: u.email,
      designation: u.designation ?? null,
      teams: teamsOf.get(id) ?? [],
      inHrms: Boolean(h),
      shift: h?.schedule
        ? {
          name: h.schedule.name, from: h.schedule.loginTime, to: h.schedule.logoutTime, timeZone: h.schedule.timeZone,
          workDays: h.schedule.workDays, assigned: h.schedule.assigned, mode: h.schedule.mode, requiredHours: h.schedule.requiredHours,
        }
        : null,
      workDay: h ? h.workDay : null,
      status: a?.status ?? null,
      firstIn: a?.firstIn ?? null,
      lastOut: a?.lastOut ?? null,
      sessions: a?.sessions ?? [],
      workedMinutes: a?.workedMinutes ?? 0,
      lateMinutes: a?.lateMinutes ?? 0,
      leave: h?.leave ?? null,
      wfh: h?.wfh ?? false,
      now,
      breakSince: null,
      order,
    };
  });
  rows.sort((a, b) => a.order - b.order || (a.firstIn ?? "").localeCompare(b.firstIn ?? "") || a.name.localeCompare(b.name));

  const summary = { people: rows.length, clockedIn: 0, onBreak: 0, onLeave: 0, notIn: 0, late: 0, notInHrms: 0 };
  for (const r of rows) {
    if (!r.inHrms) summary.notInHrms++;
    if (r.now === "in") summary.clockedIn++;
    if (r.now === "break") summary.onBreak++;
    if (r.leave || r.now === "leave") summary.onLeave++;
    // Not in yet: a work day, no clock-in, no leave — and the HRMS able to say so (a row it couldn't read says nothing).
    if (r.inHrms && r.workDay && !r.firstIn && !r.leave && r.now !== "break" && !(today && r.now === null)) summary.notIn++;
    if (r.lateMinutes > 0) summary.late++;
  }
  return {
    day: q.day,
    today,
    linked: hrmsConfigured(),
    available,
    ...(message ? { message } : {}),
    summary,
    rows: rows.map(({ order: _order, ...r }) => r),
  };
}
