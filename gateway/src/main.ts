/**
 * NovaChat Gateway — 入口文件
 *
 * 启动流程:
 *   1. 加载配置
 *   2. 创建 Fastify 实例 (含 pino logger)
 *   3. 注册插件 (CORS, WebSocket)
 *   4. 注册中间件钩子 (JWT 鉴权, 限流)
 *   5. 注册路由 (health, PushService, user API)
 *   6. 注册 WebSocket 处理器 (客户端长连接)
 *   7. 启动 HTTP 服务器
 *   8. 优雅关闭
 *
 * WS 连接生命周期在此装配; 消息处理逻辑见 ws/handlers/ (auth / messaging /
 * call_room / rpc), 单连接状态见 ws/client_session.ts。
 */

import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyCors from "@fastify/cors";
import { config, isDev } from "./config/index.js";
import { logger } from "./utils/logger.js";
import { registerAuthHook } from "./middleware/auth.js";
import { registerRateLimitHook } from "./middleware/rate_limiter.js";
import { healthRoutes } from "./routes/health.js";
import { messageRoutes } from "./routes/message.js";
import { pushRoutes } from "./routes/push.js";
import { userRoutes } from "./routes/user.js";
import { avatarRoutes } from "./routes/avatar.js";
import { connectionManager } from "./ws/connection.js";
import { onlineRegistry } from "./ws/online_registry.js";
import { gatewayRedis } from "./redis/client.js";
import { sessionStore } from "./auth/session.js";
import { ClientSession } from "./ws/client_session.js";
import {
  isClientMessage,
  getMessageType,
  buildError,
  buildRpcResult,
  type ClientMessage,
  type ClientAuthMessage,
  type ClientPingMessage,
  type ClientRpcMessage,
  type ClientSendMessage,
  type ClientTypingMessage,
  type ClientReadReceiptMessage,
  type ClientCallSignal,
  type ClientRoomSignal,
} from "./ws/protocol.js";
import { handleAuth, handlePing } from "./ws/handlers/auth.js";
import { handleSendMessage, handleReadReceipt, handleTyping } from "./ws/handlers/messaging.js";
import { handleCallSignal, handleRoomSignal } from "./ws/handlers/call_room.js";
import { handleRpc } from "./ws/handlers/rpc.js";
import type { WebSocket } from "ws";
import type { FastifyRequest } from "fastify";

// =============================================================================
// 应用创建
// =============================================================================

