"use client";

import { useState } from "react";
import { Clock, Lock, RefreshCw } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useTeamAttendance } from "@/hooks/useActivity";
import { AttendanceTable } from "@/components/activity/AttendanceTable";
import { EmptyState } from "@/components/shared/ListStates";

/** Today in Dubai, "YYYY-MM-DD" — the sales floor's day, and the HRMS's. */
const dubaiToday = () => new Date(Date.now() + 4 * 3_600_000).toISOString().slice(0, 10);

/**
 * A team's attendance on its page (the user, 2026-10-15): the HRMS shift and each leader's and member's clock-ins and
 * clock-outs for a day — today by default. Its leaders, or a role with the Activity box.
 */
export function TeamAttendanceTab({ teamId }: { teamId: string }) {
  const [day, setDay] = useState(dubaiToday);
  const { data, isLoading, isFetching, error, refetch } = useTeamAttendance(teamId, day === dubaiToday() ? undefined : day);
  // Not theirs to see (a leader no longer, a role changed since the page loaded): say so, not "try again".
  const refused = (error as { response?: { status?: number } } | null)?.response?.status === 403;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <Clock className="h-4 w-4 text-primary" /> Attendance
          </h2>
          <p className="text-xs text-muted-foreground">Shift and clock-ins from the HRMS{data?.today ? " — refreshed every minute" : ""}.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="date"
            value={day}
            max={dubaiToday()}
            onChange={(e) => e.target.value && setDay(e.target.value)}
            className="h-9 w-40 dark:[color-scheme:dark]"
            aria-label="Day"
          />
          {day !== dubaiToday() && (
            <Button variant="outline" size="sm" className="h-9" onClick={() => setDay(dubaiToday())}>
              Today
            </Button>
          )}
          <Button variant="ghost" size="icon" className="h-9 w-9" onClick={() => refetch()} aria-label="Refresh">
            <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
          </Button>
        </div>
      </div>
      <Card className="overflow-hidden border-border/50">
        <CardContent className="p-0">
          {refused ? (
            <EmptyState icon={Lock} title="Not yours to see" text="Only this team's leaders, and people with the Activity permission, see its attendance." action={null} />
          ) : (
            <AttendanceTable data={data} isLoading={isLoading} error={error} onRetry={() => refetch()} showTeams={false} emptyText="Nobody in this team yet." />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
