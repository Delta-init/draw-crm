import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/axios";
import { toast } from "@/lib/toast";
import type {
  Enrolment, EnrolmentCorrectionInput, EnrolmentCorrectionStart, EnrolmentCounts, EnrolmentDetail, Student,
} from "@/types/student";

const KEY = ["enrolments"] as const;

export const useMyEnrolments = (filters: { mine?: boolean; search?: string; state?: string; page?: number; limit?: number }) =>
  useQuery({
    queryKey: [...KEY, filters],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filters.mine === false) params.set("mine", "false");
      if (filters.search) params.set("search", filters.search);
      if (filters.state) params.set("state", filters.state);
      if (filters.page) params.set("page", String(filters.page));
      if (filters.limit) params.set("limit", String(filters.limit));
      const res = await api.get<{
        success: boolean;
        data: Enrolment[];
        counts: EnrolmentCounts;
        pagination: { page: number; limit: number; total: number; pages: number };
      }>(`/students/enrolments/mine?${params.toString()}`);
      return res.data;
    },
    // Approval happens in another system, on somebody else's schedule — but
    // one on its way to finance (sent, or sent again) is looked at again in a
    // moment, so "Sending…" turns into what finance said without a reload.
    refetchInterval: (q) => ((q.state.data?.data ?? []).some((e) => e.handover?.status === "pending") ? 3_000 : 30_000),
  });

/** One enrolment, for its own page. */
export const useEnrolment = (id: string) =>
  useQuery({
    queryKey: [...KEY, "one", id],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: EnrolmentDetail }>(`/students/enrolments/${id}`);
      return res.data.data;
    },
    enabled: Boolean(id),
    // Sooner while it is on its way to finance, as on the list.
    refetchInterval: (q) => (q.state.data?.handover?.status === "pending" ? 3_000 : 30_000),
  });

export const useRequestInvoice = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (studentId: string) => {
      const res = await api.post<{ message: string }>(`/students/${studentId}/invoice`);
      return res.data;
    },
    onSuccess: (d) => {
      toast.success(d.message ?? "Sent to finance");
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["students"] });
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? "Could not send this to finance";
      toast.error(msg);
    },
  });
};

/** The correction's starting point — only asked for while it is wanted. */
export const useEnrolmentCorrection = (studentId: string, enabled = true) =>
  useQuery({
    queryKey: [...KEY, "correction", studentId],
    queryFn: async () => {
      const res = await api.get<{ success: boolean; data: EnrolmentCorrectionStart }>(`/students/${studentId}/correction`);
      return res.data.data;
    },
    enabled: Boolean(studentId) && enabled,
    // A 403 (not theirs) or 404 is an answer, not something to retry.
    retry: false,
    staleTime: 0,
  });

/** Save the correction and send it to finance again, in one step. */
export const useCorrectEnrolment = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: EnrolmentCorrectionInput }) => {
      const res = await api.put<{ message: string; data: Student }>(`/students/${id}/correction`, data);
      return res.data;
    },
    onSuccess: (d) => {
      toast.success(d.message ?? "Corrected and sent to finance");
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["students"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
        ?? "Could not save the correction";
      toast.error(msg);
    },
  });
};

/**
 * Where a send-back stands, from what finance says and what the outbox knows:
 * on its way back to finance (finance still says "returned" until it
 * arrives), sent back, or sent again since — the user, 2026-10-05: "if send
 * again show that also".
 */
export function sendBackState(e: Pick<Enrolment, "invoice" | "handover">) {
  const h = e.handover;
  const resending = h?.status === "pending" && Boolean(h?.resentAt);
  const sentBack = !resending && (e.invoice?.approval ?? h?.approvalState) === "returned";
  return {
    resending,
    sentBack,
    /** Sent again at least once and not sent back since. */
    sentAgain: !sentBack && Boolean(h?.resentAt),
    reason: e.invoice?.returnedReason || h?.returnedReason || "",
  };
}

/** "5 Oct, 3:42 pm", in the UAE — put together from parts, which read the same in every browser. */
const UAE_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
export function uaeTime(iso?: string | null): string {
  if (!iso) return "";
  const p = Object.fromEntries(UAE_TIME.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.day} ${p.month}, ${p.hour}:${p.minute} ${String(p.dayPeriod ?? "").toLowerCase()}`.trim();
}
