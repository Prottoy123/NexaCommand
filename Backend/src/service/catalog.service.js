import { ItemType } from "@prisma/client";

const DEAD_STOCK_DAYS = 90;
const DEFAULT_LOW_STOCK_THRESHOLD = 10;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Returns the exact cutoff date (90 days ago from now)
const getDeadStockCutoffDate = (referenceDate = new Date()) => {
  return new Date(referenceDate.getTime() - DEAD_STOCK_DAYS * MS_PER_DAY);
};

// Evaluates dead-stock status, active bounty, and low-stock flag for a catalog item
const enrichCatalogItem = (
  item,
  {
    referenceDate = new Date(),
    cutoffDate = getDeadStockCutoffDate(referenceDate),
    lowStockThreshold = DEFAULT_LOW_STOCK_THRESHOLD,
  } = {}
) => {
  const numericPrice = Number(item.price ?? 0);
  const baseBountyAmount = Number(item.bountyAmount ?? 0);

  const isPhysical = item.itemType === ItemType.PHYSICAL_GOOD;
  const hasStock = typeof item.stock === "number" && item.stock > 0;
  const restockedDate = item.lastRestockedAt
    ? new Date(item.lastRestockedAt)
    : null;

  // Calculate full days elapsed since last restock (only for physical goods with a date)
  const daysSinceRestock =
    isPhysical && restockedDate
      ? Math.max(
          0,
          Math.floor((referenceDate.getTime() - restockedDate.getTime()) / MS_PER_DAY)
        )
      : null;

  // Item is dead-stock only if physical, in stock (> 0), and untouched for 90+ days
  const isDeadStock = Boolean(
    isPhysical && hasStock && restockedDate && restockedDate <= cutoffDate
  );

  // Staff earns bounty only when the item is currently classified as dead-stock
  const activeBountyAmount = isDeadStock ? baseBountyAmount : 0;

  // Low-stock flag applies only to physical goods at or below the threshold
  const isLowStock = Boolean(
    isPhysical &&
      typeof item.stock === "number" &&
      item.stock <= lowStockThreshold
  );

  return {
    ...item,
    price: numericPrice,
    bountyAmount: baseBountyAmount,
    isDeadStock,
    daysSinceRestock,
    activeBountyAmount,
    isLowStock,
  };
};

export {
  DEAD_STOCK_DAYS,
  DEFAULT_LOW_STOCK_THRESHOLD,
  getDeadStockCutoffDate,
  enrichCatalogItem,
};