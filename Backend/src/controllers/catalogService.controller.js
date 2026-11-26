import { ItemType, UserRole,prisma } from "@prisma/client";
import prisma from "../index.js";
import { ApiError } from "../utils/ApiError.js";
import { ApiResponse } from "../utils/ApiResponse.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  uploadOnCloudinary,
  deleteFromCloudinary,
} from "../utils/Cloudinary.js";


export const addCatalogItem = asyncHandler(async (req, res) => {
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

  // Validate and clean basic text fields
  const trimmedName = typeof name === "string" ? name.trim() : "";
  const normalizedSku = typeof sku === "string" ? sku.trim().toUpperCase() : "";

  if (!trimmedName || !normalizedSku) {
    throw new ApiError(400, "Item name and SKU are required.");
  }

  // Validate itemType directly against Prisma ItemType enum
  const allowedItemTypes = Object.values(ItemType);
  if (!itemType || !allowedItemTypes.includes(itemType)) {
    throw new ApiError(
      400,
      `Invalid itemType. Allowed values are: ${allowedItemTypes.join(", ")}.`
    );
  }

  // Parse and validate numeric fields (form-data sends values as strings)
  const parsedPrice = Number(price);
  if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
    throw new ApiError(400, "Price must be a valid number greater than 0.");
  }

  // Dead-stock bounty applies only to physical goods; force 0 for digital services
  let finalBountyAmount = 0;
  if (itemType === ItemType.PHYSICAL_GOOD) {
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

  // Step 3: Authorize and resolve branchId based on user role
  let resolvedBranchId = null;

  if (role === UserRole.BRANCH_MANAGER) {
    // Verify the manager's assigned branch directly from the database
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

    // Block manager from adding items to another branch
    if (bodyBranchId && bodyBranchId.trim() !== managedBranch.id) {
      throw new ApiError(
        403,
        "Branch managers can only add items to their own assigned branch."
      );
    }

    resolvedBranchId = managedBranch.id;
  } else if (role === UserRole.ORG_OWNER) {
    const cleanBranchId =
      typeof bodyBranchId === "string" && bodyBranchId.trim() !== ""
        ? bodyBranchId.trim()
        : null;

    // Physical products must belong to a branch for stock and POS tracking
    if (itemType === ItemType.PHYSICAL_GOOD && !cleanBranchId) {
      throw new ApiError(
        400,
        "branchId is required when adding a PHYSICAL_GOOD."
      );
    }

    // Verify the branch belongs to this tenant (prevents cross-tenant access)
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
  } else {
    throw new ApiError(403, "You are not authorized to add catalog items.");
  }

  // Step 4: Set stock and restock timestamp rules based on itemType
  let finalStock = null;
  let finalLastRestockedAt = null;

  if (itemType === ItemType.PHYSICAL_GOOD) {
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
    // Start restock timer only when actual stock is added
    finalLastRestockedAt = parsedStock > 0 ? new Date() : null;
  } else {
    // Digital services do not track stock or restock dates
    finalStock = null;
    finalLastRestockedAt = null;
  }

  // Step 5: Check for duplicate SKU in the same tenant and branch scope
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

  // Step 6: Upload optional image to Cloudinary (local temp file is auto-cleaned)
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

  // Step 7: Save CatalogItem and AuditLog atomically, rollback image if DB fails
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
          `${itemType === ItemType.PHYSICAL_GOOD ? "Product" : "Service"} added to catalog successfully.`
        )
      );
  } catch (dbError) {
    // Delete uploaded image from Cloudinary if database transaction fails
    if (uploadedPublicId) {
      await deleteFromCloudinary(uploadedPublicId, uploadedResourceType);
    }
    throw dbError;
  }
});

