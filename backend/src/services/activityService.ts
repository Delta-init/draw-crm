import { Types } from "mongoose";
import type { Request } from "express";
import { LoginEvent } from "../models/LoginEvent.js";
import { UserPresence } from "../models/UserPresence.js";
import { ActivityDay } from "../models/ActivityDay.js";
import { IdleStretch } from "../models/IdleStretch.js";
import { User } from "../models/User.js";
import { Team } from "../models/Team.js";
import { Role } from "../models/Role.js";
import { getAppSettings, isWithinWorkingHours, type AppSettingsDTO } from "./settingsService.js";
import { sendPushToUsers, type PushPayload } from "./pushService.js";
import {
  formatMinutes,
  localDayKey,
  startOfLocalDay,
  workingCutoff,
  workingMinutesBetween,
} from "../utils/workingHours.js";
import { clientIp, describeDevice } from "../utils/requestMeta.js";
import { hrmsConfigured } from "../lib/hrms.js";
import { attendanceForDay, dubaiToday, hrmsDayFailing, type AttendanceNow, type AttendancePersonDTO, type AttendanceShiftDTO } from "./attendanceDayService.js";
import { buildPagination } from "../utils/response.js";
import type { LoginEventKind, LoginFailReason, PaginationMeta } from "../types/index.js";

/*
 * Who signed in, who is here, who has gone quiet.
 *
 *  • Sign-ins, refused sign-ins and sign-outs are recorded with IP and device.
 *  • The web app sends a heartbeat every minute it is open, saying whether
 *    anyone used it in that minute. That moves "last seen" / "last active"
 *    and counts active minutes per day.
 *  • Idle alerts (Settings, off by default): in working hours, someone who
 *    used the app today, has not signed out, and has done nothing in it for
 *    the limit gets one alert per quiet stretch — so do the super admins (and
 *    their team leaders, if switched on). Super admins are not tracked.
 *
 * Brought over from the Sales CRM (2026-10-15). The HRMS has its say: an idle
 * alert is only for someone clocked in and not on a break ("Take break",
 * 2026-10-20) — never for anyone on leave or clocked out (attendanceDayService,
 * by email) — and the quiet time counts from their last clock-in when that came
 * later, so a lunch clock-out is not idle time. While the HRMS is linked but
 * can't say, alerts wait (it can't tell who is on leave); not linked at all,
 * activity and this CRM's own breaks go alone. A quiet stretch ends when they
 * are back, sign out, clock out, go on a break or leave, or the day ends —
 * whether or not alerts are on. People are told
 * in the bell while the CRM is open and by push — this CRM keeps no stored
 * notices — and no email.
 */

/** A heartbeat comes every 60 s; none for 2½ minutes means the app was closed. */
const ONLINE_MS = 150_000;
/** Used the app in the last 2 minutes. */
const ACTIVE_MS = 120_000;
/** A heartbeat still in flight when someone signs out must not make them look back. */
const SIGN_OUT_SLACK_MS = 90_000;

export type PresenceStatus = "active" | "idle" | "away" | "signed_out" | "offline";

interface Person {
  id: string;
  name: string;
}

export interface PersonActivityDTO {
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
  /** Minutes since they last used the app, when that was today and they are not active now. */
  quietMinutes: number | null;
  /** An idle alert has gone out for the current quiet stretch. */
  alerted: boolean;
  activeMinutesToday: number;
  firstActiveToday: string | null;
  lastLogin: { at: string; ip: string; device: string } | null;
  lastLogoutAt: string | null;
  /** Where the HRMS has them, this CRM's break first; "unknown" when it doesn't know them; null when it can't say (a break still shows). */
  attendance: AttendanceNow | "unknown" | null;
  /** Today is one of their shift's working days (null when the HRMS can't say). */
  workDay: boolean | null;
  /** Their HRMS shift, and today's first clock-in and last clock-out (null while still in) — the Attendance tab has more. */
  shift: AttendanceShiftDTO | null;
  clockedInAt: string | null;
  clockedOutAt: string | null;
}

