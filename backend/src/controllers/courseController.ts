import type { Response, NextFunction } from "express";
import { z } from "zod";
import type { AuthenticatedRequest } from "../types/index.js";
import { CourseService } from "../services/courseService.js";
import { sendSuccess, sendError } from "../utils/response.js";

const courseService = new CourseService();

// ─── Validation Schemas ───────────────────────────────────────────────────────

/**
 * Where a course maps: the finance product it bills against ("" or null to
 * unmap), and every LMS course it opens, in order ([] to unmap) — two for a
 * bundle. Slugs as the LMS writes them: lowercase letters, digits, hyphens.
 */
const financeItemIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Not a finance item id").or(z.literal("")).nullable().optional();
const lmsCourseSlugsSchema = z
  .array(z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,199}$/, "Not an LMS course slug"))
  .max(10, "At most 10 LMS courses")
  .optional();
const mappingSchema = {
  financeItemId: financeItemIdSchema,
  lmsCourseSlugs: lmsCourseSlugsSchema,
  /**
   * The course as the Bangalore academy sells it (the user, 2026-10-10): its
   * INR price (null or 0: none — it can't be closed for Bangalore), its item in
   * the Bangalore finance organization, and its LMS courses ([]: the Dubai
   * ones). Only what is sent changes.
   */
  bangalore: z
    .object({
      price: z.number().min(0, "Price cannot be negative").nullable().optional(),
      financeItemId: financeItemIdSchema,
      lmsCourseSlugs: lmsCourseSlugsSchema,
    })
    .strict()
    .optional(),
};

/** The bonus a client gets with the course, in its amount's currency; 0 for none. */
const bonusAmountSchema = z.number().min(0, "Bonus cannot be negative").optional();

const createCourseSchema = z.object({
  name: z.string().min(1, "Course name is required").max(150),
  description: z.string().max(1000).optional(),
  amount: z.number().min(0, "Amount cannot be negative"),
  bonusAmount: bonusAmountSchema,
  status: z.enum(["active", "inactive"]).optional(),
  ...mappingSchema,
});

const updateCourseSchema = z.object({
  name: z.string().min(1).max(150).optional(),
  description: z.string().max(1000).optional().nullable(),
  amount: z.number().min(0).optional(),
  bonusAmount: bonusAmountSchema,
  status: z.enum(["active", "inactive"]).optional(),
  ...mappingSchema,
});

// ─── Controllers ─────────────────────────────────────────────────────────────

export const createCourse = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = createCourseSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const course = await courseService.createCourse(parsed.data);
    sendSuccess(res, "Course created successfully", course, 201);
  } catch (err) {
    next(err);
  }
};

export const getCourses = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { search, status, page, limit } = req.query as Record<string, string>;
    const result = await courseService.getCourses({ search, status, page, limit });
    sendSuccess(res, "Courses fetched successfully", result.courses, 200, result.pagination);
  } catch (err) {
    next(err);
  }
};

export const getAllCourses = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const courses = await courseService.getAllCourses();
    sendSuccess(res, "Courses fetched successfully", courses);
  } catch (err) {
    next(err);
  }
};

export const getCourseById = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const course = await courseService.getCourseById(req.params.id);
    sendSuccess(res, "Course fetched successfully", course);
  } catch (err) {
    next(err);
  }
};

export const updateCourse = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const parsed = updateCourseSchema.safeParse(req.body);
    if (!parsed.success) {
      sendError(res, "Validation failed", 400, parsed.error.flatten().fieldErrors);
      return;
    }
    const course = await courseService.updateCourse(req.params.id, parsed.data as Record<string, unknown>);
    sendSuccess(res, "Course updated successfully", course);
  } catch (err) {
    next(err);
  }
};

export const deleteCourse = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const result = await courseService.deleteCourse(req.params.id);
    sendSuccess(res, result.message, null);
  } catch (err) {
    next(err);
  }
};

/**
 * Delta Finance's catalogue, for mapping a course onto the product it bills
 * against. Read live, so what is offered is what exists there now. Empty, not
 * an error, when this server is not connected to finance.
 */
export const getFinanceItems = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { listFinanceItems, financeConfigured, academyConfigured } = await import("../services/financeClient.js");
    if (!financeConfigured()) {
      sendSuccess(res, "Finance integration is not configured", []);
      return;
    }
    // ?academy=bangalore: the Bangalore finance organization's catalogue, for the Map screen's Bangalore part.
    const academy = req.query.academy === "bangalore" ? "bangalore" : "dubai";
    if (!academyConfigured(academy)) {
      sendSuccess(res, "The Bangalore finance organization is not configured", []);
      return;
    }
    sendSuccess(res, "Finance catalogue retrieved", await listFinanceItems(academy));
  } catch (err) {
    next(err);
  }
};

/**
 * The academies a close may be for here — ["dubai"], or ["dubai", "bangalore"]
 * once the Bangalore finance organization is set. The close dialog and the Map
 * screen offer Bangalore only when it is listed; a server from before answers
 * this with an error, which they read as Dubai only.
 */
export const getAcademies = async (
  _req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { academiesOffered } = await import("../services/financeClient.js");
    sendSuccess(res, "Academies retrieved", { academies: academiesOffered() });
  } catch (err) {
    next(err);
  }
};

/**
 * The LMS's courses, for mapping a course onto the one(s) it opens. Read live
 * from the LMS's public course list. Empty when no LMS address is set.
 */
export const getLmsCourses = async (
  _req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const { listLmsCourses } = await import("../services/lmsClient.js");
    sendSuccess(res, "LMS courses retrieved", await listLmsCourses());
  } catch (err) {
    next(err);
  }
};
