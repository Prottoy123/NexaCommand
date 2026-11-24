import prisma from "../config/prisma.config.js";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";


export const getBranchStaffList = asyncHandler(async (req, res) => {
  const { tenantId, id: managerId } = req.user;

  const manager = await prisma.user.findUnique({
    where: { id: managerId },
    select: { branchId: true },
  });

  if (!manager?.branchId) {
    throw new ApiError(
      403,
      "Access Denied: You are not assigned to manage any branch."
    );
  }

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 10));
  const skip = (page - 1) * limit;
  const searchTerm = req.query.search?.trim();
  const statusFilter = req.query.status?.trim().toUpperCase();

  const whereCondition = {
    tenantId,
    branchId: manager.branchId,
    id: { not: managerId },
    role: "STAFF", // Branch Manager monitors only STAFF under their branch
  };

  if (searchTerm) {
    whereCondition.OR = [
      { fullName: { contains: searchTerm, mode: "insensitive" } },
      { email: { contains: searchTerm, mode: "insensitive" } },
      { staffId: { contains: searchTerm, mode: "insensitive" } },
    ];
  }

  if (statusFilter) {
    if (!["ACTIVE", "SUSPENDED", "PENDING"].includes(statusFilter)) {
      throw new ApiError(
        400,
        "Invalid status filter. Allowed values are 'ACTIVE', 'SUSPENDED', or 'PENDING'."
      );
    }
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
        designation: true,
        department: true,
        status: true,
        baseSalary: true,
        createdAt: true,
        _count: {
          select: {
            ewaRequests: {
              where: { status: "APPROVED" },
            },
          },
        },
      },
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
    prisma.user.count({ where: whereCondition }),
  ]);

  const formattedList = staffList.map((staff) => ({
    ...staff,
    baseSalary: Number(staff.baseSalary) || 0,
    approvedEwaCount: staff._count.ewaRequests,
    _count: undefined,
  }));

  const totalPages = Math.ceil(totalRecords / limit);

  const responsePayload = {
    list: formattedList,
    pagination: {
      totalRecords,
      totalPages,
      currentPage: page,
      limit,
    },
  };

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        responsePayload,
        "Branch staff list fetched successfully."
      )
    );
});

export const getBranchEwaRequests = asyncHandler(async (req, res) => {
  const { tenantId, id: managerId } = req.user;

  const manager = await prisma.user.findUnique({
    where: { id: managerId },
    select: { branchId: true },
  });

  if (!manager?.branchId) {
    throw new ApiError(
      403,
      "Access Denied: You are not assigned to manage any branch."
    );
  }

  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 10));
  const skip = (page - 1) * limit;

  const statusFilter = req.query.status?.trim().toUpperCase() || "PENDING";
  if (!["PENDING", "APPROVED", "REJECTED"].includes(statusFilter)) {
    throw new ApiError(
      400,
      "Invalid status filter. Allowed values are 'PENDING', 'APPROVED', or 'REJECTED'."
    );
  }

  // Strictly isolate to STAFF of this branch and exclude manager's own EWA requests
  const whereCondition = {
    tenantId,
    status: statusFilter,
    staffId: { not: managerId },
    staff: {
      branchId: manager.branchId,
      role: "STAFF",
    },
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
            designation: true,
            baseSalary: true,
            status: true,
          },
        },
      },
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
    prisma.ewaRequest.count({ where: whereCondition }),
  ]);

  const formattedList = ewaRequests.map((reqItem) => ({
    ...reqItem,
    requestedAmount: Number(reqItem.requestedAmount) || 0,
    staff: {
      ...reqItem.staff,
      baseSalary: Number(reqItem.staff.baseSalary) || 0,
    },
  }));

  const totalPages = Math.ceil(totalRecords / limit);

  const responsePayload = {
    list: formattedList,
    pagination: {
      totalRecords,
      totalPages,
      currentPage: page,
      limit,
    },
  };

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        responsePayload,
        "Branch EWA requests fetched successfully."
      )
    );
});