export interface PeopleResponse {
  items: PersonActivityDTO[];
  summary: Record<PresenceStatus, number> & { alertsToday: number; failedSignInsToday: number };
  idleRule: {
    enabled: boolean;
    limitMinutes: number;
    notifyTeamLeaders: boolean;
    inWorkingHours: boolean;
    timezone: string;
    /** The HRMS is linked: idle alerts go only to those clocked in and not on a break. */
    byAttendance: boolean;
    /** Switched on, but waiting: the HRMS is linked and isn't answering, so nobody can be told apart from leave. */
    paused: boolean;
  };
}

export interface LoginEventDTO {
  id: string;
  kind: LoginEventKind;
  method: "password" | "sso" | null;
  reason: LoginFailReason | null;
  email: string;
  user: Person | null;
  ip: string;
  device: string;
  deviceType: string;
  createdAt: string;
}

export interface IdleStretchDTO {
  id: string;
  user: Person | null;
  since: string;
  alertedAt: string;
  endedAt: string | null;
  /** Working minutes without activity, to when they came back (or to now). */
  minutes: number;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Everyone holding the Super Admin role, still active. */
async function superAdminIds(): Promise<string[]> {
  const roles = await Role.find({ isSystemRole: true, roleName: "Super Admin" }).select("_id").lean();
  if (!roles.length) return [];
  const admins = await User.find({ role: { $in: roles.map((r) => r._id) }, status: { $ne: "inactive" } }).select("_id").lean();
  return admins.map((a) => String(a._id));
}

/**
 * A notice: to the bell on every screen they have open (this CRM keeps no stored notices — the bell holds what came
 * while it was open), and by push to every device they turned notifications on for. Never throws.
 */
async function notify(input: { userIds: string[]; type: string; title: string; body: string; url?: string; tag?: string }): Promise<void> {
  const userIds = [...new Set(input.userIds.map(String))].filter((id) => Types.ObjectId.isValid(id));
  if (!userIds.length) return;
  const title = input.title.slice(0, 200);
  const body = input.body.slice(0, 1000);
  try {
    const { emitToUser } = await import("../socket.js");
    const live = { type: input.type, title, body, url: input.url, createdAt: new Date().toISOString() };
    for (const id of userIds) emitToUser(id, "notification", live);
  } catch {
    // No socket server in this process; the push below is the message.
  }
  const payload: PushPayload = { title, body, url: input.url, tag: input.tag, data: { type: input.type } };
  await sendPushToUsers(userIds, payload).catch((err) =>
    console.error(`🔔 Push for "${input.type}" failed:`, err instanceof Error ? err.message : err)
  );
}

// ─── Recording ────────────────────────────────────────────────────────────────

function requestMeta(req: Request) {
  const userAgent = String(req.headers["user-agent"] ?? "").slice(0, 500);
  const device = describeDevice(userAgent);
  return { ip: clientIp(req), userAgent, device: device.label, deviceType: device.type };
}

/** A successful sign-in. Never throws: failing to write it down must not stop anyone signing in. */
export async function recordLogin(req: Request, user: { _id: unknown; email?: string }, method: "password" | "sso"): Promise<void> {
  try {
    const meta = requestMeta(req);
    await LoginEvent.create({ user: user._id, email: (user.email ?? "").slice(0, 200), kind: "login", method, ...meta });
    await UserPresence.updateOne(
      { user: user._id },
      { $set: { lastLoginAt: new Date(), lastIp: meta.ip, lastDevice: meta.device } },
      { upsert: true }
    );
  } catch (err) {
    console.error("[activity] could not record a sign-in:", err instanceof Error ? err.message : err);
  }
}

/** A refused sign-in — and whose account it was, when the email matched one. Server errors are not recorded. */
export async function recordLoginFailure(req: Request, email: string, error: unknown, method: "password" | "sso"): Promise<void> {
  try {
    const status = (error as { statusCode?: number })?.statusCode;
    if (status !== 401 && status !== 403) return;
    const user = await User.findOne({ email: email.trim().toLowerCase() }).select("_id").lean<{ _id: Types.ObjectId } | null>();
    const reason: LoginFailReason =
      status === 403 ? "deactivated" : method === "sso" ? "no_account" : user ? "wrong_password" : "unknown_email";
    // Cut to what the record holds: a refused sign-in with a 300-character "email" is still a refused sign-in.
    await LoginEvent.create({ user: user?._id ?? null, email: email.slice(0, 200), kind: "login_failed", method, reason, ...requestMeta(req) });
  } catch (err) {
    console.error("[activity] could not record a refused sign-in:", err instanceof Error ? err.message : err);
  }
}

/** A sign-out — which also ends a quiet stretch. Never throws: signing out goes ahead whatever happens here. */
export async function recordLogout(req: Request, userId: string): Promise<void> {
  try {
    const now = new Date();
    const user = await User.findById(userId).select("email").lean<{ email?: string } | null>();
    await LoginEvent.create({ user: userId, email: (user?.email ?? "").slice(0, 200), kind: "logout", method: null, ...requestMeta(req) });
    await UserPresence.updateOne({ user: userId }, { $set: { lastLogoutAt: now } }, { upsert: true });
    await IdleStretch.updateMany({ user: userId, endedAt: null }, { $set: { endedAt: now } });
  } catch (err) {
    console.error("[activity] could not record a sign-out:", err instanceof Error ? err.message : err);
  }
}

/**
 * The web app's minute-by-minute heartbeat. `active`: someone used the app in
 * the last minute. Counts one active minute per clock minute, however many
 * tabs are open, and ends an alerted idle stretch.
 */
export async function recordHeartbeat(userId: string, active: boolean, now: Date = new Date()): Promise<void> {
  const user = new Types.ObjectId(userId);
  // $max: these only move forward, even if two servers' clocks disagree by a second.
  await UserPresence.updateOne(
    { user },
    { $max: active ? { lastSeenAt: now, lastActiveAt: now } : { lastSeenAt: now } },
    { upsert: true }
  );
  if (!active) return;

  const settings = await getAppSettings();
  const day = localDayKey(settings.workingHours.timezone, now);
  const minute = Math.floor(now.getTime() / 60_000);
  const counted = await ActivityDay.updateOne(
    { user, day, lastMinute: { $lt: minute } },
    { $inc: { activeMinutes: 1 }, $set: { lastMinute: minute, lastActiveAt: now } }
  );
  if (!counted.matchedCount) {
    // The day's first active minute — or another tab already counted this one.
    try {
      await ActivityDay.create({ user, day, activeMinutes: 1, firstActiveAt: now, lastActiveAt: now, lastMinute: minute });
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err;
    }
  }

  await IdleStretch.updateMany({ user, endedAt: null }, { $set: { endedAt: now } });
}

// ─── Reading ──────────────────────────────────────────────────────────────────

interface PresenceRow {
  user: Types.ObjectId;
  lastSeenAt: Date | null;
  lastActiveAt: Date | null;
  lastLoginAt: Date | null;
  lastLogoutAt: Date | null;
  lastIp: string;
  lastDevice: string;
  idleAlertedAt: Date | null;
}

function statusOf(p: PresenceRow | undefined, now: Date, dayStart: Date): PresenceStatus {
  if (!p) return "offline";
  const t = now.getTime();
  const seen = p.lastSeenAt?.getTime() ?? 0;
  const active = p.lastActiveAt?.getTime() ?? 0;
  const login = p.lastLoginAt?.getTime() ?? 0;
  const logout = p.lastLogoutAt?.getTime() ?? 0;
  if (logout && logout >= login && logout >= seen - SIGN_OUT_SLACK_MS) {
    return logout >= dayStart.getTime() ? "signed_out" : "offline";
  }
  if (active >= t - ACTIVE_MS) return "active";
  if (seen >= t - ONLINE_MS) return "idle";
  // Seen today, or signed in today (an app that sends no heartbeat): here today, nothing lately.
  if (seen >= dayStart.getTime() || login >= dayStart.getTime()) return "away";
  return "offline";
}

const STATUS_ORDER: PresenceStatus[] = ["active", "idle", "away", "signed_out", "offline"];

/** Everyone active in the CRM with where they are now and how their day has gone. */
export async function listPeople(q: { search?: string; teamId?: string }, now: Date = new Date()): Promise<PeopleResponse> {
  const settings = await getAppSettings();
  const tz = settings.workingHours.timezone;
  const dayStart = startOfLocalDay(tz, now);
  const day = localDayKey(tz, now);

  const filter: Record<string, unknown> = { status: { $ne: "inactive" } };
  if (q.teamId) {
    const team = await Team.findById(q.teamId).select("leaders members").lean();
    filter._id = { $in: team ? [...team.leaders, ...team.members] : [] };
  }
  if (q.search) {
    const rx = new RegExp(escapeRegex(q.search), "i");
    filter.$or = [{ name: rx }, { email: rx }];
  }

  const users = await User.find(filter)
    .select("name email designation role")
    .populate("role", "roleName isSystemRole")
    .lean<Array<{ _id: Types.ObjectId; name: string; email: string; designation?: string; role?: { roleName?: string; isSystemRole?: boolean } | null }>>();
  const ids = users.map((u) => u._id);

  const [presence, days, teams, alertsToday, failedSignInsToday, openStretches] = await Promise.all([
    UserPresence.find({ user: { $in: ids } }).lean<PresenceRow[]>(),
    ActivityDay.find({ user: { $in: ids }, day }).lean<Array<{ user: Types.ObjectId; activeMinutes: number; firstActiveAt: Date | null }>>(),
    Team.find({ $or: [{ members: { $in: ids } }, { leaders: { $in: ids } }] })
      .select("name members leaders")
      .lean<Array<{ name: string; members: Types.ObjectId[]; leaders: Types.ObjectId[] }>>(),
    IdleStretch.countDocuments({ alertedAt: { $gte: dayStart } }),
    LoginEvent.countDocuments({ kind: "login_failed", createdAt: { $gte: dayStart } }),
    // "Alerted" is an idle stretch still open — not one that ended with a clock-out, a break or leave.
    IdleStretch.distinct("user", { endedAt: null, user: { $in: ids } }),
  ]);
  const alertedNow = new Set((openStretches as Types.ObjectId[]).map(String));
  const presenceByUser = new Map(presence.map((p) => [String(p.user), p]));
  // Today's shift and clock-ins from the HRMS (one ask, kept a minute) — where each person is, their shift, when in.
  const hrmsDay = ids.length ? await attendanceForDay({ day: dubaiToday(now), userIds: ids.map(String) }) : null;
  const hrmsUp = hrmsDay ? hrmsDay.available : hrmsConfigured();
  const dayRowOf = new Map((hrmsDay?.rows ?? []).map((r) => [r.id, r]));
  const dayOf = new Map(days.map((d) => [String(d.user), d]));
  const teamsOf = new Map<string, string[]>();
  for (const t of teams) {
    for (const m of [...t.leaders, ...t.members].map(String)) {
      const list = teamsOf.get(m) ?? [];
      if (!list.includes(t.name)) list.push(t.name);
      teamsOf.set(m, list);
    }
  }

  const items: PersonActivityDTO[] = users.map((u) => {
    const id = String(u._id);
    const p = presenceByUser.get(id);
    const d = dayOf.get(id);
    const status = statusOf(p, now, dayStart);
    const activeToday = p?.lastActiveAt && p.lastActiveAt >= dayStart;
    return {
      id,
      name: u.name,
      email: u.email,
      designation: u.designation ?? null,
      role: u.role?.roleName ?? "",
      superAdmin: Boolean(u.role?.isSystemRole && u.role.roleName === "Super Admin"),
      teams: teamsOf.get(id) ?? [],
      status,
      lastSeenAt: p?.lastSeenAt ? p.lastSeenAt.toISOString() : null,
      lastActiveAt: p?.lastActiveAt ? p.lastActiveAt.toISOString() : null,
      quietMinutes:
        status !== "active" && activeToday && p?.lastActiveAt
          ? Math.floor((now.getTime() - p.lastActiveAt.getTime()) / 60_000)
          : null,
      alerted: alertedNow.has(id),
      activeMinutesToday: d?.activeMinutes ?? 0,
      firstActiveToday: d?.firstActiveAt ? new Date(d.firstActiveAt).toISOString() : null,
      lastLogin: p?.lastLoginAt ? { at: p.lastLoginAt.toISOString(), ip: p.lastIp, device: p.lastDevice } : null,
      lastLogoutAt: p?.lastLogoutAt ? p.lastLogoutAt.toISOString() : null,
      attendance: dayRowOf.get(id)?.now ?? (hrmsUp ? "unknown" : null),
      workDay: dayRowOf.get(id)?.workDay ?? null,
      shift: dayRowOf.get(id)?.shift ?? null,
      clockedInAt: dayRowOf.get(id)?.firstIn ?? null,
      clockedOutAt: dayRowOf.get(id)?.lastOut ?? null,
    };
  });
  items.sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.name.localeCompare(b.name));

