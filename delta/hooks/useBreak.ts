"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import api from "@/lib/axios";
import type { ApiResponse } from "@/types";
import { breakLabel, type BreakKind } from "@/lib/breaks";
import { ACTIVITY_KEY } from "@/hooks/useActivity";
import { INACTIVE_LEADS_KEY } from "@/hooks/useInactiveLeads";

/** My break — "Take break" (2026-10-20, as in the Sales CRM): the inactive-lead clock stops for my leads until it ends. */
export interface MyBreak { onBreak: boolean; since: string | null; kind?: BreakKind | null }
const BREAK_KEY = ["break"] as const;

export const useMyBreak = () =>
  useQuery({
    queryKey: BREAK_KEY,
    queryFn: async () => (await api.get<ApiResponse<MyBreak>>("/break")).data.data as MyBreak,
    staleTime: 30_000,
    refetchInterval: 5 * 60_000,
  });

export const useSetBreak = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ on, kind }: { on: boolean; kind?: BreakKind }) =>
      (await api.post<ApiResponse<MyBreak>>("/break", kind ? { on, kind } : { on })).data.data as MyBreak,
    onSuccess: (data) => {
      queryClient.setQueryData(BREAK_KEY, data);
      // Where a break shows: the Activity page (People, Attendance) and the Inactive leads page (on a break).
      queryClient.invalidateQueries({ queryKey: ACTIVITY_KEY });
      queryClient.invalidateQueries({ queryKey: INACTIVE_LEADS_KEY });
      toast.success(
        data.onBreak
          ? `${breakLabel(data.kind)} started — your leads won't go inactive until you end it`
          : "Break ended — your leads' clock is running again",
      );
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg ?? "Could not change your break");
    },
  });
};
