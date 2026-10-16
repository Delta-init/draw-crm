import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { checkPermission } from "../middleware/permissions.js";
import { getAppSettingsHandler, updateAppSettingsHandler } from "../controllers/settingsController.js";

/** The CRM's own settings (Settings → Automation & alerts): the inactive-lead and idle-alert rules and the working hours they count in. */
const router = Router();

router.use(authenticate);

router.get("/app", checkPermission("settings", "view"), getAppSettingsHandler);
// Changing them needs seeing them too — a role given only "edit" can't change what its screen won't show it.
router.put("/app", checkPermission("settings", "view"), checkPermission("settings", "edit"), updateAppSettingsHandler);

export default router;
