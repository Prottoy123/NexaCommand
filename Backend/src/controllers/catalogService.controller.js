import { PrismaClient } from "@prisma/client";
import ApiError from "../utils/ApiError.js";
import ApiResponse from "../utils/ApiResponse.js";
import asyncHandler from "../utils/asyncHandler.js";
import {
  uploadOnCloudinary,
  deleteFromCloudinary,
} from "../utils/Cloudinary.js";

const prisma = new PrismaClient(); 

// Allowed catalog item types matching Prisma schema enum
const VALID_ITEM_TYPES = ["PHYSICAL_GOOD", "DIGITAL_SERVICE"];

const addCatalogItem = asyncHandler(async (req, res) => {
  const tenantId = req.tenantId || req.user.tenantId;
  const { id: userId, role } = req.user;
  const localFilePath = req.file?.path || null;

  const {
    name,
    sku,
    price,
    itemType,
    stock,
    bountyAmount,
    branchId: bodyBranchId,
  } = req.body;

  // Step 1: Validate and normalize basic string inputs
  const trimmedName = typeof name === "string" ? name.trim() : "";
  const normalizedSku = typeof sku === "string" ? sku.trim().toUpperCase() : "";

  if (!trimmedName || !normalizedSku) {
    throw new ApiError(400, "Item name and SKU are required.");
  }

  if (!itemType || !VALID_ITEM_TYPES.includes(itemType)) {
    throw new ApiError(
      400,
      `Invalid itemType. Allowed values are: ${VALID_ITEM_TYPES.join(", ")}.`
    );
  }

  // Parse and validate numeric fields (form-data sends strings)
  const parsedPrice = Number(price);
  if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
    throw new ApiError(400, "Price must be a valid number greater than 0.");
  }

  // Dead-stock bounty applies only to PHYSICAL_GOOD; force 0 for DIGITAL_SERVICE
  let finalBountyAmount = 0;
  if (itemType === "PHYSICAL_GOOD") {
    const parsedBounty =
      bountyAmount === undefined || bountyAmount === null || bountyAmount === ""
        ? 0
        : Number(bountyAmount);

    if (!Number.isFinite(parsedBounty) || parsedBounty < 0) {
      throw new ApiError(
        400,
        "Bounty amount must be a valid non-negative number."
      );
    }

    if (parsedBounty > parsedPrice) {
      throw new ApiError(400, "Bounty amount cannot exceed the item price.");
    }

    finalBountyAmount = parsedBounty;
  }

  // Resolve and authorize branchId based on user role
  let resolvedBranchId = null;

  if (role === "BRANCH_MANAGER") {
    // Zero-Trust: Always verify the manager's assigned branch from DB
    const managedBranch = await prisma.branch.findFirst({
      where: {
        tenantId,
        managerId: userId,
      },
      select: { id: true },
    });

    if (!managedBranch) {
      throw new ApiError(
        403,
        "You are not assigned as a manager to any active branch."
      );
    }

    // Block manager from adding items to any other branch
    if (bodyBranchId && bodyBranchId.trim() !== managedBranch.id) {
      throw new ApiError(
        403,
        "Branch managers can only add items to their own assigned branch."
      );
    }

    resolvedBranchId = managedBranch.id;
  } else if (role === "ORG_OWNER") {
    const cleanBranchId =
      typeof bodyBranchId === "string" && bodyBranchId.trim() !== ""
        ? bodyBranchId.trim()
        : null;

    // Physical inventory must belong to a branch for stock & POS tracking
    if (itemType === "PHYSICAL_GOOD" && !cleanBranchId) {
      throw new ApiError(
        400,
        "branchId is required when adding a PHYSICAL_GOOD."
      );
    }

    // Verify target branch belongs to this tenant (Anti-IDOR protection)
    if (cleanBranchId) {
      const targetBranch = await prisma.branch.findFirst({
        where: {
          id: cleanBranchId,
          tenantId,
        },
        select: { id: true },
      });

      if (!targetBranch) {
        throw new ApiError(404, "Target branch not found in your organization.");
      }

      resolvedBranchId = targetBranch.id;
    }
  }

  // Apply itemType-specific stock and restock timestamp rules
  let finalStock = null;
  let finalLastRestockedAt = null;

  if (itemType === "PHYSICAL_GOOD") {
    if (stock === undefined || stock === null || stock === "") {
      throw new ApiError(
        400,
        "Initial stock quantity is required for PHYSICAL_GOOD."
      );
    }

    const parsedStock = Number(stock);
    if (!Number.isInteger(parsedStock) || parsedStock < 0) {
      throw new ApiError(400, "Stock must be a valid non-negative integer.");
    }

    finalStock = parsedStock;
    // Start restock timer only if actual stock is added initially
    finalLastRestockedAt = parsedStock > 0 ? new Date() : null;
  } else {
    // Digital services do not use stock or dead-stock tracking
    finalStock = null;
    finalLastRestockedAt = null;
  }

  // Block duplicate SKU within the same tenant and branch scope
  const existingItem = await prisma.catalogItem.findFirst({
    where: {
      tenantId,
      branchId: resolvedBranchId,
      sku: {
        equals: normalizedSku,
        mode: "insensitive",
      },
    },
    select: { id: true },
  });

  if (existingItem) {
    throw new ApiError(
      409,
      `An item with SKU '${normalizedSku}' already exists in this scope.`
    );
  }

  // Upload optional image to Cloudinary (local temp file is cleaned automatically)
  let uploadedImageUrl = null;
  let uploadedPublicId = null;
  let uploadedResourceType = null;

  if (localFilePath) {
    const cloudinaryResponse = await uploadOnCloudinary(
      localFilePath,
      "catalog"
    );

    if (!cloudinaryResponse?.secure_url) {
      throw new ApiError(500, "Failed to upload item image to cloud storage.");
    }

    uploadedImageUrl = cloudinaryResponse.secure_url;
    uploadedPublicId = cloudinaryResponse.public_id;
    uploadedResourceType = cloudinaryResponse.resource_type;
  }

  // Create CatalogItem and AuditLog atomically with Cloudinary rollback on failure
  try {
    const createdItem = await prisma.$transaction(async (tx) => {
      const newItem = await tx.catalogItem.create({
        data: {
          tenantId,
          branchId: resolvedBranchId,
          name: trimmedName,
          sku: normalizedSku,
          price: parsedPrice,
          itemType,
          stock: finalStock,
          lastRestockedAt: finalLastRestockedAt,
          isDeadStock: false,
          bountyAmount: finalBountyAmount,
          imageUrl: uploadedImageUrl,
        },
        include: {
          branch: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      await tx.auditLog.create({
        data: {
          tenantId,
          userId,
          action: "CATALOG_ITEM_CREATED",
          targetResource: `CatalogItem:${newItem.id} (SKU: ${newItem.sku})`,
        },
      });

      return newItem;
    });

    return res
      .status(201)
      .json(
        new ApiResponse(
          201,
          createdItem,
          `${itemType === "PHYSICAL_GOOD" ? "Product" : "Service"} added to catalog successfully.`
        )
      );
  } catch (dbError) {
    // Rollback uploaded Cloudinary asset if database transaction fails
    if (uploadedPublicId) {
      await deleteFromCloudinary(uploadedPublicId, uploadedResourceType);
    }
    throw dbError;
  }
});

export { addCatalogItem };