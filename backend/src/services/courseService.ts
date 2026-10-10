import { Course } from "../models/Course.js";
import { buildPagination } from "../utils/response.js";
import type { ICourse } from "../types/index.js";

/** What a caller may say about where a course maps: finance's product, and the LMS course(s) it opens. */
export interface CourseMapping {
  /** The finance catalogue item's id; "" or null unmaps it. */
  financeItemId?: string | null;
  /** Every LMS course it opens, in order; [] unmaps it. */
  lmsCourseSlugs?: string[];
  /** As the Bangalore academy sells it: INR price (null/0: none), finance item there, LMS courses ([]: the Dubai ones). */
  bangalore?: { price?: number | null; financeItemId?: string | null; lmsCourseSlugs?: string[] };
}

const uniqueSlugs = (list: string[]) => [...new Set(list.map((s) => s.trim()).filter(Boolean))];

/**
 * The fields to store for a mapping, from what the caller sent: nothing about
 * a side it did not mention, the course list with its first as
 * `lmsCourseSlug` — which is what everything reading a single course reads.
 */
function mappingFields(mapping: CourseMapping): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (mapping.financeItemId !== undefined) fields.financeItemId = mapping.financeItemId || null;
  if (mapping.lmsCourseSlugs !== undefined) {
    const slugs = uniqueSlugs(mapping.lmsCourseSlugs);
    fields.lmsCourseSlugs = slugs;
    fields.lmsCourseSlug = slugs[0] ?? "";
  }
  // The Bangalore side, field by field — dotted, so what it does not mention stays.
  const b = mapping.bangalore;
  if (b?.price !== undefined) fields["bangalore.price"] = b.price && b.price > 0 ? b.price : null;
  if (b?.financeItemId !== undefined) fields["bangalore.financeItemId"] = b.financeItemId || null;
  if (b?.lmsCourseSlugs !== undefined) fields["bangalore.lmsCourseSlugs"] = uniqueSlugs(b.lmsCourseSlugs);
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
  async createCourse(data: { name: string; description?: string; amount: number; bonusAmount?: number; status?: string } & CourseMapping) {
    const { financeItemId, lmsCourseSlugs, bangalore, ...rest } = data;
    const course = new Course(rest);
    course.set(mappingFields({ financeItemId, lmsCourseSlugs, bangalore }));
    await course.save();
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
  async updateCourse(id: string, data: Partial<{ name: string; description: string; amount: number; bonusAmount: number; status: string }> & CourseMapping) {
    const course = await Course.findById(id);
    if (!course)
      throw Object.assign(new Error("Course not found"), { statusCode: 404 });

    const { financeItemId, lmsCourseSlugs, bangalore, ...rest } = data;
    Object.assign(course, rest);
    course.set(mappingFields({ financeItemId, lmsCourseSlugs, bangalore }));
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
