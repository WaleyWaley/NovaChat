/**
 * JWT 鉴权工具
 *
 * Phase 2.1: RS256 非对称验证 + HS256 回退 + Session 失效检测
 * Phase 1:   HMAC-SHA256 对称签名 (保留 signToken 用于 dev/mock)
 *
 * 核心原则: 网关只做验证 (verify)，不做签名 (sign)。
 * 生产环境 token 由 C++ user-service 的 RS256 私钥签发，网关持有公钥验证。
 */

import jwt, { type SignOptions, type JwtHeader } from "jsonwebtoken";
import { config } from "../config/index.js";
import { keyStore } from "./keys.js";
import { sessionStore } from "./session.js";
import { logger } from "../utils/logger.js";

// ---- 类型定义 ----

export interface JwtPayload {
  user_id: number;
  username: string;
  iat?: number;
  exp?: number;
  /** Phase 2.1: session 唯一标识，用于登出失效 */
  session_id?: string;
  /** 临时标记 (refresh token 内部使用) */
  type?: string;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix ms
}

// ---- 验证结果 ----

export type TokenVerifyError =
  | "EXPIRED"
  | "INVALID"
  | "SESSION_INVALIDATED";

export type TokenVerifyResult =
  | { ok: true; payload: JwtPayload }
  | { ok: false; error: TokenVerifyError; message: string };

// ---- 辅助: 解码 JWT header (未验证, 仅提取 kid) ----

function decodeTokenHeader(token: string): { kid?: string; alg: string } | null {
  try {
    const decoded = jwt.decode(token, { complete: true });
    if (!decoded || typeof decoded === "string") return null;

    const header = decoded.header as JwtHeader;
    return {
      kid: header.kid,
      alg: header.alg ?? "unknown",
    };
  } catch {
    return null;
  }
}

// ---- Token 验证 ----

/**
 * 验证 access_token
 *
 * 流程:
 *   1. 解码 header 提取 kid
 *   2. 从 keyStore 查找对应的验证密钥
 *   3. jwt.verify 验证签名和过期时间
 *   4. 检查 session 是否已被撤销 (如果 token 携带 session_id)
 *
 * @returns 验证结果 — ok: true 或具体的错误类型
 */
export function verifyAccessToken(token: string): TokenVerifyResult {
  // 1. 解码 header 获取 kid
  const headerInfo = decodeTokenHeader(token);
  const kid = headerInfo?.kid;

  // 2. 查找验证密钥
  let keyEntry;
  try {
    keyEntry = keyStore.getKey(kid);
  } catch (err) {
    logger.warn(
      { kid, err },
      "No verification key found for token"
    );
    return {
      ok: false,
      error: "INVALID",
      message: "No verification key available",
    };
  }

  // 3. 验证签名 + 过期
  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, keyEntry.publicKey, {
      algorithms: [keyEntry.algorithm],
    }) as JwtPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      logger.debug({ err }, "Token expired");
      return {
        ok: false,
        error: "EXPIRED",
        message: `Token expired at ${err.expiredAt.toISOString()}`,
      };
    }
    if (err instanceof jwt.JsonWebTokenError) {
      logger.warn({ err }, "Token invalid");
      return {
        ok: false,
        error: "INVALID",
        message: `Token verification failed: ${err.message}`,
      };
    }
    logger.error({ err }, "Unexpected JWT error");
    return {
      ok: false,
      error: "INVALID",
      message: "Token verification failed",
    };
  }

  // 4. Session 失效检查
  if (payload.session_id) {
    const session = sessionStore.getSync(payload.session_id);
    if (session && session.invalidatedAt) {
      logger.debug(
        {
          sessionId: payload.session_id,
          userId: payload.user_id,
          invalidatedAt: session.invalidatedAt,
        },
        "Session has been invalidated"
      );
      return {
        ok: false,
        error: "SESSION_INVALIDATED",
        message: "Session has been invalidated (logged out or password changed)",
      };
    }
  }

  return { ok: true, payload };
}

/**
 * 验证 refresh_token
 *
 * 与 verifyAccessToken 的区别:
 *   - Refresh token 语义不同 (type: "refresh")
 *   - 不检查 session 失效 (refresh 是独立生命周期)
 *   - Phase 2.2: 独立的 refresh_token 密钥
 */
export function verifyRefreshToken(token: string): TokenVerifyResult {
  // 1-3 步与 verifyAccessToken 相同
  const headerInfo = decodeTokenHeader(token);
  const kid = headerInfo?.kid;

  let keyEntry;
  try {
    keyEntry = keyStore.getKey(kid);
  } catch {
    return {
      ok: false,
      error: "INVALID",
      message: "No verification key available",
    };
  }

  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, keyEntry.publicKey, {
      algorithms: [keyEntry.algorithm],
    }) as JwtPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return {
        ok: false,
        error: "EXPIRED",
        message: `Refresh token expired at ${err.expiredAt.toISOString()}`,
      };
    }
    if (err instanceof jwt.JsonWebTokenError) {
      return {
        ok: false,
        error: "INVALID",
        message: `Refresh token verification failed: ${err.message}`,
      };
    }
    return {
      ok: false,
      error: "INVALID",
      message: "Refresh token verification failed",
    };
  }

  return { ok: true, payload };
}

// ---- Token 签发 (dev/mock 使用; 生产环境由 C++ user-service 签发) ----

/**
 * 签发 access_token + refresh_token
 *
 * Phase 2.1: 使用 keyStore 默认密钥签名, kid header 注入
 * Phase 1:   HMAC-SHA256 共享密钥
 *
 * 仅用于开发和 mock 场景。生产环境 token 由 C++ user-service 签发。
 */
export function signToken(payload: JwtPayload): TokenPair {
  const defaultKid = keyStore.getDefaultKid();
  const keyEntry = keyStore.getKey(defaultKid ?? undefined);

  const accessExpiresIn = config.JWT_EXPIRES_IN;
  const refreshExpiresIn = "30d";

  // 如果没有 session_id，生成一个临时 ID (dev/mock)
  const sessionId =
    payload.session_id ??
    (Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10));

  const accessPayload: JwtPayload = {
    ...payload,
    session_id: sessionId,
  };

  const signOpts: SignOptions = {
    algorithm: keyEntry.algorithm,
    expiresIn: accessExpiresIn as SignOptions["expiresIn"],
  };

  // RS256: 注入 kid header
  if (defaultKid) {
    signOpts.keyid = defaultKid;
  }

  const access_token = jwt.sign(
    accessPayload,
    keyEntry.publicKey,
    signOpts
  );

  const refresh_token = jwt.sign(
    {
      user_id: payload.user_id,
      type: "refresh",
      session_id: sessionId,
    },
    keyEntry.publicKey,
    {
      algorithm: keyEntry.algorithm,
      expiresIn: refreshExpiresIn as SignOptions["expiresIn"],
      ...(defaultKid ? { keyid: defaultKid } : {}),
    }
  );

  // 解析 access_token 获取实际过期时间
  const decoded = jwt.decode(access_token) as { exp: number };
  const expires_at = decoded.exp * 1000;

  return { access_token, refresh_token, expires_at };
}

// ---- 请求提取 ----

/**
 * 从 HTTP Authorization header 提取 Bearer token 并验证
 * 返回 user_id 或 null
 *
 * Phase 2.1: 使用 verifyAccessToken 区分错误类型
 */
export function extractUserIdFromAuthHeader(
  authHeader: string | undefined
): number | null {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice(7);
  const result = verifyAccessToken(token);
  return result.ok ? result.payload.user_id : null;
}
