import dotenv from "dotenv";
import Redis from "ioredis";

dotenv.config({ path: "./.env" });

const globalForRedis = globalThis;

const createRedisClient = () => {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    console.warn("[Redis] REDIS_URL is missing in environment variables.");
  }

  const client = new Redis(redisUrl, {
    // Fail fast on active requests so rate-limiter and idempotency do not hang
    maxRetriesPerRequest: 2,
    connectTimeout: 5000,
    // Retry with backoff up to 10 seconds if connection drops
    retryStrategy(times) {
      return Math.min(times * 500, 10000);
    },
    // Enable TLS automatically for Upstash secure rediss:// URLs
    tls: redisUrl?.startsWith("rediss://") ? {} : undefined,
  });

  client.on("connect", () => {
    console.log("[Redis] Connected to Upstash Redis.");
  });

  client.on("ready", () => {
    console.log("[Redis] Client is ready.");
  });

  // Prevent unhandled error events from crashing the Node process
  client.on("error", (error) => {
    console.error("[Redis] Connection error:", error.message);
  });

  return client;
};

// Reuse single Redis instance across hot reloads in development
const redisClient = globalForRedis.redisClient || createRedisClient();

if (process.env.NODE_ENV !== "production") {
  globalForRedis.redisClient = redisClient;
}

// Register SIGINT graceful shutdown only once to prevent memory leaks
if (!globalForRedis.redisShutdownRegistered) {
  process.once("SIGINT", async () => {
    try {
      if (redisClient.status !== "end") {
        await redisClient.quit();
        console.log("[Redis] Connection closed cleanly on SIGINT.");
      }
    } catch (error) {
      console.error("[Redis] Graceful shutdown error:", error.message);
    }
  });

  globalForRedis.redisShutdownRegistered = true;
}

export default redisClient;