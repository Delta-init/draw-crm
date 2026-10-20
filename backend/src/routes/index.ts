import { Router } from "express";
import authRoutes from "./authRoutes.js";
import breakRoutes from "./breakRoutes.js";
import myTrackerRoutes from "./myTrackerRoutes.js";
import userRoutes from "./userRoutes.js";
import roleRoutes from "./roleRoutes.js";
import leadRoutes from "./leadRoutes.js";
import userLeadRoutes from "./userLeadRoutes.js";
import teamRoutes from "./teamRoutes.js";
import courseRoutes from "./courseRoutes.js";
import sheetsRoutes from "./sheetsRoutes.js";
import reportRoutes from "./reportRoutes.js";
import pushRoutes from "./pushRoutes.js";
import aiRoutes from "./aiRoutes.js";
import studentRoutes from "./studentRoutes.js";
import balancePaymentRoutes from "./balancePaymentRoutes.js";
import callRoutes from "./callRoutes.js";
import portalRoutes from "./portalRoutes.js";
import mentorRoutes from "./mentorRoutes.js";
import commissionRoutes from "./commissionRoutes.js";
import leaderboardRoutes from "./leaderboardRoutes.js";
import publicRoutes from "./publicRoutes.js";
import activityRoutes from "./activityRoutes.js";
import meetingRoomRoutes from "./meetingRoomRoutes.js";
import settingsRoutes from "./settingsRoutes.js";
import notificationRoutes from "./notificationRoutes.js";
import inactiveLeadRoutes from "./inactiveLeadRoutes.js";

const router = Router();


router.use("/auth", authRoutes);
// Server-to-server, from the Root portal. Guarded by a shared secret, not a
// session — see portalRoutes.
router.use("/service", portalRoutes);
router.use("/my-tracker", myTrackerRoutes);
router.use("/users", userRoutes);
router.use("/users", userLeadRoutes);
router.use("/roles", roleRoutes);
router.use("/leads", leadRoutes);
router.use("/teams", teamRoutes);
router.use("/courses", courseRoutes);
router.use("/sheets",  sheetsRoutes);
router.use("/reports", reportRoutes);
router.use("/push",    pushRoutes);
router.use("/ai",       aiRoutes);
router.use("/students", studentRoutes);
// Part-paid closes and their next payments, for finance to approve (2026-10-13).
router.use("/balance-payments", balancePaymentRoutes);
router.use("/calls",    callRoutes);
router.use("/mentors", mentorRoutes);
// Sales commission: the plan per course, and what each approved sale earns.
router.use("/commission", commissionRoutes);
router.use("/leaderboard", leaderboardRoutes);
router.use("/public", publicRoutes); // no sign-in: the open leaderboard only
// Who is here, sign-ins, idle alerts and the HRMS attendance (2026-10-15), and the settings they keep.
router.use("/activity", activityRoutes);
router.use("/settings", settingsRoutes);
// The bell's kept notifications, and the Inactive leads page (2026-10-16, as in the Sales CRM)
router.use("/notifications", notificationRoutes);
router.use("/inactive-leads", inactiveLeadRoutes);
// The office's meeting rooms, booked through the HRMS — see meetingRoomRoutes.
router.use("/meeting-rooms", meetingRoomRoutes);
// "Take break" — everyone's own (2026-10-20, as in the Sales CRM): the inactive-lead clock stops while it lasts.
router.use("/break", breakRoutes);

// Health check
router.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});


router.get("/hi", (_req, res) => {
  res.send("hi");
});

export default router;
