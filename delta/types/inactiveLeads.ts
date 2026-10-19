import type { LeadStatus } from "@/types/lead";
import type { AppSettings } from "@/types/settings";

/** What the automatic mover will do with a lead on the list. */
export type AutoMoveState =
  | "due" //           moves at the next check in working hours
  | "off" //           automatic moves are switched off
  | "before_switch" // assigned before they were switched on — move it by hand
  | "stuck" //         nobody left in the team to take it
  | "no_team" | "excluded_source" //      it has no team to move within
  | "on_call"; //      its owner is on a 3CX call now — it waits, and call time doesn't count

export interface PersonRef {
  id: string;
  name: string;
}

/** GET /inactive-leads — one lead whose owner has not acted on it within the limit. */
export interface InactiveLead {
  id: string;
  name: string;
  phone: string;
  source: string | null;
  status: LeadStatus;
  team: { id: string; name: string } | null;
  owner: { id: string; name: string; email: string; active: boolean } | null;
  assignedAt: string;
  /** Working minutes since it was assigned. */
  waitingMinutes: number;
  moves: number;
  /** Everyone who lost it before — automatic moves never send it back to them. */
  lostBy: PersonRef[];
  autoMove: AutoMoveState;
  /** Every 3CX call on record for the lead, by anyone. */
  calls: { total: number; answered: number; lastAt: string | null };
}

export interface InactiveRule {
  limitMinutes: number;
  autoReassign: boolean;
  enabledAt: string | null;
  workingHours: AppSettings["workingHours"];
  inWorkingHours: boolean;
}

export interface InactiveLeadSummary {
  total: number;
  stuck: number;
  movedToday: number;
  /** More than the server lists at once — the oldest are shown. */
  capped: boolean;
}

export interface InactiveLeadsResponse {
  items: InactiveLead[];
  summary: InactiveLeadSummary;
  rule: InactiveRule;
}

export interface InactiveLeadFilters {
  page?: number;
  limit?: number;
  teamId?: string;
  ownerId?: string;
  search?: string;
  sort?: InactiveSort;
  /** yes: has at least one 3CX call on record · no: never called. */
  called?: "yes" | "no";
  /** Assigned between these Dubai days (YYYY-MM-DD). */
  dateFrom?: string;
  dateTo?: string;
}

export type InactiveSort = "waiting_desc" | "waiting_asc" | "calls_desc" | "calls_asc" | "moves_desc" | "owner_asc";
export type MovesSort = "newest" | "oldest" | "waited_desc";

/** GET /inactive-leads/teams — the page's team filter. */
export interface FilterTeam {
  id: string;
  name: string;
}

/** GET /inactive-leads/people — someone a lead can be moved to by hand. */
export interface MovePerson {
  id: string;
  name: string;
  email: string;
  designation: string | null;
}

/** GET /inactive-leads/moves — one lead moved on for inactivity. */
export interface LeadMoveEntry {
  id: string;
  lead: { id: string; name: string };
  team: { id: string; name: string } | null;
  from: PersonRef | null;
  to: PersonRef | null;
  kind: "automatic" | "manual";
  /** Who moved it by hand; null when the CRM did. */
  by: PersonRef | null;
  inactiveMinutes: number;
  createdAt: string;
}

export interface LeadMoveFilters {
  page?: number;
  limit?: number;
  kind?: "automatic" | "manual";
  teamId?: string;
  /** Lead name, or who it moved from or to. */
  search?: string;
  sort?: MovesSort;
  /** Moved between these Dubai days (YYYY-MM-DD). */
  dateFrom?: string;
  dateTo?: string;
}

/** POST /inactive-leads/reassign — no `to`: each lead goes to the next person in its team. */
export interface ReassignRequest {
  leadIds: string[];
  to?: string;
}

export interface ReassignResult {
  moved: Array<{ leadId: string; leadName: string; from: PersonRef; to: PersonRef }>;
  skipped: Array<{ leadId: string; leadName: string; reason: string }>;
}

/** Where the leads of a period went — the Workflow tab (GET /inactive-leads/workflow). */
export interface WorkflowCounts {
  came: number; assigned: number; unassigned: number; worked: number; fresh: number; inactive: number;
  movedAuto: number; movedHand: number; onBreak: number; nobodyLeft: number; waiting: number;
}

export interface WorkflowPerson {
  id: string; name: string; active: boolean; team: string | null;
  /** Leads of the period they held at some point: theirs now, or moved from or to them. */
  held: number;
  now: number; worked: number; fresh: number; inactiveNow: number;
  lost: number; got: number;
  statuses: Record<string, number>;
  breakMinutes: number;
}

export interface LeadWorkflow {
  generatedAt: string;
  period: { from: string; to: string; days: number };
  /** breaks: false — this CRM keeps no breaks. */
  rule: { limitMinutes: number; hours: { start: string; end: string }; timezone: string; breaks?: boolean };
  totals: WorkflowCounts & { moves: number };
  statuses: Array<{ status: string; count: number }>;
  timeline: { unit: "hour" | "day"; rows: Array<{ key: string; came: number }> };
  teams: Array<WorkflowCounts & { id: string | null; name: string; statuses: Record<string, number> }>;
  people: WorkflowPerson[];
  movesMap: Array<{ from: PersonRef; to: PersonRef; count: number; automatic: number }>;
}

export interface LeadWorkflowFilters {
  from?: string;
  to?: string;
  teamId?: string;
  personId?: string;
}
