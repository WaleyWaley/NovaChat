/**
 * 在线状态注册器 — 网关 ↔ Redis 在线路由表的桥梁
 *
 * 职责:
 *   1. 用户上线 → 写入 Redis `user:online:<user_id>`
 *   2. 用户下线 → 删除 Redis key
 *   3. 定时心跳 → 刷新所有本地在线用户的 Redis TTL
 *
 * 架构:
 *   ConnectionManager (本地连接表) → OnlineRegistry → Redis (全局路由表)
 *
 * C++ message-service 通过查 Redis 路由表知道用户在哪个网关节点，
 * 然后通过 bRPC HTTP 调用该网关的 PushService 实现消息推送。
 */

import { connectionManager } from "./connection.js";
import { gatewayRedis } from "../redis/client.js";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

// ---- OnlineRegistry ----

export class OnlineRegistry {
  private heartbeatTimer: NodeJS.Timeout | null = null;

  // ===== 用户上线 =====

  /**
   * 用户认证成功后调用 — 注册到 Redis 全局路由表
   *
   * @returns 是否成功写入 Redis (不影响本地状态, 即使失败也返回 true)
   */
  async onUserOnline(userId: number, username: string): Promise<void> {
    logger.debug({ userId, username }, "Registering user online in Redis");

    if (!gatewayRedis.connected) {
      logger.debug({ userId }, "Redis not connected, skipping online registration");
      return;
    }

    const ok = await gatewayRedis.setUserOnline(userId);
    if (ok) {
      logger.info(
        { userId, gatewayAddr: config.GATEWAY_ADDR },
        "User registered in Redis online table"
      );
    }
  }

  // ===== 用户下线 =====

  /**
   * 用户断开连接时调用 — 从 Redis 删除
   */
  async onUserOffline(userId: number): Promise<void> {
    logger.debug({ userId }, "Removing user from Redis online table");

    if (!gatewayRedis.connected) {
      return;
    }

    await gatewayRedis.setUserOffline(userId);
    logger.info({ userId }, "User removed from Redis online table");
  }

  // ===== 心跳维护 =====

  /**
   * 启动定时心跳刷新
   *
   * 每 ONLINE_HEARTBEAT_INTERVAL 秒刷新一次 Redis 中所有本地在线用户的 TTL。
   * 如果某个用户的 key 已过期 (被 Redis 自动清理), 重新注册。
   */
  startHeartbeat(): void {
    if (this.heartbeatTimer) return;

    const intervalMs = config.ONLINE_HEARTBEAT_INTERVAL * 1000;

    this.heartbeatTimer = setInterval(async () => {
      const userIds = connectionManager.getOnlineUserIds();
      if (userIds.length === 0) return;

      if (!gatewayRedis.connected) return;

      const count = await gatewayRedis.refreshHeartbeats(userIds as any);
      if (count > 0) {
        logger.debug(
          { refreshed: count, total: userIds.length },
          "Online heartbeat refreshed"
        );
      }
    }, intervalMs);

    logger.info(
      { intervalSec: config.ONLINE_HEARTBEAT_INTERVAL },
      "Online registry heartbeat started"
    );
  }

  /** 停止心跳 */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ===== 优雅关闭 =====

  /**
   * 网关关闭时清除所有本地在线用户
   */
  async shutdown(): Promise<void> {
    this.stopHeartbeat();

    const userIds = connectionManager.getOnlineUserIds();
    if (userIds.length > 0 && gatewayRedis.connected) {
      await gatewayRedis.clearGatewayUsers(userIds as any);
    }

    logger.info("OnlineRegistry shutdown complete");
  }
}

/** 全局单例 */
export const onlineRegistry = new OnlineRegistry();
