import { Router } from "express";
import { login, refreshToken, getProfile, changePassword, ssoLogin } from "../controllers/authController.js";
import { stopImpersonation } from "../controllers/impersonationController.js";
import { authenticate, authenticateViewAsExit } from "../middleware/auth.js";

const router = Router();

// Public routes
router.post("/login", login);
router.post("/refresh-token", refreshToken);
router.post("/sso-login", ssoLogin); // Root portal SSO

// Protected routes
router.get("/profile", authenticate, getProfile);
router.put("/change-password", authenticate, changePassword);
// "Back to my account" from View as — the one write a view-as pass may make.
router.post("/impersonation/stop", authenticateViewAsExit, stopImpersonation);

export default router;
