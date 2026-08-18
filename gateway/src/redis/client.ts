/**
 * Redis 客户端 — 网关注入在线路由表的入口
 *
 * Phase 2.3: 使用 ioredis 连接 Redis
 * 核心用途:
 *   - 用户上下线时写入/删除 `user:online:<user_id>`
 *   - 定期刷新在线心跳 TTL (保持 key 存活)
 *   - 网关间事件通知 (pub/sub)
 *
 * 故障模式: Redis 不可用时优雅降级 — 仅记录日志, 不影响网关正常服务。
 *   此时 IsUserOnline 只返回本节点结果, 跨节点推送依赖 C++ 消息服务重试。
 */

import { Redis } from "ioredis";
import { config, isDev } from "../config/index.js";
import { logger } from "../utils/logger.js";

// ---- 类型 ----

/** 在线路由表 Value 的格式 (JSON) */
export interface OnlineEntry {
  gateway_addr: string;
  last_heartbeat: number; // unix ms
}

// ---- Redis 客户端 ----

class GatewayRedis {
  private client: Redis | null = null;
  private _connected = false;

  // ===== 生命周期 =====

  /** 连接 Redis */
  async connect(): Promise<boolean> {
    if (this._connected) return true;

    const [host, portStr] = config.REDIS_ADDR.split(":");
    const port = parseInt(portStr || "6379", 10);

    try {
      this.client = new Redis({
        host,
        port,
        password: config.REDIS_PASSWORD || undefined,
        lazyConnect: true,  // 等调用connect()再连接
        retryStrategy: (times: number) => {
        // 重连10次就放弃
          if (times > 10) {
            logger.error("Redis retry limit exceeded, giving up");
            return null; // 停止重试
          }
          // 最多等待5秒
          return Math.min(times * 200, 5000);
        },
        maxRetriesPerRequest: 3,
        connectTimeout: 5000,
        enableOfflineQueue: false, // Redis 不可用时直接失败, 不堆积请求    
      });

      this.client.on("connect", () => {
        this._connected = true;
        logger.info({ host, port }, "Redis connected");
      });

      this.client.on("error", (err: Error) => {
        logger.error({ err }, "Redis error");
        this._connected = false;
      });

      this.client.on("close", () => {
        this._connected = false;
        logger.warn("Redis connection closed");
      });

      await this.client.connect();
      return true;
    } catch (err) {
      logger.error({ err }, "Failed to connect to Redis");
      this.client = null;
      this._connected = false;
      return false;
    }
  }

