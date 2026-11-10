import { Router } from 'express';
import { 
    getBranchStaffList, 
    getBranchEwaRequests, 
    approveEwaRequest 
} from '../controllers/branch.controller.js';
import { verifyJWT } from '../middlewares/userAuth.middleware.js';
import { isolateTenant } from '../middlewares/tenant.middleware.js';
import { restrictTo } from '../middlewares/role.middleware.js';

const router = Router();

router.use(verifyJWT, isolateTenant);

router.get(
    '/staff-list',
    restrictTo('BRANCH_MANAGER'), 
    getBranchStaffList
);

router.get(
    '/ewa-requests',
    restrictTo('BRANCH_MANAGER', 'HR', 'ORG_OWNER'),
    getBranchEwaRequests
);

router.patch(
    '/approve-ewa/:requestId',
    restrictTo('BRANCH_MANAGER', 'HR', 'ORG_OWNER'),
    approveEwaRequest
);

export default router;