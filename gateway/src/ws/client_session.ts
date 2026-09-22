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

// ClientSession 是每条 WS 连接对应一个实例，从连接建立到断开，这个实例一直存在。
export class ClientSession {
  // 保存这条连接对应的 WebSocket 实例。readonly 表示只能在构造函数里赋值，之后不能换别的 socket。
  readonly ws: WebSocket;

  // handleAuth 里认证成功会变为true
  authenticated = false;
  // sting 雪花ID被转化成字符串，number 正常数字ID，null 未认证
  userId: string | number | null = null;
  
  // 认证成功后赋值
  username = "";
    
  // 当前JWT会话的session ID
  sessionId: string | null = null;
  
  // token 过期定时器，认证成功后启动，token过期前主动断开连接。只能类内部访问
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
    // exp * 1000 把exp从秒转成毫秒
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

// 状态流转图
// 客户端连上 / ws
//     ↓
// new ClientSession(socket)
//     ↓
// authenticated = false, userId = null, username = "", sessionId = null
//     ↓
// 收到 auth 消息
//     ↓
// JWT 验证通过
//     ↓
// authenticated = true
// userId = xxx
// username = xxx
// sessionId = xxx
// 启动 armExpiryTimer(exp)
//     ↓
// 正常收发消息(send_msg / read / typing / rpc / call_signal ...)
//     ↓
// token 即将过期
//     ↓
// ws.close(4003, "Token expired")
//     ↓
// 或客户端主动断开
//     ↓
// socket.on("close")
// clearExpiryTimer()
// 清理在线状态