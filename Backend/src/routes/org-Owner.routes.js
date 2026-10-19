import { Router } from 'express';
import { 
    createBranch, 
    addStaff, 
    acceptInvite 
} from '../controllers/org-Owner.controller.js';
import { verifyJWT } from '../middlewares/userAuth.middleware.js';
import { isolateTenant } from '../middlewares/tenant.middleware.js';
import { restrictTo } from '../middlewares/role.middleware.js';
import { rateLimiter } from '../middlewares/rateLimiter.middleware.js';

const router = Router();

// ==========================================
// 1. PUBLIC ROUTES (No JWT Required)
// ==========================================

// Activate pending staff/manager account using the email invitation token
router.post(
    '/accept-invite',
    rateLimiter('accept-invite', 5, 900), // Max 5 attempts per 15 minutes (900s) per IP
    acceptInvite
);

// ==========================================
// 2. PROTECTED ORG OWNER ROUTES
// ==========================================

router.post(
    '/create-branch',
    verifyJWT,
    isolateTenant,
    restrictTo('ORG_OWNER'),
    createBranch
);

router.post(
    '/add-staff',
    verifyJWT,
    isolateTenant,
    restrictTo('ORG_OWNER'),
    addStaff
);

export default router;