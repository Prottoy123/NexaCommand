import { Router } from "express";
import {
  provisionStaff,
  promoteStaff,
  updateStaffStatus,
} from "../controllers/HR.controller.js";
import { verifyJWT } from "../middleware/userAuth.middleware.js";
import { isolateTenant } from "../middleware/tenant.middleware.js";
import { restrictTo } from "../middleware/role.middleware.js";

const router = Router();

router.use(verifyJWT, isolateTenant, restrictTo("HR", "ORG_OWNER"));

router.route("/provision-staff").post(provisionStaff);

router.route("/promote-staff/:userId").patch(promoteStaff);

router.route("/staff-status/:userId").patch(updateStaffStatus);

export default router;