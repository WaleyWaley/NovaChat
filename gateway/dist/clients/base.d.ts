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
/** bRPC 标准响应：所有 C++ 服务统一返回此结构 */
export interface BrpcResponse<T = unknown> {
    error_code: number;
    error_message: string;
    data?: T;
}
/** HTTP 调用选项 */
export interface CallOptions {
    timeout?: number;
    headers?: Record<string, string>;
    /** 注入到请求体的 user_id (网关鉴权后注入) */
    injectUserId?: number;
}
export declare class BrpcClient {
    protected readonly baseUrl: string;
    protected readonly defaultTimeout: number;
    constructor(baseUrl: string, timeout?: number);
    /**
     * 通用 RPC 调用
     *
     * @param serviceName 完整的服务名，如 "nova.user.UserService"
     * @param methodName  方法名，如 "Register"
     * @param body        请求体 (JSON 对象)
     * @param opts        可选参数
     * @returns 响应 JSON
     */
    call<TReq extends object, TResp = unknown>(serviceName: string, methodName: string, body: TReq, opts?: CallOptions): Promise<TResp>;
}
export declare class BrpcCallError extends Error {
    readonly status: number;
    readonly url: string;
    constructor(status: number, message: string, url: string);
}
//# sourceMappingURL=base.d.ts.map