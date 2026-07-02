/**
 * WebSocket 消息协议定义
 *
 * 客户端 ↔ 网关之间通过单一 WebSocket 通道通信，使用 JSON 消息。
 * 消息格式参考 Telegram MTProto 的 Update 模型 —— 所有服务端事件统一为一个通道下发。
 *
 * 设计原则:
 *   - 每个消息有唯一的 `seq` (客户端生成，用于请求-响应匹配和去重)
 *   - `type` 决定 `payload` 的结构
 *   - 网关只做路由和推送，不解析业务 payload (透传给 C++ 服务)
 */

// =============================================================================
// 客户端 → 网关 (ClientMessage)
// =============================================================================

export type ClientMessage =
  | ClientAuthMessage    // 认证 (login token)
  | ClientSendMessage    // 发送消息
  | ClientPingMessage    // 心跳
  | ClientTypingMessage  // 输入中指示
  | ClientReadReceiptMessage // 已读回执
  | ClientRpcMessage;    // 通用 RPC 代理 (网关转发到 C++ 服务)

/** 认证: 客户端发 token 登录 */
export interface ClientAuthMessage {
  type: "auth";
  seq: number;
  payload: {
    access_token: string;
    device_name?: string;
    device_type?: string; // android | ios | desktop | web
  };
}

/** 发送消息: 客户端发消息给对端 */
export interface ClientSendMessage {
  type: "send_msg";
  seq: number;
  payload: {
    peer_type: number;  // PeerType: 1=user, 2=chat, 3=channel
    peer_id: number;
    msg_type: number;   // MessageType
    text?: string;
    reply_to_msg_id?: number;
    // Phase 3+: media, entities, etc.
  };
}

/** 心跳: keepalive */
export interface ClientPingMessage {
  type: "ping";
  seq: number;
}

/** 输入中指示 */
export interface ClientTypingMessage {
  type: "typing";
  seq: number;
  payload: {
    peer_type: number;
    peer_id: number;
    is_typing: boolean;
  };
}

/** 已读回执 */
export interface ClientReadReceiptMessage {
  type: "read";
  seq: number;
  payload: {
    peer_type: number;
    peer_id: number;
    max_read_msg_id: number;
  };
}

/** 通用 RPC 代理: 客户端通过网关调用 C++ 服务的任意 RPC */
export interface ClientRpcMessage {
  type: "rpc";
  seq: number;
  payload: {
    service: string;  // e.g. "nova.user.UserService"
    method: string;   // e.g. "GetUserProfile"
    body: Record<string, unknown>;
  };
}

// =============================================================================
// 网关 → 客户端 (ServerMessage)
// =============================================================================

export type ServerMessage =
  | ServerAuthOkMessage      // 认证成功
  | ServerErrorMessage       // 错误
  | ServerUpdateMessage      // 新消息/状态更新 (核心推送)
  | ServerPongMessage        // 心跳响应
  | ServerKickedMessage      // 被踢下线
  | ServerRpcResultMessage;  // RPC 代理响应

export interface ServerAuthOkMessage {
  type: "auth_ok";
  seq: number;  // 对应客户端的 auth 请求 seq
  payload: {
    user_id: number;
    username: string;
  };
}

export interface ServerErrorMessage {
  type: "error";
  seq: number;
  payload: {
    code: number;       // ErrorCode
    message: string;    // 人类可读的错误描述
  };
}

/** 核心推送: 新消息、状态变更、输入指示等 */
export interface ServerUpdateMessage {
  type: "update";
  // 注意: update 没有 seq，因为它是服务端主动推送，不回应客户端的某个请求
  payload: {
    update_type: number;      // UpdateType: 0=NEW_MESSAGE, 4=USER_STATUS, 5=TYPING, etc.
    data: Record<string, unknown>; // 具体 Update 内容 (透传给客户端)
  };
}

export interface ServerPongMessage {
  type: "pong";
  seq: number;
}

export interface ServerKickedMessage {
  type: "kicked";
  payload: {
    reason: number;   // KickReason
    message: string;
  };
}

export interface ServerRpcResultMessage {
  type: "rpc_result";
  seq: number;
  payload: {
    error_code: number;
    error_message: string;
    data: unknown;
  };
}

// =============================================================================
// 类型守卫
// =============================================================================

export function isClientMessage(msg: unknown): msg is ClientMessage {
  if (typeof msg !== "object" || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return typeof m.type === "string" && typeof m.seq === "number";
}

export function getMessageType(msg: unknown): string | null {
  if (typeof msg !== "object" || msg === null) return null;
  return typeof (msg as Record<string, unknown>).type === "string"
    ? (msg as Record<string, unknown>).type as string
    : null;
}

// =============================================================================
// 消息构造器 (网关内部使用)
// =============================================================================

export function buildAuthOk(seq: number, user_id: number, username: string): ServerAuthOkMessage {
  return { type: "auth_ok", seq, payload: { user_id, username } };
}

export function buildError(seq: number, code: number, message: string): ServerErrorMessage {
  return { type: "error", seq, payload: { code, message } };
}

export function buildUpdate(update_type: number, data: Record<string, unknown>): ServerUpdateMessage {
  return { type: "update", payload: { update_type, data } };
}

export function buildPong(seq: number): ServerPongMessage {
  return { type: "pong", seq };
}

export function buildKicked(reason: number, message: string): ServerKickedMessage {
  return { type: "kicked", payload: { reason, message } };
}

export function buildRpcResult(
  seq: number,
  error_code: number,
  error_message: string,
  data: unknown
): ServerRpcResultMessage {
  return { type: "rpc_result", seq, payload: { error_code, error_message, data } };
}
