import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import { stat } from "fs";
import { calculatePayrollData } from '../service/payroll.service.js';

const prisma = new PrismaClient();

export const createBranch = asyncHandler(async (req, res) => {
    const { name, location, contactNumber } = req.body;
    
    const tenantId = req.user.tenantId;

    // Validation Check
    if (!name?.trim() || !location?.trim() || !contactNumber?.trim()) {
        throw new ApiError(400, "branch name, location and contact number are required.");
    }

    // Zero-Tolerance Duplication Check
    const existingBranch = await prisma.branch.findFirst({
        where: {
            tenantId,
            name: {
                equals: name.trim(),
                mode: 'insensitive'
            }
        }
    });

    if (existingBranch) {
        throw new ApiError(409, `your branch '${name}' name already exists.`);
    }

    // Database Insertion
    const newBranch = await prisma.branch.create({
        data: {
            tenantId,
            name: name.trim(),
            location: location.trim(),
            contactNumber: contactNumber.trim()
        }
    });

    return res.status(201).json(
        new ApiResponse(201, newBranch, "your branch has been created successfully.")
    );
});

export const addStaff = asyncHandler(async (req, res) => {
  const { fullName, email, baseSalary } = req.body;
  const tenantId = req.user.tenantId;

  if (!fullName?.trim() || !email?.trim() || baseSalary === undefined) {
    throw new ApiError(400, "Full name, email, and base salary are required.");
  }

  const sanitizedEmail = email.trim().toLowerCase();
  const salary = Number(baseSalary);

  if (isNaN(salary) || salary < 0) {
    throw new ApiError(400, "Base salary must be a valid positive number.");
  }

  //Composite Unique Check (Same email cannot be added twice in the SAME company)
  const existingUser = await prisma.user.findUnique({
    where: {
      email_tenantId: {
        email: sanitizedEmail,
        tenantId: tenantId,
      },
    },
  });

  if (existingUser) {
    throw new ApiError(409, "A staff member with this email already exists in your organization.");
  }

  //Tenant Details & Prefix Extraction for Staff ID
  const tenantDetails = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true, tenantCode: true },
  });

  if (!tenantDetails) {
    throw new ApiError(404, "Organization not found.");
  }

  // Generate Globally Unique Staff ID -> Format: [First 4 chars of tenantCode]-[5 Random Hex chars] (e.g., A3F9-8B2C1)
  const tenantPrefix = tenantDetails.tenantCode.substring(0, 4).toUpperCase();
  const randomDigits = crypto.randomBytes(3).toString("hex").toUpperCase().substring(0, 5);
  const generatedStaffId = `${tenantPrefix}-${randomDigits}`;

  // High-Entropy Temporary Password Generation (8 Characters)
  const tempPasswordPlain = crypto.randomBytes(4).toString("hex"); // ইমেইলে পাঠানোর জন্য Plain Text
  const hashedTempPassword = await bcrypt.hash(tempPasswordPlain, 10); // ডেটাবেসে রাখার জন্য Hashed

  // Database Insertion (Status remains PENDING until they change the temp password)
  const newStaff = await prisma.user.create({
    data: {
      fullName: fullName.trim(),
      email: sanitizedEmail,
      staffId: generatedStaffId,
      password: hashedTempPassword,
      role: "STAFF",
      baseSalary: salary,
      tenantId: tenantId,
      status: "PENDING",
    },
    select: {
      id: true,
      staffId: true,
      fullName: true,
      email: true,
      role: true,
      baseSalary: true,
      status: true,
    },
  });

  // Dispatch Email with Staff ID & Temporary Password
  const activationUrl = `${process.env.FRONTEND_URL}/activate-account?staffId=${generatedStaffId}`;
  const emailMessage = `Hello ${newStaff.fullName},

You have been invited to join ${tenantDetails.name} on NexaCommand.

Here are your official login credentials:
-----------------------------------------
Official Staff ID : ${generatedStaffId}
Temporary Password: ${tempPasswordPlain}
-----------------------------------------

IMPORTANT: Your account is currently in PENDING status. To activate your account and set your own permanent password, please visit the link below and enter your Staff ID and Temporary Password:

${activationUrl}

Please keep your Staff ID safe, as you will use this ID (not your email) for all future logins.`;

  try {
    await sendEmail({
      email: sanitizedEmail,
      subject: `[Action Required] Your Official Credentials for ${tenantDetails.name}`,
      message: emailMessage,
    });
  } catch (error) {
    await prisma.user.delete({ where: { id: newStaff.id } });
    throw new ApiError(500, "Failed to send invitation email. Staff creation rolled back.");
  }

  await prisma.auditLog.create({
    data: {
      tenantId: tenantId,
      userId: req.user.id, 
      action: `PROVISIONED_STAFF_${generatedStaffId}`,
      targetResource: "USER",
    },
  });

  return res.status(201).json(
    new ApiResponse(
      201,
      newStaff,
      "Staff provisioned successfully. Official Staff ID and Temporary Password sent via email."
    )
  );
});

