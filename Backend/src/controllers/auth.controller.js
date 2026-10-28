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
    where: { email },
  });

  if (userExists) {
    throw new ApiError(409, "User with this email already exists");
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const generatedTenantCode = crypto.randomBytes(4).toString("hex").toUpperCase();

  const newTenant = await prisma.tenant.create({
    data: {
      name: tenantName,
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
          email: email,
          password: passwordHash,
          role: "ORG_OWNER",
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
        "Invalid credentials. Note: Staff members must log in using their Official Staff ID, not email."
      );
    }
  } else {
    // Staff / Branch Manager Login via Globally Unique Staff ID
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
  const loggedOutUser = await prisma.user.update({
    where: { id: req.user.id },
    data: { refreshToken: null },
    select: {
      id: true,
    },
  });

  const options = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "none",
  };

  return res
    .status(200)
    .clearCookie("accessToken", options)
    .clearCookie("refreshToken", options)
    .json(new ApiResponse(200, {}, "User Logged Out Successfully"));
});

export const getCurrentUser = asyncHandler(async (req, res) => {
  const currentUser = req.user;

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

    const accessToken = generateAccessToken(user);
    const newRefreshToken = generateRefreshToken(user);

    await prisma.user.update({
      where: { id: user.id },
      data: { refreshToken: newRefreshToken },
    });

    const options = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "none",
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
    updateData.fullName = fullName;
  }

  if (email) {
    const existingUser = await prisma.user.findUnique({
      where: {
        email_tenantId: {
          email: email,
          tenantId: req.user.tenantId,
        },
      },
    });

    if (existingUser && existingUser.id !== req.user.id) {
      throw new ApiError(409, "Email already exists in your organization");
    }
    updateData.email = email;
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
        fullName: true,
        email: true,
        avatarUrl: true,
        role: true,
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
    throw new ApiError(400, "Please provide your Email (for Owners) or Official Staff ID (for Staff)");
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
    // Staff / Branch Manager lookup by Globally Unique Staff ID
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

//Google Register & Login 

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

  // Verify Google Token via Config Utility
  const { googleId, email, fullName, avatarUrl } = await verifyGoogleIdToken(idToken);

  const existingUser = await prisma.user.findFirst({
    where: {
      OR: [{ email: email }, { googleId: googleId }],
    },
  });

  if (existingUser) {
    throw new ApiError(
      409,
      "An account with this Google email already exists. Please sign in instead."
    );
  }

  // Cryptographic Dummy Password & Workspace Code Generation
  const dummyPasswordHash = await bcrypt.hash(
    crypto.randomBytes(32).toString("hex"),
    10
  );
  const generatedTenantCode = crypto.randomBytes(4).toString("hex").toUpperCase();

  // Atomic Tenant + Subscription + Owner Creation
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
          email: email,
          googleId: googleId,
          avatarUrl: avatarUrl,
          password: dummyPasswordHash,
          role: "ORG_OWNER", // Zero-Trust Owner Role
          status: "ACTIVE",
        },
      },
    },
    include: {
      users: true,
    },
  });

  const ownerUser = newTenant.users[0];

  // Auto-Login (Generate JWT Tokens immediately after Google Sign-Up)
  const accessToken = await generateAccessToken(ownerUser);
  const refreshToken = await generateRefreshToken(ownerUser);

  await prisma.user.update({
    where: { id: ownerUser.id },
    data: { refreshToken: refreshToken },
  });

  // Step 7: Audit Log
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

// Verify Google Token
  const { googleId, email, avatarUrl } = await verifyGoogleIdToken(idToken);

  // Find User by Google ID or Email
  const user = await prisma.user.findFirst({
    where: {
      OR: [{ googleId: googleId }, { email: email }],
    },
  });

  if (!user) {
    throw new ApiError(
      404,
      "No account found with this Google email. If you are an Organization Owner, please register your workspace first."
    );
  }

  // Strict Role Gatekeeper (Block Staff & Branch Managers from Google Login)
  if (!["ORG_OWNER", "SUPER_ADMIN"].includes(user.role)) {
    throw new ApiError(
      403,
      "Google Sign-In is strictly reserved for Organization Owners. Staff and Branch Managers must log in using their Official Staff ID and password."
    );
  }

  // Step 4: Status Check
  if (user.status !== "ACTIVE") {
    throw new ApiError(403, "Your account is currently suspended or inactive.");
  }

  // Step 5: Generate Session Tokens & Self-Healing Account Linking
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

