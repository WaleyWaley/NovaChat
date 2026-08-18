/**
 * PushService HTTP 端点 — C++ 服务反向推送的入口
 *
 * 调用方: C++ 核心服务 (message-service / user-service) 通过 bRPC HTTP Channel
 * 实现方: TS 网关 (本文件)
 *
 * Phase 2.3: IsUserOnline / BatchOnlineCheck 升级为全局在线查询
 *   - 先查本地 ConnectionManager
 *   - 本地不在线时查 Redis 在线路由表 (用户可能在另一个网关上)
 */

import type { FastifyInstance } from "fastify";
import { connectionManager } from "../ws/connection.js";
import { gatewayRedis } from "../redis/client.js";
import { logger } from "../utils/logger.js";
import { buildUpdate, buildKicked } from "../ws/protocol.js";

// ---- 请求/响应类型 (与 push.proto 对齐) ----

interface PushUpdateReq {
  target_user_id: string | number;
  update: {
    type: number;
    payload?: Record<string, unknown>;
  };
  skip_offline?: boolean;
  push_id?: number;
  ttl_seconds?: number;
}

interface PushUpdateResp {
  error_code: number;
  error_message: string;
  delivered: boolean;
  push_id: number;
}

interface PushToUsersReq {
  target_user_ids: (string | number)[];
  update: {
    type: number;
    payload?: Record<string, unknown>;
  };
  skip_offline?: boolean;
  push_id?: number;
  ttl_seconds?: number;
}

interface PushToUsersResp {
  error_code: number;
  error_message: string;
  delivered_user_ids: string[];
  missed_user_ids: string[];
  push_id: number;
}

interface KickUserReq {
  user_id: number;
  reason: number;
  message?: string;
}

interface KickUserResp {
  error_code: number;
  error_message: string;
  kicked: boolean;
}

interface IsUserOnlineReq {
  user_id: number;
}

interface IsUserOnlineResp {
  error_code: number;
  error_message: string;
  is_online: boolean;
  last_seen_at: number;
}

interface BatchOnlineCheckReq {
  user_ids: string[];
}

interface BatchOnlineCheckResp {
  error_code: number;
  error_message: string;
  online_user_ids: string[];
  offline_user_ids: string[];
}

interface NotifyGatewayReq {
  event: number;
  user_id?: number;
  payload?: string;
}

interface NotifyGatewayResp {
  error_code: number;
  error_message: string;
}

// ---- 路由注册 ----

const SERVICE_PATH = "/nova.gateway.PushService";