export const acceptInvite = asyncHandler(async (req, res) => {
  const { staffId, tempPassword, newPassword, confirmNewPassword } = req.body;

  if (!staffId?.trim() || !tempPassword?.trim() || !newPassword?.trim() || !confirmNewPassword?.trim()) {
    throw new ApiError(400, "Staff ID, temporary password, and new password fields are required.");
  }

  if (newPassword !== confirmNewPassword) {
    throw new ApiError(400, "New password and confirm password do not match.");
  }

  if (newPassword.trim().length < 6) {
    throw new ApiError(400, "New password must be at least 6 characters long.");
  }

  if (tempPassword.trim() === newPassword.trim()) {
    throw new ApiError(400, "New password cannot be the same as your temporary password.");
  }

  // Global Lookup using Unique Staff ID
  const user = await prisma.user.findUnique({
    where: {
      staffId: staffId.trim().toUpperCase(),
    },
    include: {
      tenant: {
        select: { name: true },
      },
    },
  });

  if (!user) {
    throw new ApiError(404, "Invalid Staff ID. No user found.");
  }

  // Check Account State
  if (user.status === "ACTIVE") {
    throw new ApiError(400, "This account is already activated. Please go to the login page.");
  }

  if (user.status === "SUSPENDED") {
    throw new ApiError(403, "This account has been suspended by the organization.");
  }

  //Verify the Temporary Password
  const isTempPasswordValid = await bcrypt.compare(tempPassword.trim(), user.password);
  if (!isTempPasswordValid) {
    throw new ApiError(401, "Invalid temporary password. Please check your invitation email.");
  }

  //Hash Permanent Password & Activate Account
  const hashedNewPassword = await bcrypt.hash(newPassword.trim(), 10);

  const activatedUser = await prisma.user.update({
    where: { id: user.id },
    data: {
      password: hashedNewPassword,
      status: "ACTIVE", 
    },
    select: {
      id: true,
      staffId: true,
      fullName: true,
      email: true,
      role: true,
      status: true,
    },
  });

  // Audit Log for Activation
  await prisma.auditLog.create({
    data: {
      tenantId: user.tenantId,
      userId: user.id,
      action: "STAFF_ACCOUNT_ACTIVATED",
      targetResource: "USER",
    },
  });

  return res.status(200).json(
    new ApiResponse(
      200,
      { user: activatedUser, workspace: user.tenant.name },
      "Account activated successfully! You can now log in using your Staff ID and new password."
    )
  );
});

export const updateUserStatus = asyncHandler(async (req, res) => {
    const { userId } = req.params;
    const { status } = req.body;

    if (!['ACTIVE', 'SUSPENDED'].includes(status)) {
        throw new ApiError(400, "Invalid status. Allowed values are 'ACTIVE' or 'SUSPENDED'.");
    }

    if (userId === req.user.id) {
        throw new ApiError(403, "Action denied. You cannot modify your own access status.");
    }

    const targetUser = await prisma.user.findFirst({
        where: { 
            id: userId,
            tenantId: req.user.tenantId
        }
    });

    if (!targetUser) {
        throw new ApiError(404, "User not found or does not belong to your organization.");
    }

    //Hierarchy Protection - Prevent modifying other owners
    if (['SUPER_ADMIN', 'ORG_OWNER'].includes(targetUser.role)) {
        throw new ApiError(403, "Action denied. You cannot modify the status of an administrator or owner.");
    }

    if (targetUser.status === status) {
        throw new ApiError(400, `User is already in '${status}' state.`);
    }

    if (targetUser.status === 'PENDING' && status === 'ACTIVE') {
        throw new ApiError(400, "Action denied. A pending user must activate their account via the email invitation link.");
    }

    // Prepare dynamic update payload
    const updateData = { status };
    
    // terminate the session if the user is being suspended
    if (status === 'SUSPENDED') {
        updateData.refreshToken = null;
    }

    // Database Mutation with Safe Projection
    const updatedUser = await prisma.user.update({
        where: { 
            id: userId 
        },
        data: updateData,
        select: {
            id: true,
            staffId: true,
            fullName: true,
            email: true,
            role: true,
            status: true
        }
    });

    return res.status(200).json(
        new ApiResponse(200, updatedUser, "User status has been successfully updated.")
    );
});

