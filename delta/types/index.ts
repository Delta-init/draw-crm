// ─── Permissions ──────────────────────────────────────────────────────────────
export type PermissionAction = "view" | "create" | "edit" | "delete" | "approve" | "export";

export interface ModulePermissions {
  view: boolean;
  create: boolean;
  edit: boolean;
  delete: boolean;
  approve: boolean;
  export: boolean;
}

export const CRM_MODULES = [
  "dashboard",
  "users",
  "roles",
  "leads",
  "teams",
  "courses",
  "reminders",
  "reports",
  "settings",
  /*
   * Rows added 2026-10-07. Students and My Tracker were already modules on the
   * server but never had a row here; the rest were open to everyone — see
   * OPEN_BY_DEFAULT.
   */
  "students",
  "tracker",
  "mentors",
  "commission",
  "leaderboard",
] as const;

export type CrmModule = (typeof CRM_MODULES)[number];

export const MODULE_LABELS: Record<CrmModule, string> = {
  dashboard: "Dashboard",
  users: "Users",
  roles: "Roles & Permissions",
  leads: "Leads",
  teams: "Teams",
  courses: "Courses",
  reminders: "Reminders",
  reports: "Reports",
  settings: "Settings",
  students: "Students",
  tracker: "My Tracker",
  mentors: "Mentors (booking)",
  commission: "Commission",
  leaderboard: "Leaderboard",
};

export type PermissionsMap = Partial<Record<CrmModule, ModulePermissions>>;

const NONE: ModulePermissions = { view: false, create: false, edit: false, delete: false, approve: false, export: false };

/**
 * Screens that were open to everyone before they had a row on the Roles screen
 * (2026-10-07). A role that has never been given a value for one keeps that
 * access — the same default the server holds — so nothing disappears until
 * someone unticks the box.
 */
export const OPEN_BY_DEFAULT: Partial<Record<CrmModule, Partial<ModulePermissions>>> = {
  mentors: { view: true, create: true, edit: true, delete: true },
  commission: { view: true },
  leaderboard: { view: true },
  tracker: { view: true, edit: true },
};

/** A role's permissions on one module — what it was given, or the module's default. */
export function modulePermissions(perms: PermissionsMap | undefined, mod: CrmModule): ModulePermissions {
  return perms?.[mod] ?? { ...NONE, ...OPEN_BY_DEFAULT[mod] };
}

// ─── Role ─────────────────────────────────────────────────────────────────────
export interface Role {
  _id: string;
  roleName: string;
  description?: string;
  permissions: PermissionsMap;
  isSystemRole: boolean;
  createdAt: string;
  updatedAt: string;
}

export type RoleSimple = Pick<Role, "_id" | "roleName" | "description" | "isSystemRole">;

// ─── User ─────────────────────────────────────────────────────────────────────
export interface User {
  _id: string;
  name: string;
  email: string;
  role: Role | string;
  designation?: string;
  extension?: string | null;   // 3CX phone extension e.g. "101"
  status: "active" | "inactive";
  createdAt: string;
  updatedAt: string;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
export interface AuthUser {
  _id: string;
  name: string;
  email: string;
  role: Role;
  designation?: string;
  extension?: string | null;
  status: "active" | "inactive";
}

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

// ─── API ──────────────────────────────────────────────────────────────────────
export interface ApiResponse<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
  errors?: unknown;
  pagination?: PaginationMeta;
}

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPrevPage: boolean;
}

export interface PaginatedResult<T> {
  data: T[];
  pagination: PaginationMeta;
}
