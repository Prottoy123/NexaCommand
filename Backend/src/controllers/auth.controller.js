import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js"; 
import asyncHandler from "../utils/asyncHandler.js";

const prisma = new PrismaClient(); 

const registerTenant = asyncHandler(async (req, res) => {
  const { email, businessType, fullName, password, tenantName } = req.body;

  if (!email || !businessType || !fullName || !password || !tenantName) {
    throw new ApiError(400, "Please fill in all required fields");
  }

  const userExists = await prisma.user.findUnique({
    where: { email },
  });

  if (userExists) {
    throw new ApiError(409, "User with this email already exists");
  }

  const passwordHash = await bcrypt.hash(password, 10);

  // ফেজ ৪ & ৫: দ্য মাস্টার ট্রানজ্যাকশন (Nested Write) & স্যানিটাইজেশন (Select)
  const newTenant = await prisma.tenant.create({
    // [THE FIX] Prisma-তে সব ডেটা 'data' অবজেক্টের ভেতরে থাকতে হয়
    data: {
      name: tenantName, // tenantName কে স্কিমার name ফিল্ডে ম্যাপ করা হলো
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

  return res
    .status(201)
    .json(new ApiResponse(201, newTenant, "Tenant registered successfully"));
});

export { registerTenant };
