/**
 * MessageService HTTP 客户端 — 网关调用 C++ message-service
 *
 * 复用 BrpcClient (与 user_client 同模式): 统一超时 (5s)、错误分类 (408/503)、
 * 调用日志与 int64 精度安全解析。
 */

import { BrpcClient } from "./base.js";
import { getServiceUrl, getFullServiceName } from "./service_registry.js";
import { logger } from "../utils/logger.js";

// ---- 类型 (与 message.proto 对齐) ----

export interface SendMessageReq {
  // 1=用户，2=群组用户； 用户 ID 或群组 ID
  from_peer: { type: number; id: string | number }; // int64: base.ts 解析后为 string (精度安全)
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

export class MessageClient {
  private readonly client: BrpcClient;
  private readonly serviceName: string;

  constructor(messageServiceUrl?: string) {
    this.client = new BrpcClient(messageServiceUrl ?? getServiceUrl("message-service"));
    this.serviceName = getFullServiceName("message-service");
  }

  private call<TReq extends object, TResp>(method: string, body: TReq): Promise<TResp> {
    return this.client.call<TReq, TResp>(this.serviceName, method, body);
  }

  /** 发送消息 */
  async sendMessage(req: SendMessageReq): Promise<SendMessageResp> {
    logger.debug({ to: req.to_peer.id }, "Sending message via message-service");
    return this.call<SendMessageReq, SendMessageResp>("SendMessage", req);
  }

  /** 拉取消息历史 (Timeline) */
  async getMessages(req: GetMessagesReq): Promise<GetMessagesResp> {
    return this.call<GetMessagesReq, GetMessagesResp>("GetMessages", req);
  }

  /** 确认消息已读/送达 (Phase 4: 转发客户端 read 回执) */
  async ackMessage(req: AckMessageReq): Promise<AckMessageResp> {
    return this.call<AckMessageReq, AckMessageResp>("AckMessage", req);
  }

  /** 会话列表 (Phase 4.2: 客户端刷新后恢复) */
  async getDialogs(userId: string | number): Promise<GetDialogsResp> {
    return this.call<object, GetDialogsResp>("GetDialogs", { user_id: userId, limit: 100 });
  }

  /** 双向会话历史 (Phase 4.2) */
  async getConversation(req: GetConversationReq): Promise<GetConversationResp> {
    return this.call<GetConversationReq, GetConversationResp>("GetConversation", req);
  }
}

// 导出单例，网关全局使用同一个 MessageClient 实例
export const messageClient = new MessageClient();


// 复用模式结构
// messageClient.sendMessage(req)
//         ↓
// MessageClient.call("SendMessage", req)
//         ↓
// BrpcClient.call("nova.message.MessageService", "SendMessage", req)
//         ↓
// HTTP POST http://message-service:8002/nova.message.MessageService/SendMessage
//         ↓
// C++ message-service 处理
//         ↓
// 返回 JSON
//         ↓
// parseBrpcJson 解析
//         ↓
// 回到 messageClient