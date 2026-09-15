/**
 * ClientSession — 单条 WS 连接的状态封装
 *
 * 原 main.ts 里每个连接用 4 个闭包变量 (authenticated / currentUserId /
 * currentUsername / currentSessionId) 记录状态, handler 全部挤在闭包里。
 * 抽成类后, handler 可以拆到独立文件 (ws/handlers/), 连接生命周期留在 main.ts。
 */

import type { WebSocket } from "ws";
import { logger } from "../utils/logger.js";

/** token 到期断连定时器钳制上限 (JWT exp 已验签, 此项纯防御) */
const MAX_EXPIRY_TTL_MS = 31 * 24 * 3600 * 1000; // 31 天

export class ClientSession {
  readonly ws: WebSocket;

  authenticated = false;
  userId: string | number | null = null;
  username = "";
  sessionId: string | null = null;

  private expTimer: NodeJS.Timeout | null = null;

  constructor(ws: WebSocket) {
    this.ws = ws;
  }

  /** 发送 JSON 消息 (替代散落的 ws.send(JSON.stringify(...))) */
  send(obj: unknown): void {
    this.ws.send(JSON.stringify(obj));
  }

  /**
   * token 到期前主动断开 WS, 逼前端走"静默续期 → 重连"
   * (前端 REST 层已实现 401 自动 refresh; 否则长连接会带着过期身份一直挂着)
   *
   * 钳制: ttl 上限 31 天; exp 已过/非法值不开定时器 (维持原语义)
   */
  armExpiryTimer(exp: number): void {
    const rawTtl = exp * 1000 - Date.now();
    if (!Number.isFinite(rawTtl) || rawTtl <= 0) return;

    const ttlMs = Math.min(rawTtl, MAX_EXPIRY_TTL_MS);
    this.expTimer = setTimeout(() => {
      logger.info(
        { userId: this.userId },
        "WS closing: access token expired, forcing refresh-reconnect"
      );
      this.ws.close(4003, "Token expired");
    }, ttlMs);
  }

  clearExpiryTimer(): void {
    if (this.expTimer) {
      clearTimeout(this.expTimer);
      this.expTimer = null;
    }
  }
}
