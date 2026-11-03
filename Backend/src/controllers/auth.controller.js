import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import jwt from "jsonwebtoken";
import { verifyGoogleIdToken } from "../config/google.config.js";

const prisma = new PrismaClient();

const extractPublicIdFromUrl = (url) => {
  if (!url) return null;
  const parts = url.split("/");
  const fileWithExtension = parts[parts.length - 1];
  const publicId = fileWithExtension.split(".")[0];
  return publicId;
};

export const generateAccessToken = async (user) => {
  return jwt.sign(
    {
      id: user.id,
      tenantId: user.tenantId, // Added tenantId to JWT payload per architecture spec
      branchId: user.branchId, // Added branchId to JWT payload per architecture spec
      email: user.email,
      fullName: user.fullName,
      role: user.role,
    },
    process.env.ACCESS_TOKEN_SECRET,
    {
      expiresIn: process.env.ACCESS_TOKEN_EXPIRY,
    },
  );
};

export const generateRefreshToken = async (user) => {
  return jwt.sign(
    {
      id: user.id,
    },
    process.env.REFRESH_TOKEN_SECRET,
    {
      expiresIn: process.env.REFRESH_TOKEN_EXPIRY,
    },
  );
};

export const registerTenant = asyncHandler(async (req, res) => {
  const { email, businessType, fullName, password, tenantName } = req.body;

  if (!email || !businessType || !fullName || !password || !tenantName) {
    throw new ApiError(400, "Please fill in all required fields");
  }

  const userExists = await prisma.user.findFirst({
    where: { email: email.toLowerCase().trim() }, // Normalized email lookup
  });

  if (userExists) {
    throw new ApiError(409, "User with this email already exists");
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const generatedTenantCode = crypto.randomBytes(4).toString("hex").toUpperCase();

  const newTenant = await prisma.tenant.create({
    data: {
      name: tenantName.trim(),
      tenantCode: generatedTenantCode,
      businessType: businessType,
      subscription: {
        create: {
          plan: "FREE",
        },
      },
      users: {
        create: {
          fullName: fullName.trim(),
          email: email.toLowerCase().trim(),
          password: passwordHash,
          role: "ORG_OWNER",
          designation: "Founder & CEO", // Added default executive designation for Org Owner
          department: "Management",     // Added default department for Org Owner
          status: "ACTIVE",
        },
      },
    },
    select: {
      id: true,
      name: true,
      tenantCode: true, 
      businessType: true,
      subscriptionStatus: true,
      users: {
        select: {
          id: true,
          fullName: true,
          email: true,
          role: true,
          designation: true, // Projected designation in registration response
          department: true,  // Projected department in registration response
          status: true,
        },
      },
    },
  });

  if (!newTenant) {
    throw new ApiError(500, "Failed to create tenant");
  }

  await prisma.auditLog.create({
    data: {
      tenantId: newTenant.id,
      userId: newTenant.users[0].id,
      action: "TENANT_REGISTERED",
      targetResource: "PLATFORM",
    },
  });

  return res
    .status(201)
    .json(new ApiResponse(201, newTenant, "Tenant registered successfully"));
});

export const loginUser = asyncHandler(async (req, res) => {
  const { identifier, email, staffId, password } = req.body;
  const loginInput = (identifier || email || staffId)?.trim();

  if (!loginInput || !password) {
    throw new ApiError(400, "Please provide your Email or Staff ID and password");
  }

  let user;

  if (loginInput.includes("@")) {
    user = await prisma.user.findFirst({
      where: {
        email: loginInput.toLowerCase(),
        role: { in: ["ORG_OWNER", "SUPER_ADMIN"] },
      },
    });

    if (!user) {
      throw new ApiError(
        401,
        // Updated error message to include HR alongside Staff and Branch Managers
        "Invalid credentials. Note: Staff, HR, and Branch Managers must log in using their Official Staff ID, not email."
      );
    }
  } else {
    user = await prisma.user.findUnique({
      where: {
        staffId: loginInput.toUpperCase(),
      },
    });

    if (!user) {
      throw new ApiError(401, "Invalid Staff ID or password");
    }
  }

  if (user.status === "PENDING") {
    throw new ApiError(
      403,
      "Your account is not activated yet. Please check your invitation email to activate your account."
    );
  }

  if (user.status === "SUSPENDED") {
    throw new ApiError(
      403,
      "Your account has been suspended. Please contact your organization administrator."
    );
  }

  const isPasswordValid = await bcrypt.compare(password, user.password);

  if (!isPasswordValid) {
    throw new ApiError(401, "Invalid credentials");
  }

  const accessToken = await generateAccessToken(user);
  const refreshToken = await generateRefreshToken(user);

  await prisma.user.update({
    where: { id: user.id },
    data: { refreshToken: refreshToken },
  });

  const loggedInUser = {
    id: user.id,
    tenantId: user.tenantId,
    branchId: user.branchId, 
    staffId: user.staffId,   
    fullName: user.fullName,
    email: user.email,
    avatarUrl: user.avatarUrl,
    role: user.role,
    designation: user.designation, // Added designation to login payload for frontend state
    department: user.department,   // Added department to login payload for frontend state
    status: user.status,
  };

  const isProduction = process.env.NODE_ENV === "production";
  const cookieOptions = {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax", 
  };

  return res
    .status(200)
    .cookie("accessToken", accessToken, cookieOptions)
    .cookie("refreshToken", refreshToken, cookieOptions)
    .json(
      new ApiResponse(
        200,
        {
          user: loggedInUser,
          accessToken,
          refreshToken,
        },
        "User logged in successfully"
      )
    );
});

export const logoutUser = asyncHandler(async (req, res) => {
  await prisma.user.update({
    where: { id: req.user.id },
    data: { refreshToken: null },
    select: {
      id: true,
    },
  });

  // Fixed cookie options to match loginUser for local development compatibility
  const isProduction = process.env.NODE_ENV === "production";
  const options = {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
  };

  return res
    .status(200)
    .clearCookie("accessToken", options)
    .clearCookie("refreshToken", options)
    .json(new ApiResponse(200, {}, "User Logged Out Successfully"));
});

export const getCurrentUser = asyncHandler(async (req, res) => {
  // Updated to fetch fresh user state, designation, and department from DB for Redux hydration
  const currentUser = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: {
      id: true,
      tenantId: true,
      branchId: true,
      staffId: true,
      fullName: true,
      email: true,
      avatarUrl: true,
      role: true,
      designation: true,
      department: true,
      status: true,
    },
  });

  if (!currentUser || currentUser.status !== "ACTIVE") {
    throw new ApiError(403, "User session is no longer active");
  }

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        { currentUser },
        "Current User Fetched Successfully",
      ),
    );
});

