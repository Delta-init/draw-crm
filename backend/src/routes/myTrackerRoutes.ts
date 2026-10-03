import { Router } from "express";
import { getMyTracker, saveMyTracker } from "../controllers/myTrackerController.js";
import { authenticate } from "../middleware/auth.js";

const router = Router();

// Every role files its own day (2026-10-03), so signed in is enough — the
// "Daily Tracker" permission is gone from Roles & Permissions. A rep only ever
// reads and writes their OWN row: the portal scopes to whoever this server
// says is signed in, so there is nobody else's tracker to reach from here.
router.get("/me", authenticate, getMyTracker);
router.put("/me", authenticate, saveMyTracker);

export default router;
