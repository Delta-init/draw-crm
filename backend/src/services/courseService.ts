import { Course } from "../models/Course.js";
import { buildPagination } from "../utils/response.js";
import type { ICourse } from "../types/index.js";

/** What a caller may say about where a course maps: finance's product, and the LMS course(s) it opens. */
export interface CourseMapping {
  /** The finance catalogue item's id; "" or null unmaps it. */
  financeItemId?: string | null;
  /** Every LMS course it opens, in order; [] unmaps it. */
  lmsCourseSlugs?: string[];
}

/**
 * The fields to store for a mapping, from what the caller sent: nothing about
 * a side it did not mention, the course list with its first as
 * `lmsCourseSlug` — which is what everything reading a single course reads.
 */
function mappingFields(mapping: CourseMapping): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (mapping.financeItemId !== undefined) fields.financeItemId = mapping.financeItemId || null;
  if (mapping.lmsCourseSlugs !== undefined) {
    const slugs = [...new Set(mapping.lmsCourseSlugs.map((s) => s.trim()).filter(Boolean))];
    fields.lmsCourseSlugs = slugs;
    fields.lmsCourseSlug = slugs[0] ?? "";
  }
  return fields;
}

export interface CourseFilters {
  search?: string;
  status?: string;
  page?: string;
  limit?: string;
}

export class CourseService {
  // ── Create ──────────────────────────────────────────────────────────────────
  async createCourse(data: { name: string; description?: string; amount: number; status?: string } & CourseMapping) {
    const { financeItemId, lmsCourseSlugs, ...rest } = data;
    const course = await Course.create({ ...rest, ...mappingFields({ financeItemId, lmsCourseSlugs }) });
    return course;
  }

  // ── List ─────────────────────────────────────────────────────────────────────
  async getCourses(filters: CourseFilters) {
    const page = Math.max(1, parseInt(filters.page ?? "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(filters.limit ?? "20", 10)));
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = {};

    if (filters.status) query.status = filters.status;

    if (filters.search) {
      const regex = new RegExp(filters.search, "i");
      query.$or = [{ name: regex }, { description: regex }];
    }

    const [courses, total] = await Promise.all([
      Course.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Course.countDocuments(query),
    ]);

    return { courses, pagination: buildPagination(total, page, limit) };
  }

  // ── Get All (for dropdowns) ──────────────────────────────────────────────────
  async getAllCourses() {
    return Course.find({ status: "active" }).sort({ name: 1 }).lean();
  }

  // ── Get by ID ────────────────────────────────────────────────────────────────
  async getCourseById(id: string) {
    const course = await Course.findById(id);
    if (!course)
      throw Object.assign(new Error("Course not found"), { statusCode: 404 });
    return course;
  }

  // ── Update ───────────────────────────────────────────────────────────────────
  async updateCourse(id: string, data: Partial<{ name: string; description: string; amount: number; status: string }> & CourseMapping) {
    const course = await Course.findById(id);
    if (!course)
      throw Object.assign(new Error("Course not found"), { statusCode: 404 });

    const { financeItemId, lmsCourseSlugs, ...rest } = data;
    Object.assign(course, rest, mappingFields({ financeItemId, lmsCourseSlugs }));
    await course.save();
    return course;
  }

  // ── Delete ───────────────────────────────────────────────────────────────────
  async deleteCourse(id: string) {
    const course = await Course.findById(id);
    if (!course)
      throw Object.assign(new Error("Course not found"), { statusCode: 404 });
    await Course.findByIdAndDelete(id);
    return { message: "Course deleted successfully" };
  }
}
