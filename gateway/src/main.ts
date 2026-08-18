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
 */

import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyCors from "@fastify/cors";
import { config, isDev } from "./config/index.js";
import { logger } from "./utils/logger.js";
import { registerAuthHook } from "./middleware/auth.js";
import { registerRateLimitHook } from "./middleware/rate_limiter.js";
import { healthRoutes } from "./routes/health.js";
import { pushRoutes } from "./routes/push.js";
import { userRoutes } from "./routes/user.js";
import { connectionManager } from "./ws/connection.js";
import { onlineRegistry } from "./ws/online_registry.js";
import { gatewayRedis } from "./redis/client.js";
import { signToken, verifyAccessToken } from "./auth/jwt.js";
import { sessionStore } from "./auth/session.js";
import {
  isClientMessage,
  getMessageType,
  buildAuthOk,
  buildError,
  buildPong,
  buildRpcResult,
  buildCallSignal,
  buildRoomSignal,
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
import { userClient } from "./clients/user_client.js";
import { messageClient } from "./clients/message_client.js";
import { roomManager } from "./ws/room_manager.js";
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
  await app.register(pushRoutes);
  await app.register(userRoutes);

  // ---- WebSocket 处理器 (客户端长连接入口) ----
  app.get(
    "/ws",
    { websocket: true },
    (socket: WebSocket, req: FastifyRequest) => {
      let authenticated = false;
      let currentUserId: number | null = null;
      let currentUsername = "";
      let currentSessionId: string | null = null; // Phase 2.1

      logger.info({ ip: req.ip }, "WebSocket connection established");

      // 发送欢迎帧 (提示客户端发送 auth)
      socket.send(
        JSON.stringify({
          type: "welcome",
          payload: { version: "0.1.0", message: "NovaChat Gateway" },
        })
      );

      // ---- 消息处理 ----
      socket.on("message", (rawData: Buffer) => {
        let msg: unknown;
        try {
          msg = JSON.parse(rawData.toString());
        } catch {
          socket.send(
            JSON.stringify(
              buildError(0, 1302, "Invalid JSON")
            )
          );
          return;
        }

        if (!isClientMessage(msg)) {
          socket.send(
            JSON.stringify(
              buildError(0, 1302, "Invalid message format: need {type, seq}")
            )
          );
          return;
        }

        const clientMsg = msg as ClientMessage;
        const msgType = getMessageType(clientMsg);

        // 未认证时只接受 auth 和 ping
        if (!authenticated && msgType !== "auth" && msgType !== "ping") {
          socket.send(
            JSON.stringify(
              buildError(clientMsg.seq, 1004, "Authentication required")
            )
          );
          return;
        }

        switch (msgType) {
          case "auth":
            handleAuth(clientMsg as ClientAuthMessage, socket);
            break;
          case "ping":
            handlePing(clientMsg as ClientPingMessage, socket);
            break;
          case "send_msg":
            handleSendMessage(clientMsg as ClientSendMessage).catch((err) => {
              logger.error({ err }, "send_msg handler error");
              socket.send(JSON.stringify(buildRpcResult(clientMsg.seq, 5001, "Internal error", null)));
            });
            break;
          case "typing":
            handleTyping(clientMsg as ClientTypingMessage);
            break;
          case "read":
            handleReadReceipt(clientMsg as ClientReadReceiptMessage);
            break;
          case "call_signal":
            handleCallSignal(clientMsg as ClientCallSignal);
            break;
          case "room_signal":
            handleRoomSignal(clientMsg as ClientRoomSignal);
            break;
          case "rpc":
            handleRpc(clientMsg as ClientRpcMessage, socket).catch((err) => {
              logger.error({ err }, "RPC proxy error");
              socket.send(
                JSON.stringify(
                  buildRpcResult(
                    clientMsg.seq,
                    5001,
                    err instanceof Error ? err.message : "Internal error",
                    null
                  )
                )
              );
            });
            break;
          default:
            socket.send(
              JSON.stringify(
                buildError(clientMsg.seq, 1302, `Unknown message type: ${msgType}`)
              )
            );
        }
      });

      // ---- 连接关闭 ----
      socket.on("close", (_code: number, _reason: Buffer) => {
        if (authenticated && currentUserId !== null) {
          connectionManager.unregister(socket);
          // Phase 2.3: 通知 Redis 删除在线状态
          onlineRegistry.onUserOffline(currentUserId).catch((err) => {
            logger.error({ err, userId: currentUserId }, "Failed to unregister online status");
          });
        }
        logger.info(
          {
            userId: currentUserId,
            sessionId: currentSessionId,
            authenticated,
          },
          "WebSocket connection closed"
        );
      });

      // ---- 错误处理 ----
      socket.on("error", (err: Error) => {
        logger.error({ err, userId: currentUserId }, "WebSocket error");
      });

      // ===================================================================
      // 消息处理函数 (闭包内, 可访问 socket / authenticated / currentUserId)
      // ===================================================================

      function handleAuth(msg: ClientAuthMessage, ws: WebSocket): void {
        const { access_token, device_name, device_type } = msg.payload;

        const result = verifyAccessToken(access_token);
        if (!result.ok) {
          const code =
            result.error === "EXPIRED"
              ? 1002
              : result.error === "SESSION_INVALIDATED"
                ? 1003
                : 1004;
          ws.send(
            JSON.stringify(buildError(msg.seq, code, result.message))
          );
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
          ws
        );
        if (!ok) {
          ws.send(
            JSON.stringify(
              buildError(msg.seq, 5002, "Server busy, please try another gateway")
            )
          );
          return;
        }

        authenticated = true;
        currentUserId = payload.user_id;
        currentUsername = payload.username;
        currentSessionId = payload.session_id ?? null;

        logger.info(
          {
            userId: currentUserId,
            username: currentUsername,
            sessionId: currentSessionId,
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

        ws.send(
          JSON.stringify(
            buildAuthOk(msg.seq, payload.user_id, payload.username)
          )
        );
      }

      function handlePing(msg: ClientPingMessage, ws: WebSocket): void {
        if (authenticated) {
          connectionManager.refreshHeartbeat(ws);
        }
        ws.send(JSON.stringify(buildPong(msg.seq)));
      }

      async function handleSendMessage(msg: ClientSendMessage): Promise<void> {
        if (!currentUserId) return;

        logger.info(
          { from: currentUserId, to: msg.payload.peer_id },
          "Forwarding message to message-service"
        );

        try {
          const result = await messageClient.sendMessage({
            from_peer: { type: 1, id: currentUserId },
            to_peer: { type: msg.payload.peer_type, id: msg.payload.peer_id },
            msg_type: msg.payload.msg_type ?? 0,
            text: msg.payload.text,
            reply_to_msg_id: msg.payload.reply_to_msg_id,
          });

          // proto3 omits error_code=0 from JSON, so it may be undefined
          if (result.error_code && result.error_code !== 0) {
            socket.send(
              JSON.stringify(
                buildRpcResult(msg.seq, result.error_code, result.error_message || '', null)
              )
            );
            return;
          }

          // 回确认给发送者 (消息已存储, message_id 已生成)
          const confirmMsg = buildRpcResult(msg.seq, 0, "", {
            message_id: result.message?.message_id,
            status: "sent",
          });
          logger.info({ seq: msg.seq, msgId: result.message?.message_id }, "Sending rpc_result confirmation");
          socket.send(JSON.stringify(confirmMsg));
        } catch (err) {
          logger.error({ err }, "Failed to send message via message-service");
          socket.send(
            JSON.stringify(
              buildRpcResult(msg.seq, 5001, "Failed to send message", null)
            )
          );
        }
      }

      function handleRoomSignal(msg: ClientRoomSignal): void {
        if (!authenticated) return;
        const { action, room_id, invite_user_ids, webrtc } = msg.payload;
        const uid = String(currentUserId!);
        const uname = currentUsername;

        if (action === "create") {
          const rid = roomManager.createRoom(uid, uname);
          socket.send(JSON.stringify(buildRoomSignal({ action: "created", room_id: rid, participants: [{ userId: uid, username: uname }] })));
          logger.info({ roomId: rid, userId: uid }, "Room created");
        } else if (action === "join") {
          const others = roomManager.joinRoom(room_id!, uid, uname);
          if (!others) { socket.send(JSON.stringify(buildError(msg.seq, 1202, "Room not found"))); return; }
          // 通知房间内其他人: 新成员加入
          const room = roomManager.getRoom(room_id!);
          for (const p of others) {
            const ws = connectionManager.getByUserId(p.userId);
            if (ws) ws.send(JSON.stringify(buildRoomSignal({ action: "user_joined", room_id, from_user_id: uid, from_username: uname, participants: room?.participants })));
          }
          // 告知加入者完整列表
          socket.send(JSON.stringify(buildRoomSignal({ action: "joined", room_id, participants: room?.participants || [] })));
        } else if (action === "leave") {
          const result = roomManager.leaveRoom(uid);
          if (!result) return;
          if (result.remaining.length === 0) return;
          const room = roomManager.getRoom(result.roomId);
          for (const p of result.remaining) {
            const ws = connectionManager.getByUserId(p.userId);
            if (ws) ws.send(JSON.stringify(buildRoomSignal({ action: "user_left", room_id: result.roomId, from_user_id: uid, from_username: uname, participants: room?.participants })));
          }
        } else if (action === "invite") {
          if (!invite_user_ids) return;
          const room = roomManager.getUserRoom(uid);
          if (!room) { socket.send(JSON.stringify(buildError(msg.seq, 1202, "You are not in a room"))); return; }
          for (const targetId of invite_user_ids) {
            const ws = connectionManager.getByUserId(String(targetId));
            if (ws) ws.send(JSON.stringify(buildRoomSignal({ action: "invited", room_id: room.roomId, from_user_id: uid, from_username: uname })));
          }
        } else if (action === "webrtc" && webrtc) {
          // Mesh 模式: 转发 WebRTC 信令到房间内所有其他人
          const room = roomManager.getUserRoom(uid);
          if (!room) return;
          for (const p of room.participants) {
            if (p.userId === uid) continue;
            const ws = connectionManager.getByUserId(p.userId);
            if (ws) ws.send(JSON.stringify(buildRoomSignal({ action: "webrtc", from_user_id: uid, from_username: uname, webrtc: { ...webrtc, from_user_id: uid, from_username: uname } })));
          }
        }
      }

      function handleCallSignal(msg: ClientCallSignal): void {
        if (!authenticated) return;
        const { signal_type, to_user_id, data } = msg.payload;
        const targetWs = connectionManager.getByUserId(String(to_user_id));
        if (!targetWs) {
          socket.send(JSON.stringify(buildError(msg.seq, 1101, "User not online")));
          return;
        }
        // 转发信令给目标用户
        const forward = buildCallSignal(signal_type, currentUserId!, currentUsername, data);
        targetWs.send(JSON.stringify(forward));
        logger.info({ signal_type, from: currentUserId, to: to_user_id }, "Call signal relayed");
      }

      function handleTyping(msg: ClientTypingMessage): void {
        // Phase 2: 转发 typing 指示到 message-service
        logger.debug(
          { from: currentUserId, to: msg.payload.peer_id },
          "Typing indicator (Phase 2)"
        );
      }

      function handleReadReceipt(msg: ClientReadReceiptMessage): void {
        // Phase 2: 转发已读回执到 message-service
        logger.debug(
          { from: currentUserId, to: msg.payload.peer_id },
          "Read receipt (Phase 2)"
        );
      }

      async function handleRpc(
        msg: ClientRpcMessage,
        ws: WebSocket
      ): Promise<void> {
        // 通用 RPC 代理: 客户端通过 WS 调用 C++ 服务
        // 网关做鉴权注入后转发

        logger.debug(
          { service: msg.payload.service, method: msg.payload.method },
          "WS RPC proxy"
        );

        try {
          // 根据服务名路由到对应客户端
          let result: unknown;

          if (msg.payload.service === "nova.user.UserService") {
            result = await proxyUserService(
              msg.payload.method,
              msg.payload.body,
              currentUserId!
            );
          } else {
            ws.send(
              JSON.stringify(
                buildRpcResult(
                  msg.seq,
                  5002,
                  `Unknown service: ${msg.payload.service}`,
                  null
                )
              )
            );
            return;
          }

          ws.send(
            JSON.stringify(buildRpcResult(msg.seq, 0, "", result))
          );
        } catch (err) {
          logger.error(
            { err, service: msg.payload.service, method: msg.payload.method },
            "RPC proxy failed"
          );
          ws.send(
            JSON.stringify(
              buildRpcResult(
                msg.seq,
                5001,
                err instanceof Error ? err.message : "RPC call failed",
                null
              )
            )
          );
        }
      }
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
  app.setErrorHandler((error, _request, reply) => {
    logger.error({ err: error }, "Unhandled error");
    reply.status(500).send({
      error_code: 5001,
      error_message: isDev ? error.message : "Internal server error",
    });
  });

  return app;
}

// =============================================================================
// RPC 代理辅助
// =============================================================================

/**
 * 将 WebSocket RPC 调用转发给 C++ user-service
 */
async function proxyUserService(
  method: string,
  body: Record<string, unknown>,
  userId: number
): Promise<unknown> {
  // 注入 user_id (网关已验证身份)
  const bodyWithUser = { ...body, user_id: userId };

  switch (method) {
    case "GetUserProfile":
      return userClient.getUserProfile(bodyWithUser as any);
    case "GetUsers":
      return userClient.getUsers(bodyWithUser as any);
    case "UpdateProfile":
      return userClient.updateProfile(userId, body as any);
    case "ChangeUsername":
      return userClient.changeUsername(userId, (body as any).new_username);
    case "CheckUsername":
      return userClient.checkUsername((body as any).username);
    case "SearchUsers":
      return userClient.searchUsers(bodyWithUser as any);
    case "ChangePassword":
      return userClient.changePassword(
        userId,
        (body as any).old_password,
        (body as any).new_password
      );
    default:
      throw new Error(`Unknown UserService method: ${method}`);
  }
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
