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
  injectUserId?: string | number;
}

/**
 * int64 安全的 JSON 解析。
 *
 * 雪花 ID 是 59 位整数, 超出 JS Number 安全精度 (2^53 ≈ 9e15, 16 位)。
 * JSON.parse 的 reviver 拿到的是已舍入的数字, 救不回来 —— 必须在解析前
 * 把原始文本中 16 位以上的整数字面量加上引号, 让它们按 string 解析。
 *
 * 正则说明:
 *   (?<=[:\[,]\s*) 前面必须是 JSON 结构符 (冒号/方括号/逗号),
 *                  已带引号的字符串值 (如纯数字用户名 "1234567890123456")
 *                  前面是引号, 不会被误伤
 *   (\d{16,})      16 位以上整数 (时间戳只有 13 位, 不受影响)
 *   (?=\s*[,\]\}]) 后面必须是 JSON 结构符
 */
export function parseBrpcJson(text: string): unknown {
  const quoted = text.replace(/(?<=[:\[,]\s*)(\d{16,})(?=\s*[,\]\}])/g, '"$1"');
  return JSON.parse(quoted);
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

      const data = parseBrpcJson(await response.text()) as TResp;
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