export const getCatalogItems = asyncHandler(async (req, res) => {
  const tenantId = req.tenantId || req.user.tenantId;
  const { id: userId, role } = req.user;

  const {
    search,
    itemType,
    branchId: queryBranchId,
    onlyDeadStock,
    lowStock,
    lowStockThreshold,
    page,
    limit,
  } = req.query;

  // Local helper to strictly parse boolean query strings ("true" / "false")
  const parseQueryBoolean = (value, fieldName) => {
    if (value === undefined || value === null || value === "") {
      return false;
    }

    if (typeof value === "boolean") {
      return value;
    }

    const normalized = String(value).trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;

    throw new ApiError(
      400,
      `Invalid '${fieldName}' value. Expected 'true' or 'false'.`
    );
  };

  // Safe Math.max pagination and reference timestamps
  const rawPage = parseInt(page, 10);
  const currentPage = Number.isNaN(rawPage) ? 1 : Math.max(1, rawPage);

  const rawLimit = parseInt(limit, 10);
  const itemsPerPage = Number.isNaN(rawLimit)
    ? 10
    : Math.min(100, Math.max(1, rawLimit));

  const skip = (currentPage - 1) * itemsPerPage;

  const now = new Date();
  const deadStockCutoffDate = getDeadStockCutoffDate(now);

  // Strict query parameter validation
  let normalizedItemType = null;
  if (itemType !== undefined && String(itemType).trim() !== "") {
    const cleanType = String(itemType).trim().toUpperCase();
    const allowedTypes = Object.values(ItemType);

    if (!allowedTypes.includes(cleanType)) {
      throw new ApiError(
        400,
        `Invalid itemType. Allowed values are: ${allowedTypes.join(", ")}.`
      );
    }
    normalizedItemType = cleanType;
  }

  const isOnlyDeadStock = parseQueryBoolean(onlyDeadStock, "onlyDeadStock");
  const isLowStock = parseQueryBoolean(lowStock, "lowStock");

  let parsedLowStockThreshold = DEFAULT_LOW_STOCK_THRESHOLD;
  if (
    lowStockThreshold !== undefined &&
    lowStockThreshold !== null &&
    String(lowStockThreshold).trim() !== ""
  ) {
    const numThreshold = Number(lowStockThreshold);
    if (!Number.isInteger(numThreshold) || numThreshold < 0) {
      throw new ApiError(
        400,
        "lowStockThreshold must be a valid non-negative integer."
      );
    }
    parsedLowStockThreshold = numThreshold;
  }

  const cleanBranchId =
    typeof queryBranchId === "string" && queryBranchId.trim() !== ""
      ? queryBranchId.trim()
      : null;

  // Step 3: Build master AND conditions with role-based branch isolation
  const andConditions = [{ tenantId }];

  if (role === UserRole.ORG_OWNER || role === UserRole.HR) {
    // Owner and HR can view all branches or filter by a specific tenant branch
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

      andConditions.push({ branchId: targetBranch.id });
    }
  } else if (role === UserRole.BRANCH_MANAGER) {
    // Zero-Trust: Verify manager's assigned branch directly from DB
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

    // Block cross-branch access attempts
    if (cleanBranchId && cleanBranchId !== managedBranch.id) {
      throw new ApiError(
        403,
        "Branch managers can only view catalog items for their own branch."
      );
    }

    // Show own branch inventory + global company services (branchId: null)
    andConditions.push({
      OR: [{ branchId: managedBranch.id }, { branchId: null }],
    });
  } else if (role === UserRole.STAFF) {
    // Zero-Trust: Fetch current branch assignment directly from DB
    const staffUser = await prisma.user.findFirst({
      where: {
        id: userId,
        tenantId,
      },
      select: { branchId: true },
    });

    if (!staffUser) {
      throw new ApiError(404, "Staff profile not found.");
    }

    // Block staff from querying any branch other than their assigned branch
    if (cleanBranchId && cleanBranchId !== staffUser.branchId) {
      throw new ApiError(
        403,
        "You can only view catalog items for your assigned branch."
      );
    }

    if (staffUser.branchId) {
      andConditions.push({
        OR: [{ branchId: staffUser.branchId }, { branchId: null }],
      });
    } else {
      // Unassigned staff (e.g., agency/corporate) only see global items
      andConditions.push({ branchId: null });
    }
  } else {
    throw new ApiError(403, "You are not authorized to view catalog items.");
  }

  // Step 4: Push search, itemType, dead-stock, and low-stock filters
  const trimmedSearch = typeof search === "string" ? search.trim() : "";
  if (trimmedSearch) {
    andConditions.push({
      OR: [
        { name: { contains: trimmedSearch, mode: "insensitive" } },
        { sku: { contains: trimmedSearch, mode: "insensitive" } },
      ],
    });
  }

  if (normalizedItemType) {
    andConditions.push({ itemType: normalizedItemType });
  }

  if (isOnlyDeadStock) {
    andConditions.push({
      itemType: ItemType.PHYSICAL_GOOD,
      stock: { gt: 0 },
      lastRestockedAt: { lte: deadStockCutoffDate },
    });
  }

  if (isLowStock) {
    andConditions.push({
      itemType: ItemType.PHYSICAL_GOOD,
      stock: {
        not: null,
        lte: parsedLowStockThreshold,
      },
    });
  }

  const whereClause = { AND: andConditions };

  // Step 5: Choose context-aware sorting and run parallel DB queries
  let orderBy = { createdAt: "desc" };
  if (isOnlyDeadStock) {
    // Oldest untouched stock first so staff can prioritize clearing it
    orderBy = { lastRestockedAt: "asc" };
  } else if (isLowStock) {
    // Lowest or out-of-stock items first for urgent restocking
    orderBy = { stock: "asc" };
  }

  const [rawItems, totalRecords] = await Promise.all([
    prisma.catalogItem.findMany({
      where: whereClause,
      skip,
      take: itemsPerPage,
      orderBy,
      include: {
        branch: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    }),
    prisma.catalogItem.count({
      where: whereClause,
    }),
  ]);

  // Step 6: Inject dynamic dead-stock, bounty, and low-stock flags
  const list = rawItems.map((item) =>
    enrichCatalogItem(item, {
      referenceDate: now,
      cutoffDate: deadStockCutoffDate,
      lowStockThreshold: parsedLowStockThreshold,
    })
  );

  // Step 7: Build uniform paginated ApiResponse payload
  const totalPages = Math.ceil(totalRecords / itemsPerPage);

  const responsePayload = {
    list,
    pagination: {
      totalRecords,
      totalPages,
      currentPage,
      limit: itemsPerPage,
    },
  };

  return res
    .status(200)
    .json(
      new ApiResponse(
        200,
        responsePayload,
        "Catalog items fetched successfully."
      )
    );
});





