import { PrismaClient } from "@prisma/client";
import ApiError from "../utils/ApiError.js";
import asyncHandler from "../utils/asyncHandler.js";

import jwt from "jsonwebtoken";
 
const prisma = new PrismaClient();

export const verifyJWT = asyncHandler(async (req, res, next) => {
  try {
    const token =
      req.cookies?.accessToken ||
      req.header("Authorization")?.replace("Bearer ", "");

    if (!token || token === "null" || token === "undefined") {
      throw new ApiError(401, "Unauthorized request: Token missing");
    }

    const decodedToken = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);

    const user = await prisma.user.findUnique({
      where: { id: decodedToken?.id },
      select: {
        id: true,
        tenantId: true,
        fullName: true,
        email: true,
        role: true,
        status: true,
      },
    });

    if (!user) {
      throw new ApiError(401, "Invalid Access Token");
    }

    if (user.status !== "ACTIVE") {
      throw new ApiError(403, "Access denied: User account is not active");
    }

    req.user = user;
    next();
  } catch (error) {
    throw new ApiError(401, error?.message || "Invalid access token");
  }
});
