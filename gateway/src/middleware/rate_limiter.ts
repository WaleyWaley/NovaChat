/**
 * 简易令牌桶限流中间件
 *
 * Phase 1: 内存实现，进程重启后计数清零
 * Phase 2: 升级为 Redis 令牌桶，支持多网关节点共享限流状态
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { config } from "../config/index.js";

// ---- 令牌桶 ----

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

class InMemoryRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly cleanupTimer: NodeJS.Timeout;

  constructor(private readonly maxTokens: number) {
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  /**
   * 尝试消费 1 个令牌
   * @returns true 如果允许通过，false 如果限流
   */
  tryConsume(key: string): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: this.maxTokens - 1, lastRefill: now };
      this.buckets.set(key, bucket);
      return true;
    }

    const elapsedSec = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(
      this.maxTokens,
      bucket.tokens + elapsedSec * this.maxTokens
    );
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    return false;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > 120_000) {
        this.buckets.delete(key);
      }
    }
  }

  destroy(): void {
    clearInterval(this.cleanupTimer);
  }
}

// ---- 限流器实例 ----

const userLimiter = new InMemoryRateLimiter(config.RATE_LIMIT_PER_USER);
const ipLimiter = new InMemoryRateLimiter(config.RATE_LIMIT_PER_IP);

// ---- 白名单 ----

const RATE_LIMIT_WHITELIST = [
  "/health",
  "/nova.gateway.PushService/",
];

function skipRateLimit(url: string): boolean {
  return RATE_LIMIT_WHITELIST.some((prefix) => url.startsWith(prefix));
}

// ---- 注册函数 ----

/**
 * 注册限流钩子到 Fastify 实例
 */
export function registerRateLimitHook(app: FastifyInstance): void {
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (skipRateLimit(request.url)) {
      return;
    }

    const ipKey = `ip:${request.ip}`;
    if (!ipLimiter.tryConsume(ipKey)) {
      return reply.status(429).send({
        error_code: 1501, // FLOOD_WAIT
        error_message: "Too many requests. Please wait.",
      });
    }

    if (request.userId !== undefined) {
      const userKey = `user:${request.userId}`;
      if (!userLimiter.tryConsume(userKey)) {
        return reply.status(429).send({
          error_code: 1501, // FLOOD_WAIT
          error_message: "Too many requests. Please wait.",
        });
      }
    }
  });
}
