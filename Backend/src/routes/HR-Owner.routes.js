import { Router } from "express";
import {
  provisionStaff,
  promoteStaff,
  updateStaffStatus,
  getHrDirectory,
  getStaffDetails,
  getCentralEwaRequests,
  decideCentralEwaRequest,
} from "../controllers/HR.controller.js";
import {
  payrollPreview,
  getBranchList,
  updateUserStatus,
  getStaffList,
} from "../controllers/org-Owner.controller.js";
import { verifyJWT } from "../middleware/userAuth.middleware.js";
import { isolateTenant } from "../middleware/tenant.middleware.js";
import { restrictTo } from "../middleware/role.middleware.js";

const router = Router();

// SECURED ROUTES (Shared by ORG_OWNER & HR)

// Global security gate for all shared HR & Owner operations
router.use(verifyJWT, isolateTenant, restrictTo("ORG_OWNER", "HR"));

// 1. Staff onboarding & provisioning (HR portal)
router.route("/provision-staff").post(provisionStaff);

// 2. Promotion, salary increment & branch transfer engine
router.route("/promote-staff/:userId").patch(promoteStaff);

// 3. Staff & manager status control (with HR hierarchy shield)
router.route("/staff-status/:userId").patch(updateStaffStatus);
router.route("/user-status/:userId").patch(updateUserStatus);

// 4. Central HR directory, single staff profile & organization lists
router.route("/directory").get(getHrDirectory);
router.route("/staff/:userId").get(getStaffDetails);
router.route("/staff-list").get(getStaffList);
router.route("/branches/list").get(getBranchList);

// 5. Central EWA approval engine (HR handles Branch Managers; Owner handles HR & all)
router.route("/ewa-requests").get(getCentralEwaRequests);
router.route("/ewa-requests/:requestId/decision").patch(decideCentralEwaRequest);

// 6. Shared read-only monthly payroll sheet / preview
router.route("/payroll-preview").get(payrollPreview);

export default router;