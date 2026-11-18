import { PrismaClient } from "@prisma/client";
import crypto from "crypto";
import bcrypt from "bcrypt";
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { sendEmail } from "../utils/sendEmail.js";

const prisma = new PrismaClient();

export const getMyDashboard = asyncHandler(async (req, res) => {
  const staffUserId = req.user.id;
  const tenantId = req.user.tenantId;

  //Define time boundaries for Today (Sales) and Current Month (EWA)
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

  //Run parallel queries for profile, today's sales, and current month EWA requests
  const [
    staffProfile,
    todaySalesAgg,
    approvedEwaAgg,
    pendingEwaAgg,
  ] = await Promise.all([
    // Fetch staff basic profile and salary info
    prisma.user.findFirst({
      where: {
        id: staffUserId,
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

    // Calculate today's total PAID sales created by this staff member
    prisma.invoice.aggregate({
      where: {
        tenantId: tenantId,
        creatorId: staffUserId,
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
        staffId: staffUserId,
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
        staffId: staffUserId,
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

  if (!staffProfile) {
    throw new ApiError(404, "Staff profile not found.");
  }

  // 3. Safely convert Decimal and nullable aggregate values to Numbers
  const baseSalary = Number(staffProfile.baseSalary) || 0;
  const earnedCommission = Number(staffProfile.earnedCommission) || 0;

  const todayTotalSales = Number(todaySalesAgg._sum.netPayable) || 0;
  const todayInvoiceCount = Number(todaySalesAgg._count.id) || 0;

  const approvedEwaAmount = Number(approvedEwaAgg._sum.requestedAmount) || 0;
  const pendingEwaAmount = Number(pendingEwaAgg._sum.requestedAmount) || 0;

  // 4. Calculate real-time earnings and 50% EWA safety cap (Commission is isolated from EWA cap)
  const grossEarnings = baseSalary + earnedCommission;
  const maxEwaLimit = Number((baseSalary * 0.5).toFixed(2));
  const usedOrLockedEwa = approvedEwaAmount + pendingEwaAmount;
  const remainingEwaLimit = Math.max(
    0,
    Number((maxEwaLimit - usedOrLockedEwa).toFixed(2))
  );
  const estimatedNetPayable = Math.max(
    0,
    Number((grossEarnings - approvedEwaAmount).toFixed(2))
  );

  // 5. Build clean dashboard summary payload
  const dashboardData = {
    profile: {
      id: staffProfile.id,
      staffId: staffProfile.staffId,
      fullName: staffProfile.fullName,
      email: staffProfile.email,
      avatarUrl: staffProfile.avatarUrl,
      role: staffProfile.role,
      designation: staffProfile.designation,
      department: staffProfile.department,
      branch: staffProfile.branch,
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
      "Staff dashboard summary fetched successfully."
    )
  );
});

export const requestEwa = asyncHandler(async (req, res) => {
  const staffUserId = req.user.id;
  const tenantId = req.user.tenantId;
  const { requestedAmount } = req.body;

  // 1. Validate requestedAmount input (must be a positive number)
  const parsedAmount = Number(parseFloat(requestedAmount).toFixed(2));
  if (!requestedAmount || isNaN(parsedAmount) || parsedAmount <= 0) {
    throw new ApiError(
      400,
      "Please provide a valid positive amount for the advance salary request."
    );
  }

  // 2. Define current month timeframe boundaries
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

  // 3. Execute eligibility verification, 50% cap check, and record creation inside an atomic transaction
  const ewaTransactionResult = await prisma.$transaction(async (tx) => {
    const [staffProfile, currentMonthEwaAgg, payrollDisbursedEvent] =
      await Promise.all([
        // Fetch staff member's current baseSalary, status, and branch assignment
        tx.user.findFirst({
          where: {
            id: staffUserId,
            tenantId: tenantId,
          },
          select: {
            id: true,
            staffId: true,
            fullName: true,
            status: true,
            branchId: true,
            baseSalary: true,
          },
        }),

        // Sum both PENDING and APPROVED EWA requests for the current month
        tx.ewaRequest.aggregate({
          where: {
            tenantId: tenantId,
            staffId: staffUserId,
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

    //Verify staff profile and active status
    if (!staffProfile) {
      throw new ApiError(404, "Staff profile not found.");
    }

    if (staffProfile.status !== "ACTIVE") {
      throw new ApiError(
        403,
        "Only active staff members are eligible to request an advance salary."
      );
    }

    //Ensure staff is assigned to a branch (required for Branch Manager approval routing)
    if (!staffProfile.branchId) {
      throw new ApiError(
        400,
        "You must be assigned to a branch before requesting an advance salary."
      );
    }

    //Block EWA requests if current month's final payroll is already disbursed
    if (payrollDisbursedEvent) {
      throw new ApiError(
        400,
        "Monthly payroll has already been disbursed for this month. Advance requests are closed until next month."
      );
    }

    // 50% Base Salary Safety Cap & Commission Isolation
    // Note: earnedCommission is strictly excluded from EWA limit calculation
    const baseSalary = Number(staffProfile.baseSalary) || 0;
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
        staffId: staffUserId,
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
        userId: staffUserId,
        action: `EWA_REQUEST_SUBMITTED_AMOUNT_${parsedAmount}`,
        targetResource: newEwaRequest.id,
      },
    });

    const updatedRemainingLimit = Math.max(
      0,
      Number((remainingEwaLimit - parsedAmount).toFixed(2))
    );

    return {
      ewaRequest: newEwaRequest,
      limitSummary: {
        baseSalary,
        maxEwaLimit,
        previouslyUsedOrPending: alreadyUsedOrPending,
        requestedAmount: parsedAmount,
        updatedRemainingLimit,
      },
    };
  });

  return res.status(201).json(
    new ApiResponse(
      201,
      ewaTransactionResult,
      "Advance salary (EWA) request submitted successfully and is pending branch manager approval."
    )
  );
});