export const approveEwaRequest = asyncHandler(async (req, res) => {
  const { tenantId, id: managerId } = req.user;
  const { requestId } = req.params;

  const manager = await prisma.user.findUnique({
    where: { id: managerId },
    select: { branchId: true },
  });

  if (!manager?.branchId) {
    throw new ApiError(
      403,
      "Access Denied: You are not assigned to manage any branch."
    );
  }

  // Use findFirst for composite non-unique filter (id + tenantId)
  const ewaRequest = await prisma.ewaRequest.findFirst({
    where: { id: requestId, tenantId },
    include: {
      staff: {
        select: {
          id: true,
          branchId: true,
          staffId: true,
          role: true,
          status: true,
        },
      },
    },
  });

  if (!ewaRequest) {
    throw new ApiError(404, "EWA request not found.");
  }

  // Zero Self-Approval Shield
  if (ewaRequest.staffId === managerId) {
    throw new ApiError(
      403,
      "Forbidden: You cannot approve your own EWA request. Manager requests must be approved by HR or the Organization Owner."
    );
  }

  // Strict Role Lock: Branch Managers can only approve STAFF requests
  if (ewaRequest.staff.role !== "STAFF") {
    throw new ApiError(
      403,
      "Forbidden: Branch Managers are only authorized to approve EWA requests from STAFF members."
    );
  }

  // Cross-Branch Isolation Shield
  if (ewaRequest.staff.branchId !== manager.branchId) {
    throw new ApiError(
      403,
      "Unauthorized: You can only approve requests from your own branch."
    );
  }

  // Prevent cash disbursement to a suspended staff account
  if (ewaRequest.staff.status !== "ACTIVE") {
    throw new ApiError(
      400,
      `Cannot approve EWA request because the staff member's account is currently ${ewaRequest.staff.status}.`
    );
  }

  if (ewaRequest.status !== "PENDING") {
    throw new ApiError(
      400,
      `Request cannot be approved. Current status is already ${ewaRequest.status}.`
    );
  }

  const transactionId = `EWA-${crypto
    .randomBytes(3)
    .toString("hex")
    .toUpperCase()}-${Date.now()}`;

  // Interactive transaction with conditional updateMany to eliminate double-click race conditions
  const result = await prisma.$transaction(async (tx) => {
    const updateResult = await tx.ewaRequest.updateMany({
      where: {
        id: requestId,
        tenantId,
        status: "PENDING",
      },
      data: {
        status: "APPROVED",
        approvedBy: managerId,
      },
    });

    if (updateResult.count === 0) {
      throw new ApiError(
        409,
        "Conflict: This EWA request has already been processed."
      );
    }

    const ledgerEntry = await tx.ledgerEvent.create({
      data: {
        tenantId,
        transactionId,
        eventType: "EWA_ADVANCE",
        debitAccount: "BRANCH_CASH",
        creditAccount: `STAFF_${ewaRequest.staff.staffId}`,
        amount: ewaRequest.requestedAmount,
        referenceId: requestId,
      },
    });

    await tx.auditLog.create({
      data: {
        tenantId,
        userId: managerId,
        action: `EWA_APPROVED_BY_MANAGER_AMOUNT_${Number(
          ewaRequest.requestedAmount
        )}`,
        targetResource: requestId,
      },
    });

    const updatedRequest = await tx.ewaRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        status: true,
        requestedAmount: true,
        updatedAt: true,
      },
    });

    return { updatedRequest, ledgerEntry };
  });

  const responsePayload = {
    request: {
      id: result.updatedRequest.id,
      status: result.updatedRequest.status,
      requestedAmount: Number(result.updatedRequest.requestedAmount) || 0,
      approvedAt: result.updatedRequest.updatedAt,
    },
    ledgerReference: result.ledgerEntry.transactionId,
  };

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        responsePayload,
        "EWA request approved successfully and recorded in ledger."
      )
    );
});