export const getBranchList = asyncHandler(async (req, res) => {
    const tenantId = req.user.tenantId;

    const branchList = await prisma.branch.findMany({
        where: {
            tenantId: tenantId
        },
        orderBy: {
            createdAt: "desc"
        },
        select: {
            id: true,
            name: true,
            location: true,
            contactNumber: true,
            manager: {
                select: {
                    id: true,
                    staffId: true,
                    fullName: true,
                    email: true,
                    role: true
                }
            },
            _count: {
                select: {
                    staff: {
                        where: {
                            status: "ACTIVE"
                        }
                    }
                }
            }
        }
    });
    
    return res.status(200).json(
        new ApiResponse(200, branchList, "Branches fetched successfully.")
    );
});

export const assignManager = asyncHandler(async (req, res) => {
    const { userId, branchId } = req.body;

    if (!userId?.trim() || !branchId?.trim()) {
        throw new ApiError(400, "User ID and Branch ID are required.");
    }

    // Concurrent Fetching with Relationship Expansion
    const [existingUser, existingBranch] = await Promise.all([
        prisma.user.findFirst({
            where: { id: userId, tenantId: req.user.tenantId },
            include: { managedBranch: true } 
        }),
        prisma.branch.findFirst({
            where: { id: branchId, tenantId: req.user.tenantId }
        })
    ]);

    if (!existingUser) {
        throw new ApiError(404, "User not found or does not belong to your organization.");
    }

    if (!existingBranch) {
        throw new ApiError(404, "Branch not found or does not belong to your organization.");
    }

    // Strict Rule-Based Gatekeepers
    if (existingBranch.managerId !== null) {
        throw new ApiError(409, "This branch already has a manager. Remove the current manager first.");
    }

    if (existingUser.status !== "ACTIVE") {
        throw new ApiError(400, "User must be active to be assigned as a branch manager.");
    }

    if (['SUPER_ADMIN', 'ORG_OWNER'].includes(existingUser.role)) {
        throw new ApiError(403, "Action denied. Owners or Admins cannot be assigned as branch managers.");
    }

    if (existingUser.managedBranch) {
        throw new ApiError(409, "This user is already managing another branch.");
    }

    const transactionResult = await prisma.$transaction(async (prismaTx) => {
        const updatedUser = await prismaTx.user.update({
            where: { id: existingUser.id },
            data: { 
                role: "BRANCH_MANAGER"
            },
            select: {
                id: true,
                staffId: true,
                fullName: true,
                email: true,
                role: true,
                status: true,
                branchId: true
            }
        });

        const updatedBranch = await prismaTx.branch.update({
            where: { id: existingBranch.id },
            data: { managerId: existingUser.id },
            select: {
                id: true,
                name: true,
                location: true,
                contactNumber: true,
                manager: {
                    select: {
                        id: true,
                        staffId: true,
                        fullName: true,
                        email: true,
                        role: true
                    }
                },
                _count: {
                    select: {
                        staff: {
                            where: { status: "ACTIVE" }
                        }
                    }
                }
            }
        });

        return { updatedUser, updatedBranch };
    });

    return res.status(200).json(
        new ApiResponse(200, transactionResult, "Manager has been assigned successfully.")
    );
});

export const removeManager = asyncHandler(async (req, res) => {
    const { branchId } = req.body;

    if (!branchId?.trim()) {
        throw new ApiError(400, "Branch ID is required.");
    }

    // Fetch branch with its current manager
    const existingBranch = await prisma.branch.findFirst({
        where: { 
            id: branchId, 
            tenantId: req.user.tenantId 
        }
    });

    if (!existingBranch) {
        throw new ApiError(404, "Branch not found or does not belong to your organization.");
    }

    // Ensure the branch actually has a manager
    if (existingBranch.managerId === null) {
        throw new ApiError(400, "This branch currently does not have an active manager to remove.");
    }

    const transactionResult = await prisma.$transaction(async (prismaTx) => {
        // Demote the current manager to STAFF 
        // (They remain physically in the branch as a regular staff member)
        const demotedUser = await prismaTx.user.update({
            where: { id: existingBranch.managerId },
            data: { role: "STAFF" },
            select: {
                id: true,
                staffId: true,
                fullName: true,
                email: true,
                role: true,
                status: true,
                branchId: true
            }
        });

        // Remove the manager link from the branch
        const updatedBranch = await prismaTx.branch.update({
            where: { id: existingBranch.id },
            data: { managerId: null },
            select: {
                id: true,
                name: true,
                location: true,
                contactNumber: true,
                managerId: true
            }
        });

        return { demotedUser, updatedBranch };
    });

    return res.status(200).json(
        new ApiResponse(200, transactionResult, "Manager has been successfully removed and demoted to staff.")
    );
});

