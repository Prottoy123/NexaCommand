import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import jwt from "jsonwebtoken";

const prisma = new PrismaClient();

const generateAccessToken = async (user) => {
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

const generateRefreshToken = async (user) => {
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

const registerTenant = asyncHandler(async (req, res) => {
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

const loginUser = asyncHandler(async (req, res) => {
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

const logoutUser = asyncHandler(async (req, res) => {
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

const getCurrentUser = asyncHandler(async (req, res) => {
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

export { registerTenant, loginUser,logoutUser };
