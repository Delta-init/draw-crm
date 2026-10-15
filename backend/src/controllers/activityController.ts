import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { listIdleStretches, listLoginEvents, listPeople, recordHeartbeat } from "../services/activityService.js";
import { heartbeatSchema, attendanceQuery, idleStretchesQuery, loginEventsQuery, peopleQuery, teamAttendanceQuery } from "../validations/activityValidation.js";
import { sendSuccess, sendError } from "../utils/response.js";
import { attendanceForDay, dubaiToday, leadsTeam, teamPeople } from "../services/attendanceDayService.js";

// POST /api/v1/activity/heartbeat — anyone signed in; the web app sends it every minute it is open.
export async function heartbeatHandler(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = heartbeatSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten());
      return;
    }
    await recordHeartbeat(req.user!.userId, parsed.data.active);
    sendSuccess(res, "OK");
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/activity/people
export async function peopleHandler(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = peopleQuery.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten());
      return;
    }
    sendSuccess(res, "People", await listPeople(parsed.data));
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/activity/logins
export async function loginEventsHandler(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = loginEventsQuery.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten());
      return;
    }
    const { items, pagination } = await listLoginEvents(parsed.data);
    sendSuccess(res, "Sign-ins", items, 200, pagination);
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/activity/idle
export async function idleStretchesHandler(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = idleStretchesQuery.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten());
      return;
    }
    const { items, pagination } = await listIdleStretches(parsed.data);
    sendSuccess(res, "Idle alerts", items, 200, pagination);
  } catch (err) {
    next(err);
  }
}

// GET /api/v1/activity/attendance — the Activity page's Attendance tab: the HRMS's shift and the day's clock-ins.
export async function attendanceHandler(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = attendanceQuery.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten());
      return;
    }
    sendSuccess(res, "Attendance", await attendanceForDay({ ...parsed.data, day: parsed.data.day ?? dubaiToday() }));
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/teams/:id/attendance — the same for one team's leaders and members, on its page. Clock-in times are
 * not every colleague's business: the Super Admin, a role with the Activity box, or one of this team's leaders.
 */
export async function teamAttendanceHandler(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = teamAttendanceQuery.safeParse(req.query);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten());
      return;
    }
    const role = req.user?.role;
    const allowed = (role?.isSystemRole && role.roleName === "Super Admin") || role?.permissions?.activity?.view === true
      || (await leadsTeam(req.user!.userId, req.params.id));
    if (!allowed) {
      sendError(res, "Only this team's leaders, or a role with the Activity box, see its attendance", 403);
      return;
    }
    if (!(await teamPeople(req.params.id))) {
      sendError(res, "Team not found", 404);
      return;
    }
    sendSuccess(res, "Team attendance", await attendanceForDay({ day: parsed.data.day ?? dubaiToday(), teamId: req.params.id }));
  } catch (err) {
    next(err);
  }
}