  const summary = { active: 0, idle: 0, away: 0, signed_out: 0, offline: 0, alertsToday, failedSignInsToday };
  for (const i of items) summary[i.status]++;

  return {
    items,
    summary,
    idleRule: {
      enabled: settings.idleAlerts.enabled,
      limitMinutes: settings.idleAlerts.limitMinutes,
      notifyTeamLeaders: settings.idleAlerts.notifyTeamLeaders,
      inWorkingHours: isWithinWorkingHours(settings, now),
      timezone: tz,
      byAttendance: hrmsConfigured(),
      paused: settings.idleAlerts.enabled && hrmsConfigured() && (hrmsDay ? !hrmsDay.available : hrmsDayFailing(dubaiToday(now))),
    },
  };
}

type Ref = { _id: Types.ObjectId; name: string } | null;
const person = (r: Ref): Person | null => (r ? { id: String(r._id), name: r.name } : null);

/** Sign-ins, refused sign-ins and sign-outs, newest first. */
export async function listLoginEvents(q: {
  page: number;
  limit: number;
  userId?: string;
  kind?: LoginEventKind;
  from?: Date;
  to?: Date;
}): Promise<{ items: LoginEventDTO[]; pagination: PaginationMeta }> {
  const filter: Record<string, unknown> = {};
  if (q.userId) filter.user = new Types.ObjectId(q.userId);
  if (q.kind) filter.kind = q.kind;
  if (q.from || q.to) {
    const range: Record<string, Date> = {};
    if (q.from) range.$gte = q.from;
    if (q.to) range.$lte = q.to;
    filter.createdAt = range;
  }
  const [rows, total] = await Promise.all([
    LoginEvent.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate("user", "name")
      .lean<
        Array<{
          _id: Types.ObjectId;
          kind: LoginEventKind;
          method: "password" | "sso" | null;
          reason: LoginFailReason | null;
          email: string;
          user: Ref;
          ip: string;
          device: string;
          deviceType: string;
          createdAt: Date;
        }>
      >(),
    LoginEvent.countDocuments(filter),
  ]);
  return {
    items: rows.map((r) => ({
      id: String(r._id),
      kind: r.kind,
      method: r.method,
      reason: r.reason,
      email: r.email,
      user: person(r.user),
      ip: r.ip,
      device: r.device,
      deviceType: r.deviceType,
      createdAt: new Date(r.createdAt).toISOString(),
    })),
    pagination: buildPagination(total, q.page, q.limit),
  };
}

