import { Types } from "mongoose";
import { User } from "../models/User.js";
import { Team } from "../models/Team.js";
import { Student } from "../models/Student.js";
import { LeaderboardService } from "./leaderboardService.js";
import { saleClosedOf } from "./saleAnnouncement.js";
import { drawMidnight } from "./breakClock.js";

/*
 * The Root portal's Sales TV (the user, 2026-10-20: "Dubai, Draw and Remote on
 * one screen — closings and calls, only the sales staff, the closing pop-up
 * with the amount and the sound, and who is on a break"). What this CRM tells
 * it, over GET /api/v1/service/sales-tv — the same shape as the Sales CRM's:
 *
 *   people    the sales staff — members and leaders of an active team,
 *             active, a Super Admin too when in one (the CRM's own
 *             Leaderboard leaves them out), not excluded from commission —
 *             with this month's and today's (Draw's day, DRAW_TZ) closings,
 *             this month's revenue, and today's 3CX calls, connected and
 *             talk time (the Leaderboard's own counts)
 *   onBreak   who pressed "Take break" today and hasn't ended it
 *   closes    closes after `after` (an instant; else the last two hours; never
 *             more than a day back), the newest 20 — what the sale-closed
 *             pop-up says (saleAnnouncement.ts), with the amount, never the
 *             student's name
 *
 * `parts=live` answers only onBreak and closes — cheap, for every few seconds;
 * the people's counts come every half minute or so. Read-only.
 */

export const SALES_TV_CRM = "draw";
const DAY_MS = 86_400_000;

/** Each member or leader of an active team → that team's name (the first one found). */
async function teamPeople(): Promise<Map<string, string>> {
  const teams = await Team.find({ status: "active" }).select("name members leaders").lean<Array<{ name: string; members?: Types.ObjectId[]; leaders?: Types.ObjectId[] }>>();
  const teamOf = new Map<string, string>();
  for (const t of teams) for (const u of [...(t.leaders ?? []), ...(t.members ?? [])]) if (!teamOf.has(String(u))) teamOf.set(String(u), t.name);
  return teamOf;
}

export interface SalesTvPerson {
  id: string; name: string; email: string; team: string;
  closingsMonth: number; closingsToday: number; revenueMonth: number;
  callsToday: number; connectedToday: number; talkSecondsToday: number;
}

export interface SalesTvBreak { id: string; name: string; email: string; team: string; since: string; kind: string | null }

export interface SalesTvClose {
  id: string; closer: string; closerEmail: string; courses: string[]; amount: number;
  academy: "dubai" | "bangalore"; currency: "AED" | "INR"; at: string;
}

export interface SalesTv {
  crm: typeof SALES_TV_CRM;
  generatedAt: string;
  month?: string;
  onBreak: SalesTvBreak[];
  closes: SalesTvClose[];
  people?: SalesTvPerson[];
}

export async function salesTv(q: { after?: string; parts?: string }): Promise<SalesTv> {
  const now = Date.now();
  const teamOf = await teamPeople();
  const since = q.after && Number.isFinite(Date.parse(q.after)) ? new Date(Math.max(Date.parse(q.after), now - DAY_MS)) : new Date(now - 2 * 3_600_000);
  const midnight = drawMidnight(new Date(now));

  const [breakers, closed] = await Promise.all([
    User.find({ status: "active", breakSince: { $gte: midnight } }).select("name email breakSince breakKind")
      .lean<Array<{ _id: Types.ObjectId; name: string; email: string; breakSince: Date; breakKind?: string | null }>>(),
    Student.find({ createdAt: { $gt: since }, status: { $ne: "dropped" } }).sort({ createdAt: -1 }).limit(20)
      .populate("courses", "name").populate("assignedTo", "name email")
      .select("courses assignedTo totalFee academy createdAt")
      .lean<Array<{ _id: Types.ObjectId; courses?: unknown; assignedTo?: { name?: string; email?: string } | null; totalFee?: number; academy?: string; createdAt: Date }>>(),
  ]);
  const onBreak: SalesTvBreak[] = breakers.map((u) => ({
    id: String(u._id), name: u.name, email: u.email, team: teamOf.get(String(u._id)) ?? "", since: new Date(u.breakSince).toISOString(), kind: u.breakKind ?? null,
  }));
  const closes: SalesTvClose[] = closed.map((s) => {
    // The pop-up's own words, less the student's name: this is a public screen. The fee is in the academy's currency
    // (Dubai AED, Bangalore INR — the close's own rule, models/Student.ts).
    const { student: _student, ...c } = saleClosedOf(s);
    return {
      ...c,
      at: new Date(s.createdAt).toISOString(),
      closerEmail: String(s.assignedTo?.email ?? ""),
      currency: c.academy === "bangalore" ? "INR" : "AED",
    };
  });

  const base: SalesTv = { crm: SALES_TV_CRM, generatedAt: new Date(now).toISOString(), onBreak, closes };
  if (q.parts === "live") return base;

  // Super Admins too, but only those in an active team (filtered below) — dilshad leads Remote's team (2026-10-20).
  const board = await new LeaderboardService().getLeaderboard(undefined, "revenue", { withSuperAdmins: true });
  const todayClosings = await Student.aggregate<{ _id: Types.ObjectId | null; n: number }>([
    { $match: { enrollmentDate: { $gte: midnight, $lt: new Date(midnight.getTime() + DAY_MS) }, status: { $ne: "dropped" } } },
    { $group: { _id: "$assignedTo", n: { $sum: 1 } } },
  ]);
  const today = new Map(todayClosings.filter((r) => r._id).map((r) => [String(r._id), r.n]));
  const ids = board.rows.map((r) => r.userId).filter((id) => teamOf.has(id));
  const emails = new Map(
    (await User.find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) } }).select("email").lean<Array<{ _id: Types.ObjectId; email: string }>>())
      .map((u) => [String(u._id), u.email]),
  );
  const people: SalesTvPerson[] = board.rows.filter((r) => teamOf.has(r.userId)).map((r) => ({
    id: r.userId, name: r.name, email: emails.get(r.userId) ?? "", team: teamOf.get(r.userId) ?? "",
    closingsMonth: r.closings, closingsToday: today.get(r.userId) ?? 0, revenueMonth: r.revenue,
    callsToday: r.callsToday, connectedToday: r.connectedToday, talkSecondsToday: r.talkSecondsToday,
  })).sort((a, b) => b.closingsMonth - a.closingsMonth || b.closingsToday - a.closingsToday || b.callsToday - a.callsToday
    || b.talkSecondsToday - a.talkSecondsToday || a.name.localeCompare(b.name));
  return { ...base, month: board.month, people };
}
