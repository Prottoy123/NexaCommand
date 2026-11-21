import redisClient from "../config/redis.config.js";
import { ApiError } from "../utils/ApiError.js";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SAFE_KEY_REGEX = /^[a-zA-Z0-9_-]{8,128}$/;

/**
 * Reusable Redis-based Idempotency Middleware Factory
 * @param {Object} options
 * @param {number} options.ttlSeconds - Lock window in seconds (default: 5s)
 * @param {boolean} options.strict - If true, missing Idempotency-Key throws 400 and Redis outage throws 503
 */
export const requireIdempotency = ({ ttlSeconds = 5, strict = true } = {}) => {
  return async (req, res, next) => {

    try {
      // Skip non-mutation (read-only) requests like GET, HEAD, OPTIONS
      if (!MUTATION_METHODS.has(req.method)) {
        return next();
      }

      // Extract Idempotency-Key header (Express normalizes header names to lowercase)
      const rawHeader = req.headers["idempotency-key"];

      if (!rawHeader) {
        if (strict) {
          throw new ApiError(
            400,
            "Missing required 'Idempotency-Key' header for this operation."
          );
        }
        return next();
      }

      if (typeof rawHeader !== "string") {
        throw new ApiError(400, "Invalid 'Idempotency-Key' header format.");
      }

      const idempotencyKey = rawHeader.trim();

      // Validate format & length to prevent Redis memory bloat or header spoofing
      if (!SAFE_KEY_REGEX.test(idempotencyKey)) {
        throw new ApiError(
          400,
          "Invalid 'Idempotency-Key'. Must be 8-128 characters (UUID or alphanumeric with hyphens/underscores)."
        );
      }

      // Build tenant- and user-scoped composite Redis key
      const tenantScope = req.user?.tenantId || "public";
      const userScope = req.user?.id || req.ip || "anonymous";
      const cleanPath = req.originalUrl.split("?")[0];

      const redisKey = `idempotency:${tenantScope}:${userScope}:${req.method}:${cleanPath}:${idempotencyKey}`;

      // Acquire atomic Redis lock (SET key value EX ttlnds });
      const lockAcquired = await redisClient.set(
        redisKey,
        "LOCKED",
        "EX",
        ttlSeconds,
        "NX"
      );

      // If lockAcquired is null/falsy, the exact key is already locked within the TTL window
      if (!lockAcquired) {
        throw new ApiError(
          409,
          "Duplicate request detected. Please wait a moment before retrying this action."
        );
      }

      // Auto-release lock ONLY if the server crashes with a 5xx error so client can safely retry
      res.on("finish", async () => {
        if (res.statusCode >= 500) {
          try {
            await redisClient.del(redisKey);
          } catch (cleanupError) {
            console.error(
              "[Idempotency] Failed to release lock after 5xx error:",
              cleanupError.message
            );
          }
        }
      });

      return next();
    } catch (error) {
      // Forward expected application errors (400 / 409) directly to global error middleware
      if (error instanceof ApiError) {
        return next(error);
      }

      // Handle unexpected Redis outages based on strictness policy
      console.error("[Idempotency] Redis lock error:", error.message);

      if (strict) {
        // Fail-Closed for financial/critical mutations to prevent double-charging
        return next(
          new ApiError(
            503,
            "Request protection service is temporarily unavailable. Please try again shortly."
          )
        );
      }

      // Fail-Open for optional global protection so non-critical routes keep working
      return next();
    }
  };
};