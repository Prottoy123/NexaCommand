import redisClient from "../config/redis.config.js";
import { ApiError } from "../utils/ApiError.js";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SAFE_KEY_REGEX = /^[a-zA-Z0-9_-]{8,128}$/;

/**
 * Reusable Redis-based Idempotency Middleware Factory
 * @param {Object} options
 * @param {number} options.ttlSeconds - Lock duration in seconds (default: 5)
 * @param {boolean} options.strict - If true, header is required (400) and Redis failure blocks request (503)
 */
export const requireIdempotency = ({ ttlSeconds = 5, strict = true } = {}) => {
  return async (req, res, next) => {
    try {
      // Skip read-only HTTP methods (GET, HEAD, OPTIONS)
      if (!MUTATION_METHODS.has(req.method)) {
        return next();
      }

      // Express automatically normalizes header names to lowercase
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

      // Validate key length and safe characters to prevent memory bloat
      if (!SAFE_KEY_REGEX.test(idempotencyKey)) {
        throw new ApiError(
          400,
          "Invalid 'Idempotency-Key'. Must be 8-128 characters (UUID or alphanumeric with hyphens/underscores)."
        );
      }

      // Build tenant, user, method, and clean path scoped composite key
      const tenantScope = req.tenantId || req.user?.tenantId || "public";
      const userScope = req.user?.id || req.ip || "anonymous";
      const cleanPath = req.originalUrl.split("?")[0];

      const redisKey = `idempotency:${tenantScope}:${userScope}:${req.method}:${cleanPath}:${idempotencyKey}`;

      // Set atomic Redis lock only if key does not exist (NX) with expiry (EX)
      const lockAcquired = await redisClient.set(
        redisKey,
        "LOCKED",
        "EX",
        ttlSeconds,
        "NX"
      );

      // Block duplicate request if lock already exists within TTL window
      if (!lockAcquired) {
        throw new ApiError(
          409,
          "Duplicate request detected. Please wait a moment before retrying this action."
        );
      }

      // Auto-release lock on 5xx server errors so client can retry safely
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
      // Pass expected ApiError (400 / 409) straight to global error handler
      if (error instanceof ApiError) {
        return next(error);
      }

      console.error("[Idempotency] Redis error:", error.message);

      if (strict) {
        // Fail-Closed for critical/financial routes
        return next(
          new ApiError(
            503,
            "Request protection service is temporarily unavailable. Please try again shortly."
          )
        );
      }

      // Fail-Open for non-critical routes
      return next();
    }
  };
};