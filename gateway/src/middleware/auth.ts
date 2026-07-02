/**
 * JWT 鉴权中间件
 *
 * Phase 2.1: 三级白名单 + 差异化错误码 (过期/失效/无效) + sessionId 注入
 * Phase 1:   单级白名单 + 简单 401
 *
 * 白名单分级:
 *   NO_AUTH:         完全不需要认证 (register/login/health/PushService)
 *   REFRESH_TOKEN:   Token 刷新端点 — 不需要 access_token (在 body 传 refresh_token)
 *   PUBLIC:          公开端点 — 可选认证 (check-username)
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { verifyAccessToken } from "../auth/jwt.js";
import { logger } from "../utils/logger.js";

// ---- 扩展 Fastify Request 类型 ----

declare module "fastify" {
  interface FastifyRequest {
    /** 由 JWT 中间件注入的 user_id (未认证时为 undefined) */
    userId?: number;
    /** Phase 2.1: session_id (来自 JWT payload) */
    sessionId?: string;
  }
}

// ---- 三级白名单 ----

/** 完全不需要认证的路由 */
const NO_AUTH_ROUTES = [
  "/health",
  "/nova.gateway.PushService/", // C++ 服务内部调用
  "/api/auth/register",
  "/api/auth/login",
];

/** Token 刷新端点 — 在 body 中传 refresh_token, 不需要 Authorization header */
const REFRESH_TOKEN_ROUTES = [
  "/api/auth/refresh",
];

/** 公开端点 — 认证可选 (有 token 就注入 userId, 没有也不拒绝) */
const PUBLIC_ROUTES = [
  "/api/users/check-username/",
];

// ---- 辅助 ----

function matchesPrefix(url: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => url.startsWith(prefix));
}

// ---- 注册函数 ----

/**
 * 注册 JWT 鉴权钩子到 Fastify 实例
 *
 * 四级处理:
 *   Tier 1 — NO_AUTH:        直接放行
 *   Tier 2 — REFRESH_TOKEN:  直接放行 (handler 自行校验 refresh_token)
 *   Tier 3 — PUBLIC:         Bearer token 可选, 有则注入 userId/sessionId
 *   Tier 4 — PROTECTED:      必须提供有效 token, 否则 401
 *
 * 错误码:
 *   1002 AUTH_KEY_EXPIRED — Token 已过期
 *   1003 SESSION_EXPIRED   — Session 已被撤销 (登出/改密码)
 *   1004 TOKEN_INVALID     — 签名无效/格式错误/无密钥
 */
export function registerAuthHook(app: FastifyInstance): void {
  app.decorateRequest("userId", undefined);
  app.decorateRequest("sessionId", undefined);

  app.addHook(
    "preHandler",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const url = request.url;

      // → Tier 1: 完全不需要认证
      if (matchesPrefix(url, NO_AUTH_ROUTES)) {
        return;
      }

      // → Tier 2: Refresh token 端点 — 不放 access_token, handler 自行校验
      if (matchesPrefix(url, REFRESH_TOKEN_ROUTES)) {
        return;
      }

      // → Tier 3: 公开端点 — 可选认证
      if (matchesPrefix(url, PUBLIC_ROUTES)) {
        const userId = tryInjectUser(request);
        if (userId !== null) {
          logger.debug({ url, userId }, "Public route with optional auth");
        }
        return;
      }

      // → Tier 4: 受保护路由 — 必须认证
      const authHeader = request.headers.authorization;

      if (!authHeader || !authHeader.startsWith("Bearer ")) {
        logger.warn({ url, ip: request.ip }, "Missing Authorization header");
        return reply.status(401).send({
          error_code: 1004, // TOKEN_INVALID
          error_message:
            "Authentication required. Provide Authorization: Bearer <token>",
        });
      }

      const token = authHeader.slice(7);
      const result = verifyAccessToken(token);

      if (!result.ok) {
        const error_code = mapErrorToCode(result.error);
        logger.warn(
          { url, ip: request.ip, error: result.error },
          "Token verification failed"
        );
        return reply.status(401).send({
          error_code,
          error_message: result.message,
        });
      }

      request.userId = result.payload.user_id;
      request.sessionId = result.payload.session_id;
    }
  );
}

// ---- 内部 ----

/**
 * 尝试从 Authorization header 提取并验证 token
 * 返回 user_id 或 null (不会 reject 请求)
 */
function tryInjectUser(request: FastifyRequest): number | null {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice(7);
  const result = verifyAccessToken(token);

  if (result.ok) {
    request.userId = result.payload.user_id;
    request.sessionId = result.payload.session_id;
    return result.payload.user_id;
  }

  return null;
}

/** TokenVerifyError → ErrorCode 映射 */
function mapErrorToCode(error: string): number {
  switch (error) {
    case "EXPIRED":
      return 1002; // AUTH_KEY_EXPIRED
    case "SESSION_INVALIDATED":
      return 1003; // SESSION_EXPIRED
    default:
      return 1004; // TOKEN_INVALID
  }
}
