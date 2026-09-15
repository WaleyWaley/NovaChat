/**
 * WS 通用 RPC 代理 — 从 main.ts 拆出
 *
 * 客户端通过 WS 调用 C++ 服务的任意 RPC, 网关做鉴权注入后转发。
 * 当前只支持 nova.user.UserService (proxyUserService)。
 */

import { userClient } from "../../clients/user_client.js";
import { logger } from "../../utils/logger.js";
import { buildRpcResult, type ClientRpcMessage } from "../protocol.js";
import type { ClientSession } from "../client_session.js";

export async function handleRpc(
  session: ClientSession,
  msg: ClientRpcMessage
): Promise<void> {
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
        session.userId!
      );
    } else {
      session.send(
        buildRpcResult(
          msg.seq,
          5002,
          `Unknown service: ${msg.payload.service}`,
          null
        )
      );
      return;
    }

    session.send(buildRpcResult(msg.seq, 0, "", result));
  } catch (err) {
    logger.error(
      { err, service: msg.payload.service, method: msg.payload.method },
      "RPC proxy failed"
    );
    session.send(
      buildRpcResult(
        msg.seq,
        5001,
        err instanceof Error ? err.message : "RPC call failed",
        null
      )
    );
  }
}

/**
 * 将 WebSocket RPC 调用转发给 C++ user-service
 */
async function proxyUserService(
  method: string,
  body: Record<string, unknown>,
  userId: string | number
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
