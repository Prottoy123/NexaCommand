import redis from '../config/redis.config.js';
import  ApiError from '../utils/ApiError.js';
import asyncHandler from '../utils/asyncHandler.js';

/**
 * Dynamic Rate Limiter Middleware Factory
 * @param {string} keyPrefix - Unique identifier for the route (e.g., 'accept-invite', 'ai-pnl')
 * @param {number} limit - Maximum allowed requests within the window
 * @param {number} windowInSeconds - Time window in seconds
 */
export const rateLimiter = (keyPrefix, limit = 5, windowInSeconds = 60) => {
    return asyncHandler(async (req, res, next) => {
        // Hybrid Identifier: Use user ID for authenticated routes, fallback to IP for public routes
        const clientIdentifier = req.user?.id || req.ip || req.headers['x-forwarded-for'] || 'unknown-ip';
        const redisKey = `ratelimit:${keyPrefix}:${clientIdentifier}`;

        // Atomic increment operation in Redis
        const currentRequests = await redis.incr(redisKey);

        // If this is the first request, set the expiration window
        if (currentRequests === 1) {
            await redis.expire(redisKey, windowInSeconds);
        }

        // Check if the request count exceeds the allowed limit
        if (currentRequests > limit) {
            const ttl = await redis.ttl(redisKey);
            throw new ApiError(
                429, 
                `Too many requests. Please try again after ${ttl > 0 ? ttl : windowInSeconds} seconds.`
            );
        }

        next();
    });
};