import { PrismaClient } from "@prisma/client";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";

const prisma = new PrismaClient();

export const getBranchStaffList = asyncHandler(async (req, res) => {
    const { tenantId, id: managerId } = req.user; 
    
    const manager = await prisma.user.findUnique({
        where: { id: managerId },
        select: { branchId: true }
    });

    if (!manager?.branchId) {
        throw new ApiError(403, "Access Denied: You are not assigned to manage any branch.");
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 10);
    const skip = (page - 1) * limit;
    const searchTerm = req.query.search?.trim();
    const statusFilter = req.query.status?.toUpperCase();

    const whereCondition = {
        tenantId,
        branchId: manager.branchId,
        id: { not: managerId } 
    };

    if (searchTerm) {
        whereCondition.OR = [
            { fullName: { contains: searchTerm, mode: 'insensitive' } },
            { email: { contains: searchTerm, mode: 'insensitive' } },
            { staffId: { contains: searchTerm, mode: 'insensitive' } }
        ];
    }

    if (statusFilter && ['ACTIVE', 'SUSPENDED', 'PENDING'].includes(statusFilter)) {
        whereCondition.status = statusFilter;
    }

    const [staffList, totalRecords] = await Promise.all([
        prisma.user.findMany({
            where: whereCondition,
            select: {
                id: true,
                staffId: true,
                fullName: true,
                email: true,
                role: true,
                status: true,
                baseSalary: true, 
                createdAt: true, 
                _count: {
                    select: {
                        ewaRequests: {
                            where: { status: 'APPROVED' } 
                        }
                    }
                }
            },
            skip,
            take: limit,
            orderBy: { createdAt: 'desc' }
        }),
        prisma.user.count({ where: whereCondition })
    ]);

    const formattedList = staffList.map(staff => ({
        ...staff,
        approvedEwaCount: staff._count.ewaRequests,
        _count: undefined
    }));

    const totalPages = Math.ceil(totalRecords / limit);

    const responsePayload = {
        list: formattedList,
        pagination: {
            totalRecords,
            totalPages,
            currentPage: page,
            limit
        }
    };

    return res.status(200).json(
        new ApiResponse(200, responsePayload, "Branch staff list fetched successfully")
    );
});

export const getBranchEwaRequests = asyncHandler(async (req, res) => {
    const { tenantId, id: managerId } = req.user;

    const manager = await prisma.user.findUnique({
        where: { id: managerId },
        select: { branchId: true }
    });

    if (!manager?.branchId) {
        throw new ApiError(403, "Access Denied: You are not assigned to manage any branch.");
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, parseInt(req.query.limit) || 10);
    const skip = (page - 1) * limit;
    
    const statusFilter = req.query.status?.toUpperCase() || 'PENDING';

    const whereCondition = {
        tenantId,
        status: statusFilter,
        staff: {
            branchId: manager.branchId 
        }
    };

    const [ewaRequests, totalRecords] = await Promise.all([
        prisma.ewaRequest.findMany({
            where: whereCondition,
            include: {
                staff: {
                    select: {
                        id: true,
                        staffId: true,
                        fullName: true,
                        baseSalary: true, 
                        status: true 
                    }
                }
            },
            skip,
            take: limit,
            orderBy: { createdAt: 'desc' }
        }),
        prisma.ewaRequest.count({ where: whereCondition })
    ]);

    const totalPages = Math.ceil(totalRecords / limit);

const responsePayload = {
    list: ewaRequests,
    pagination: {
        totalRecords,
        totalPages,
        currentPage: page,
        limit
    }
};

return res.status(200).json(
    new ApiResponse(200, responsePayload, "EWA requests fetched successfully")
);

});

export const approveEwaRequest = asyncHandler(async (req, res) => {
    const { tenantId, id: managerId } = req.user;
    const { requestId } = req.params;

    const manager = await prisma.user.findUnique({
        where: { id: managerId },
        select: { branchId: true }
    });

    if (!manager?.branchId) {
        throw new ApiError(403, "Access Denied: You are not assigned to manage any branch.");
    }

    const ewaRequest = await prisma.ewaRequest.findUnique({
        where: { id: requestId, tenantId }, 
        include: {
            staff: { select: { branchId: true, staffId: true } }
        }
    });

    if (!ewaRequest) {
        throw new ApiError(404, "EWA request not found.");
    }

    if (ewaRequest.staff.branchId !== manager.branchId) {
        throw new ApiError(403, "Unauthorized: You can only approve requests from your own branch.");
    }

    if (ewaRequest.status !== 'PENDING') {
        throw new ApiError(400, `Request cannot be approved. Current status is already ${ewaRequest.status}.`);
    }

    const transactionId = `EWA-${crypto.randomBytes(3).toString('hex').toUpperCase()}-${Date.now()}`;

    const [updatedRequest, ledgerEntry] = await prisma.$transaction([
        
        prisma.ewaRequest.update({
            where: { 
                id: requestId,
                status: 'PENDING'
            },
            data: {
                status: 'APPROVED',
                approvedBy: managerId 
            }
        }),

        prisma.ledgerEvent.create({
            data: {
                tenantId,
                transactionId, 
                eventType: 'EWA_ADVANCE',
                debitAccount: 'BRANCH_CASH', 
                creditAccount: `STAFF_${ewaRequest.staff.staffId}`,
                amount: ewaRequest.requestedAmount, 
                referenceId: requestId 
            }
        })
    ]);

    const responsePayload = {
        request: {
            id: updatedRequest.id,
            status: updatedRequest.status,
            requestedAmount: updatedRequest.requestedAmount,
            approvedAt: updatedRequest.updatedAt
        },
        ledgerReference: ledgerEntry.transactionId
    };

    return res.status(200).json(
        new ApiResponse(200, responsePayload, "EWA request approved successfully and recorded in ledger.")
    );
});



