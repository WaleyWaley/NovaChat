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
// 类型守卫
// =============================================================================
export function isClientMessage(msg) {
    if (typeof msg !== "object" || msg === null)
        return false;
    const m = msg;
    return typeof m.type === "string" && typeof m.seq === "number";
}
export function getMessageType(msg) {
    if (typeof msg !== "object" || msg === null)
        return null;
    return typeof msg.type === "string"
        ? msg.type
        : null;
}
// =============================================================================
// 消息构造器 (网关内部使用)
// =============================================================================
export function buildAuthOk(seq, user_id, username) {
    return { type: "auth_ok", seq, payload: { user_id, username } };
}
export function buildError(seq, code, message) {
    return { type: "error", seq, payload: { code, message } };
}
export function buildUpdate(update_type, data) {
    return { type: "update", payload: { update_type, data } };
}
export function buildPong(seq) {
    return { type: "pong", seq };
}
export function buildKicked(reason, message) {
    return { type: "kicked", payload: { reason, message } };
}
export function buildRpcResult(seq, error_code, error_message, data) {
    return { type: "rpc_result", seq, payload: { error_code, error_message, data } };
}
//# sourceMappingURL=protocol.js.map