/**
 * MessageService HTTP 客户端 — 网关调用 C++ message-service
 *
 * 通过普通 HTTP POST 调用 bRPC 的 http+pb 端点。
 * 不需要引入 protobuf 库，直接发 JSON body。
 */

import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
import { parseBrpcJson } from "./base.js";

// ---- 类型 (与 message.proto 对齐) ----

export interface SendMessageReq {
  from_peer: { type: number; id: string | number };
  to_peer: { type: number; id: string | number };
  msg_type: number;
  text?: string;
  reply_to_msg_id?: string | number;
  is_silent?: boolean;
  idempotency_key?: string;
}

export interface SendMessageResp {
  error_code: number;
  error_message: string;
  message?: {
    message_id: string | number;
    from_peer: { type: string; id: string | number };
    to_peer: { type: string; id: string | number };
    type: string;
    text: string;
    created_at: number;
  };
}

export interface GetMessagesReq {
  peer: { type: number; id: string | number };
  limit?: number;
  offset_id?: string | number;
}

export interface GetMessagesResp {
  error_code: number;
  error_message: string;
  messages?: Array<{
    message_id: string | number;
    from_peer: { type: string; id: string | number };
    to_peer: { type: string; id: string | number };
    text: string;
    created_at: number;
  }>;
  has_more?: boolean;
  next_offset_id?: number;
}

export interface AckMessageReq {
  user_id: string | number;
  peer: { type: number; id: string | number };
  max_ack_msg_id: string | number; // int64: brpc JSON 接受 string, 原样透传防精度丢失
  status: number;   // MessageStatus: 2=DELIVERED, 3=READ
}

export interface AckMessageResp {
  error_code: number;
  error_message: string;
}

// ---- Phase 4.2: 历史恢复 ----

export interface DialogPeer {
  peer_type: number;
  peer_id: string | number;
  latest_msg_id: string | number;
}

export interface GetDialogsResp {
  error_code: number;
  error_message: string;
  dialogs?: DialogPeer[];
}

export interface GetConversationReq {
  user_id: string | number;
  peer_type: number;
  peer_id: string | number;
  limit?: number;
  offset_id?: string | number;
}

export interface GetConversationResp {
  error_code: number;
  error_message: string;
  messages?: Array<{
    message_id: string | number;
    from_peer: { type: string; id: string | number };
    to_peer: { type: string; id: string | number };
    type: string;
    text: string;
    status?: number;
    created_at: number;
  }>;
  has_more?: boolean;
  next_offset_id?: string | number;
}

// ---- Client ----

const SERVICE_URL = config.MESSAGE_SERVICE_URL;
const SERVICE_PATH = "/nova.message.MessageService";

async function callRpc<T>(method: string, body: unknown): Promise<T> {
  const url = `${SERVICE_URL}${SERVICE_PATH}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(`MessageService ${method} failed: HTTP ${response.status}`);
  }

  return parseBrpcJson(await response.text()) as T;
}

// ---- 公开方法 ----

export const messageClient = {
  /** 发送消息 */
  async sendMessage(req: SendMessageReq): Promise<SendMessageResp> {
    logger.debug({ to: req.to_peer.id }, "Sending message via message-service");
    return callRpc<SendMessageResp>("SendMessage", req);
  },

  /** 拉取消息历史 (Timeline) */
  async getMessages(req: GetMessagesReq): Promise<GetMessagesResp> {
    return callRpc<GetMessagesResp>("GetMessages", req);
  },

  /** 确认消息已读/送达 (Phase 4: 转发客户端 read 回执) */
  async ackMessage(req: AckMessageReq): Promise<AckMessageResp> {
    return callRpc<AckMessageResp>("AckMessage", req);
  },

  /** 会话列表 (Phase 4.2: 客户端刷新后恢复) */
  async getDialogs(userId: string | number): Promise<GetDialogsResp> {
    return callRpc<GetDialogsResp>("GetDialogs", { user_id: userId, limit: 100 });
  },

  /** 双向会话历史 (Phase 4.2) */
  async getConversation(req: GetConversationReq): Promise<GetConversationResp> {
    return callRpc<GetConversationResp>("GetConversation", req);
  },
};
