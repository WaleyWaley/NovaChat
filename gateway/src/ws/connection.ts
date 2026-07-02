/**
 * WebSocket 连接管理器 — 网关注册的核心数据结构
 *
 * 维护:
 *   - userId → WebSocket 映射 (在线路由)
 *   - WebSocket → userId 反向映射 (断开时清理)
 *   - push_id 去重缓存 (幂等推送)
 *
 * Node.js 单线程模型下无需 mutex，但需要注意异步 I/O 回调中的一致性。
 */

import type { WebSocket } from "ws";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

// ---- 内部结构 ----

interface ConnectionEntry {
  ws: WebSocket;
  userId: number;
  username: string;
  connectedAt: number;     // unix ms
  lastHeartbeat: number;   // unix ms
}

// ---- ConnectionManager ----

export class ConnectionManager {
  /** userId → ConnectionEntry */
  private readonly byUserId = new Map<number, ConnectionEntry>();

  /** WebSocket → userId (用于 close 事件快速反查) */
  private readonly bySocket = new Map<WebSocket, number>();

  /** push_id 去重缓存 (LRU 风格 — 超容量时清空最旧的一半) */
  private readonly processedPushIds = new Set<number>();

  /** 心跳定时器 */
  private heartbeatTimer: NodeJS.Timeout | null = null;

  // ---- 注册 / 注销 ----

  /**
   * 用户上线注册
   * @returns false 如果已达最大连接数或用户已在线 (旧连接会被 kick)
   */
  register(userId: number, username: string, ws: WebSocket): boolean {
    // 容量检查
    if (this.byUserId.size >= config.WS_MAX_CONNECTIONS) {
      logger.warn({ count: this.byUserId.size }, "Max connections reached");
      return false;
    }

    // 同用户已有连接 → 先踢掉旧连接 (多端互踢逻辑由 C++ user-service 控制)
    const existing = this.byUserId.get(userId);
    if (existing) {
      logger.info({ userId }, "Replacing existing connection (multi-device)");
      this.kickExisting(existing);
    }

    const entry: ConnectionEntry = {
      ws,
      userId,
      username,
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
    };

    this.byUserId.set(userId, entry);
    this.bySocket.set(ws, userId);

    logger.info(
      { userId, username, onlineCount: this.byUserId.size },
      "User connected"
    );
    return true;
  }

  /**
   * 用户下线注销 (由 WebSocket close 事件触发)
   */
  unregister(ws: WebSocket): number | null {
    const userId = this.bySocket.get(ws);
    if (userId === undefined) return null;

    this.byUserId.delete(userId);
    this.bySocket.delete(ws);

    logger.info(
      { userId, onlineCount: this.byUserId.size },
      "User disconnected"
    );
    return userId;
  }

  // ---- 查询 ----

  /** 根据 userId 查找 WebSocket 连接 */
  getByUserId(userId: number): WebSocket | null {
    const entry = this.byUserId.get(userId);
    return entry && entry.ws.readyState === 1 /* OPEN */ ? entry.ws : null;
  }

  /** 根据 WebSocket 反查 userId */
  getUserId(ws: WebSocket): number | null {
    return this.bySocket.get(ws) ?? null;
  }

  /** 用户是否在线 */
  isOnline(userId: number): boolean {
    const entry = this.byUserId.get(userId);
    return entry !== undefined && entry.ws.readyState === 1; /* OPEN */
  }

  /** 当前在线用户数 */
  getOnlineCount(): number {
    return this.byUserId.size;
  }

  /** 获取所有在线 userId 列表 */
  getOnlineUserIds(): number[] {
    return [...this.byUserId.keys()];
  }

  // ---- 推送 ----

  /**
   * 向指定用户推送消息
   * @returns true 如果成功送达，false 如果用户不在线
   */
  sendToUser(userId: number, message: unknown): boolean {
    const entry = this.byUserId.get(userId);
    if (!entry || entry.ws.readyState !== 1) {
      return false;
    }

    try {
      entry.ws.send(JSON.stringify(message));
      return true;
    } catch (err) {
      logger.error({ userId, err }, "Failed to send message to user");
      return false;
    }
  }

