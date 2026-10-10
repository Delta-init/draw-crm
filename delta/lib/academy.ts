import { fmtFull } from "@/lib/currency";
import type { Course } from "@/types/course";

/**
 * Which academy a close is for (the user, 2026-10-10): Dubai — in AED, as
 * every close was before — or Bangalore, in INR. Picked at the close and fixed
 * from then on; a correction shows it and never changes it.
 */
export const ACADEMIES = ["dubai", "bangalore"] as const;
export type Academy = (typeof ACADEMIES)[number];
export const ACADEMY_LABELS: Record<Academy, string> = { dubai: "Dubai", bangalore: "Bangalore" };

/** Bangalore only when it says so: absent — every close from before — is Dubai. */
export const academyOf = (v: unknown): Academy => (v === "bangalore" ? "bangalore" : "dubai");

/** Rupees, the Indian way: "₹1,25,000". */
export function fmtINR(n: number): string {
  return `₹${(Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

/** Dirhams: "AED 1,250". */
export function fmtAED(n: number): string {
  return `AED ${(Number(n) || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

/** A close's money in its academy's currency: ₹ for Bangalore, the screen's usual currency for Dubai. */
export function fmtFee(n: number, academy: Academy): string {
  return academy === "bangalore" ? fmtINR(n) : fmtFull(n);
}

/** A course's Bangalore INR price, when it has one above zero. */
export function bangalorePriceOf(course: Pick<Course, "bangalore"> | null | undefined): number | null {
  const p = Number(course?.bangalore?.price);
  return Number.isFinite(p) && p > 0 ? p : null;
}

/** What a course is listed at for an academy: its Bangalore price for Bangalore (0 when it has none), its amount for Dubai. */
export function priceFor(course: Pick<Course, "amount" | "bangalore">, academy: Academy): number {
  return academy === "bangalore" ? bangalorePriceOf(course) ?? 0 : course.amount ?? 0;
}