/** Idle alerts that went out, newest first — with how long each person stayed away. */
export async function listIdleStretches(
  q: { page: number; limit: number; userId?: string },
  now: Date = new Date()
): Promise<{ items: IdleStretchDTO[]; pagination: PaginationMeta }> {
  const settings = await getAppSettings();
  const filter: Record<string, unknown> = {};
  if (q.userId) filter.user = new Types.ObjectId(q.userId);
  const [rows, total] = await Promise.all([
    IdleStretch.find(filter)
      .sort({ alertedAt: -1, _id: -1 })
      .skip((q.page - 1) * q.limit)
      .limit(q.limit)
      .populate("user", "name")
      .lean<Array<{ _id: Types.ObjectId; user: Ref; since: Date; alertedAt: Date; endedAt: Date | null }>>(),
    IdleStretch.countDocuments(filter),
  ]);
  return {
    items: rows.map((r) => ({
      id: String(r._id),
      user: person(r.user),
      since: new Date(r.since).toISOString(),
      alertedAt: new Date(r.alertedAt).toISOString(),
      endedAt: r.endedAt ? new Date(r.endedAt).toISOString() : null,
      minutes: Math.floor(workingMinutesBetween(settings.workingHours, new Date(r.since), r.endedAt ? new Date(r.endedAt) : now)),
    })),
    pagination: buildPagination(total, q.page, q.limit),
  };
}

