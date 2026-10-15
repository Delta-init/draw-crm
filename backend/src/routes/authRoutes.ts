import { Router } from "express";
import { login, refreshToken, getProfile, changePassword, ssoLogin, logout } from "../controllers/authController.js";
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
// Signing out goes on record (the Activity page); the app drops its tokens either way.
router.post("/logout", authenticate, logout);
// "Back to my account" from View as — the one write a view-as pass may make.
router.post("/impersonation/stop", authenticateViewAsExit, stopImpersonation);

export default router;