async function createApp() {
  // ---- Fastify 实例 ----
  const app = Fastify({
    logger: false, // 我们使用自己的 pino 实例
    trustProxy: true,
  });

  // ---- 插件注册 ----
  await app.register(fastifyCors, {
    origin: true,
    credentials: true,
  });

  await app.register(fastifyWebsocket, {
    options: {
      maxPayload: 64 * 1024, // 64KB max WS message size
    },
  });

  // ---- 中间件钩子 ----
  registerAuthHook(app);
  registerRateLimitHook(app);

  // ---- HTTP 路由 ----
  await app.register(healthRoutes);
  await app.register(messageRoutes);
  await app.register(pushRoutes);
  await app.register(userRoutes);
  await app.register(avatarRoutes);

  // ---- WebSocket 处理器 (客户端长连接入口) ----
  app.get(
    "/ws",
    { websocket: true },
    (socket: WebSocket, req: FastifyRequest) => {
      const session = new ClientSession(socket);

      logger.info({ ip: req.ip }, "WebSocket connection established");

      // 发送欢迎帧 (提示客户端发送 auth)
      session.send({
        type: "welcome",
        payload: { version: "0.1.0", message: "NovaChat Gateway" },
      });

      // ---- 消息处理 ----
      socket.on("message", (rawData: Buffer) => {
        let msg: unknown;
        try {
          msg = JSON.parse(rawData.toString());
        } catch {
          session.send(buildError(0, 1302, "Invalid JSON"));
          return;
        }

        if (!isClientMessage(msg)) {
          session.send(
            buildError(0, 1302, "Invalid message format: need {type, seq}")
          );
          return;
        }

        const clientMsg = msg as ClientMessage;
        const msgType = getMessageType(clientMsg);

        // 未认证时只接受 auth 和 ping
        if (!session.authenticated && msgType !== "auth" && msgType !== "ping") {
          session.send(
            buildError(clientMsg.seq, 1004, "Authentication required")
          );
          return;
        }

        switch (msgType) {
          case "auth":
            handleAuth(session, clientMsg as ClientAuthMessage);
            break;
          case "ping":
            handlePing(session, clientMsg as ClientPingMessage);
            break;
          case "send_msg":
            handleSendMessage(session, clientMsg as ClientSendMessage).catch((err) => {
              logger.error({ err }, "send_msg handler error");
              session.send(
                buildRpcResult(clientMsg.seq, 5001, "Internal error", null)
              );
            });
            break;
          case "typing":
            handleTyping(session, clientMsg as ClientTypingMessage);
            break;
          case "read":
            handleReadReceipt(session, clientMsg as ClientReadReceiptMessage).catch((err) => {
              logger.error({ err }, "read receipt handler error");
            });
            break;
          case "call_signal":
            handleCallSignal(session, clientMsg as ClientCallSignal);
            break;
          case "room_signal":
            handleRoomSignal(session, clientMsg as ClientRoomSignal);
            break;
          case "rpc":
            handleRpc(session, clientMsg as ClientRpcMessage).catch((err) => {
              logger.error({ err }, "RPC proxy error");
              session.send(
                buildRpcResult(
                  clientMsg.seq,
                  5001,
                  err instanceof Error ? err.message : "Internal error",
                  null
                )
              );
            });
            break;
          default:
            session.send(
              buildError(clientMsg.seq, 1302, `Unknown message type: ${msgType}`)
            );
        }
      });

      // ---- 连接关闭 ----
      socket.on("close", (_code: number, _reason: Buffer) => {
        session.clearExpiryTimer();
        if (session.authenticated && session.userId !== null) {
          connectionManager.unregister(socket);
          // Phase 2.3: 通知 Redis 删除在线状态
          onlineRegistry.onUserOffline(session.userId).catch((err) => {
            logger.error({ err, userId: session.userId }, "Failed to unregister online status");
          });
        }
        logger.info(
          {
            userId: session.userId,
            sessionId: session.sessionId,
            authenticated: session.authenticated,
          },
          "WebSocket connection closed"
        );
      });

      // ---- 错误处理 ----
      socket.on("error", (err: Error) => {
        logger.error({ err, userId: session.userId }, "WebSocket error");
      });
    }
  );

  // ---- 404 处理 ----
  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({
      error_code: 1201,
      error_message: "Not found",
    });
  });

  // ---- 全局错误处理 ----
  // 注意: 必须透传错误自带的状态码 (如 multipart 超限的 413),
  // 否则 RequestFileTooLargeError 会被吞成 500, 前端无法区分"文件太大"
  app.setErrorHandler((error, _request, reply) => {
    const status =
      typeof (error as { statusCode?: number }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;
    logger.error({ err: error, status }, "Unhandled error");
    reply.status(status).send({
      error_code: status === 413 ? 1401 : 5001, // 1401 = FILE_TOO_LARGE (common.proto)
      error_message:
        status === 413
          ? "File too large (max 2MB)"
          : isDev
            ? error.message
            : "Internal server error",
    });
  });

  return app;
}

// =============================================================================
// 服务启动
// =============================================================================

async function main(): Promise<void> {
  const app = await createApp();

  // ---- Phase 2.3: 初始化 Redis 在线路由表 ----
  const redisOk = await gatewayRedis.connect();
  if (!redisOk) {
    logger.warn("Redis not available, cross-gateway online queries disabled");
  }

  // 启动 HTTP 服务器
  try {
    await app.listen({
      port: config.PORT,
      host: config.HOST,
    });

    logger.info(
      {
        port: config.PORT,
        host: config.HOST,
        env: config.NODE_ENV,
        workerId: config.WORKER_ID,
        gatewayAddr: config.GATEWAY_ADDR,
        redis: redisOk ? "connected" : "unavailable",
      },
      "🚀 NovaChat Gateway started"
    );

    // 启动本地心跳检测
    connectionManager.startHeartbeat();

    // Phase 2.3: 启动 Redis 在线路由表心跳刷新
    if (redisOk) {
      onlineRegistry.startHeartbeat();
    }

    // Phase 2.1: 启动 session 清理定时器
    sessionStore.startCleanupTimer();
  } catch (err) {
    logger.fatal({ err }, "Failed to start gateway");
    process.exit(1);
  }

  // ---- 优雅关闭 ----
  const shutdown = async (signal: string) => {
    logger.info({ signal }, "Shutting down...");

    connectionManager.stopHeartbeat();
    onlineRegistry.stopHeartbeat();
    sessionStore.stopCleanupTimer();

    // Phase 2.3: 清除 Redis 中本网关的所有在线用户
    await onlineRegistry.shutdown();
    await gatewayRedis.disconnect();

    connectionManager.disconnectAll("Server shutting down");

    try {
      await app.close();
      logger.info("Gateway closed");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "Error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
