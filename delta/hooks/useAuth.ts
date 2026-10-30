"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { toast } from "@/lib/toast";
import api from "@/lib/axios";
import { API_URL } from "@/lib/apiUrl";
import { useAuthStore } from "@/lib/store/authStore";
import { getViewAs, leaveViewAsForSignOut } from "@/lib/impersonation";
import type { LoginFormValues } from "@/lib/validations/authSchema";
import type { ApiResponse, LoginResponse } from "@/types";

export const useLogin = () => {
  const { setAuth } = useAuthStore();
  const router = useRouter();

  return useMutation({
    mutationFn: async (data: LoginFormValues) => {
      const response = await api.post<ApiResponse<LoginResponse>>(
        "/auth/login",
        data,
      );
      return response.data.data!;
    },
    onSuccess: (data) => {
      setAuth(data.user, data.accessToken, data.refreshToken);
      toast.success("Welcome back!", {
        description: `Logged in as ${data.user.name}`,
      });
      router.push("/dashboard");
    },
    onError: (error: unknown) => {
      const message =
        (error as { response?: { data?: { message?: string } } })?.response
          ?.data?.message ?? "Login failed. Please check your credentials.";
      toast.error(message);
    },
  });
};

export const useLogout = () => {
  const { clearAuth } = useAuthStore();
  const router = useRouter();
  const queryClient = useQueryClient();

  return () => {
    const viewing = typeof window !== "undefined" && !!getViewAs();
    // Signing out while viewing as someone ends that session too, and forgets
    // the admin's own sign-in that was kept aside — the sign-out below is complete.
    const adminToken = leaveViewAsForSignOut();
    // The sign-out on record (the Activity page), under whoever is signing out — the admin when they were viewing as
    // someone, never that person. fetch with keepalive, not the api client: the client puts the stored token on every
    // call, and the request has to outlive the page going to /login.
    const token = viewing ? adminToken : typeof window !== "undefined" ? localStorage.getItem("accessToken") : null;
    if (token) {
      fetch(`${API_URL}/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: "{}",
        keepalive: true,
      }).catch(() => undefined);
    }
    // clearAuth();
    toast.success("Logged out successfully");
    if (typeof window !== "undefined") {
      localStorage.removeItem("crm-auth");
      localStorage.removeItem("accessToken");
      localStorage.removeItem("refreshToken");
      queryClient.clear();
      
    }

    router.push("/login");
  };
};
