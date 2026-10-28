/** The CRM's settings document (GET /settings/app) — Settings → Automation & alerts. Limits are in minutes. */
export interface AppSettings {
  key: "app";
  /** enabledAt: when automatic moves were last switched on (set by the server) — only leads assigned since then move on their own. */
  inactiveLeads: {
    autoReassign: boolean;
    limitMinutes: number;
    enabledAt: string | null;
    /** Lead sources the automatic mover never moves (matched without regard to case). */
    excludedSources?: string[];
  };
  idleAlerts: { enabled: boolean; limitMinutes: number; notifyTeamLeaders: boolean };
  /**
   * The rate a Bangalore enrolment's rupees count in the leaderboard, Sales TV and reports at: 1 AED = this many
   * rupees. Absent from a server older than 2026-10-28.
   */
  bangaloreRevenue?: { inrPerAed: number };
  workingHours: { timezone: string; days: number[]; start: string; end: string };
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface AppSettingsResponse {
  settings: AppSettings;
}

/** A partial update: send only the groups that changed. */
export type AppSettingsUpdate = Partial<{
  inactiveLeads: Partial<Omit<AppSettings["inactiveLeads"], "enabledAt">>;
  idleAlerts: Partial<AppSettings["idleAlerts"]>;
  workingHours: Partial<AppSettings["workingHours"]>;
  bangaloreRevenue: Partial<NonNullable<AppSettings["bangaloreRevenue"]>>;
}>;
