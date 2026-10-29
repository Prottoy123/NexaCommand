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

    return res.status(200).json(
        new ApiResponse(200, "Branch staff list fetched successfully", {
            list: formattedList,
            pagination: {
                totalRecords,
                totalPages,
                currentPage: page,
                limit
            }
        })
    );
});