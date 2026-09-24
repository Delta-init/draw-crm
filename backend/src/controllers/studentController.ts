import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { StudentService } from "../services/studentService.js";
import { sendSuccess, sendError } from "../utils/response.js";

const svc = new StudentService();

export const createStudent = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const student = await svc.createStudent(req.body);
    sendSuccess(res, "Student created", student, 201);
  } catch (err) { next(err); }
};

export const getStudents = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await svc.getStudents(req.query as Record<string, string>);
    res.json({ success: true, data: result.students, pagination: result.pagination });
  } catch (err) { next(err); }
};

export const getStudentById = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const student = await svc.getStudentById(req.params.id);
    sendSuccess(res, "Student fetched", student);
  } catch (err) { next(err); }
};

export const getStudentByLeadId = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const student = await svc.getStudentByLeadId(req.params.leadId);
    sendSuccess(res, "Student fetched", student ?? null);
  } catch (err) { next(err); }
};

export const updateStudent = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const student = await svc.updateStudent(req.params.id, req.body);
    sendSuccess(res, "Student updated", student);
  } catch (err) { next(err); }
};

export const deleteStudent = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await svc.deleteStudent(req.params.id);
    sendSuccess(res, "Student deleted", { deleted: result });
  } catch (err) { next(err); }
};

// ── Enrolments, and what finance made of them ────────────────────────────────

/**
 * A counsellor's own enrolments, each with the state of its invoice.
 *
 * Until now the only way to learn what happened to that invoice — whether
 * anybody approved it, whether it was sent back, whether it was ever raised
 * at all — was a finance login and a different application. This is that
 * answer, on the side of the wall where the question gets asked.
 */
export const getMyEnrolments = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.userId;
    if (!userId) return sendError(res, "Not authenticated", 401);
    const result = await svc.listEnrolments({
      ...(req.query as Record<string, string>),
      userId,
    });
    res.json({
      success: true,
      data: result.rows,
      counts: result.counts,
      pagination: result.pagination,
    });
  } catch (err) { next(err); }
};

/**
 * Send this enrolment to finance, or send it again.
 *
 * The queue row is upserted with $setOnInsert, so a row that already exists
 * keeps the payload it was created with — the snapshot of the sale. This
 * resets the schedule instead, which is what "try again now" means for one
 * that failed or is waiting on a backoff, and it builds a fresh payload for
 * one that was sent back — see requestInvoice's own doc comment.
 */
export const requestInvoice = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await svc.requestInvoice(req.params.id);
    if (!result.queued) return sendError(res, result.message, 409);
    sendSuccess(res, result.message, { queued: true });
  } catch (err) { next(err); }
};
