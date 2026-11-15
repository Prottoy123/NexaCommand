import { Router } from "express";
import {
  createBranch,
  addStaff,
  acceptInvite,
  assignManager,
  removeManager,
  generatePayroll,
} from "../controllers/org-Owner.controller.js";
import { verifyJWT } from "../middlewares/userAuth.middleware.js";
import { isolateTenant } from "../middlewares/tenant.middleware.js";
import { restrictTo } from "../middlewares/role.middleware.js";
import { rateLimiter } from "../middlewares/rateLimiter.middleware.js";

const router = Router();

router
  .route("/accept-invite")
  .post(rateLimiter("accept-invite", 5, 900), acceptInvite);

router.use(verifyJWT, isolateTenant, restrictTo("ORG_OWNER"));

router.route("/create-branch").post(createBranch);
router.route("/branches/assign-manager").patch(assignManager);
router.route("/branches/remove-manager").patch(removeManager);

router.route("/add-staff").post(addStaff);

router.route("/generate-payroll").post(generatePayroll);

export default router;