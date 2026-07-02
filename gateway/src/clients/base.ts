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

// ---- 类型 ----

/** bRPC 标准响应：所有 C++ 服务统一返回此结构 */
export interface BrpcResponse<T = unknown> {
  error_code: number;    // 0 = OK
  error_message: string;
  data?: T;              // 具体业务数据 (展开到顶层)
}

/** HTTP 调用选项 */
export interface CallOptions {
  timeout?: number;      // 超时 ms (默认 5000)
  headers?: Record<string, string>;
  /** 注入到请求体的 user_id (网关鉴权后注入) */
  injectUserId?: number;
}

// ---- BrpcClient ----

export class BrpcClient {
  protected readonly baseUrl: string;
  protected readonly defaultTimeout: number;

  constructor(baseUrl: string, timeout: number = 5000) {
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
  async call<TReq extends object, TResp = unknown>(
    serviceName: string,
    methodName: string,
    body: TReq,
    opts: CallOptions = {}
  ): Promise<TResp> {
    const url = `${this.baseUrl}/${serviceName}/${methodName}`;
    const timeout = opts.timeout ?? this.defaultTimeout;

    // 注入 user_id (网关注入，后端信任)
    if (opts.injectUserId !== undefined) {
      (body as Record<string, unknown>).user_id = opts.injectUserId;
    }

    const startTime = Date.now();

    logger.debug(
      { url, method: methodName },
      "bRPC call →"
    );

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
        logger.warn(
          { url, status: response.status, elapsed },
          "bRPC call failed"
        );
        throw new BrpcCallError(
          response.status,
          `bRPC call failed: ${response.status} ${response.statusText}`,
          url
        );
      }

      const data = (await response.json()) as TResp;
      logger.debug(
        { url, elapsed },
        "bRPC call ←"
      );
      return data;
    } catch (err) {
      if (err instanceof BrpcCallError) throw err;

      if (err instanceof DOMException && err.name === "AbortError") {
        logger.error({ url, timeout }, "bRPC call timeout");
        throw new BrpcCallError(408, `bRPC call timeout after ${timeout}ms`, url);
      }

      logger.error({ url, err }, "bRPC call error");
      throw new BrpcCallError(
        503,
        `bRPC call error: ${err instanceof Error ? err.message : String(err)}`,
        url
      );
    }
  }
}

// ---- 自定义错误 ----

export class BrpcCallError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly url: string
  ) {
    super(message);
    this.name = "BrpcCallError";
  }
}
