import { PrismaClient } from "@prisma/client";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";

const prisma = new PrismaClient();

export const getMyDashboard = asyncHandler(async (req, res) => {
  const employeeUserId = req.user.id;
  const tenantId = req.user.tenantId;

  // Define time boundaries for Today (Sales) and Current Month (EWA)
  const now = new Date();

  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    0, 0, 0, 0
  );
  const endOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23, 59, 59, 999
  );

  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const endOfMonth = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0,
    23, 59, 59, 999
  );

  // Run parallel queries for profile, today's sales, and current month EWA requests
  const [
    employeeProfile,
    todaySalesAgg,
    approvedEwaAgg,
    pendingEwaAgg,
  ] = await Promise.all([
    // Fetch employee basic profile and salary info
    prisma.user.findFirst({
      where: {
        id: employeeUserId,
        tenantId: tenantId,
      },
      select: {
        id: true,
        staffId: true,
        fullName: true,
        email: true,
        avatarUrl: true,
        role: true,
        designation: true,
        department: true,
        baseSalary: true,
        earnedCommission: true,
        branchId: true,
        branch: {
          select: {
            id: true,
            name: true,
            location: true,
          },
        },
      },
    }),

    // Calculate today's total PAID sales created by this employee
    prisma.invoice.aggregate({
      where: {
        tenantId: tenantId,
        creatorId: employeeUserId,
        status: "PAID", // Exclude unpaid/pending B2B invoices
        createdAt: {
          gte: startOfToday,
          lte: endOfToday,
        },
      },
      _sum: {
        netPayable: true,
      },
      _count: {
        id: true,
      },
    }),

    // Sum all APPROVED EWA requests for the current month
    prisma.ewaRequest.aggregate({
      where: {
        tenantId: tenantId,
        staffId: employeeUserId,
        status: "APPROVED",
        createdAt: {
          gte: startOfMonth,
          lte: endOfMonth,
        },
      },
      _sum: {
        requestedAmount: true,
      },
    }),

    // Sum all PENDING EWA requests for the current month
    prisma.ewaRequest.aggregate({
      where: {
        tenantId: tenantId,
        staffId: employeeUserId,
        status: "PENDING",
        createdAt: {
          gte: startOfMonth,
          lte: endOfMonth,
        },
      },
      _sum: {
        requestedAmount: true,
      },
    }),
  ]);

  if (!employeeProfile) {
    throw new ApiError(404, "Employee profile not found.");
  }

  // Safely convert Decimal and nullable aggregate values to Numbers
  const baseSalary = Number(employeeProfile.baseSalary) || 0;
  const earnedCommission = Number(employeeProfile.earnedCommission) || 0;

  const todayTotalSales = Number(todaySalesAgg._sum.netPayable) || 0;
  const todayInvoiceCount = Number(todaySalesAgg._count.id) || 0;

  const approvedEwaAmount = Number(approvedEwaAgg._sum.requestedAmount) || 0;
  const pendingEwaAmount = Number(pendingEwaAgg._sum.requestedAmount) || 0;

  // Calculate real-time earnings and 50% EWA safety cap (Commission is isolated from EWA cap)
  const grossEarnings = Number((baseSalary + earnedCommission).toFixed(2));
  const maxEwaLimit = Number((baseSalary * 0.5).toFixed(2));
  const usedOrLockedEwa = Number((approvedEwaAmount + pendingEwaAmount).toFixed(2));
  const remainingEwaLimit = Math.max(
    0,
    Number((maxEwaLimit - usedOrLockedEwa).toFixed(2))
  );
  const estimatedNetPayable = Math.max(
    0,
    Number((grossEarnings - approvedEwaAmount).toFixed(2))
  );

  // Build clean dashboard summary payload
  const dashboardData = {
    profile: {
      id: employeeProfile.id,
      staffId: employeeProfile.staffId,
      fullName: employeeProfile.fullName,
      email: employeeProfile.email,
      avatarUrl: employeeProfile.avatarUrl,
      role: employeeProfile.role,
      designation: employeeProfile.designation,
      department: employeeProfile.department,
      branch: employeeProfile.branch,
    },
    todayPerformance: {
      totalSalesAmount: todayTotalSales,
      totalInvoicesCreated: todayInvoiceCount,
    },
    currentMonthFinancials: {
      baseSalary,
      earnedCommission,
      grossEarnings,
      maxEwaLimit,
      approvedEwaDeduction: approvedEwaAmount,
      pendingEwaAmount,
      remainingEwaLimit,
      estimatedNetPayable,
    },
  };

  return res.status(200).json(
    new ApiResponse(
      200,
      dashboardData,
      "Employee dashboard summary fetched successfully."
    )
  );
});

