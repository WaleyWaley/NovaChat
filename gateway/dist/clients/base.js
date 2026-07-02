/**
 * bRPC HTTP 客户端基类
 *
 * 封装对 C++ bRPC 服务的 HTTP 调用。
 * bRPC 的 http+pb 模式让 C++ 服务直接接收 HTTP JSON Body，
 * 并自动反序列化为 Protobuf 对象 —— 网关只需发 fetch，无需引入 proto 库。
 *
 * 端点格式: {baseUrl}/{serviceName}/{methodName}
 *   例如: http://user-service:8001/nova.user.UserService/Register
 */
import { logger } from "../utils/logger.js";
// ---- BrpcClient ----
export class BrpcClient {
    baseUrl;
    defaultTimeout;
    constructor(baseUrl, timeout = 5000) {
        // 去掉尾部斜杠
        this.baseUrl = baseUrl.replace(/\/+$/, "");
        this.defaultTimeout = timeout;
    }
    /**
     * 通用 RPC 调用
     *
     * @param serviceName 完整的服务名，如 "nova.user.UserService"
     * @param methodName  方法名，如 "Register"
     * @param body        请求体 (JSON 对象)
     * @param opts        可选参数
     * @returns 响应 JSON
     */
    async call(serviceName, methodName, body, opts = {}) {
        const url = `${this.baseUrl}/${serviceName}/${methodName}`;
        const timeout = opts.timeout ?? this.defaultTimeout;
        // 注入 user_id (网关注入，后端信任)
        if (opts.injectUserId !== undefined) {
            body.user_id = opts.injectUserId;
        }
        const startTime = Date.now();
        logger.debug({ url, method: methodName }, "bRPC call →");
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);
            const response = await fetch(url, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    ...opts.headers,
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            clearTimeout(timeoutId);
            const elapsed = Date.now() - startTime;
            if (!response.ok) {
                logger.warn({ url, status: response.status, elapsed }, "bRPC call failed");
                throw new BrpcCallError(response.status, `bRPC call failed: ${response.status} ${response.statusText}`, url);
            }
            const data = (await response.json());
            logger.debug({ url, elapsed }, "bRPC call ←");
            return data;
        }
        catch (err) {
            if (err instanceof BrpcCallError)
                throw err;
            if (err instanceof DOMException && err.name === "AbortError") {
                logger.error({ url, timeout }, "bRPC call timeout");
                throw new BrpcCallError(408, `bRPC call timeout after ${timeout}ms`, url);
            }
            logger.error({ url, err }, "bRPC call error");
            throw new BrpcCallError(503, `bRPC call error: ${err instanceof Error ? err.message : String(err)}`, url);
        }
    }
}
// ---- 自定义错误 ----
export class BrpcCallError extends Error {
    status;
    url;
    constructor(status, message, url) {
        super(message);
        this.status = status;
        this.url = url;
        this.name = "BrpcCallError";
    }
}
//# sourceMappingURL=base.js.map