export const refreshAccessToken = asyncHandler(async (req, res) => {
  const incomingRefreshToken =
    req.cookies.refreshToken || req.body.refreshToken;

  if (!incomingRefreshToken) {
    throw new ApiError(401, "Unauthorized request: Refresh token is missing");
  }

  try {
    const decodedToken = jwt.verify(
      incomingRefreshToken,
      process.env.REFRESH_TOKEN_SECRET,
    );

    const user = await prisma.user.findUnique({
      where: { id: decodedToken.id },
    });

    if (!user) {
      throw new ApiError(401, "Invalid refresh token: User not found");
    }

    if (incomingRefreshToken !== user.refreshToken) {
      throw new ApiError(
        401,
        "Refresh token is expired, revoked, or already used",
      );
    }

    // Added missing await keywords since token generators are async functions
    const accessToken = await generateAccessToken(user);
    const newRefreshToken = await generateRefreshToken(user);

    await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken: newRefreshToken },
    });

    // Standardized cookie options for cross-environment consistency
    const isProduction = process.env.NODE_ENV === "production";
    const options = {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
    };

    return res
      .status(200)
      .cookie("accessToken", accessToken, options)
      .cookie("refreshToken", newRefreshToken, options)
      .json(
        new ApiResponse(
          200,
          { accessToken, refreshToken: newRefreshToken },
          "Access token refreshed successfully",
        ),
      );
  } catch (error) {
    throw new ApiError(401, error?.message || "Invalid refresh token");
  }
});