  /**
   * 批量推送给同一网关节点的多个在线用户
   * @returns [deliveredIds, missedIds]
   */
  sendToUsers(userIds: number[], message: unknown): [number[], number[]] {
    const delivered: number[] = [];
    const missed: number[] = [];

    for (const userId of userIds) {
      if (this.sendToUser(userId, message)) {
        delivered.push(userId);
      } else {
        missed.push(userId);
      }
    }

    return [delivered, missed];
  }

  // ---- 踢人 ----

  /**
   * 强制断开用户连接
   * @param reason KickReason 枚举值
   * @param closeCode WebSocket close code
   */
  kickUser(userId: number, reason: number, message: string): boolean {
    const entry = this.byUserId.get(userId);
    if (!entry || entry.ws.readyState !== 1) {
      return false;
    }

    // 先发 kicked 消息，再关闭连接
    try {
      entry.ws.send(
        JSON.stringify({
          type: "kicked",
          payload: { reason, message },
        })
      );
    } catch {
      // 发送失败也继续关闭
    }

    // 延迟关闭，给客户端一点时间接收 kicked 消息
    setTimeout(() => {
      entry.ws.close(4001, message);
    }, 100);

    this.byUserId.delete(userId);
    this.bySocket.delete(entry.ws);

    logger.info({ userId, reason, message }, "User kicked");
    return true;
  }

  // ---- 心跳 ----

  /** 更新用户心跳时间 */
  refreshHeartbeat(ws: WebSocket): void {
    const userId = this.bySocket.get(ws);
    if (userId !== undefined) {
      const entry = this.byUserId.get(userId);
      if (entry) {
        entry.lastHeartbeat = Date.now();
      }
    }
  }

  /**
   * 启动心跳检测定时器
   * 定期扫描超时连接并主动断开
   */
  startHeartbeat(intervalSec: number = config.WS_HEARTBEAT_INTERVAL): void {
    if (this.heartbeatTimer) return;

    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      const timeoutMs = config.WS_CONNECTION_TIMEOUT * 1000;

      for (const [userId, entry] of this.byUserId) {
        if (now - entry.lastHeartbeat > timeoutMs) {
          logger.warn({ userId }, "Heartbeat timeout, disconnecting");
          entry.ws.close(4002, "Heartbeat timeout");
          this.byUserId.delete(userId);
          this.bySocket.delete(entry.ws);
        }
      }
    }, intervalSec * 1000);

    logger.info({ intervalSec }, "Heartbeat monitor started");
  }

  /** 停止心跳检测 */
  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ---- 幂等去重 ----

  /**
   * 检查并记录 push_id
   * @returns true 如果该 push_id 已经处理过 (应跳过)
   */
  isDuplicatePush(pushId: number): boolean {
    if (this.processedPushIds.has(pushId)) {
      return true;
    }

    // 去重集合太大 → 清空最旧的一半
    if (this.processedPushIds.size >= config.PUSH_DEDUP_SIZE) {
      const entries = [...this.processedPushIds];
      const toRemove = entries.slice(0, Math.floor(entries.length / 2));
      for (const id of toRemove) {
        this.processedPushIds.delete(id);
      }
      logger.debug(
        { removed: toRemove.length, remaining: this.processedPushIds.size },
        "Push dedup cache pruned"
      );
    }

    this.processedPushIds.add(pushId);
    return false;
  }

  // ---- 清理 ----

  /**
   * 断开所有连接 (优雅关闭时调用)
   */
  disconnectAll(reason: string = "Server shutting down"): void {
    for (const [, entry] of this.byUserId) {
      try {
        entry.ws.close(4000, reason);
      } catch {
        // 忽略关闭时的错误
      }
    }
    this.byUserId.clear();
    this.bySocket.clear();
    logger.info({ reason }, "All connections closed");
  }

  // ---- 内部 ----

  private kickExisting(entry: ConnectionEntry): void {
    try {
      entry.ws.close(4001, "Replaced by new connection");
    } catch {
      // ignore
    }
    this.bySocket.delete(entry.ws);
  }
}

/**
 * 全局连接管理器单例
 * 所有路由和中间件共享此实例
 */
export const connectionManager = new ConnectionManager();
