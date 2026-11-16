import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { sendError, sendSuccess } from "../utils/response.js";
import { markCounted, markNotCounted, notCountedStatus, NotCountedError } from "../services/notCountedService.js";

/** POST /leads/:id/not-counted { reason } — leave this closed sale out of the sales figures (2026-11-16). */
export const leaveOutOfSales = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    sendSuccess(res, "Not counted in sales", await markNotCounted(req.params.id, req.user!, String(req.body?.reason ?? "")));
  } catch (err) {
    if (err instanceof NotCountedError) { sendError(res, err.message, err.status); return; }
    next(err);
  }
};

/** DELETE /leads/:id/not-counted — count it again. */
export const countInSales = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    sendSuccess(res, "Counted in sales again", await markCounted(req.params.id, req.user!));
  } catch (err) {
    if (err instanceof NotCountedError) { sendError(res, err.message, err.status); return; }
    next(err);
  }
};

/** GET /leads/:id/not-counted — where its close stands, and whether this person may change it. */
export const notCountedState = async (req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> => {
  try {
    sendSuccess(res, "OK", await notCountedStatus(req.params.id, req.user!));
  } catch (err) {
    if (err instanceof NotCountedError) { sendError(res, err.message, err.status); return; }
    next(err);
  }
};
