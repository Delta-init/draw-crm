"use client";

import { motion } from "framer-motion";
import { AlertTriangle, Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorState, TableSkeleton } from "@/components/shared/ListStates";
import { cn } from "@/lib/utils";
import { listContainerVariants, listItemVariants } from "@/lib/animations";
import { breakLabel } from "@/lib/breaks";
import type { AttendanceDay, AttendancePerson, AttendanceShift } from "@/types/activity";

/*
 * A day's attendance from the HRMS (the user, 2026-10-15): each person's shift, when they clocked in and out —
 * every session — worked time, how late, the day's status, and where they are now (today: this CRM's break first —
 * "Take break", 2026-10-20). The Activity page's Attendance tab and a team's page both show it, as in the Sales CRM.
 */

type BadgeVariant = "default" | "secondary" | "warning" | "success" | "destructive" | "outline";

const fallbackZone = "Asia/Dubai";

/** "09:57" in the shift's time zone — or Dubai's, when the HRMS has a zone the browser doesn't know. */
export function clockAt(iso: string, timeZone: string): string {
  const opts = { hour: "2-digit", minute: "2-digit" } as const;
  try {
    return new Date(iso).toLocaleTimeString("en-GB", { ...opts, timeZone });
  } catch {
    return new Date(iso).toLocaleTimeString("en-GB", { ...opts, timeZone: fallbackZone });
  }
}

