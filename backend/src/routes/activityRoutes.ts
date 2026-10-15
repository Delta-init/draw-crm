import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { checkPermission } from "../middleware/permissions.js";
import {
  heartbeatHandler,
  idleStretchesHandler,
  loginEventsHandler,
  peopleHandler,
  attendanceHandler,
} from "../controllers/activityController.js";

const router = Router();

// Everyone signed in reports their own activity.
router.post("/heartbeat", authenticate, heartbeatHandler);

// The Activity page — the Super Admin, and any role given the Activity box.
router.get("/people", authenticate, checkPermission("activity", "view"), peopleHandler);
router.get("/logins", authenticate, checkPermission("activity", "view"), loginEventsHandler);
router.get("/idle", authenticate, checkPermission("activity", "view"), idleStretchesHandler);
// The Attendance tab: the HRMS's shift and the day's clock-ins and clock-outs.
router.get("/attendance", authenticate, checkPermission("activity", "view"), attendanceHandler);

export default router;
