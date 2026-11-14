import crypto from "crypto";
import bcrypt from "bcrypt";
import prisma from "../config/prisma.config.js"; // Adjust path based on your prisma client file
import { asyncHandler } from "../utils/asyncHandler.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { sendEmail } from "../utils/sendEmail.js";


export const provisionStaff = asyncHandler(async (req, res) => {
  const { fullName, email, branchId, designation, department, baseSalary, role } = req.body;
  const tenantId = req.user.tenantId;

  if (
    !fullName?.trim() ||
    !email?.trim() ||
    !branchId?.trim() ||
    !designation?.trim() ||
    !department?.trim() ||
    baseSalary === undefined
  ) {
    throw new ApiError(
      400,
      "Full name, email, branch ID, designation, department, and base salary are required."
    );
  }

  if (role && role.trim().toUpperCase() !== "STAFF") {
    throw new ApiError(
      403,
      "Access denied. You can only provision regular STAFF members through the HR portal."
    );
  }

  const sanitizedEmail = email.trim().toLowerCase();
  const salary = Number(baseSalary);

  // Ensure base salary is a valid positive number
  if (isNaN(salary) || salary < 0) {
    throw new ApiError(400, "Base salary must be a valid positive number.");
  }

  // Verify that the target branch exists and belongs to the current tenant
  const branchExists = await prisma.branch.findFirst({
    where: {
      id: branchId.trim(),
      tenantId: tenantId,
    },
    select: { id: true, name: true },
  });

  if (!branchExists) {
    throw new ApiError(404, "Selected branch not found in your organization.");
  }

  // Check if a user with this email already exists in the same tenant
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

  // Fetch tenant name and tenantCode to generate the unique Staff ID
  const tenantDetails = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { name: true, tenantCode: true },
  });

  if (!tenantDetails) {
    throw new ApiError(404, "Organization not found.");
  }

  // Generate globally unique Staff ID -> Format: [First 4 chars of tenantCode]-[5 Random Hex chars]
  const tenantPrefix = tenantDetails.tenantCode.substring(0, 4).toUpperCase();
  const randomDigits = crypto.randomBytes(3).toString("hex").toUpperCase().substring(0, 5);
  const generatedStaffId = `${tenantPrefix}-${randomDigits}`;

  // Generate 8-character temporary password and hash it for database storage
  const tempPasswordPlain = crypto.randomBytes(4).toString("hex");
  const hashedTempPassword = await bcrypt.hash(tempPasswordPlain, 10);

  // Create the staff record with hardcoded STAFF role and PENDING status
  const newStaff = await prisma.user.create({
    data: {
      fullName: fullName.trim(),
      email: sanitizedEmail,
      staffId: generatedStaffId,
      password: hashedTempPassword,
      role: "STAFF", // Strictly locked to STAFF
      designation: designation.trim(),
      department: department.trim(),
      branchId: branchExists.id,
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
      designation: true,
      department: true,
      branchId: true,
      baseSalary: true,
      status: true,
    },
  });

  // Prepare plain-text activation email message
  const activationUrl = `${process.env.FRONTEND_URL}/activate-account?staffId=${generatedStaffId}`;
  const emailMessage = `Hello ${newStaff.fullName},

You have been invited to join ${tenantDetails.name} as ${newStaff.designation} (${newStaff.department} Department - ${branchExists.name} Branch) on NexaCommand.

Here are your official login credentials:
-----------------------------------------
Official Staff ID : ${generatedStaffId}
Designation       : ${newStaff.designation}
Department        : ${newStaff.department}
Temporary Password: ${tempPasswordPlain}
-----------------------------------------

IMPORTANT: Your account is currently in PENDING status. To activate your account and set your own permanent password, please visit the link below and enter your Staff ID and Temporary Password:

${activationUrl}

Please keep your Staff ID safe, as you will use this ID (not your email) for all future logins.`;

  // Dispatch email and auto-rollback user creation if email fails
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

  // Record the provisioning event in the AuditLog
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

