export interface Course {
  _id: string;
  name: string;
  description?: string;
  amount: number;
  /** The bonus a client gets with it, in the amount's currency; 0 (or missing, on one from before) for none. */
  bonusAmount?: number;
  status: "active" | "inactive";
  /** The Delta Finance product it bills against; null when not mapped. */
  financeItemId?: string | null;
  /** The first of `lmsCourseSlugs` — what a single-course reader sees. */
  lmsCourseSlug?: string;
  /** Every LMS course it opens, in order — two for a bundle. */
  lmsCourseSlugs?: string[];
  createdAt: string;
  updatedAt: string;
}

/** A product in Delta Finance's catalogue, as the Map screen offers it. */
export interface FinanceItem {
  id: string;
  name: string;
  sku: string;
  unitPriceMinor: number;
  type: string;
}

/** A published course in the LMS. */
export interface LmsCourse {
  slug: string;
  title: string;
}

/** Every LMS course a course opens; a single mapping from before reads the same. */
export const lmsCoursesOf = (course: Pick<Course, "lmsCourseSlug" | "lmsCourseSlugs">): string[] =>
  course.lmsCourseSlugs?.length ? course.lmsCourseSlugs : course.lmsCourseSlug ? [course.lmsCourseSlug] : [];

export interface CourseFilters {
  search?: string;
  status?: string;
  page?: number;
  limit?: number;
}
