/**
 * JWT 鉴权工具
 *
 * Phase 1: HMAC-SHA256 对称签名，简单可用
 * Phase 2: 升级 RS256 非对称签名 + Redis Session 管理 + Token 轮转
 */
import jwt from "jsonwebtoken";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";
// ---- Token 签发 ----
/**
 * 签发 access_token + refresh_token
 *
 * Phase 1: 两个 token 使用相同密钥，refresh_token 有效期更长
 * Phase 2: refresh_token 使用独立密钥 + Redis 存储
 */
export function signToken(payload) {
    const accessExpiresIn = config.JWT_EXPIRES_IN; // e.g. "24h"
    const refreshExpiresIn = "30d";
    const access_token = jwt.sign(payload, config.JWT_SECRET, {
        expiresIn: accessExpiresIn,
    });
    const refresh_token = jwt.sign({ user_id: payload.user_id, type: "refresh" }, config.JWT_SECRET, { expiresIn: refreshExpiresIn });
    // 解析 access_token 获取实际过期时间
    const decoded = jwt.decode(access_token);
    const expires_at = decoded.exp * 1000; // 转毫秒
    return { access_token, refresh_token, expires_at };
}
// ---- Token 验证 ----
/**
 * 验证 access_token，返回 payload 或 null
 */
export function verifyToken(token) {
    try {
        const payload = jwt.verify(token, config.JWT_SECRET);
        return payload;
    }
    catch (err) {
        // 区分 Token 过期和其他错误，方便上层做精细化处理
        if (err instanceof jwt.TokenExpiredError) {
            logger.debug({ err }, "Token expired");
        }
        else if (err instanceof jwt.JsonWebTokenError) {
            logger.warn({ err }, "Token invalid");
        }
        return null;
    }
}
/**
 * 验证 refresh_token，返回 payload 或 null
 */
export function verifyRefreshToken(token) {
    return verifyToken(token); // Phase 1: 复用相同密钥
}
// ---- 请求提取 ----
/**
 * 从 HTTP Authorization header 提取 Bearer token 并验证
 * 返回 user_id 或 null
 */
export function extractUserIdFromAuthHeader(authHeader) {
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return null;
    }
    const token = authHeader.slice(7);
    const payload = verifyToken(token);
    return payload?.user_id ?? null;
}
//# sourceMappingURL=jwt.js.map