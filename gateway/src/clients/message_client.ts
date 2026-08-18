/**
 * MessageService HTTP 客户端 — 网关调用 C++ message-service
 *
 * 通过普通 HTTP POST 调用 bRPC 的 http+pb 端点。
 * 不需要引入 protobuf 库，直接发 JSON body。
 */

import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

// ---- 类型 (与 message.proto 对齐) ----

export interface SendMessageReq {
  from_peer: { type: number; id: number };
  to_peer: { type: number; id: number };
  msg_type: number;
  text?: string;
  reply_to_msg_id?: number;
  is_silent?: boolean;
}

export interface SendMessageResp {
  error_code: number;
  error_message: string;
  message?: {
    message_id: number;
    from_peer: { type: string; id: number };
    to_peer: { type: string; id: number };
    type: string;
    text: string;
    created_at: number;
  };
}

export interface GetMessagesReq {
  peer: { type: number; id: number };
  limit?: number;
  offset_id?: number;
}

export interface GetMessagesResp {
  error_code: number;
  error_message: string;
  messages?: Array<{
    message_id: number;
    from_peer: { type: string; id: number };
    to_peer: { type: string; id: number };
    text: string;
    created_at: number;
  }>;
  has_more?: boolean;
  next_offset_id?: number;
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

  return (await response.json()) as T;
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
};
