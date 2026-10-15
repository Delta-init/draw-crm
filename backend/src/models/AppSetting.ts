import mongoose, { Schema } from "mongoose";
import type { IAppSettings } from "../types/index.js";

/**
 * The CRM's own settings — one document, keyed "app" (2026-10-15, with the
 * Activity page, as in the Sales CRM).
 *
 * What Settings → Idle alerts edits: when an idle employee is flagged, and the
 * working hours that counts in — by default 10:00–19:00 GST, Monday to
 * Saturday. No email: this CRM tells people in the app and by push. Read
 * through settingsService, which caches it for the scheduler that asks every
 * minute.
 */
const appSettingSchema = new Schema<IAppSettings>(
  {
    key: { type: String, enum: ["app"], default: "app", unique: true },

    idleAlerts: {
      enabled:           { type: Boolean, default: false },
      limitMinutes:      { type: Number, default: 30, min: 5, max: 24 * 60 },
      notifyTeamLeaders: { type: Boolean, default: false },
    },

    workingHours: {
      timezone: { type: String, default: "Asia/Dubai" },
      days:     { type: [Number], default: [1, 2, 3, 4, 5, 6] },
      start:    { type: String, default: "10:00" },
      end:      { type: String, default: "19:00" },
    },

    updatedBy: { type: Schema.Types.ObjectId, ref: "User", default: null },
  },
  { timestamps: true, versionKey: false }
);

export const AppSetting = mongoose.model<IAppSettings>("AppSetting", appSettingSchema);