export const updateAccount = asyncHandler(async (req, res) => {
  const { fullName, email } = req.body;
  const updateData = {};
  let uploadedAvatar = null;

  const currentUser = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { avatarUrl: true } 
  });

  const oldAvatarUrl = currentUser?.avatarUrl;

  if (fullName) {
    updateData.fullName = fullName.trim();
  }

  if (email) {
    const normalizedEmail = email.toLowerCase().trim(); // Normalized email before composite check
    const existingUser = await prisma.user.findUnique({
      where: {
        email_tenantId: {
          email: normalizedEmail,
          tenantId: req.user.tenantId,
        },
      },
    });

    if (existingUser && existingUser.id !== req.user.id) {
      throw new ApiError(409, "Email already exists in your organization");
    }
    updateData.email = normalizedEmail;
  }

  if (req.file && req.file.path) {
    uploadedAvatar = await uploadOnCloudinary(req.file.path);
    if (!uploadedAvatar?.url) {
      throw new ApiError(500, "Error while uploading new avatar to Cloudinary");
    }
    updateData.avatarUrl = uploadedAvatar.url;
  }

  if (Object.keys(updateData).length === 0) {
    throw new ApiError(400, "Please provide at least one field to update");
  }

  try {
    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: updateData,
      select: {
        id: true,
        tenantId: true,
        branchId: true,    // Added branchId to keep Redux state complete
        staffId: true,     // Added staffId to keep Redux state complete
        fullName: true,
        email: true,
        avatarUrl: true,
        role: true,
        designation: true, // Added designation to updated profile response
        department: true,  // Added department to updated profile response
        status: true,
      },
    });

    if (uploadedAvatar && oldAvatarUrl) {
      const oldPublicId = extractPublicIdFromUrl(oldAvatarUrl);
      if (oldPublicId) {
        deleteFromCloudinary(oldPublicId).catch((err) => 
          console.error("Failed to delete old avatar:", err)
        );
      }
    }

    return res
      .status(200)
      .json(new ApiResponse(200, updatedUser, "Account updated successfully"));

  } catch (error) {
    if (uploadedAvatar?.url) {
      const newPublicId = extractPublicIdFromUrl(uploadedAvatar.url);
      if (newPublicId) {
        await deleteFromCloudinary(newPublicId); 
      }
    }
    throw new ApiError(500, "Failed to update account. Changes rolled back.");
  }
});

export const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword, confirmNewPassword, confirmnewPassword } = req.body;
  const confirmedPass = confirmNewPassword || confirmnewPassword;

  if (!currentPassword || !newPassword || !confirmedPass) {
    throw new ApiError(400, "All fields are required");
  }

  if (newPassword !== confirmedPass) {
    throw new ApiError(400, "New password and confirm password do not match");
  }

  if (newPassword.trim().length < 6) {
    throw new ApiError(400, "New password must be at least 6 characters long");
  }

  if (currentPassword === newPassword) {
    throw new ApiError(400, "New password cannot be the same as the old password");
  }

  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { password: true },
  });

  if (!user) {
    throw new ApiError(404, "User not found");
  }

  const isPasswordValid = await bcrypt.compare(currentPassword, user.password);
  if (!isPasswordValid) {
    throw new ApiError(400, "Invalid current password");
  }

  const newPasswordHash = await bcrypt.hash(newPassword.trim(), 10);

  const updatedUser = await prisma.user.update({
    where: { id: req.user.id },
    data: {
      password: newPasswordHash,
      refreshToken: null, 
    },
    select: {
      id: true,
      tenantId: true,
      staffId: true,
      fullName: true,
      email: true,
      avatarUrl: true,
      role: true,
      designation: true, // Projected designation
      department: true,  // Projected department
    },
  });

  await prisma.auditLog.create({
    data: {
      tenantId: req.user.tenantId,
      userId: req.user.id,
      action: "PASSWORD_CHANGED",
      targetResource: "USER",
    },
  });

  const isProduction = process.env.NODE_ENV === "production";
  const cookieOptions = {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
  };

  return res
    .status(200)
    .clearCookie("accessToken", cookieOptions)
    .clearCookie("refreshToken", cookieOptions)
    .json(
      new ApiResponse(200, updatedUser, "Password changed successfully. Please log in again.")
    );
});