  /** 断开 Redis */
  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.quit();
      } catch {
        // ignore
      }
      this.client = null;
      this._connected = false;
    }
  }

  get connected(): boolean {
    return this._connected && this.client !== null;
  }

  // ===== 在线路由表操作 =====

  /** 用户上线 — 写入 Redis 在线路由表 */
  async setUserOnline(userId: number): Promise<boolean> {
    if (!this.client || !this._connected) return false;

    const key = `user:online:${userId}`;
    const entry: OnlineEntry = {
      gateway_addr: config.GATEWAY_ADDR,
      last_heartbeat: Date.now(),
    };

    try {
      await this.client.set(
        key,
        JSON.stringify(entry),
        "EX",
        config.REDIS_ONLINE_TTL
      );
      return true;
    } catch (err) {
      logger.error({ err, userId }, "Failed to set user online in Redis");
      return false;
    }
  }

  /** 刷新用户在线心跳 TTL */
  async refreshHeartbeat(userId: number): Promise<boolean> {
    if (!this.client || !this._connected) return false;

    const key = `user:online:${userId}`;
    try {
      // 更新 last_heartbeat 并延长 TTL
      const current = await this.client.get(key);
      if (current) {
        try {
          const entry: OnlineEntry = JSON.parse(current);
          entry.last_heartbeat = Date.now();
          await this.client.set(key, JSON.stringify(entry), "EX", config.REDIS_ONLINE_TTL);
        } catch {
          // JSON 解析失败, 重新写入
          return await this.setUserOnline(userId);
        }
      } else {
        // key 不存在, 重新注册
        return await this.setUserOnline(userId);
      }
      return true;
    } catch (err) {
      logger.error({ err, userId }, "Failed to refresh heartbeat");
      return false;
    }
  }

  /** 批量刷新心跳 (定期维护调用) */
  async refreshHeartbeats(userIds: number[]): Promise<number> {
    if (!this.client || !this._connected || userIds.length === 0) return 0;

    let refreshed = 0;
    // 使用 pipeline 批量操作
    const pipeline = this.client.pipeline();

    for (const userId of userIds) {
      const key = `user:online:${userId}`;
      pipeline.get(key);
    }

    try {
      const results = await pipeline.exec();
      if (!results) return 0;

      const setPipeline = this.client.pipeline();
      const now = Date.now();

      for (let i = 0; i < results.length; i++) {
        const [err, val] = results[i];
        const userId = userIds[i];
        if (err || !val) {
          // key 不存在, 重新注册
          const entry: OnlineEntry = {
            gateway_addr: config.GATEWAY_ADDR,
            last_heartbeat: now,
          };
          setPipeline.set(
            `user:online:${userId}`,
            JSON.stringify(entry),
            "EX",
            config.REDIS_ONLINE_TTL
          );
        } else {
          try {
            const entry: OnlineEntry = JSON.parse(val as string);
            entry.last_heartbeat = now;
            setPipeline.set(
              `user:online:${userId}`,
              JSON.stringify(entry),
              "EX",
              config.REDIS_ONLINE_TTL
            );
          } catch {
            // 解析失败, 重新注册
            const entry: OnlineEntry = {
              gateway_addr: config.GATEWAY_ADDR,
              last_heartbeat: now,
            };
            setPipeline.set(
              `user:online:${userId}`,
              JSON.stringify(entry),
              "EX",
              config.REDIS_ONLINE_TTL
            );
          }
        }
        refreshed++;
      }

      await setPipeline.exec();
    } catch (err) {
      logger.error({ err }, "Batch heartbeat refresh failed");
    }

    return refreshed;
  }

  /** 用户下线 — 从 Redis 删除 */
  async setUserOffline(userId: number): Promise<boolean> {
    if (!this.client || !this._connected) return false;

    const key = `user:online:${userId}`;
    try {
      await this.client.del(key);
      return true;
    } catch (err) {
      logger.error({ err, userId }, "Failed to set user offline in Redis");
      return false;
    }
  }

  /** 查询用户在线状态 (任意网关) */
  async isUserOnline(userId: number): Promise<OnlineEntry | null> {
    if (!this.client || !this._connected) return null;

    const key = `user:online:${userId}`;
    try {
      const val = await this.client.get(key);
      if (!val) return null;
      return JSON.parse(val) as OnlineEntry;
    } catch {
      return null;
    }
  }

  /** 批量查询在线用户 (任意网关) */
  async batchCheckOnline(userIds: number[]): Promise<{
    online: Map<number, OnlineEntry>;
    offline: number[];
  }> {
    const online = new Map<number, OnlineEntry>();
    const offline: number[] = [];

    if (!this.client || !this._connected || userIds.length === 0) {
      for (const id of userIds) offline.push(id);
      return { online, offline };
    }

    try {
      const pipeline = this.client.pipeline();
      for (const userId of userIds) {
        pipeline.get(`user:online:${userId}`);
      }
      const results = await pipeline.exec();

      if (results) {
        for (let i = 0; i < results.length; i++) {
          const [err, val] = results[i];
          if (err || !val) {
            offline.push(userIds[i]);
          } else {
            try {
              online.set(userIds[i], JSON.parse(val as string) as OnlineEntry);
            } catch {
              offline.push(userIds[i]);
            }
          }
        }
      }
    } catch (err) {
      logger.error({ err }, "Batch online check failed");
    }

    return { online, offline };
  }

  // ===== 本网关清理 =====

  /** 网关关闭时清除本节点所有在线用户 */
  async clearGatewayUsers(userIds: number[]): Promise<void> {
    if (!this.client || !this._connected || userIds.length === 0) return;

    try {
      const pipeline = this.client.pipeline();
      for (const userId of userIds) {
        pipeline.del(`user:online:${userId}`);
      }
      await pipeline.exec();
      logger.info({ count: userIds.length }, "Cleared gateway users from Redis");
    } catch (err) {
      logger.error({ err }, "Failed to clear gateway users from Redis");
    }
  }
}

/** 全局单例 */
export const gatewayRedis = new GatewayRedis();
