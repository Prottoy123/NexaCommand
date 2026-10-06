import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import jwt from "jsonwebtoken";

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

  const newTenant = await prisma.tenant.create({
    data: {
      name: tenantName,
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
  const { email, password } = req.body;

  if (!email || !password) {
    throw new ApiError(400, "Please provide email and password");
  }

  const user = await prisma.user.findFirst({
    where: { email },
  });

  if (!user) {
    throw new ApiError(404, "User does not exist");
  }

  if (user.status !== "ACTIVE") {
    throw new ApiError(403, "User account is suspended or pending");
  }

  const isPasswordValid = await bcrypt.compare(password, user.password);

  if (!isPasswordValid) {
    throw new ApiError(401, "Invalid email or password");
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
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    status: user.status,
  };

  const options = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "none",
  };

  return res
    .status(200)
    .cookie("accessToken", accessToken, options)
    .cookie("refreshToken", refreshToken, options)
    .json(
      new ApiResponse(
        200,
        {
          user: loggedInUser,
          accessToken,
          refreshToken,
        },
        "User logged in successfully",
      ),
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

export const changePassword = asyncHandler (async(req,res)=>{

  const {currentPassword, newPassword, confirmnewPassword} = req.body

  if (!currentPassword || !newPassword || !confirmnewPassword) {
    throw new ApiError(
      400,
      "All fields are required"
    );
  }

  if (newPassword !== confirmnewPassword) {
    throw new ApiError(400, "New password and confirm password do not match");
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
    throw new ApiError(400, "Invalid old password");
  }

  const newPasswordHash = await bcrypt.hash(newPassword, 10);

    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: { password: newPasswordHash, refreshToken: null},
      select: {
        id: true,
        tenantId: true,
        fullName: true,
        email: true,
        avatarUrl: true,
        role: true,
      },
    });

    if (!updatedUser) {
      throw new ApiError(500, "Failed to update password");
    }

    const AuditLog = await prisma.auditLog.create({
      data: {
        tenantId: req.user.tenantId,
        userId: req.user.id,
        action: "PASSWORD_CHANGED",
        resourceType: "USER",
        resourceId: req.user.id,
      },
    }); 

    if (!AuditLog) {
      throw new ApiError(500, "Failed to create audit log");
    }

    const options = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "none",
  };

    return res
    .status(200)
    .clearCookie("accessToken", options)
    .clearCookie("refreshToken", options)
    .json(new ApiResponse(200, updatedUser, "Password changed successfully"));

})