export const forgotPassword = asyncHandler(async (req, res) => {
  const { identifier, email, staffId } = req.body;
  const recoveryInput = (identifier || email || staffId)?.trim();

  if (!recoveryInput) {
    throw new ApiError(400, "Please provide your Email (for Owners) or Official Staff ID (for Staff, HR & Managers)"); // Updated prompt message to include HR & Managers
  }

  const genericSuccessMessage =
    "If a valid account matches this identifier, a password reset link has been sent to the registered email address.";

  let user;

  if (recoveryInput.includes("@")) {
    user = await prisma.user.findFirst({
      where: {
        email: recoveryInput.toLowerCase(),
        role: { in: ["ORG_OWNER", "SUPER_ADMIN"] },
      },
    });
  } else {
    user = await prisma.user.findUnique({
      where: {
        staffId: recoveryInput.toUpperCase(),
      },
    });
  }

  if (!user || user.status === "SUSPENDED") {
    return res.status(200).json(new ApiResponse(200, null, genericSuccessMessage));
  }

  const resetToken = crypto.randomBytes(32).toString("hex");
  const hashedToken = crypto
    .createHash("sha256")
    .update(resetToken)
    .digest("hex");

  const tokenExpiry = new Date(Date.now() + 15 * 60 * 1000);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      forgotPasswordToken: hashedToken,
      forgotPasswordExpiry: tokenExpiry,
    },
  });

  const resetUrl = `${process.env.FRONTEND_URL}/reset-password?token=${resetToken}`;
  const emailMessage = `Hello ${user.fullName},\n\nYou requested a password reset for your NexaCommand account ${
    user.staffId ? `(Staff ID: ${user.staffId})` : ""
  }.\n\nPlease click on the link below to reset your password. This link is valid for 15 minutes:\n\n${resetUrl}\n\nIf you did not request this, please ignore this email.`;

  try {
    await sendEmail({
      email: user.email, 
      subject: "NexaCommand - Password Reset Request",
      message: emailMessage,
    });

    return res.status(200).json(new ApiResponse(200, null, genericSuccessMessage));
  } catch (error) {
    await prisma.user.update({
      where: { id: user.id },
      data: {
        forgotPasswordToken: null,
        forgotPasswordExpiry: null,
      },
    });

    throw new ApiError(500, "Failed to send password reset email. Please try again later.");
  }
});

export const resetPassword = asyncHandler(async (req, res) => {
  const { token } = req.params;
  const { newPassword, confirmNewPassword } = req.body;

  if (!token?.trim()) {
    throw new ApiError(400, "Reset token is missing");
  }

  if (!newPassword || !confirmNewPassword) {
    throw new ApiError(400, "Both password fields are required");
  }

  if (newPassword !== confirmNewPassword) {
    throw new ApiError(400, "Passwords do not match");
  }

  if (newPassword.trim().length < 6) {
    throw new ApiError(400, "New password must be at least 6 characters long");
  }

  const hashedToken = crypto
    .createHash("sha256")
    .update(token.trim())
    .digest("hex");

  const user = await prisma.user.findFirst({
    where: {
      forgotPasswordToken: hashedToken,
      forgotPasswordExpiry: {
        gt: new Date(),
      },
    },
  });

  if (!user) {
    throw new ApiError(400, "Token is invalid or has expired");
  }

  if (user.status === "SUSPENDED") {
    throw new ApiError(403, "Your account is suspended. Cannot reset password.");
  }

  const newPasswordHash = await bcrypt.hash(newPassword.trim(), 10);

  await prisma.user.update({
    where: { id: user.id },
    data: {
      password: newPasswordHash,
      status: user.status === "PENDING" ? "ACTIVE" : user.status,
      forgotPasswordToken: null,
      forgotPasswordExpiry: null,
      refreshToken: null,
    },
  });

  await prisma.auditLog.create({
    data: {
      tenantId: user.tenantId,
      userId: user.id,
      action: "PASSWORD_RESET_COMPLETED",
      targetResource: "USER",
    },
  });

  return res
    .status(200)
    .json(new ApiResponse(200, null, "Password reset successfully. You can now log in."));
});

