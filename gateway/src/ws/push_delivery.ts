/**
 * 统一推送投递管线 — PushService 路由与 WS typing 转发共用
 *
 * 投递顺序:
 *   1. 本地在线 → connectionManager 直投 (失败 1.5s 后重试一次)
 *   2. 本地不在线 → 查 Redis 全局路由表 user:online:<user_id> 定位目标网关
 *      - 查到且非本机 → HTTP 转发到目标网关 (带 no_forward 防环 + push_id 幂等)
 *      - 查不到 / Redis 不可用 → delivered:false (维持既有降级语义)
 *
 * 跨网关背景: message-service 不查 Redis, 推送硬编码到 gateway:3000
 * (services/message-service/server.cc:89), 因此本网关收到"目标在别的网关"的
 * 推送时必须代为转发 — 业界 WebSocket 集群的通用做法 (转发 + 一跳限)。
 */

import { connectionManager } from "./connection.js";
import { gatewayRedis } from "../redis/client.js";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { buildUpdate } from "./protocol.js";

const PUSH_SERVICE_PATH = "/nova.gateway.PushService";

export interface DeliverOpts {
  /** true 时目标离线即丢, 不做任何排队 (typing 等瞬时信号) */
  skipOffline?: boolean;
  /** true 表示本请求来自其他网关的转发 → 只投本地, 不再转发 (防环) */
  noForward?: boolean;
  /** C++ 生成的雪花幂等键, 转发时透传保证对端网关去重 */
  pushId?: string | number;
}

export interface DeliverResult {
  delivered: boolean;
  /** 是否转发给了其他网关 (日志/调试用) */
  forwarded?: boolean;
}

/**
 * 向单个用户投递一条 update (本地直投或跨网关转发)
 *
 * @param targetUserId 目标用户
 * @param updateType   UpdateType (common.proto: 0=NEW_MESSAGE, 5=USER_TYPING, ...)
 * @param data         update 的业务数据 (不透明透传, 形状由客户端协议决定)
 */
export async function deliverUpdateToUser(
  targetUserId: string | number,
  updateType: number,
  data: Record<string, unknown>,
  opts: DeliverOpts = {}
): Promise<DeliverResult> {
  const uid = String(targetUserId);
  const serverMsg = buildUpdate(updateType, data);

  // ---- 1. 本地投递 ----
  if (connectionManager.isOnline(uid)) {
    const delivered = connectionManager.sendToUser(uid, serverMsg);

    // 推送失败时重试一次 (用户可能正在重连)
    if (!delivered) {
      setTimeout(() => {
        const retryOk = connectionManager.sendToUser(uid, serverMsg);
        logger.info({ target: targetUserId, retryOk }, "PushUpdate retry result");
      }, 1500);
    }
    return { delivered };
  }

  // ---- 2. 本地不在线 ----
  // 防环: 转发来的请求只投本地 (目标网关收到时目标可能已离线, 属正常竞态)
  if (opts.noForward) return { delivered: false };

  // 降级: Redis 不可用时不做跨网关转发 (与 redis/client.ts 注释一致)
  if (!gatewayRedis.connected) return { delivered: false };

  const entry = await gatewayRedis.isUserOnline(uid);
  if (!entry || !entry.gateway_addr) {
    return { delivered: false }; // 全集群离线
  }
  if (entry.gateway_addr === config.GATEWAY_ADDR) {
    // 路由表指向本机但本地无连接 → 用户刚下线, 路由表未过期
    return { delivered: false };
  }

  // ---- 3. 转发到目标网关 (目标网关做本地投递 + skip_offline 复核) ----
  try {
    const response = await fetch(
      `http://${entry.gateway_addr}${PUSH_SERVICE_PATH}/PushUpdate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target_user_id: uid,
          update: { type: updateType, ...data },
          skip_offline: !!opts.skipOffline,
          push_id: opts.pushId,
          no_forward: true,
        }),
        signal: AbortSignal.timeout(3000),
      }
    );
    logger.info(
      { target: targetUserId, gateway: entry.gateway_addr, ok: response.ok },
      "PushUpdate forwarded to remote gateway"
    );
    return { delivered: response.ok, forwarded: true };
  } catch (err) {
    // 转发失败视为未送达 — C++ 侧有 push_id 幂等, 重试不会产生重复推送
    logger.warn(
      { err, target: targetUserId, gateway: entry.gateway_addr },
      "PushUpdate forward failed"
    );
    return { delivered: false, forwarded: true };
  }
}
