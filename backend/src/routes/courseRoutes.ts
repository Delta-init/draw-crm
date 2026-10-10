import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { checkPermission } from "../middleware/permissions.js";
import {
  createCourse,
  getCourses,
  getAllCourses,
  getCourseById,
  updateCourse,
  deleteCourse,
  getFinanceItems,
  getLmsCourses,
  getAcademies,
} from "../controllers/courseController.js";

const router = Router();

router.use(authenticate);

// All courses (dropdown, no pagination)
router.get("/all", getAllCourses);

// Paginated list
router.get("/", getCourses);

// Which academies a close may be for here (Bangalore once its finance
// organization is set) — read by the close dialog, so open to anyone signed
// in. Before "/:id", which would otherwise take it for a course id.
router.get("/academies", getAcademies);

// What a course can be mapped to — finance's products, the LMS's courses — for
// the Map screen. Behind the permission that edits courses, and registered
// before "/:id", which would otherwise take them for course ids.
router.get("/finance-items", checkPermission("leads", "edit"), getFinanceItems);
router.get("/lms-courses", checkPermission("leads", "edit"), getLmsCourses);

// Single course
router.get("/:id", getCourseById);

// Create
router.post("/", checkPermission("leads", "create"), createCourse);

// Update
router.put("/:id", checkPermission("leads", "edit"), updateCourse);

// Delete
router.delete("/:id", checkPermission("leads", "delete"), deleteCourse);

export default router;