export const requestEwa = asyncHandler(async (req, res) => {
  const employeeUserId = req.user.id;
  const tenantId = req.user.tenantId;
  const { requestedAmount } = req.body;

  // Strictly validate requestedAmount (rejects malformed strings like "500abc", empty, <= 0, Infinity)
  const rawAmount = Number(requestedAmount);
  if (
    requestedAmount === undefined ||
    requestedAmount === null ||
    String(requestedAmount).trim() === "" ||
    !Number.isFinite(rawAmount) ||
    rawAmount <= 0
  ) {
    throw new ApiError(
      400,
      "Please provide a valid positive amount for the advance salary request."
    );
  }
  const parsedAmount = Number(rawAmount.toFixed(2));

  // Define current month timeframe boundaries
  const now = new Date();
  const startOfMonth = new Date(
    now.getFullYear(),
    now.getMonth(),
    1,
    0, 0, 0, 0
  );
  const endOfMonth = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    0,
    23, 59, 59, 999
  );

  // Execute eligibility verification, 50% cap check, and record creation inside an atomic transaction
  const ewaTransactionResult = await prisma.$transaction(async (tx) => {
    const [employeeProfile, currentMonthEwaAgg, payrollDisbursedEvent] =
      await Promise.all([
        // Fetch employee's current role, baseSalary, status, and branch assignment
        tx.user.findFirst({
          where: {
            id: employeeUserId,
            tenantId: tenantId,
          },
          select: {
            id: true,
            staffId: true,
            fullName: true,
            role: true,
            status: true,
            branchId: true,
            baseSalary: true,
          },
        }),

        // Sum both PENDING and APPROVED EWA requests for the current month
        tx.ewaRequest.aggregate({
          where: {
            tenantId: tenantId,
            staffId: employeeUserId,
            status: { in: ["PENDING", "APPROVED"] },
            createdAt: {
              gte: startOfMonth,
              lte: endOfMonth,
            },
          },
          _sum: {
            requestedAmount: true,
          },
        }),

        // Check if final monthly payroll has already been generated for the current month
        tx.ledgerEvent.findFirst({
          where: {
            tenantId: tenantId,
            eventType: "SALARY_PAID",
            createdAt: {
              gte: startOfMonth,
              lte: endOfMonth,
            },
          },
          select: { id: true },
        }),
      ]);

    // Verify employee profile, salaried role eligibility, and active status
    if (!employeeProfile) {
      throw new ApiError(404, "Employee profile not found.");
    }

    if (!["STAFF", "BRANCH_MANAGER", "HR"].includes(employeeProfile.role)) {
      throw new ApiError(
        403,
        "Only salaried employees (Staff, Branch Manager, or HR) are eligible for EWA requests."
      );
    }

    if (employeeProfile.status !== "ACTIVE") {
      throw new ApiError(
        403,
        "Only active employees are eligible to request an advance salary."
      );
    }

    // Require branch assignment strictly for STAFF (since their requests route to their Branch Manager)
    // HR is a central role (branchId can be null) and Branch Manager requests route to HR / Org Owner
    if (employeeProfile.role === "STAFF" && !employeeProfile.branchId) {
      throw new ApiError(
        400,
        "You must be assigned to a branch before requesting an advance salary."
      );
    }

    // Block EWA requests if current month's final payroll is already disbursed
    if (payrollDisbursedEvent) {
      throw new ApiError(
        400,
        "Monthly payroll has already been disbursed for this month. Advance requests are closed until next month."
      );
    }

    // 50% Base Salary Safety Cap & Commission Isolation
    // Note: earnedCommission is strictly excluded from EWA limit calculation
    const baseSalary = Number(employeeProfile.baseSalary) || 0;
    if (baseSalary <= 0) {
      throw new ApiError(
        400,
        "Your current base salary is not eligible for an advance salary request."
      );
    }

    const maxEwaLimit = Number((baseSalary * 0.5).toFixed(2));
    const alreadyUsedOrPending =
      Number(currentMonthEwaAgg._sum.requestedAmount) || 0;
    const remainingEwaLimit = Math.max(
      0,
      Number((maxEwaLimit - alreadyUsedOrPending).toFixed(2))
    );

    if (parsedAmount > remainingEwaLimit) {
      throw new ApiError(
        400,
        `Requested amount (${parsedAmount}) exceeds your 50% base salary safety cap. Max monthly limit: ${maxEwaLimit}, Already approved/pending: ${alreadyUsedOrPending}, Remaining available limit: ${remainingEwaLimit}.`
      );
    }

    // Create the EWA request in PENDING status
    const newEwaRequest = await tx.ewaRequest.create({
      data: {
        tenantId: tenantId,
        staffId: employeeUserId,
        requestedAmount: parsedAmount,
        status: "PENDING",
      },
      select: {
        id: true,
        requestedAmount: true,
        status: true,
        createdAt: true,
      },
    });

    // Record action in AuditLog
    await tx.auditLog.create({
      data: {
        tenantId: tenantId,
        userId: employeeUserId,
        action: `EWA_REQUEST_SUBMITTED_${employeeProfile.role}_AMOUNT_${parsedAmount}`,
        targetResource: newEwaRequest.id,
      },
    });

    const updatedRemainingLimit = Math.max(
      0,
      Number((remainingEwaLimit - parsedAmount).toFixed(2))
    );

    return {
      requesterRole: employeeProfile.role,
      ewaRequest: {
        ...newEwaRequest,
        requestedAmount: Number(newEwaRequest.requestedAmount) || 0,
      },
      limitSummary: {
        baseSalary,
        maxEwaLimit,
        previouslyUsedOrPending: alreadyUsedOrPending,
        requestedAmount: parsedAmount,
        updatedRemainingLimit,
      },
    };
  });

  // Dynamic response message based on Chain-of-Command approval hierarchy
  const approverLabelMap = {
    STAFF: "branch manager",
    BRANCH_MANAGER: "HR or organization owner",
    HR: "organization owner",
  };
  const pendingApprover =
    approverLabelMap[ewaTransactionResult.requesterRole] || "management";

  return res.status(201).json(
    new ApiResponse(
      201,
      {
        ewaRequest: ewaTransactionResult.ewaRequest,
        limitSummary: ewaTransactionResult.limitSummary,
      },
      `Advance salary (EWA) request submitted successfully and is pending ${pendingApprover} approval.`
    )
  );
});