function fmtMinutes(total: number): string {
  const m = Math.max(0, Math.floor(total));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${r}m`;
  return r ? `${h}h ${r}m` : `${h}h`;
}

/** "10:00–19:00", or "8 h a day" for a shift counted in hours. */
export const shiftText = (shift: AttendanceShift | null | undefined): string =>
  shift ? (shift.mode === "duration" && shift.requiredHours ? `${shift.requiredHours} h a day` : `${shift.from}–${shift.to}`) : "—";

/** The day, in a word: the HRMS's status — or, with no record, leave, a day off, not in yet, or nothing on record. */
export function dayBadge(p: AttendancePerson, today: boolean): { label: string; variant: BadgeVariant } | null {
  if (!p.inHrms) return null;
  // Today every row the HRMS could read says where they are; one it couldn't ("now" empty) gets no guess.
  if (today && p.now === null) return null;
  const leave = p.leave ? `On leave${p.leave.type ? ` · ${p.leave.type}` : ""}${p.leave.halfDay ? " (half day)" : ""}` : null;
  switch (p.status) {
    case "present": return { label: p.wfh ? "Present · WFH" : "Present", variant: "success" };
    case "late": return { label: `Late${p.lateMinutes ? ` · ${fmtMinutes(p.lateMinutes)}` : ""}`, variant: "warning" };
    case "half_day": return { label: "Half day", variant: "secondary" };
    case "early_out": return { label: "Left early", variant: "warning" };
    case "on_leave": return { label: leave ?? "On leave", variant: "secondary" };
    case "absent": return { label: "Absent", variant: "destructive" };
    case "holiday": return { label: "Holiday", variant: "outline" };
    case "weekend": return { label: "Day off", variant: "outline" };
    case "wfh": return { label: "Working from home", variant: "success" };
    default: break;
  }
  if (leave) return { label: leave, variant: "secondary" };
  if (p.workDay === false) return { label: "Day off", variant: "outline" };
  return today ? { label: "Not in yet", variant: "warning" } : { label: "No record", variant: "destructive" };
}

/** Where they are now (today only). */
export function nowBadge(p: AttendancePerson, timeZone: string): { label: string; variant: BadgeVariant } | null {
  switch (p.now) {
    case "in": return { label: "Clocked in", variant: "success" };
    case "break": {
      const what = p.breakKind ? breakLabel(p.breakKind) : "On a break";
      return { label: p.breakSince ? `${what} · since ${clockAt(p.breakSince, timeZone)}` : what, variant: "warning" };
    }
    case "out": return { label: p.firstIn ? "Clocked out" : p.workDay === false ? "Day off" : "Not clocked in", variant: "outline" };
    case "leave": return { label: "On leave", variant: "secondary" };
    default: return null;
  }
}

/** A session still open: "now" today; on a past day, a clock-out that never came. */
function OpenEnd({ today }: { today: boolean }) {
  return today
    ? <span className="text-emerald-600 dark:text-emerald-400">now</span>
    : <span className="text-amber-600 dark:text-amber-400">no out</span>;
}

function Sessions({ p, timeZone, today }: { p: AttendancePerson; timeZone: string; today: boolean }) {
  if (!p.sessions.length) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex flex-wrap gap-x-2 gap-y-0.5 font-mono text-[11px]">
      {p.sessions.map((s, i) => (
        <span key={i} className="whitespace-nowrap">
          {clockAt(s.in, timeZone)}–{s.out ? clockAt(s.out, timeZone) : <OpenEnd today={today} />}
        </span>
      ))}
    </span>
  );
}

/** The Out column: the last clock-out; while still in, "still in" — or, on a past day, the clock-out that's missing. */
function OutCell({ p, timeZone, today }: { p: AttendancePerson; timeZone: string; today: boolean }) {
  if (p.lastOut) return <span className="font-semibold">{clockAt(p.lastOut, timeZone)}</span>;
  if (!p.firstIn) return <>—</>;
  return today
    ? <span className="text-emerald-600 dark:text-emerald-400">still in</span>
    : <span className="text-amber-600 dark:text-amber-400">no clock-out</span>;
}

function SummaryChips({ data }: { data: AttendanceDay }) {
  const s = data.summary;
  const chips: Array<{ label: string; value: number; tone: string; show: boolean }> = [
    { label: "Clocked in", value: s.clockedIn, tone: "text-emerald-600 dark:text-emerald-400", show: data.today },
    { label: "On a break", value: s.onBreak, tone: "text-amber-600 dark:text-amber-400", show: data.today },
    { label: data.today ? "Not in yet" : "No record", value: s.notIn, tone: "text-red-600 dark:text-red-400", show: true },
    { label: "On leave", value: s.onLeave, tone: "text-muted-foreground", show: true },
    { label: "Late", value: s.late, tone: "text-amber-600 dark:text-amber-400", show: true },
    { label: "Not in the HRMS", value: s.notInHrms, tone: "text-muted-foreground", show: s.notInHrms > 0 },
  ];
  return (
    <div className="flex flex-wrap gap-2 border-b border-border/50 px-4 py-3">
      {chips.filter((c) => c.show).map((c) => (
        <span key={c.label} className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-muted/30 px-2.5 py-1 text-xs">
          <span className={cn("font-semibold tabular-nums", c.tone)}>{c.value}</span>
          <span className="text-muted-foreground">{c.label}</span>
        </span>
      ))}
    </div>
  );
}

/** Why there are no shifts: the HRMS isn't linked to this CRM at all, or it didn't answer just now. */
function Unavailable({ data }: { data: AttendanceDay }) {
  return (
    <div className="flex items-start gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 dark:text-amber-300">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>
        {data.linked === false
          ? "The HRMS isn't linked to this CRM yet — shifts and clock-ins show here once it is."
          : `The HRMS didn't answer, so shifts and clock-ins can't be shown just now${data.message ? ` — ${data.message}` : ""}.`}
      </span>
    </div>
  );
}

export function AttendanceTable({
  data,
  isLoading,
  error,
  onRetry,
  showTeams = true,
  emptyText = "Nobody matches — try clearing the search or the team.",
}: {
  data: AttendanceDay | undefined;
  isLoading: boolean;
  error: unknown;
  onRetry: () => void;
  showTeams?: boolean;
  emptyText?: string;
}) {
  if (isLoading && !data) return <TableSkeleton />;
  if (error && !data) {
    const reason = (error as { response?: { data?: { message?: string } } }).response?.data?.message;
    return <ErrorState onRetry={onRetry} text={reason} />;
  }
  if (!data) return null;
  if (!data.rows.length) return <EmptyState icon={Clock} title="Nobody here" text={emptyText} action={null} />;
  const zone = (p: AttendancePerson) => p.shift?.timeZone || fallbackZone;
  // With no answer from the HRMS, nobody is "not in the HRMS" — it just can't say.
  const hrmsLine = (p: AttendancePerson) => (p.inHrms ? null : data.available ? "Not in the HRMS" : "—");

  return (
    <>
      {!data.available && <Unavailable data={data} />}
      {data.available && <SummaryChips data={data} />}

      {/* ── Phones and tablets ── */}
      <motion.ul key={`cards-${data.day}`} variants={listContainerVariants} initial="hidden" animate="visible" className="divide-y divide-border/30 lg:hidden">
        {data.rows.map((p) => {
          const day = dayBadge(p, data.today);
          const now = nowBadge(p, zone(p));
          return (
            <motion.li key={p.id} variants={listItemVariants} className="space-y-2 px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium">{p.name}</p>
                  {showTeams && p.teams.length > 0 && <p className="truncate text-xs text-muted-foreground">{p.teams.join(", ")}</p>}
                  {/* Its own line, so wide badges never cut the shift short. */}
                  <p className="text-xs text-muted-foreground">
                    {p.inHrms ? <>Shift <span className="font-mono font-semibold text-foreground">{shiftText(p.shift)}</span></> : hrmsLine(p)}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  {now && <Badge variant={now.variant} className="whitespace-nowrap text-[11px]">{now.label}</Badge>}
                  {day && <Badge variant={day.variant} className="whitespace-nowrap text-[11px]">{day.label}</Badge>}
                </div>
              </div>
              {p.inHrms && (
                <dl className="grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <dt className="text-muted-foreground">In</dt>
                    <dd className="font-mono font-semibold">{p.firstIn ? clockAt(p.firstIn, zone(p)) : "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Out</dt>
                    <dd className="font-mono"><OutCell p={p} timeZone={zone(p)} today={data.today} /></dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Worked</dt>
                    <dd className="font-mono font-semibold">{p.workedMinutes ? fmtMinutes(p.workedMinutes) : "—"}</dd>
                  </div>
                  {p.sessions.length > 1 && (
                    <div className="col-span-3">
                      <dt className="text-muted-foreground">Sessions</dt>
                      <dd><Sessions p={p} timeZone={zone(p)} today={data.today} /></dd>
                    </div>
                  )}
                </dl>
              )}
            </motion.li>
          );
        })}
      </motion.ul>

      {/* ── Desktop ── */}
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/50 bg-muted/30 text-left text-xs text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Person</th>
              <th className="px-3 py-2.5 font-medium">Shift</th>
              <th className="px-3 py-2.5 font-medium">In</th>
              <th className="px-3 py-2.5 font-medium">Out</th>
              <th className="px-3 py-2.5 font-medium">Sessions</th>
              <th className="px-3 py-2.5 font-medium">Worked</th>
              <th className="px-3 py-2.5 font-medium">Day</th>
              {data.today && <th className="px-3 py-2.5 font-medium">Now</th>}
            </tr>
          </thead>
          <motion.tbody key={data.day} variants={listContainerVariants} initial="hidden" animate="visible">
            {data.rows.map((p) => {
              const day = dayBadge(p, data.today);
              const now = nowBadge(p, zone(p));
              return (
                <motion.tr key={p.id} variants={listItemVariants} className="border-b border-border/30 align-top transition-colors hover:bg-muted/20">
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-muted-foreground">{(showTeams && p.teams.join(", ")) || p.designation || p.email}</div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5">
                    {p.inHrms ? (
                      <>
                        <div className="font-mono text-xs font-semibold">{shiftText(p.shift)}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {p.shift?.assigned ? p.shift.name : "HRMS default"}
                          {p.workDay === false ? " · day off" : ""}
                        </div>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">{hrmsLine(p)}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs font-semibold">{p.firstIn ? clockAt(p.firstIn, zone(p)) : "—"}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs"><OutCell p={p} timeZone={zone(p)} today={data.today} /></td>
                  <td className="px-3 py-2.5"><Sessions p={p} timeZone={zone(p)} today={data.today} /></td>
                  <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs">{p.workedMinutes ? fmtMinutes(p.workedMinutes) : "—"}</td>
                  <td className="px-3 py-2.5">
                    {day ? <Badge variant={day.variant} className="whitespace-nowrap text-[11px]">{day.label}</Badge> : <span className="text-xs text-muted-foreground">—</span>}
                  </td>
                  {data.today && (
                    <td className="px-3 py-2.5">
                      {now ? <Badge variant={now.variant} className="whitespace-nowrap text-[11px]">{now.label}</Badge> : <span className="text-xs text-muted-foreground">—</span>}
                    </td>
                  )}
                </motion.tr>
              );
            })}
          </motion.tbody>
        </table>
      </div>
    </>
  );
}
