/**
 * 简易令牌桶限流中间件
 *
 * Phase 1: 内存实现，进程重启后计数清零
 * Phase 2: 升级为 Redis 令牌桶，支持多网关节点共享限流状态
 */
import type { FastifyInstance } from "fastify";
/**
 * 注册限流钩子到 Fastify 实例
 */
export declare function registerRateLimitHook(app: FastifyInstance): void;
//# sourceMappingURL=rate_limiter.d.ts.map