// ─── Idle alerts ──────────────────────────────────────────────────────────────

interface IdlePerson extends Person {
  since: Date;
  minutes: number;
  /** The quiet time counts from when they clocked back in, not from their last use of the CRM. */
  sinceClockIn: boolean;
}

async function notifyIdle(people: IdlePerson[], admins: string[], toTeamLeaders: boolean, settings: AppSettingsDTO): Promise<void> {
  if (!people.length) return;
  const tz = settings.workingHours.timezone;
  const at = (d: Date) => d.toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
  const line = (p: IdlePerson) => `${p.name} — no activity since ${p.sinceClockIn ? "clocking in at " : ""}${at(p.since)} (${formatMinutes(p.minutes)})`;
  const tasks: Array<Promise<void>> = [];

  for (const p of people) {
    tasks.push(
      notify({
        userIds: [p.id],
        type: "idle_self",
        title: "Still there?",
        body: `No activity from you in the CRM since ${p.sinceClockIn ? "you clocked in at " : ""}${at(p.since)} — ${formatMinutes(p.minutes)} of working time. Your super admin has been told.`,
        url: "/dashboard",
        tag: `idle-self-${p.id}`,
      })
    );
  }

  const summary = (list: IdlePerson[]) =>
    list.length <= 3 ? list.map(line).join(" · ") : `${list.slice(0, 3).map(line).join(" · ")} and ${list.length - 3} more`;
  const titleFor = (list: IdlePerson[]) => (list.length === 1 ? `${list[0].name} is idle` : `${list.length} people are idle`);

  if (admins.length) {
    tasks.push(
      notify({
        userIds: admins,
        type: "idle_alert",
        title: titleFor(people),
        body: summary(people),
        url: "/activity",
        tag: "idle-alert",
      })
    );
  }

  if (toTeamLeaders) {
    // Each leader hears about their own team members only — and a super admin already heard.
    const teams = await Team.find({ members: { $in: people.map((p) => new Types.ObjectId(p.id)) }, status: { $ne: "inactive" } })
      .select("leaders members")
      .lean<Array<{ leaders: Types.ObjectId[]; members: Types.ObjectId[] }>>();
    const byLeader = new Map<string, IdlePerson[]>();
    for (const t of teams) {
      const members = new Set(t.members.map(String));
      for (const leader of t.leaders.map(String)) {
        if (admins.includes(leader)) continue;
        const list = byLeader.get(leader) ?? [];
        for (const p of people) {
          if (p.id !== leader && members.has(p.id) && !list.includes(p)) list.push(p);
        }
        if (list.length) byLeader.set(leader, list);
      }
    }
    for (const [leader, list] of byLeader) {
      tasks.push(
        notify({
          userIds: [leader],
          type: "idle_alert",
          title: titleFor(list),
          body: summary(list),
          url: "/teams",
          tag: `idle-alert-team-${leader}`,
        })
      );
    }
  }

  await Promise.allSettled(tasks);
}

