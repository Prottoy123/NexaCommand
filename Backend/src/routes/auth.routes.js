import { Router } from "express";

import { verifyJWT } from "../middleware/userAuth.middleware.js";
import { upload } from "../middleware/multer.middleware.js";
import { changePassword, forgotPassword, getCurrentUser, googleLogin, googleRegisterTenant, loginUser, logoutUser, refreshAccessToken, registerTenant, resetPassword, updateAccount } from "../controllers/auth.controller.js";

const router = Router();

// ==========================================
// PUBLIC ROUTES (No Authentication Required)
// ==========================================

// 1.Identity provisioning & login
router.route("/register-tenant").post(registerTenant);
router.route("/login").post(loginUser);

// 2. Session restoration
router.route("/refresh-token").post(refreshAccessToken);

// 3. Password recovery chain
router.route("/forgot-password").post(forgotPassword);
router.route("/reset-password/:token").patch(resetPassword);


// ==========================================
// SECURED ROUTES (verifyJWT Middleware Required)
// ==========================================

// 4. Session termination
router.route("/logout").post(verifyJWT, logoutUser);

// 5. Identity hydrator
router.route("/me").get(verifyJWT, getCurrentUser);

// 6. Account lifecycle management
router.route("/change-password").patch(verifyJWT, changePassword);

// Dynamic profile updater (with cloudinary file upload)
router.route("/update-account").patch(
  verifyJWT,
  upload.single("avatar"), 
  updateAccount
);

// 7. Google OAuth Routes (Strictly for ORG_OWNER)
router.route("/google-register-tenant").post(googleRegisterTenant);
router.route("/google-login").post(googleLogin);

export default router;