export const getMyEwaHistory = asyncHandler(async (req, res) => {
  const employeeUserId = req.user.id;
  const tenantId = req.user.tenantId;

  const {
    timeframe = "all",
    month,
    year,
    status,
    page = 1,
    limit = 10,
  } = req.query;

  // Safe pagination setup using Math.max to prevent negative skip crashes
  const currentPage = Math.max(1, parseInt(page, 10) || 1);
  const pageSize = Math.max(1, Math.min(100, parseInt(limit, 10) || 10));
  const skip = (currentPage - 1) * pageSize;

  // Base filter locked strictly to the logged-in employee and their tenant
  const whereClause = {
    tenantId: tenantId,
    staffId: employeeUserId,
  };

  // Validate and apply optional status filter
  let appliedStatus = "ALL";
  if (status?.trim()) {
    const requestedStatus = status.trim().toUpperCase();
    if (!["PENDING", "APPROVED", "REJECTED"].includes(requestedStatus)) {
      throw new ApiError(
        400,
        "Invalid status filter. Allowed values are 'PENDING', 'APPROVED', or 'REJECTED'."
      );
    }
    whereClause.status = requestedStatus;
    appliedStatus = requestedStatus;
  }

  // Build dynamic timeframe / custom month-year date range filter
  const now = new Date();
  let appliedTimeframe = "all";

  if (month !== undefined && String(month).trim() !== "") {
    // Priority 1: Specific month & year filter (e.g., ?month=10&year=2026)
    const parsedMonth = parseInt(month, 10);
    const parsedYear =
      year !== undefined && String(year).trim() !== ""
        ? parseInt(year, 10)
        : now.getFullYear();

    if (isNaN(parsedMonth) || parsedMonth < 1 || parsedMonth > 12) {
      throw new ApiError(
        400,
        "Invalid month. Please provide a value between 1 and 12."
      );
    }

    if (isNaN(parsedYear) || parsedYear < 2000 || parsedYear > 2100) {
      throw new ApiError(
        400,
        "Invalid year. Please provide a valid 4-digit year."
      );
    }

    const startDate = new Date(parsedYear, parsedMonth - 1, 1, 0, 0, 0, 0);
    const endDate = new Date(parsedYear, parsedMonth, 0, 23, 59, 59, 999);

    whereClause.createdAt = {
      gte: startDate,
      lte: endDate,
    };
    appliedTimeframe = `${parsedYear}-${String(parsedMonth).padStart(2, "0")}`;
  } else if (timeframe?.trim()) {
    // Priority 2: Preset timeframe filter ('all', 'current_month', 'previous_month')
    const normalizedTimeframe = timeframe.trim().toLowerCase();

    if (normalizedTimeframe === "current_month") {
      const startOfCurrentMonth = new Date(
        now.getFullYear(),
        now.getMonth(),
        1,
        0, 0, 0, 0
      );
      const endOfCurrentMonth = new Date(
        now.getFullYear(),
        now.getMonth() + 1,
        0,
        23, 59, 59, 999
      );

      whereClause.createdAt = {
        gte: startOfCurrentMonth,
        lte: endOfCurrentMonth,
      };
      appliedTimeframe = "current_month";
    } else if (normalizedTimeframe === "previous_month") {
      // Automatically handles January year rollover (e.g., Jan 2026 -> Dec 2025)
      const startOfPreviousMonth = new Date(
        now.getFullYear(),
        now.getMonth() - 1,
        1,
        0, 0, 0, 0
      );
      const endOfPreviousMonth = new Date(
        now.getFullYear(),
        now.getMonth(),
        0,
        23, 59, 59, 999
      );

      whereClause.createdAt = {
        gte: startOfPreviousMonth,
        lte: endOfPreviousMonth,
      };
      appliedTimeframe = "previous_month";
    } else if (normalizedTimeframe === "all") {
      appliedTimeframe = "all";
    } else {
      throw new ApiError(
        400,
        "Invalid timeframe filter. Allowed values are 'all', 'current_month', or 'previous_month'."
      );
    }
  }

  // Fetch paginated EWA history list, total count, and filtered sum in parallel
  const [ewaList, totalRecords, filteredAmountAgg] = await Promise.all([
    prisma.ewaRequest.findMany({
      where: whereClause,
      skip: skip,
      take: pageSize,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        requestedAmount: true,
        status: true,
        approvedBy: true,
        createdAt: true,
        updatedAt: true,
      },
    }),

    prisma.ewaRequest.count({
      where: whereClause,
    }),

    prisma.ewaRequest.aggregate({
      where: whereClause,
      _sum: {
        requestedAmount: true,
      },
    }),
  ]);

  // Normalize Decimal values and prepare uniform pagination payload
  const formattedList = ewaList.map((item) => ({
    ...item,
    requestedAmount: Number(item.requestedAmount) || 0,
  }));

  const totalFilteredAmount = Number(
    (Number(filteredAmountAgg._sum.requestedAmount) || 0).toFixed(2)
  );
  const totalPages = Math.ceil(totalRecords / pageSize);

  const responsePayload = {
    list: formattedList,
    summary: {
      appliedTimeframe,
      appliedStatus,
      totalFilteredAmount,
    },
    pagination: {
      totalRecords,
      totalPages,
      currentPage,
      limit: pageSize,
    },
  };

  return res.status(200).json(
    new ApiResponse(
      200,
      responsePayload,
      "EWA request history fetched successfully."
    )
  );
});