let pausedLoggedAt = 0;

/** The start of the session they are in now, if one is open — today's clock-in, or a clock-in after a clock-out. */
function openSessionStart(row: AttendancePersonDTO | undefined): Date | null {
  const last = row?.sessions[row.sessions.length - 1];
  return last && last.out === null ? new Date(last.in) : null;
}

/** The clock-out just before the session that began at `clockIn` — when they stopped working last time. */
function previousClockOut(row: AttendancePersonDTO | undefined, clockIn: Date): Date | null {
  const outs = (row?.sessions ?? []).map((x) => (x.out ? new Date(x.out) : null)).filter((d): d is Date => !!d && d <= clockIn);
  return outs.length ? new Date(Math.max(...outs.map((d) => d.getTime()))) : null;
}

/** When a quiet stretch ended for someone who stopped working: the break's start, the clock-out, or now. */
function stoppedWorkingAt(row: AttendancePersonDTO | undefined, since: Date, now: Date): Date {
  const at = row?.now === "break" && row.breakSince ? new Date(row.breakSince)
    : row?.now === "out" && row.lastOut ? new Date(row.lastOut)
      : now;
  return at < since ? since : at > now ? now : at;
}

/**
 * One pass of the idle alerts (every minute): in working hours, with the switch on, everyone at work who used the app
 * today, has not signed out since and has done nothing in it for the limit (working time) — counted from their last
 * use of the app, or from their last clock-in when that came later — once per quiet stretch. While the HRMS is linked
 * but can't say, nobody is alerted (it can't tell who is on leave). Whether or not alerts are on, a stretch ends when
 * they are back, sign out, stop working (a break, a clock-out, leave) or the day ends.
 */
