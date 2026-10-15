/** The CRM's settings document (GET /settings/app) — Settings → Idle alerts. The limit is in minutes. */
export interface AppSettings {
  key: "app";
  idleAlerts: { enabled: boolean; limitMinutes: number; notifyTeamLeaders: boolean };
  workingHours: { timezone: string; days: number[]; start: string; end: string };
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface AppSettingsResponse {
  settings: AppSettings;
}

/** A partial update: send only the groups that changed. */
export type AppSettingsUpdate = Partial<{
  idleAlerts: Partial<AppSettings["idleAlerts"]>;
  workingHours: Partial<AppSettings["workingHours"]>;
}>;
