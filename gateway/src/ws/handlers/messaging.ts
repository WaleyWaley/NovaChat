/**
 * WS 消息类 handler — 从 main.ts 拆出
 *
 * handleSendMessage: 转发到 message-service, 回 rpc_result 确认 (message_id)
 * handleReadReceipt: 转发已读回执到 message-service 的 AckMessage RPC
 * handleTyping:      网关直投 USER_TYPING update (skipOffline, 瞬时信号不排队)
 */

import { messageClient } from "../../clients/message_client.js";
import { logger } from "../../utils/logger.js";
import { deliverUpdateToUser } from "../push_delivery.js";
import {
  buildRpcResult,
  type ClientReadReceiptMessage,
  type ClientSendMessage,
  type ClientTypingMessage,
} from "../protocol.js";
import type { ClientSession } from "../client_session.js";

export async function handleSendMessage(
  session: ClientSession,
  msg: ClientSendMessage
): Promise<void> {
    // 检查 session 已登录，同理用session.userId作为发送者ID，不信任客户端传的from_peer
  if (!session.userId) return;

  logger.info(
    { from: session.userId, to: msg.payload.peer_id },
    "Forwarding message to message-service"
  );

  try {
    const result = await messageClient.sendMessage({
      from_peer: { type: 1, id: session.userId },
      to_peer: { type: msg.payload.peer_type, id: msg.payload.peer_id },
      msg_type: msg.payload.msg_type ?? 0,
      text: msg.payload.text,
      reply_to_msg_id: msg.payload.reply_to_msg_id,
      idempotency_key: msg.payload.idempotency_key,
    });

      // proto3 omits error_code=0 from JSON, so it may be undefined
    // 如果后端返回错误，就直接回给客户端一个 rpc_result 错误响应，而不是抛异常
    if (result.error_code && result.error_code !== 0) {
      session.send(
        buildRpcResult(msg.seq, result.error_code, result.error_message || "", null)
      );
      return;
    }

    // 回确认给发送者 (消息已存储, message_id 已生成)，带上生成的message_id和状态
    const confirmMsg = buildRpcResult(msg.seq, 0, "", {
      message_id: result.message?.message_id,
      status: "sent",
    });
    logger.info({ seq: msg.seq, msgId: result.message?.message_id }, "Sending rpc_result confirmation");
    session.send(confirmMsg);
  } catch (err) {
    logger.error({ err }, "Failed to send message via message-service");
    session.send(
      buildRpcResult(msg.seq, 5001, "Failed to send message", null)
    );
  }
}

export async function handleReadReceipt(
  session: ClientSession,
  msg: ClientReadReceiptMessage
): Promise<void> {
  // Phase 4: 转发已读回执到 message-service 的 AckMessage RPC
  if (!session.userId) return;

  const max_ack_msg_id = msg.payload.max_read_msg_id;
  // 校验用数值转换, 但转发原值 (string 防雪花 ID 精度丢失)
  if (!max_ack_msg_id || !Number.isFinite(Number(max_ack_msg_id)) ||
      Number(max_ack_msg_id) <= 0) {
    return;   // 无效回执, 静默丢弃
  }

  logger.debug(
    { user: session.userId, max_read_msg_id: max_ack_msg_id },
    "Forwarding read receipt to message-service"
  );

  try {
    // 服务端消息模型以"接收方自己"为对话键 (to_peer_id = 接收者用户 ID),
    // 所以 peer.id 用鉴权注入的 userId, 不信任客户端传的 peer_id
    const result = await messageClient.ackMessage({
      user_id: session.userId,
      peer: { type: msg.payload.peer_type || 1, id: session.userId },
      max_ack_msg_id: max_ack_msg_id,
      status: 3,   // MESSAGE_STATUS_READ
    });

    // proto3 omits error_code=0 from JSON, so it may be undefined
    if (result.error_code && result.error_code !== 0) {
      session.send(
        buildRpcResult(msg.seq, result.error_code, result.error_message || "", null)
      );
      return;
    }

    session.send(
      buildRpcResult(msg.seq, 0, "", { max_ack_msg_id })
    );
  } catch (err) {
    logger.error({ err }, "Failed to forward read receipt to message-service");
    session.send(
      buildRpcResult(msg.seq, 5001, "Failed to ack message", null)
    );
  }
}

/**
 * 输入中指示 — 网关直投 (全仓库无 Typing RPC, push.proto 的 skip_offline
 * 注释明确此信号走 PushUpdate 通道)。typing 是高频瞬时信号: 对方离线即丢
 * (skipOffline), 不做任何排队; 跨网关可达性由统一投递管线免费获得。
 */
export function handleTyping(session: ClientSession, msg: ClientTypingMessage): void {
  if (!session.userId) return;

  const { peer_type, peer_id, is_typing } = msg.payload;
  logger.debug(
    { from: session.userId, to: peer_id, is_typing },
    "Typing indicator"
  );

  void deliverUpdateToUser(
    peer_id,
    5, // UpdateType: UPDATE_USER_TYPING (common.proto)
    {
      from_peer: { type: 1, id: session.userId },
      to_peer: { type: peer_type, id: peer_id },
      is_typing,
    },
    { skipOffline: true }
  );
}


// 调用链路：
// 客户端发送 WS: { type: "send_msg", seq: 1, payload: {...} }
//         ↓
// main.ts 解析并分发到 handleSendMessage(session, msg)
//         ↓
// 构造 SendMessageReq:
//   from_peer.id = session.userId
//   to_peer.id = msg.payload.peer_id
//         ↓
// messageClient.sendMessage(req)
//         ↓
// MessageClient.call("SendMessage", req)
//         ↓
// BrpcClient.call("nova.message.MessageService", "SendMessage", req)
//         ↓
// HTTP POST http://message-service:8002/nova.message.MessageService/SendMessage
//         ↓
// C++ message-service 存储消息
//         ↓
// 返回 SendMessageResp
//         ↓
// 网关回 WS: { type: "rpc_result", seq: 1, result: { message_id, status: "sent" } }