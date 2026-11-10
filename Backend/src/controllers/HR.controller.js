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