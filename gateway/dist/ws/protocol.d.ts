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
export type ClientMessage = ClientAuthMessage | ClientSendMessage | ClientPingMessage | ClientTypingMessage | ClientReadReceiptMessage | ClientRpcMessage;
/** 认证: 客户端发 token 登录 */
export interface ClientAuthMessage {
    type: "auth";
    seq: number;
    payload: {
        access_token: string;
        device_name?: string;
        device_type?: string;
    };
}
/** 发送消息: 客户端发消息给对端 */
export interface ClientSendMessage {
    type: "send_msg";
    seq: number;
    payload: {
        peer_type: number;
        peer_id: number;
        msg_type: number;
        text?: string;
        reply_to_msg_id?: number;
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
        service: string;
        method: string;
        body: Record<string, unknown>;
    };
}
export type ServerMessage = ServerAuthOkMessage | ServerErrorMessage | ServerUpdateMessage | ServerPongMessage | ServerKickedMessage | ServerRpcResultMessage;
export interface ServerAuthOkMessage {
    type: "auth_ok";
    seq: number;
    payload: {
        user_id: number;
        username: string;
    };
}
export interface ServerErrorMessage {
    type: "error";
    seq: number;
    payload: {
        code: number;
        message: string;
    };
}
/** 核心推送: 新消息、状态变更、输入指示等 */
export interface ServerUpdateMessage {
    type: "update";
    payload: {
        update_type: number;
        data: Record<string, unknown>;
    };
}
export interface ServerPongMessage {
    type: "pong";
    seq: number;
}
export interface ServerKickedMessage {
    type: "kicked";
    payload: {
        reason: number;
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
export declare function isClientMessage(msg: unknown): msg is ClientMessage;
export declare function getMessageType(msg: unknown): string | null;
export declare function buildAuthOk(seq: number, user_id: number, username: string): ServerAuthOkMessage;
export declare function buildError(seq: number, code: number, message: string): ServerErrorMessage;
export declare function buildUpdate(update_type: number, data: Record<string, unknown>): ServerUpdateMessage;
export declare function buildPong(seq: number): ServerPongMessage;
export declare function buildKicked(reason: number, message: string): ServerKickedMessage;
export declare function buildRpcResult(seq: number, error_code: number, error_message: string, data: unknown): ServerRpcResultMessage;
//# sourceMappingURL=protocol.d.ts.map