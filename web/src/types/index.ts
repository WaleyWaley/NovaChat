/**
 * NovaChat Web — 领域类型 + WS 线协议类型
 * 线协议逐字对应旧 api.js / 网关协议, 不可改动字段名。
 */

// ===== 领域类型 =====

export interface Me {
  user_id: string | number; // 网关 int64 安全解析后为 string
  username: string;
  first_name: string;
  access_token: string;
  refresh_token?: string;
  avatar_photo_id?: string; // Phase 4.3: 头像文件名 (空串 = 无头像)
}

export type MessageStatus = 'sending' | 'sent' | 'received'; // 'received' 渲染为 ✓✓

export interface Message {
  message_id: string; // 真实 id, 或发送中的 'temp_<seq>'
  from_peer: { id: string };
  text: string;
  created_at: number; // ms epoch
  is_me: boolean;
  status?: MessageStatus;
}

export interface Chat {
  peerId: string;
  peerName: string;
  messages: Message[];
  unread: number;
}

export interface SearchUser {
  user_id: string | number;
  username: string;
  first_name?: string;
}

export interface RoomParticipant {
  userId: number;
  username: string;
}

// ===== WS 出站协议 (对应 api.js) =====

export interface OutboundMsg {
  type: string;
  seq: number;
  payload?: unknown; // ping 等心跳消息无 payload
}

export interface SendMsgPayload {
  peer_type: 1; // USER
  peer_id: string | number;
  msg_type: 0; // TEXT
  text: string;
  // 幂等键 (客户端生成, 每条消息一个 UUID): 服务端据此去重, 重试同一消息时复用同一 key
  idempotency_key?: string;
}

export interface ReadReceiptPayload {
  peer_type: 1; // USER
  peer_id: string | number; // 网关忽略此值, 以鉴权用户为准
  max_read_msg_id: string; // 64 位雪花 ID 用 string 传, 防 JS Number 精度丢失
}

export interface CallSignalPayload {
  signal_type: string; // call_start | call_answer_accept | answer | ice_candidate | call_end
  to_user_id: string | number;
  data: unknown;
}

export interface RoomWebrtcSignal {
  signal_type: 'offer' | 'answer' | 'ice_candidate';
  to_user_id: string;
  data: unknown;
}

export interface RoomSignalPayload {
  action: string; // create | join | leave | invite | webrtc
  room_id?: string;
  invite_user_ids?: number[];
  webrtc?: RoomWebrtcSignal;
}

// ===== WS 入站事件 (WsManager 归一化后发出, 对应 api.js _handleMessage) =====

export type WsEvent =
  | { kind: 'auth_ok'; payload: Record<string, unknown> }
  | { kind: 'pong' }
  | { kind: 'update'; updateType?: string | number; data?: unknown }
  | { kind: 'rpc_result'; seq: number; data: { message_id?: string | number } }
  | {
      kind: 'call_signal';
      payload: {
        signal_type: string;
        from_user_id: number;
        from_username?: string;
        data?: unknown;
      };
    }
  | {
      kind: 'room_signal';
      payload: {
        action: string;
        room_id?: string;
        from_user_id?: number;
        from_username?: string;
        participants?: RoomParticipant[];
        webrtc?: RoomWebrtcSignal & { from_user_id: number };
      };
    }
  | { kind: 'error'; payload: unknown }
  | { kind: 'kicked'; payload: unknown };

/** update 事件里 new message 的归一化形状 (对应 app.js receiveMessage 的容错读取) */
export interface IncomingMessageInner {
  text: string;
  fromPeer?: { id?: string | number };
  from_peer?: { id?: string | number };
  messageId?: string | number;
  message_id?: string | number;
  newMessage?: IncomingMessageInner;
  new_message?: IncomingMessageInner;
}
