import { PrismaClient } from "@prisma/client";
import ApiError from "../utils/ApiError.js";
import asyncHandler from "../utils/asyncHandler.js";

const prisma = new PrismaClient();

export const isolateTenant = asyncHandler(async (req, res, next) => {
  // ১. The Exception: SUPER_ADMIN Bypass
  if (req.user?.role === "SUPER_ADMIN") {
    return next();
  }

  const { tenantId } = req.user;

  // ২. The Identity Check
  if (!tenantId) {
    throw new ApiError(400, "Bad Request: Tenant ID is missing for this user");
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { subscriptionStatus: true },
  });

  if (!tenant || tenant.subscriptionStatus !== "ACTIVE") {
    throw new ApiError(
      402, // 402 Payment Required
      "Payment Required: Your organization's subscription is inactive, suspended, or expired.",
    );
  }

  // ৪. [NEW] The Invisible Shield: Payload Injection
  if (req.body) req.body.tenantId = tenantId;
  if (req.query) req.query.tenantId = tenantId;

  next();
});
