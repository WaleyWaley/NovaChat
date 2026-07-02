/**
 * 日志工具 — 封装 pino，统一日志格式
 *
 * Phase 3: 替换为向 C++ 双缓冲日志系统发送的桥接层
 */
import pino from "pino";
export declare const logger: pino.Logger<never, boolean>;
/**
 * 创建带有请求上下文的子 logger
 * 注入 requestId，方便追踪单次请求的全链路日志
 */
export declare function createRequestLogger(requestId: string): pino.Logger<never, boolean>;
//# sourceMappingURL=logger.d.ts.map