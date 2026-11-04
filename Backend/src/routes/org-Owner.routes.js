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

// Activate pending staff/manager account using the email invitation token
router.post(
    '/accept-invite',
    rateLimiter('accept-invite', 5, 900), 
);


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

router.patch(
    '/branches/assign-manager',
    restrictTo('ORG_OWNER'), 
    assignManager
);

router.patch(
    '/branches/remove-manager',
    restrictTo('ORG_OWNER'), 
    removeManager
);

router.post(
    '/generate-payroll',
    restrictTo('ORG_OWNER'), 
    generatePayroll
);

//shared Route By Org-owner and HR dept

router.get(
    '/payroll-preview',
    restrictTo('ORG_OWNER', 'HR'), 
    payrollPreview
);

router.get(
    '/branches/list',
    restrictTo('ORG_OWNER', 'HR'), 
    getBranchList
);

router.patch(
    '/user-status/:userId',
    restrictTo('ORG_OWNER', 'HR'),
    updateUserStatus
);

router.get(
    '/staff-list',
    restrictTo('ORG_OWNER', 'HR'), 
    getStaffList
);

export default router;