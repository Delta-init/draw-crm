"use client";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import api from "@/lib/axios";
import type { ApiResponse, PaginationMeta } from "@/types";
import type {
  AttendanceDay,
  AttendanceFilters,
  IdleStretchEntry,
  IdleStretchFilters,
  LoginEventEntry,
  LoginEventFilters,
  PeopleFilters,
  PeopleResponse,
} from "@/types/activity";

export const ACTIVITY_KEY = ["activity"] as const;

/** Drops empty filters so the query string only carries what is set. */
function params<T extends object>(filters: T): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(filters).filter(([, v]) => v !== undefined && v !== "" && v !== null)
  ) as Record<string, string | number>;
}

/** Everyone and where they are — refreshes every 30 s, like the heartbeats it reads. */
export const useActivityPeople = (filters: PeopleFilters, enabled = true) =>
  useQuery({
    queryKey: [...ACTIVITY_KEY, "people", filters],
    enabled,
    queryFn: async () =>
      (await api.get<ApiResponse<PeopleResponse>>("/activity/people", { params: params(filters) })).data.data!,
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });

export const useLoginEvents = (filters: LoginEventFilters, enabled = true) =>
  useQuery({
    queryKey: [...ACTIVITY_KEY, "logins", filters],
    enabled,
    queryFn: async () => {
      const res = await api.get<ApiResponse<LoginEventEntry[]>>("/activity/logins", { params: params(filters) });
      return { items: res.data.data ?? [], pagination: res.data.pagination as PaginationMeta };
    },
    placeholderData: keepPreviousData,
  });

export const useIdleStretches = (filters: IdleStretchFilters, enabled = true) =>
  useQuery({
    queryKey: [...ACTIVITY_KEY, "idle", filters],
    enabled,
    queryFn: async () => {
      const res = await api.get<ApiResponse<IdleStretchEntry[]>>("/activity/idle", { params: params(filters) });
      return { items: res.data.data ?? [], pagination: res.data.pagination as PaginationMeta };
    },
    placeholderData: keepPreviousData,
  });

/**
 * The Attendance tab: the HRMS's shift and the day's clock-ins and clock-outs (GET /activity/attendance). Today's
 * refreshes every minute — the HRMS's answer is kept a minute on the server.
 */
export const useAttendance = (filters: AttendanceFilters, enabled = true) =>
  useQuery({
    queryKey: [...ACTIVITY_KEY, "attendance", filters],
    enabled,
    queryFn: async () =>
      (await api.get<ApiResponse<AttendanceDay>>("/activity/attendance", { params: params(filters) })).data.data!,
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.today ? 60_000 : false),
  });

/** One team's attendance, on its page — its leaders, or a role with the Activity box (GET /teams/:id/attendance). */
export const useTeamAttendance = (teamId: string, day: string | undefined, enabled = true) =>
  useQuery({
    queryKey: [...ACTIVITY_KEY, "team-attendance", teamId, day ?? "today"],
    enabled: enabled && !!teamId,
    queryFn: async () =>
      (await api.get<ApiResponse<AttendanceDay>>(`/teams/${teamId}/attendance`, { params: day ? { day } : {} })).data.data!,
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.today ? 60_000 : false),
    retry: (count, err) => (err as { response?: { status?: number } })?.response?.status !== 403 && count < 2,
  });
