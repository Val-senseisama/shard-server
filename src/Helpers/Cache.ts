import { Redis } from "ioredis";
import "dotenv/config";

const REDIS_ENABLED = !!(process.env.REDIS_HOST || process.env.REDIS_URL);

let redis: Redis | null = null;

if (REDIS_ENABLED) {
  redis = process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL, { lazyConnect: true })
    : new Redis({
        host: process.env.REDIS_HOST || "localhost",
        port: parseInt(process.env.REDIS_PORT || "6379"),
        password: process.env.REDIS_PASSWORD,
        lazyConnect: true,
      });

  redis.on("error", (err) => {
    console.error("Redis Client Error:", err);
  });

  redis.on("connect", () => {
    console.log("✅ Redis connected");
  });
} else {
  console.log("ℹ️ Redis not configured — caching disabled");
}

const connectRedis = async () => {
  if (!redis) return false;
  try {
    if (!redis.status || redis.status === "end") {
      await redis.connect();
    }
    return true;
  } catch (error) {
    console.error("Redis connection error:", error);
    return false;
  }
};

/**
 * Cache helper with TTL
 */
export const cache = {
  /**
   * Get cached value
   */
  async get<T>(key: string): Promise<T | null> {
    if (!redis) return null;
    try {
      const connected = await connectRedis();
      if (!connected) return null;
      const value = await redis.get(key);
      return value ? JSON.parse(value) : null;
    } catch (error) {
      console.error("Cache get error:", error);
      return null;
    }
  },

  /**
   * Set cached value with TTL (default 1 hour)
   */
  async set(key: string, value: any, ttl: number = 3600): Promise<void> {
    if (!redis) return;
    try {
      const connected = await connectRedis();
      if (!connected) return;
      await redis.setex(key, ttl, JSON.stringify(value));
    } catch (error) {
      console.error("Cache set error:", error);
    }
  },

  /**
   * Delete cached value
   */
  async del(key: string): Promise<void> {
    if (!redis) return;
    try {
      const connected = await connectRedis();
      if (!connected) return;
      await redis.del(key);
    } catch (error) {
      console.error("Cache delete error:", error);
    }
  },

  /**
   * Delete multiple cached values by pattern
   */
  async delPattern(pattern: string): Promise<void> {
    if (!redis) return;
    try {
      const connected = await connectRedis();
      if (!connected) return;
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (error) {
      console.error("Cache delete pattern error:", error);
    }
  },

  /**
   * Get or set with caching
   */
  async getOrSet<T>(
    key: string,
    fetcher: () => Promise<T>,
    ttl: number = 3600
  ): Promise<T> {
    // Try to get from cache
    const cached = await this.get(key);
    if (cached !== null) {
      return cached as T;
    }

    // Fetch fresh data
    const fresh = await fetcher();

    // Cache it (fire-and-forget)
    this.set(key, fresh, ttl);

    return fresh;
  },
};

/**
 * Cache key generators
 */
export const cacheKeys = {
  user: (userId: string) => `user:${userId}`,
  userList: (filters: object) => `users:${JSON.stringify(filters)}`,
  shard: (shardId: string) => `shard:${shardId}`,
  userShards: (userId: string) => `user:${userId}:shards`,
  shardMiniGoals: (shardId: string) => `shard:${shardId}:minigoals`,
  friendship: (userId: string, friendId: string) => `friendship:${userId}:${friendId}`,
  userFriendships: (userId: string, status: string) => `user:${userId}:friendships:${status}`,
  aiUsage: (userId: string, date: string) => `ai:usage:${userId}:${date}`,
  chat: (chatId: string) => `chat:${chatId}`,
  userChats: (userId: string) => `user:${userId}:chats`,
};

/**
 * Cache invalidation helpers
 */
export const cacheInvalidate = {
  user: async (userId: string) => {
    await cache.del(cacheKeys.user(userId));
    await cache.delPattern(cacheKeys.userShards(userId));
  },

  shard: async (shardId: string) => {
    await cache.del(cacheKeys.shard(shardId));
    await cache.del(cacheKeys.shardMiniGoals(shardId));
  },

  shardList: async (userId: string) => {
    await cache.del(cacheKeys.userShards(userId));
  },

  friendship: async (userId: string, friendId: string) => {
    await cache.del(cacheKeys.friendship(userId, friendId));
    await cache.del(cacheKeys.friendship(friendId, userId));
    await cache.delPattern(cacheKeys.userFriendships(userId, "*"));
    await cache.delPattern(cacheKeys.userFriendships(friendId, "*"));
    await cache.del(`friends:suggestions:${userId}`);
    await cache.del(`friends:suggestions:${friendId}`);
  },

  chat: async (chatId: string) => {
    await cache.del(cacheKeys.chat(chatId));
  },

  userChats: async (userId: string) => {
    await cache.del(cacheKeys.userChats(userId));
  },
};

export default redis;
