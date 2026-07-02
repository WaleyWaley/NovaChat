/**
 * PushService HTTP 端点 — C++ 服务反向推送的入口
 *
 * 调用方: C++ 核心服务 (message-service / user-service) 通过 bRPC HTTP Channel
 * 实现方: TS 网关 (本文件)
 *
 * 这些端点处于 JWT 白名单中，由 C++ 服务内部调用，不经过客户端鉴权。
 * 网关根据在线路由表查找目标用户的 WebSocket 连接并推送。
 */
import { connectionManager } from "../ws/connection.js";
import { logger } from "../utils/logger.js";
import { buildUpdate } from "../ws/protocol.js";
// ---- 路由注册 ----
const SERVICE_PATH = "/nova.gateway.PushService";
export async function pushRoutes(app) {
    // ===== PushUpdate — 单用户推送 =====
    app.post(`${SERVICE_PATH}/PushUpdate`, async (request) => {
        const { target_user_id, update, skip_offline, push_id } = request.body;
        // 幂等去重
        if (push_id && connectionManager.isDuplicatePush(push_id)) {
            logger.debug({ push_id }, "Duplicate push skipped");
            return {
                error_code: 0,
                error_message: "",
                delivered: true,
                push_id,
            };
        }
        // 跳过离线时的推送 (如 typing 指示)
        if (skip_offline && !connectionManager.isOnline(target_user_id)) {
            return {
                error_code: 0,
                error_message: "",
                delivered: false,
                push_id: push_id ?? 0,
            };
        }
        // 构造 ServerMessage 并推送
        const serverMsg = buildUpdate(update.type, update.payload ?? {});
        const delivered = connectionManager.sendToUser(target_user_id, serverMsg);
        return {
            error_code: 0,
            error_message: "",
            delivered,
            push_id: push_id ?? 0,
        };
    });
    // ===== PushToUsers — 批量推送 =====
    app.post(`${SERVICE_PATH}/PushToUsers`, async (request) => {
        const { target_user_ids, update, push_id } = request.body;
        // 幂等去重
        if (push_id && connectionManager.isDuplicatePush(push_id)) {
            return {
                error_code: 0,
                error_message: "",
                delivered_user_ids: target_user_ids,
                missed_user_ids: [],
                push_id,
            };
        }
        const serverMsg = buildUpdate(update.type, update.payload ?? {});
        const [delivered, missed] = connectionManager.sendToUsers(target_user_ids, serverMsg);
        return {
            error_code: 0,
            error_message: "",
            delivered_user_ids: delivered,
            missed_user_ids: missed,
            push_id: push_id ?? 0,
        };
    });
    // ===== KickUser — 强制断连 =====
    app.post(`${SERVICE_PATH}/KickUser`, async (request) => {
        const { user_id, reason, message } = request.body;
        const msg = message ?? getDefaultKickMessage(reason);
        const kicked = connectionManager.kickUser(user_id, reason, msg);
        return {
            error_code: 0,
            error_message: "",
            kicked,
        };
    });
    // ===== IsUserOnline — 在线探测 =====
    app.post(`${SERVICE_PATH}/IsUserOnline`, async (request) => {
        const { user_id } = request.body;
        const is_online = connectionManager.isOnline(user_id);
        return {
            error_code: 0,
            error_message: "",
            is_online,
            last_seen_at: 0, // Phase 2: 从 Redis 获取精确值
        };
    });
    // ===== BatchOnlineCheck — 批量在线检查 =====
    app.post(`${SERVICE_PATH}/BatchOnlineCheck`, async (request) => {
        const { user_ids } = request.body;
        const online = [];
        const offline = [];
        for (const userId of user_ids) {
            if (connectionManager.isOnline(userId)) {
                online.push(userId);
            }
            else {
                offline.push(userId);
            }
        }
        return {
            error_code: 0,
            error_message: "",
            online_user_ids: online,
            offline_user_ids: offline,
        };
    });
    // ===== NotifyGateway — 事件通知 (网关间 / 服务间) =====
    app.post(`${SERVICE_PATH}/NotifyGateway`, async (request) => {
        const { event, user_id } = request.body;
        logger.info({ event, user_id }, "Gateway notification received");
        // Phase 2: 根据事件类型执行不同逻辑
        //   GATEWAY_USER_ONLINE   → 来自其他网关的用户上线广播
        //   GATEWAY_USER_OFFLINE  → 用户下线
        //   GATEWAY_CONFIG_RELOAD → 重载配置
        //   GATEWAY_CLEAR_SESSION → 清除用户本地会话
        return {
            error_code: 0,
            error_message: "",
        };
    });
}
// ---- 辅助 ----
function getDefaultKickMessage(reason) {
    const messages = {
        0: "Session expired",
        1: "Account deleted",
        2: "Logged in from another device",
        3: "Server maintenance",
        4: "Account banned",
        5: "Kicked by admin",
    };
    return messages[reason] ?? "Disconnected";
}
//# sourceMappingURL=push.js.map