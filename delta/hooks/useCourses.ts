"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/lib/toast";
import api from "@/lib/axios";
import type { ApiResponse } from "@/types";
import type { Course, CourseFilters, FinanceItem, LmsCourse } from "@/types/course";

const COURSES_KEY = ["courses"] as const;

function errMsg(error: unknown, fallback: string) {
  return (
    (error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? fallback
  );
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export const useCourses = (filters?: CourseFilters) => {
  return useQuery({
    queryKey: [...COURSES_KEY, filters],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (filters?.page)   params.page   = String(filters.page);
      if (filters?.limit)  params.limit  = String(filters.limit);
      if (filters?.status) params.status = filters.status;
      if (filters?.search) params.search = filters.search;
      const response = await api.get<ApiResponse<Course[]>>("/courses", { params });
      return { data: response.data.data ?? [], pagination: response.data.pagination };
    },
  });
};

/** Fetch all active courses (for dropdowns) */
export const useAllCourses = () => {
  return useQuery({
    queryKey: [...COURSES_KEY, "all"],
    queryFn: async () => {
      const response = await api.get<ApiResponse<Course[]>>("/courses/all");
      return response.data.data ?? [];
    },
  });
};

export const useCourse = (id: string) => {
  return useQuery({
    queryKey: [...COURSES_KEY, id],
    queryFn: async () => {
      const response = await api.get<ApiResponse<Course>>(`/courses/${id}`);
      return response.data.data!;
    },
    enabled: !!id,
  });
};

// ─── Mutations ────────────────────────────────────────────────────────────────

export const useCreateCourse = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: { name: string; description?: string; amount: number; bonusAmount?: number; status?: string }) => {
      const response = await api.post<ApiResponse<Course>>("/courses", data);
      return response.data.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: COURSES_KEY });
      toast.success("Course created successfully");
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to create course")),
  });
};

export const useUpdateCourse = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: Partial<{ name: string; description: string; amount: number; bonusAmount: number; status: string }> }) => {
      const response = await api.put<ApiResponse<Course>>(`/courses/${id}`, data);
      return response.data.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: COURSES_KEY });
      toast.success("Course updated successfully");
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to update course")),
  });
};

export const useDeleteCourse = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/courses/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: COURSES_KEY });
      toast.success("Course deleted successfully");
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to delete course")),
  });
};

// ─── Academies ────────────────────────────────────────────────────────────────

/**
 * Whether this server takes Bangalore closes (the user, 2026-10-10): true only
 * when it says so — its finance organization for Bangalore is set. The web goes
 * live on push and the server by hand, so a server from before (which answers
 * this with an error) or one not set up yet reads as false: no Academy choice,
 * every close Dubai, as before.
 */
export const useBangaloreOffered = (enabled = true) =>
  useQuery({
    queryKey: ["close-academies"],
    queryFn: async () => {
      try {
        const response = await api.get<ApiResponse<{ academies?: string[] }>>("/courses/academies");
        const listed = response.data.data?.academies;
        return Array.isArray(listed) && listed.includes("bangalore");
      } catch {
        return false;
      }
    },
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });

// ─── Mapping ──────────────────────────────────────────────────────────────────

/**
 * Delta Finance's catalogue, for mapping courses onto it — the Dubai
 * organization's, or with "bangalore" the Bangalore one's. Empty when this
 * server is not connected to that organization.
 */
export const useFinanceItems = (enabled = true, academy: "dubai" | "bangalore" = "dubai") =>
  useQuery({
    queryKey: ["finance-items", academy],
    queryFn: async () => {
      const response = await api.get<ApiResponse<FinanceItem[]>>("/courses/finance-items", {
        params: academy === "bangalore" ? { academy } : {},
      });
      return response.data.data ?? [];
    },
    enabled,
    staleTime: 60_000,
  });

/** The LMS's published courses, for mapping courses onto the one(s) they open. */
export const useLmsCourses = (enabled = true) =>
  useQuery({
    queryKey: ["lms-courses"],
    queryFn: async () => {
      const response = await api.get<ApiResponse<LmsCourse[]>>("/courses/lms-courses");
      return response.data.data ?? [];
    },
    enabled,
    staleTime: 60_000,
  });

/**
 * Save where a course maps: its finance product ("" to unmap) and its LMS
 * courses, in order ([] to unmap) — and, when given, how the Bangalore academy
 * sells it: INR price (null for none), its Bangalore finance product, its LMS
 * courses there ([] for the Dubai ones).
 */
export const useMapCourse = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, financeItemId, lmsCourseSlugs, bangalore }: {
      id: string; financeItemId: string; lmsCourseSlugs: string[];
      bangalore?: { price: number | null; financeItemId: string; lmsCourseSlugs: string[] };
    }) => {
      const response = await api.put<ApiResponse<Course>>(`/courses/${id}`, { financeItemId, lmsCourseSlugs, ...(bangalore ? { bangalore } : {}) });
      return response.data.data!;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: COURSES_KEY });
      toast.success("Mapping saved");
    },
    onError: (error: unknown) => toast.error(errMsg(error, "Failed to save the mapping")),
  });
};
