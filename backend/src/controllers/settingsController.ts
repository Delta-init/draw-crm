import type { Response, NextFunction } from "express";
import type { AuthenticatedRequest } from "../types/index.js";
import { getAppSettings, updateAppSettings } from "../services/settingsService.js";
import { updateAppSettingsSchema } from "../validations/settingsValidation.js";
import { sendSuccess, sendError } from "../utils/response.js";

// GET /api/v1/settings/app
export async function getAppSettingsHandler(_req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    sendSuccess(res, "Settings", { settings: await getAppSettings() });
  } catch (err) {
    next(err);
  }
}

// PUT /api/v1/settings/app
export async function updateAppSettingsHandler(req: AuthenticatedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const parsed = updateAppSettingsSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten());
      return;
    }
    const settings = await updateAppSettings(parsed.data, req.user!.userId);
    sendSuccess(res, "Settings saved", { settings });
  } catch (err) {
    next(err);
  }
}