export const payrollPreview = asyncHandler(async (req, res) => {
    const tenantId = req.user.tenantId;

    // Fetch and calculate payroll data purely in memory
    const previewData = await calculatePayrollData(tenantId);

    return res.status(200).json(
        new ApiResponse(200, previewData, "Payroll preview generated successfully.")
    );
});

export const generatePayroll = asyncHandler(async (req, res) => {
    const tenantId = req.user.tenantId;
    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1, 0, 0, 0, 0);
    const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59, 999);

    // Step 1: Idempotency Check - Prevent double salary generation for the same month
    const existingPayroll = await prisma.ledgerEvent.findFirst({
        where: {
            tenantId: tenantId,
            eventType: "SALARY_PAID",
            createdAt: {
                gte: startOfMonth,
                lte: endOfMonth
            }
        }
    });

    if (existingPayroll) {
        throw new ApiError(409, "Payroll for this month has already been generated and recorded.");
    }

    // Step 2: Fetch the validated, real-time calculated data from the service
    const payrollData = await calculatePayrollData(tenantId);

    // Step 3: Prepare the batch transaction array
    const transactionOperations = [];

    for (const staff of payrollData.details) {
        // Record the salary disbursement in the ledger[cite: 8]
        transactionOperations.push(
            prisma.ledgerEvent.create({
                data: {
                    tenantId: tenantId,
                    transactionId: `PR-${Date.now()}-${staff.userId.substring(0, 5)}`,
                    eventType: "SALARY_PAID",
                    debitAccount: "COMPANY_ACCOUNT",
                    creditAccount: "STAFF_ACCOUNT",
                    amount: staff.netPayable,
                    referenceId: staff.userId,
                    referenceType: "PAYROLL"
                }
            })
        );

        // Reset the staff's earned commission back to 0 for the next month[cite: 8]
        transactionOperations.push(
            prisma.user.update({
                where: { id: staff.userId },
                data: { earnedCommission: 0 }
            })
        );
    }

    await prisma.$transaction(transactionOperations);

    return res.status(200).json(
        new ApiResponse(200, {
            processedMonth: payrollData.month,
            totalStaffProcessed: payrollData.totalStaff,
            totalAmountDisbursed: payrollData.totalCompanyPayroll
        }, "Payroll has been finalized and recorded in the ledger successfully.")
    );
});

export const getStaffList = asyncHandler(async(req, res) => {
    const tenantId = req.user.tenantId;
    const { limit, page, search } = req.query;

    const pageNumber = Math.max(1, parseInt(page) || 1);
    const limitNumber = Math.max(1, parseInt(limit) || 10);
    const skip = (pageNumber - 1) * limitNumber;

    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1, 0, 0, 0, 0);
    const endOfMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59, 999);

    const where = {
        tenantId: tenantId,
        role: { in: ['STAFF', 'BRANCH_MANAGER'] }
    };

    if (search) {
        where.OR = [
            { fullName: { contains: search, mode: 'insensitive' } },
            { email: { contains: search, mode: 'insensitive' } },
            { staffId: { contains: search, mode: 'insensitive' } }
        ];
    }

    const [totalStaff, staffList] = await Promise.all([
        prisma.user.count({
            where: where
        }),
        prisma.user.findMany({
            where: where,
            skip: skip,
            take: limitNumber,
            orderBy: {
                createdAt: "desc" 
            },
            select: {
                id: true,
                staffId: true,
                fullName: true,
                email: true,
                role: true,
                status: true,
                branchId: true,
                earnedCommission: true, 
                branch: {
                    select: {
                        name: true
                    }
                },
                _count: {
                    select: {
                        sales: {
                            where: {
                                status: "ACTIVE",
                                commissionEarned: true,
                                createdAt: {
                                    gte: startOfMonth,
                                    lte: endOfMonth
                                }
                            }
                        },
                        ewaRequests: {
                            where: {
                                status: "APPROVED",
                                createdAt: {
                                    gte: startOfMonth,
                                    lte: endOfMonth
                                }
                            }
                        }
                    }
                }
            }
        })
    ]);

    const totalPages = Math.ceil(totalStaff / limitNumber);

    return res.status(200).json(
        new ApiResponse(200, {
            staffs: staffList,
            meta: {
                totalRecords: totalStaff,
                currentPage: pageNumber,
                totalPages: totalPages,
                limit: limitNumber
            }
        }, "Staff directory fetched successfully.")
    );
});





