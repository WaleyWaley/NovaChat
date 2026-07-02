/**
 * JWT 鉴权中间件
 *
 * 对需要认证的 HTTP 路由进行 JWT 校验，将解析出的 user_id 注入 request。
 * 白名单路由 (health, PushService 内部调用) 跳过校验。
 */
import { extractUserIdFromAuthHeader } from "../auth/jwt.js";
import { logger } from "../utils/logger.js";
// ---- 白名单 ----
const AUTH_WHITELIST = [
    "/health",
    "/nova.gateway.PushService/", // C++ 服务内部调用
];
function isWhitelisted(url) {
    return AUTH_WHITELIST.some((prefix) => url.startsWith(prefix));
}
// ---- 注册函数 ----
/**
 * 注册 JWT 鉴权钩子到 Fastify 实例
 *
 * 对所有非白名单请求:
 *   1. 提取 Authorization: Bearer <token>
 *   2. 验证 JWT
 *   3. 注入 request.userId
 *   4. 验证失败返回 401
 */
export function registerAuthHook(app) {
    // 声明 request.userId 属性 (Fastify 要求在 decorate 之前声明)
    app.decorateRequest("userId", undefined);
    app.addHook("preHandler", async (request, reply) => {
        if (isWhitelisted(request.url)) {
            return;
        }
        const authHeader = request.headers.authorization;
        const userId = extractUserIdFromAuthHeader(authHeader);
        if (userId === null) {
            logger.warn({ url: request.url, ip: request.ip }, "Unauthorized request");
            return reply.status(401).send({
                error_code: 1004, // TOKEN_INVALID
                error_message: "Authentication required",
            });
        }
        request.userId = userId;
    });
}
//# sourceMappingURL=auth.js.map