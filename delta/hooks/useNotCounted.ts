"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import api from "@/lib/axios";

/** A closed sale left out of the sales figures (2026-11-16) — backend services/notCountedService.ts. */
export interface NotCountedStatus {
  leadId: string;
  notCountedInSales: { at: string; byName: string; reason: string } | null;
  amount: number;
  commission: string | null;
  closed: boolean;
  mayMark: boolean;
}

const key = (leadId: string) => ["leads", leadId, "not-counted"] as const;
const errMsg = (e: unknown, fallback: string) =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback;

export const useNotCounted = (leadId: string, enabled = true) =>
  useQuery({
    queryKey: key(leadId),
    queryFn: async () => (await api.get(`/leads/${leadId}/not-counted`)).data.data as NotCountedStatus,
    enabled: enabled && !!leadId,
    staleTime: 30_000,
  });

export const useLeaveOutOfSales = (leadId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (reason: string) => (await api.post(`/leads/${leadId}/not-counted`, { reason })).data.data as NotCountedStatus,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads", leadId] });
      toast.success("Not counted in sales — off the TVs, leaderboard, reports and commission");
    },
    onError: (e: unknown) => toast.error(errMsg(e, "Could not leave it out")),
  });
};

export const useCountInSales = (leadId: string) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.delete(`/leads/${leadId}/not-counted`)).data.data as NotCountedStatus,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leads", leadId] });
      toast.success("Counted in sales again");
    },
    onError: (e: unknown) => toast.error(errMsg(e, "Could not count it again")),
  });
};