export const googleRegisterTenant = asyncHandler(async (req, res) => {
  const { idToken, tenantName, businessType } = req.body;

  if (!idToken || !tenantName?.trim() || !businessType) {
    throw new ApiError(
      400,
      "Google token, organization name, and business type are required."
    );
  }

  const validBusinessTypes = ["RETAIL", "CORPORATE", "AGENCY"];
  if (!validBusinessTypes.includes(businessType)) {
    throw new ApiError(400, "Invalid business type. Must be RETAIL, CORPORATE, or AGENCY.");
  }

  const { googleId, email, fullName, avatarUrl } = await verifyGoogleIdToken(idToken);

  const existingUser = await prisma.user.findFirst({
    where: {
      OR: [{ email: email.toLowerCase().trim() }, { googleId: googleId }],
    },
  });

  if (existingUser) {
    throw new ApiError(
      409,
      "An account with this Google email already exists. Please sign in instead."
    );
  }

  const dummyPasswordHash = await bcrypt.hash(
    crypto.randomBytes(32).toString("hex"),
    10
  );
  const generatedTenantCode = crypto.randomBytes(4).toString("hex").toUpperCase();

  const newTenant = await prisma.tenant.create({
    data: {
      name: tenantName.trim(),
      tenantCode: generatedTenantCode,
      businessType: businessType,
      subscription: {
        create: {
          plan: "FREE",
        },
      },
      users: {
        create: {
          fullName: fullName,
          email: email.toLowerCase().trim(),
          googleId: googleId,
          avatarUrl: avatarUrl,
          password: dummyPasswordHash,
          role: "ORG_OWNER",
          designation: "Founder & CEO", // Added default executive designation for Google Org Owner
          department: "Management",     // Added default department for Google Org Owner
          status: "ACTIVE",
        },
      },
    },
    include: {
      users: true,
    },
  });

  const ownerUser = newTenant.users[0];

  const accessToken = await generateAccessToken(ownerUser);
  const refreshToken = await generateRefreshToken(ownerUser);

  await prisma.user.update({
    where: { id: ownerUser.id },
    data: { refreshToken: refreshToken },
  });

  await prisma.auditLog.create({
    data: {
      tenantId: newTenant.id,
      userId: ownerUser.id,
      action: "TENANT_REGISTERED_VIA_GOOGLE",
      targetResource: "PLATFORM",
    },
  });

  const isProduction = process.env.NODE_ENV === "production";
  const cookieOptions = {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
  };

  const responsePayload = {
    tenant: {
      id: newTenant.id,
      name: newTenant.name,
      tenantCode: newTenant.tenantCode,
      businessType: newTenant.businessType,
    },
    user: {
      id: ownerUser.id,
      tenantId: ownerUser.tenantId,
      fullName: ownerUser.fullName,
      email: ownerUser.email,
      avatarUrl: ownerUser.avatarUrl,
      role: ownerUser.role,
      designation: ownerUser.designation, // Added designation to Google sign-up payload
      department: ownerUser.department,   // Added department to Google sign-up payload
      status: ownerUser.status,
    },
    accessToken,
    refreshToken,
  };

  return res
    .status(201)
    .cookie("accessToken", accessToken, cookieOptions)
    .cookie("refreshToken", refreshToken, cookieOptions)
    .json(
      new ApiResponse(
        201,
        responsePayload,
        "Organization registered and logged in successfully via Google"
      )
    );
  });

export const googleLogin = asyncHandler(async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) {
    throw new ApiError(400, "Google authentication token is required.");
  }

  const { googleId, email, avatarUrl } = await verifyGoogleIdToken(idToken);

  const user = await prisma.user.findFirst({
    where: {
      OR: [{ googleId: googleId }, { email: email.toLowerCase().trim() }],
    },
  });

  if (!user) {
    throw new ApiError(
      404,
      "No account found with this Google email. If you are an Organization Owner, please register your workspace first."
    );
  }

  if (!["ORG_OWNER", "SUPER_ADMIN"].includes(user.role)) {
    throw new ApiError(
      403,
      // Updated error message to explicitly mention HR alongside Staff and Branch Managers
      "Google Sign-In is strictly reserved for Organization Owners. Staff, HR, and Branch Managers must log in using their Official Staff ID and password."
    );
  }

  if (user.status !== "ACTIVE") {
    throw new ApiError(403, "Your account is currently suspended or inactive.");
  }

  const accessToken = await generateAccessToken(user);
  const refreshToken = await generateRefreshToken(user);

  const updatedUser = await prisma.user.update({
    where: { id: user.id },
    data: {
      refreshToken: refreshToken,
      googleId: user.googleId || googleId,
      avatarUrl: user.avatarUrl || avatarUrl,
    },
    select: {
      id: true,
      tenantId: true,
      branchId: true,
      fullName: true,
      email: true,
      avatarUrl: true,
      role: true,
      designation: true, // Added designation to Google login projection
      department: true,  // Added department to Google login projection
      status: true,
    },
  });

  const isProduction = process.env.NODE_ENV === "production";
  const cookieOptions = {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
  };

  return res
    .status(200)
    .cookie("accessToken", accessToken, cookieOptions)
    .cookie("refreshToken", refreshToken, cookieOptions)
    .json(
      new ApiResponse(
        200,
        {
          user: updatedUser,
          accessToken,
          refreshToken,
        },
        "Owner logged in successfully via Google"
      )
    );
});