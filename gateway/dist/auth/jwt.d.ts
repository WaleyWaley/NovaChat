/**
 * JWT 鉴权工具
 *
 * Phase 1: HMAC-SHA256 对称签名，简单可用
 * Phase 2: 升级 RS256 非对称签名 + Redis Session 管理 + Token 轮转
 */
export interface JwtPayload {
    user_id: number;
    username: string;
    iat?: number;
    exp?: number;
}
export interface TokenPair {
    access_token: string;
    refresh_token: string;
    expires_at: number;
}
/**
 * 签发 access_token + refresh_token
 *
 * Phase 1: 两个 token 使用相同密钥，refresh_token 有效期更长
 * Phase 2: refresh_token 使用独立密钥 + Redis 存储
 */
export declare function signToken(payload: JwtPayload): TokenPair;
/**
 * 验证 access_token，返回 payload 或 null
 */
export declare function verifyToken(token: string): JwtPayload | null;
/**
 * 验证 refresh_token，返回 payload 或 null
 */
export declare function verifyRefreshToken(token: string): JwtPayload | null;
/**
 * 从 HTTP Authorization header 提取 Bearer token 并验证
 * 返回 user_id 或 null
 */
export declare function extractUserIdFromAuthHeader(authHeader: string | undefined): number | null;
//# sourceMappingURL=jwt.d.ts.map