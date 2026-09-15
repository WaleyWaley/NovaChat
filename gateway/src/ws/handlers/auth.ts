/**
 * WS auth / ping handler — 从 main.ts 拆出
 *
 * handleAuth: 验 JWT → sessionStore 延迟创建 → connectionManager 注册 →
 *             置连接身份 → token 到期定时器 → Redis 在线登记 → auth_ok
 */

import { verifyAccessToken } from "../../auth/jwt.js";
import { sessionStore } from "../../auth/session.js";
import { connectionManager } from "../connection.js";
import { onlineRegistry } from "../online_registry.js";
import { logger } from "../../utils/logger.js";
import {
  buildAuthOk,
  buildError,
  buildPong,
  type ClientAuthMessage,
  type ClientPingMessage,
} from "../protocol.js";
import type { ClientSession } from "../client_session.js";

export function handleAuth(session: ClientSession, msg: ClientAuthMessage): void {
  const { access_token, device_name, device_type } = msg.payload;

  const result = verifyAccessToken(access_token);
  if (!result.ok) {
    const code =
      result.error === "EXPIRED"
        ? 1002
        : result.error === "SESSION_INVALIDATED"
          ? 1003
          : 1004;
    session.send(buildError(msg.seq, code, result.message));
    return;
  }

  const payload = result.payload;

  // Phase 2.1: 延迟创建 session (若 token 携带 session_id)
  if (payload.session_id) {
    const existing = sessionStore.getSync(payload.session_id);
    if (!existing) {
      // 延迟创建: 首次见到这个 session_id
      sessionStore
        .create({
          sessionId: payload.session_id,
          userId: payload.user_id,
          deviceName: device_name,
          deviceType: device_type,
          createdAt: Date.now(),
          expiresAt: (payload.exp ?? 0) * 1000,
        })
        .catch((err) =>
          logger.error({ err }, "Failed to create session")
        );
    } else {
      // 更新活跃时间
      sessionStore
        .updateActivity(payload.session_id)
        .catch((err) =>
          logger.error({ err }, "Failed to update session activity")
        );
    }
  }

  // 注册到连接管理器
  const ok = connectionManager.register(
    payload.user_id,
    payload.username,
    session.ws
  );
  if (!ok) {
    session.send(
      buildError(msg.seq, 5002, "Server busy, please try another gateway")
    );
    return;
  }

  session.authenticated = true;
  session.userId = payload.user_id;
  session.username = payload.username;
  session.sessionId = payload.session_id ?? null;

  // token 到期前主动断开 WS, 逼前端走"静默续期 → 重连"
  // (前端 REST 层已实现 401 自动 refresh; 否则长连接会带着过期身份一直挂着)
  if (payload.exp) {
    session.armExpiryTimer(payload.exp);
  }

  logger.info(
    {
      userId: session.userId,
      username: session.username,
      sessionId: session.sessionId,
      device_name,
      device_type,
      onlineCount: connectionManager.getOnlineCount(),
    },
    "User authenticated via WebSocket"
  );

  // Phase 2.3: 向 Redis 注册在线状态 → 全局路由表
  onlineRegistry.onUserOnline(payload.user_id, payload.username).catch((err) => {
    logger.error({ err, userId: payload.user_id }, "Failed to register online status");
  });

  session.send(buildAuthOk(msg.seq, payload.user_id, payload.username));
}

export function handlePing(session: ClientSession, msg: ClientPingMessage): void {
  if (session.authenticated) {
    connectionManager.refreshHeartbeat(session.ws);
  }
  session.send(buildPong(msg.seq));
}