export const promoteStaff = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { designation, department, baseSalary, role, targetBranchId } = req.body;
  const tenantId = req.user.tenantId;

  if (
    !designation?.trim() ||
    !department?.trim() ||
    baseSalary === undefined ||
    !role?.trim()
  ) {
    throw new ApiError(
      400,
      "Designation, department, base salary, and role are all required for promotion."
    );
  }

  // Prevent user from promoting themselves
  if (userId === req.user.id) {
    throw new ApiError(403, "You cannot promote or update your own profile.");
  }

  const salary = Number(baseSalary);
  if (isNaN(salary) || salary <= 0) {
    throw new ApiError(400, "Base salary must be a valid positive number greater than zero.");
  }

  // Validate target role (only STAFF or BRANCH_MANAGER allowed)
  const requestedRole = role.trim().toUpperCase();
  if (!["STAFF", "BRANCH_MANAGER"].includes(requestedRole)) {
    throw new ApiError(
      400,
      "Invalid role. Staff can only hold 'STAFF' or 'BRANCH_MANAGER' roles."
    );
  }

  // 4. Fetch target staff member and organization details
  const [targetStaff, tenantDetails] = await Promise.all([
    prisma.user.findFirst({
      where: { id: userId, tenantId: tenantId },
    }),
    prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    }),
  ]);

  if (!targetStaff) {
    throw new ApiError(404, "Staff member not found in your organization.");
  }

  // Only ACTIVE staff members can be promoted or transferred
  if (targetStaff.status !== "ACTIVE") {
    throw new ApiError(400, "Only ACTIVE staff members are eligible for promotion or transfer.");
  }

  // Block modifications to Owner, Super Admin, or other HR accounts
  if (["ORG_OWNER", "SUPER_ADMIN", "HR"].includes(targetStaff.role)) {
    throw new ApiError(403, "Access denied. You cannot modify Owner or HR accounts.");
  }

  // 5. Determine target branch (use new targetBranchId if provided, otherwise keep current branchId)
  const finalBranchId = targetBranchId?.trim() ? targetBranchId.trim() : targetStaff.branchId;

  if (!finalBranchId) {
    throw new ApiError(400, "A valid branch ID is required for this staff member.");
  }

  // 6. Execute atomic transaction for Promotion, Branch Manager assignment, and AuditLog
  const updatedStaff = await prisma.$transaction(async (tx) => {

    const branch = await tx.branch.findFirst({
      where: { id: finalBranchId, tenantId: tenantId },
    });

    if (!branch) {
      throw new ApiError(404, "Target branch not found in your organization.");
    }

    // If promoted to BRANCH_MANAGER, check if the branch already has a manager
    if (requestedRole === "BRANCH_MANAGER") {
      if (branch.managerId && branch.managerId !== targetStaff.id) {
        throw new ApiError(
          409,
          `The ${branch.name} branch already has an assigned Branch Manager.`
        );
      }

      // Assign this staff member as the manager of the target branch
      await tx.branch.update({
        where: { id: branch.id },
        data: { managerId: targetStaff.id },
      });
    }

    // Update staff profile with all promotion details
    const promotedUser = await tx.user.update({
      where: { id: targetStaff.id },
      data: {
        designation: designation.trim(),
        department: department.trim(),
        baseSalary: salary,
        role: requestedRole,
        branchId: branch.id,
      },
      select: {
        id: true,
        staffId: true,
        fullName: true,
        email: true,
        role: true,
        designation: true,
        department: true,
        baseSalary: true,
        branchId: true,
        status: true,
        updatedAt: true,
      },
    });

    // Save complete promotion record in AuditLog
    await tx.auditLog.create({
      data: {
        tenantId: tenantId,
        userId: req.user.id,
        action: `PROMOTED_${promotedUser.staffId}_TO_${promotedUser.role}_${promotedUser.designation.toUpperCase().replace(/\s+/g, "_")}_SALARY_${salary}`,
        targetResource: "USER",
      },
    });

    return { promotedUser, branchName: branch.name };
  });

  // 7. Send official promotion notification email
  const emailMessage = `Hello ${updatedStaff.promotedUser.fullName},

Congratulations! Your employment profile at ${tenantDetails.name} has been officially updated/promoted.

Here are your updated employment details:
-----------------------------------------
Official Staff ID : ${updatedStaff.promotedUser.staffId}
New Designation   : ${updatedStaff.promotedUser.designation}
Department        : ${updatedStaff.promotedUser.department}
System Role       : ${updatedStaff.promotedUser.role}
Assigned Branch   : ${updatedStaff.branchName}
Revised Salary    : ${updatedStaff.promotedUser.baseSalary}
-----------------------------------------

Log in to your NexaCommand dashboard to view your updated profile. Keep up the great work!`;

  try {
    await sendEmail({
      email: updatedStaff.promotedUser.email,
      subject: `Official Promotion & Profile Update - ${tenantDetails.name}`,
      message: emailMessage,
    });
  } catch (error) {
    console.error("Failed to send promotion email:", error.message);
  }

  return res.status(200).json(
    new ApiResponse(
      200,
      updatedStaff.promotedUser,
      "Staff promoted and updated successfully."
    )
  );
});