export async function pushRoutes(app: FastifyInstance): Promise<void> {
  // ===== PushUpdate — 单用户推送 =====
  app.post<{ Body: PushUpdateReq }>(
    `${SERVICE_PATH}/PushUpdate`,
    async (request) => {
      // bRPC json2pb 输出 camelCase, Fastify 解析后字段名是 camelCase
      const target_user_id = (request.body as any).target_user_id ?? (request.body as any).targetUserId;
      const { update, skip_offline, push_id } = request.body as any;

      // 幂等去重
      if (push_id && connectionManager.isDuplicatePush(push_id)) {
        logger.debug({ push_id }, "Duplicate push skipped");
        return {
          error_code: 0,
          error_message: "",
          delivered: true,
          push_id,
        } as PushUpdateResp;
      }

      // 跳过离线时的推送 (如 typing 指示)
      if (skip_offline && !connectionManager.isOnline(String(target_user_id))) {
        return {
          error_code: 0,
          error_message: "",
          delivered: false,
          push_id: push_id ?? 0,
        } as PushUpdateResp;
      }

      const { type: _t, ...data } = update as Record<string, unknown>;
      const serverMsg = buildUpdate((update as any).type || 0, data);
      // 先获取所有在线用户, 再检查目标是否在其中
      const onlineIds = connectionManager.getOnlineUserIds();
      const isOnline = connectionManager.isOnline(String(target_user_id));
      logger.info({ target: target_user_id, isOnline, onlineCount: onlineIds.length, targetInList: onlineIds.includes(String(target_user_id)) }, "PushUpdate");
      let delivered = connectionManager.sendToUser(String(target_user_id), serverMsg);

      // 推送失败时重试一次 (用户可能正在重连)
      if (!delivered) {
        setTimeout(() => {
          const retryOk = connectionManager.sendToUser(String(target_user_id), serverMsg);
          logger.info({ target: target_user_id, retryOk }, "PushUpdate retry result");
        }, 1500);
      }

      return {
        error_code: 0,
        error_message: "",
        delivered,
        push_id: push_id ?? 0,
      } as PushUpdateResp;
    }
  );

  // ===== PushToUsers — 批量推送 =====
  app.post<{ Body: PushToUsersReq }>(
    `${SERVICE_PATH}/PushToUsers`,
    async (request) => {
      const target_user_ids = (request.body as any).target_user_ids ?? (request.body as any).targetUserIds;
      const { update, push_id } = request.body as any;

      if (push_id && connectionManager.isDuplicatePush(push_id)) {
        return {
          error_code: 0,
          error_message: "",
          delivered_user_ids: target_user_ids,
          missed_user_ids: [],
          push_id,
        } as PushToUsersResp;
      }

      const { type: _t, ...data } = update as Record<string, unknown>;
      const serverMsg = buildUpdate((update as any).type || 0, data);
      const [delivered, missed] = connectionManager.sendToUsers(
        target_user_ids,
        serverMsg
      );

      return {
        error_code: 0,
        error_message: "",
        delivered_user_ids: delivered,
        missed_user_ids: missed,
        push_id: push_id ?? 0,
      } as PushToUsersResp;
    }
  );

  // ===== KickUser — 强制断连 =====
  app.post<{ Body: KickUserReq }>(
    `${SERVICE_PATH}/KickUser`,
    async (request) => {
      const { user_id, reason, message } = request.body;

      const msg = message ?? getDefaultKickMessage(reason);
      const kicked = connectionManager.kickUser(user_id, reason, msg);

      // 同步删除 Redis 在线状态
      if (kicked) {
        gatewayRedis.setUserOffline(user_id as any).catch((err) =>
          logger.error({ err, userId: user_id }, "Failed to sync offline to Redis")
        );
      }

      return {
        error_code: 0,
        error_message: "",
        kicked,
      } as KickUserResp;
    }
  );

  // ===== IsUserOnline — 全局在线探测 (Phase 2.3 升级) =====
  app.post<{ Body: IsUserOnlineReq }>(
    `${SERVICE_PATH}/IsUserOnline`,
    async (request) => {
      const { user_id } = request.body;

      // 1. 先查本地 ConnectionManager (最快)
      if (connectionManager.isOnline(user_id)) {
        return {
          error_code: 0,
          error_message: "",
          is_online: true,
          last_seen_at: Date.now(),
        } as IsUserOnlineResp;
      }

      // 2. 查询 Redis 在线路由表 (用户在另一个网关?)
      if (gatewayRedis.connected) {
        const entry = await gatewayRedis.isUserOnline(user_id);
        if (entry) {
          return {
            error_code: 0,
            error_message: "",
            is_online: true,
            last_seen_at: entry.last_heartbeat,
          } as IsUserOnlineResp;
        }
      }

      // 3. 不在线
      return {
        error_code: 0,
        error_message: "",
        is_online: false,
        last_seen_at: 0,
      } as IsUserOnlineResp;
    }
  );

  // ===== BatchOnlineCheck — 批量全局在线检查 (Phase 2.3 升级) =====
  app.post<{ Body: BatchOnlineCheckReq }>(
    `${SERVICE_PATH}/BatchOnlineCheck`,
    async (request) => {
      const { user_ids } = request.body;

      const online: string[] = [];
      const offline: string[] = [];
      const needRedisCheck: string[] = [];

      // 1. 先查本地
      for (const userId of user_ids) {
        if (connectionManager.isOnline(userId)) {
          online.push(String(userId));
        } else {
          needRedisCheck.push(userId);
        }
      }

      // 2. 本地不在线的，查 Redis
      if (needRedisCheck.length > 0 && gatewayRedis.connected) {
        const result = await gatewayRedis.batchCheckOnline(needRedisCheck as any);
        for (const [userId] of result.online) {
          online.push(String(userId));
        }
        for (const userId of needRedisCheck) {
          if (!online.includes(userId)) {
            offline.push(userId);
          }
        }
      } else {
        // Redis 不可用, 本地不在线就算离线
        for (const userId of needRedisCheck) {
          offline.push(userId);
        }
      }

      return {
        error_code: 0,
        error_message: "",
        online_user_ids: online,
        offline_user_ids: offline,
      } as BatchOnlineCheckResp;
    }
  );

  // ===== NotifyGateway — 事件通知 =====
  app.post<{ Body: NotifyGatewayReq }>(
    `${SERVICE_PATH}/NotifyGateway`,
    async (request) => {
      const { event, user_id } = request.body;

      logger.info({ event, user_id }, "Gateway notification received");

      // Phase 2.3: GATEWAY_USER_ONLINE / GATEWAY_USER_OFFLINE
      // 来自其他网关的上/下线广播 — 可选的跨网关缓存预热
      // 当前实现: 不缓存远程用户的在线状态, 每次通过 Redis 实时查询

      switch (event) {
        case 0: // GATEWAY_USER_ONLINE
          logger.debug({ user_id }, "Remote user online (from another gateway)");
          break;
        case 1: // GATEWAY_USER_OFFLINE
          logger.debug({ user_id }, "Remote user offline (from another gateway)");
          break;
        case 2: // GATEWAY_CONFIG_RELOAD
          logger.info("Config reload notification received");
          break;
        case 3: // GATEWAY_CLEAR_SESSION
          logger.info({ user_id }, "Session clear notification");
          break;
      }

      return {
        error_code: 0,
        error_message: "",
      } as NotifyGatewayResp;
    }
  );
}

// ---- 辅助 ----

function getDefaultKickMessage(reason: number): string {
  const messages: Record<number, string> = {
    0: "Session expired",
    1: "Account deleted",
    2: "Logged in from another device",
    3: "Server maintenance",
    4: "Account banned",
    5: "Kicked by admin",
  };
  return messages[reason] ?? "Disconnected";
}
