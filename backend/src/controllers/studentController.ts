import type { Request, Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { StudentService } from "../services/studentService.js";
import { sendSuccess, sendError } from "../utils/response.js";

const svc = new StudentService();

export const createStudent = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    // Who closed it, for the lead's history when the close fills in its email.
    const student = await svc.createStudent(req.body, req.user?.userId);
    sendSuccess(res, "Student created", student, 201);
  } catch (err) { next(err); }
};

/**
 * Take the payment receipt, before the enrolment that will carry it exists.
 *
 * Uploaded on its own rather than as part of the close, because the close
 * creates a student and hands it to finance in one go, and a multipart body
 * carrying both a file and the enrolment would have to be unpicked before
 * either could be validated. This returns a stored file; the close is then the
 * same JSON it always was, with the receipt named in it.
 *
 * Keyed under the lead, since that is what exists at the time.
 */
export const uploadPaymentReceipt = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const file = req.file;
    if (!file) return sendError(res, "No file was uploaded", 400);

    const { storageConfigured, uploadFile } = await import("../lib/storage.js");
    if (!storageConfigured()) {
      return sendError(res, "File storage is not configured, so a receipt cannot be taken", 503);
    }

    // The uploader's filename never becomes the key. It is theirs to choose,
    // and a key built from it could otherwise reach outside this prefix.
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
    const leadId = String(req.params.leadId ?? "unfiled").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
    const uploaded = await uploadFile({
      key: `enrolment-receipts/${leadId}/${Date.now()}-${safe}`,
      buffer: file.buffer,
      mimeType: file.mimetype,
      originalName: file.originalname,
    });

    sendSuccess(res, "Receipt uploaded", {
      name: file.originalname.slice(0, 200),
      url: uploaded.url,
      key: uploaded.key,
      size: uploaded.size,
      mimeType: uploaded.mimeType,
    });
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
