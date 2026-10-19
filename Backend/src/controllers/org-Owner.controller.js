import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import { stat } from "fs";

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



