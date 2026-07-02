/**
 * 日志工具 — 封装 pino，统一日志格式
 *
 * Phase 3: 替换为向 C++ 双缓冲日志系统发送的桥接层
 */

import pino from "pino";
import { config, isDev } from "../config/index.js";

export const logger = pino({
  level: isDev ? "debug" : "info",
  // 开发环境使用 pino-pretty 美化输出
  transport: isDev
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss.l",
          ignore: "pid,hostname",
        },
      }
    : undefined,
  base: {
    worker_id: config.WORKER_ID,
    env: config.NODE_ENV,
  },
});

/**
 * 创建带有请求上下文的子 logger
 * 注入 requestId，方便追踪单次请求的全链路日志
 */
export function createRequestLogger(requestId: string) {
  return logger.child({ requestId });
}
