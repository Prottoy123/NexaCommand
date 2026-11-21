import { Router } from "express";
import {
  getMyDashboard,
  requestEwa,
  getMyEwaHistory,
} from "../controllers/staff.controller.js";
import { verifyJWT } from "../middlewares/userAuth.middleware.js";
import { isolateTenant } from "../middlewares/tenant.middleware.js";
import { restrictTo } from "../middlewares/role.middleware.js";
import { requireIdempotency } from "../config/redis.config.js"

const router = Router();

router.use(verifyJWT, isolateTenant, restrictTo("STAFF", "BRANCH_MANAGER", "HR"));

router.route("/my-dashboard").get(getMyDashboard);

router.route("/request-ewa").post(requestEwa);

router.route("/my-ewa-history").get(getMyEwaHistory);

router
  .route("/request-ewa")
  .post(requireIdempotency({ ttlSeconds: 5, strict: true }), requestEwa);

export default router;