export const updateStaffStatus = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { status } = req.body;
  const tenantId = req.user.tenantId;

  if (!status?.trim()) {
    throw new ApiError(400, "Account status is required.");
  }

  const requestedStatus = status.trim().toUpperCase();
  if (!["ACTIVE", "SUSPENDED"].includes(requestedStatus)) {
    throw new ApiError(
      400,
      "Invalid status. Status can only be updated to 'ACTIVE' or 'SUSPENDED'."
    );
  }

  if (userId === req.user.id) {
    throw new ApiError(403, "Forbidden. You cannot change your own account status.");
  }

  const targetUser = await prisma.user.findFirst({
    where: {
      id: userId,
      tenantId: tenantId,
    },
  });

  if (!targetUser) {
    throw new ApiError(404, "Staff member not found in your organization.");
  }

  if (["ORG_OWNER", "SUPER_ADMIN", "HR"].includes(targetUser.role)) {
    throw new ApiError(
      403,
      "Forbidden. HR portal can only manage the status of STAFF or BRANCH_MANAGER accounts."
    );
  }

  if (targetUser.status === "PENDING" && requestedStatus === "ACTIVE") {
    throw new ApiError(
      400,
      "Cannot manually activate a PENDING account. The staff member must accept their invitation email first."
    );
  }

  if (targetUser.status === requestedStatus) {
    throw new ApiError(
      400,
      `This staff member's account is already ${requestedStatus}.`
    );
  }

  // 7. Update status and kill active session (refreshToken: null) if suspended
  const updatedStaff = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: targetUser.id },
      data: {
        status: requestedStatus,
        ...(requestedStatus === "SUSPENDED" && { refreshToken: null }), // Kill session immediately on suspension
      },
      select: {
        id: true,
        staffId: true,
        fullName: true,
        email: true,
        role: true,
        designation: true,
        department: true,
        branchId: true,
        status: true,
        updatedAt: true,
      },
    });

    await tx.auditLog.create({
      data: {
        tenantId: tenantId,
        userId: req.user.id,
        action: `CHANGED_STAFF_STATUS_${user.staffId}_TO_${requestedStatus}`,
        targetResource: "USER",
      },
    });

    return user;
  });

  return res.status(200).json(
    new ApiResponse(
      200,
      updatedStaff,
      `Staff account status has been updated to ${requestedStatus} successfully.`
    )
  );
});

export const getHrDirectory = asyncHandler(async (req, res) => {
  const {
    branchId,
    department,
    designation,
    role,
    status,
    search,
    page = 1,
    limit = 10,
  } = req.query;

  const tenantId = req.user.tenantId;

  //Safe pagination setup using Math.max to prevent negative skip crashes
  const currentPage = Math.max(1, parseInt(page, 10) || 1);
  const pageSize = Math.max(1, Math.min(100, parseInt(limit, 10) || 10));
  const skip = (currentPage - 1) * pageSize;

  // Build base query filter (Isolate by tenant and exclude ORG_OWNER / SUPER_ADMIN)
  const whereClause = {
    tenantId: tenantId,
    id: { not: req.user.id }, // Exclude the currently logged-in user from their own list
    role: { in: ["STAFF", "BRANCH_MANAGER", "HR"] },
  };

  // Apply dynamic filters if provided in query params

  if (branchId?.trim()) {
    whereClause.branchId = branchId.trim();
  }

  // Filter by department (case-insensitive)
  if (department?.trim()) {
    whereClause.department = {
      contains: department.trim(),
      mode: "insensitive",
    };
  }

  // Filter by designation (case-insensitive)
  if (designation?.trim()) {
    whereClause.designation = {
      contains: designation.trim(),
      mode: "insensitive",
    };
  }

  // Validate and filter by role
  if (role?.trim()) {
    const requestedRole = role.trim().toUpperCase();
    if (!["STAFF", "BRANCH_MANAGER", "HR"].includes(requestedRole)) {
      throw new ApiError(
        400,
        "Invalid role filter. Allowed values are 'STAFF', 'BRANCH_MANAGER', or 'HR'."
      );
    }
    whereClause.role = requestedRole;
  }

  // Validate and filter by account status
  if (status?.trim()) {
    const requestedStatus = status.trim().toUpperCase();
    if (!["ACTIVE", "SUSPENDED", "PENDING"].includes(requestedStatus)) {
      throw new ApiError(
        400,
        "Invalid status filter. Allowed values are 'ACTIVE', 'SUSPENDED', or 'PENDING'."
      );
    }
    whereClause.status = requestedStatus;
  }

  // Apply case-insensitive search by fullName, email, or staffId
  if (search?.trim()) {
    const searchTerm = search.trim();
    whereClause.OR = [
      { fullName: { contains: searchTerm, mode: "insensitive" } },
      { email: { contains: searchTerm, mode: "insensitive" } },
      { staffId: { contains: searchTerm, mode: "insensitive" } },
    ];
  }

  // Fetch paginated staff list and total count in parallel
  const [directoryList, totalRecords] = await Promise.all([
    prisma.user.findMany({
      where: whereClause,
      skip: skip,
      take: pageSize,
      orderBy: { createdAt: "desc" },
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
        status: true,
        branchId: true,
        branch: {
          select: {
            id: true,
            name: true,
            location: true,
          },
        },
        createdAt: true, // Used as Joining Date on the frontend
      },
    }),
    prisma.user.count({
      where: whereClause,
    }),
  ]);

  const totalPages = Math.ceil(totalRecords / pageSize);
  const responsePayload = {
    list: directoryList,
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
      "Central HR directory fetched successfully."
    )
  );
});