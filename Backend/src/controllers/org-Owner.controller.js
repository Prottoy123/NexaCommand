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
    const { fullName, email, role, branchId } = req.body;
    const tenantId = req.user.tenantId;

    // Step 1: Basic validation for required fields
    if (!fullName?.trim() || !email?.trim()) {
        throw new ApiError(400, "Full name and email are required.");
    }

    // Step 2: Strict role checking
    if (!['STAFF', 'BRANCH_MANAGER'].includes(role)) {
        throw new ApiError(403, "Invalid role. You can only assign STAFF or BRANCH_MANAGER roles.");
    }

    // Step 3: Cross-tenant branch validation
    if (branchId) {
        const existingBranch = await prisma.branch.findFirst({
            where: { id: branchId, tenantId }
        });

        if (!existingBranch) {
            throw new ApiError(404, "Branch not found or does not belong to your organization.");
        }
    }

    // Step 4: Composite email duplication check
    const sanitizedEmail = email.trim().toLowerCase();
    const existingUser = await prisma.user.findFirst({
        where: { tenantId, email: sanitizedEmail }
    });

    if (existingUser) {
        throw new ApiError(409, "A user with this email already exists in your organization.");
    } 

    // Step 5: Secure invitation logic with dummy password
    // The password field is mandatory in the schema, so we generate a random hash
    const dummyPassword = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10);
    
    // Generate a secure invite token
    const inviteToken = crypto.randomBytes(32).toString("hex");
    const hashedInviteToken = crypto.createHash('sha256').update(inviteToken).digest('hex');
    const tokenExpiry = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours expiry

    // Step 6: Database insertion
    const user = await prisma.user.create({
        data: {
            fullName: fullName.trim(),
            email: sanitizedEmail,
            password: dummyPassword, 
            branchId: branchId || null,
            tenantId,
            status: "PENDING",
            forgotPasswordToken: hashedInviteToken,
            forgotPasswordExpiry: tokenExpiry
        },
        select: {
            id: true,
            fullName: true,
            email: true,
            role: true,
            status: true,
            branchId: true
        }
    });

    // Step 7: Fire and forget email dispatch[cite: 2]
    const inviteUrl = `${process.env.FRONTEND_URL}/accept-invite?token=${inviteToken}`;
    const emailMessage = `
        Hello ${user.fullName}, 
        
        You have been invited to join the platform. 
        Please click the link below to set up your password and activate your account:
        ${inviteUrl}
        
        This link will expire in 48 hours.
    `;

    try {
        await sendEmail(sanitizedEmail, "Welcome to the system - Activate your account", emailMessage);
    } catch (error) {
        console.error("Invitation email sending failed:", error);
    }

    return res.status(201).json(
        new ApiResponse(201, user, "Staff has been added successfully and an invitation link has been sent.")
    );
});

export const acceptInvite = asyncHandler(async (req, res) => {
    const { token, newPassword } = req.body;

    if (!token?.trim() || !newPassword?.trim()) {
        throw new ApiError(400, "Invitation token and new password are required.");
    }

    if (newPassword.trim().length < 6) {
        throw new ApiError(400, "New password must be at least 6 characters long.");
    }

    const hashedToken = crypto.createHash("sha256").update(token.trim()).digest("hex");

    // Find the pending user with a valid, non-expired token
    const user = await prisma.user.findFirst({
        where: {
            forgotPasswordToken: hashedToken,
            forgotPasswordExpiry: { gt: new Date() },
            status: "PENDING"
        }
    });

    if (!user) {
        throw new ApiError(400, "Invalid or expired invitation token.");
    }

    const hashedNewPassword = await bcrypt.hash(newPassword.trim(), 10);
    
    //Update user state, clear tokens, and project only safe fields
    const updatedUser = await prisma.user.update({
        where: {
            id: user.id
        },
        data: {
            password: hashedNewPassword,
            status: "ACTIVE",
            forgotPasswordToken: null,
            forgotPasswordExpiry: null
        },
        select: {
            id: true,
            fullName: true,
            email: true,
            role: true,
            status: true
        }
    });

    return res.status(200).json(
        new ApiResponse(200, updatedUser, "Your account has been activated successfully. You can now log in.")
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
                role: "BRANCH_MANAGER",
                branchId: existingBranch.id // Linking the user to the physical branch
            },
            select: {
                id: true,
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