export async function sweepIdleUsers(now: Date = new Date()): Promise<{ alerted: number; ended: number; idle?: "off" | "outside working hours" | "hrms unavailable" }> {
  const settings = await getAppSettings();
  const dayStart = startOfLocalDay(settings.workingHours.timezone, now);
  // A quiet stretch never outlives its day: one still open from an earlier day ends with it.
  const stale = await IdleStretch.updateMany({ endedAt: null, alertedAt: { $lt: dayStart } }, { $set: { endedAt: dayStart } });
  let ended = stale.modifiedCount;

  const { enabled, limitMinutes, notifyTeamLeaders } = settings.idleAlerts;
  const alerting = enabled && isWithinWorkingHours(settings, now);
  const idle = !enabled ? ("off" as const) : !alerting ? ("outside working hours" as const) : undefined;
  const cutoff = workingCutoff(settings.workingHours, now, limitMinutes);
  const [candidates, open] = await Promise.all([
    !alerting || cutoff < dayStart
      ? Promise.resolve([] as Array<{ _id: Types.ObjectId; user: Types.ObjectId; lastActiveAt: Date; idleAlertedAt: Date | null }>)
      : UserPresence.find({
        lastActiveAt: { $gte: dayStart, $lte: cutoff },
        // Not signed out since. Already alerted is decided below: a clock-in after the alert starts a new stretch.
        $expr: { $not: [{ $gte: ["$lastLogoutAt", "$lastActiveAt"] }] },
      })
        .select("user lastActiveAt idleAlertedAt")
        .limit(500)
        .lean<Array<{ _id: Types.ObjectId; user: Types.ObjectId; lastActiveAt: Date; idleAlertedAt: Date | null }>>(),
    IdleStretch.find({ endedAt: null }).select("user since").lean<Array<{ _id: Types.ObjectId; user: Types.ObjectId; since: Date }>>(),
  ]);
  if (!candidates.length && !open.length) return { alerted: 0, ended, ...(idle ? { idle } : {}) };

  const admins = await superAdminIds();
  const ids = [...new Set([...candidates.map((c) => String(c.user)), ...open.map((o) => String(o.user))])];
  const users = await User.find({ _id: { $in: ids }, status: { $ne: "inactive" } })
    .select("name")
    .lean<Array<{ _id: Types.ObjectId; name: string }>>();
  const nameOf = new Map(users.map((u) => [String(u._id), u.name]));
  const tracked = new Set(ids.filter((id) => nameOf.has(id) && !admins.includes(id)));

  // Where each of them is (one ask of the HRMS, kept a minute), this CRM's breaks first. At work: clocked in and not
  // on a break; never on leave or clocked out. Not linked: this CRM's breaks are all there is to go by.
  const day = tracked.size ? await attendanceForDay({ day: dubaiToday(now), userIds: [...tracked] }) : null;
  const rowOf = new Map((day?.rows ?? []).map((r) => [r.id, r]));
  const available = Boolean(day?.available);
  const state = (id: string) => rowOf.get(id)?.now ?? null;
  const atWork = (id: string): boolean => (available ? state(id) === "in" : state(id) !== "break");
  // Known to have stopped: by the HRMS when it answers; a break whatever it says.
  const stopped = (id: string): boolean => state(id) === "break" || (available && (state(id) === "out" || state(id) === "leave"));

  // Stopped working — a break, a clock-out, leave — ends the stretch, so it doesn't run on while they're away.
  for (const o of open) {
    const id = String(o.user);
    if (tracked.has(id) && !stopped(id)) continue;
    const res = await IdleStretch.updateOne({ _id: o._id, endedAt: null }, { $set: { endedAt: stoppedWorkingAt(rowOf.get(id), o.since, now) } });
    ended += res.modifiedCount;
  }

  if (idle) return { alerted: 0, ended, idle };
  if (!tracked.size) return { alerted: 0, ended };
  // Linked but not answering: who is on leave or out can't be told, and alerting them is worse than waiting a minute.
  // Said in the log every 10 minutes while it lasts — a wrong key or an HRMS not yet deployed would otherwise only
  // show as "paused" on the Activity page.
  if (hrmsConfigured() && !available) {
    if (Date.now() - pausedLoggedAt > 10 * 60_000) {
      pausedLoggedAt = Date.now();
      console.warn(`[idleAlerts] paused — the HRMS isn't answering: ${day?.message ?? "no answer"}`);
    }
    return { alerted: 0, ended, idle: "hrms unavailable" };
  }

  const alerted: IdlePerson[] = [];
  for (const c of candidates) {
    const id = String(c.user);
    if (!tracked.has(id) || !atWork(id)) continue;
    // Quiet since their last use of the CRM — or since they clocked back in, when that was later: a lunch clock-out
    // is not idle time.
    const clockIn = available ? openSessionStart(rowOf.get(id)) : null;
    const since = clockIn && clockIn > c.lastActiveAt ? clockIn : c.lastActiveAt;
    if (since > cutoff) continue;
    if (c.idleAlertedAt && c.idleAlertedAt >= since) continue;
    // Once per quiet stretch: only if they haven't come back meanwhile, nor another sweep got there first.
    const res = await UserPresence.updateOne(
      { _id: c._id, lastActiveAt: c.lastActiveAt, $or: [{ idleAlertedAt: null }, { idleAlertedAt: { $lt: since } }] },
      { $set: { idleAlertedAt: now } }
    );
    if (!res.modifiedCount) continue;
    // Still one open from before a clock-out no sweep saw: it ended at that clock-out (or where this one starts).
    const end = previousClockOut(rowOf.get(id), since) ?? since;
    await IdleStretch.updateMany({ user: c.user, endedAt: null }, [{ $set: { endedAt: { $max: ["$since", end] } } }]);
    await IdleStretch.create({ user: c.user, since, alertedAt: now });
    alerted.push({
      id,
      name: nameOf.get(id)!,
      since,
      minutes: workingMinutesBetween(settings.workingHours, since, now),
      sinceClockIn: since !== c.lastActiveAt,
    });
  }

  await notifyIdle(alerted, admins, notifyTeamLeaders, settings);
  if (alerted.length || ended) console.log(`[idleAlerts] alerted ${alerted.length}, ended ${ended}`);
  return { alerted: alerted.length, ended };
}
