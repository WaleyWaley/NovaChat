/**
 * JWT 鉴权中间件
 *
 * 对需要认证的 HTTP 路由进行 JWT 校验，将解析出的 user_id 注入 request。
 * 白名单路由 (health, PushService 内部调用) 跳过校验。
 */
import type { FastifyInstance } from "fastify";
declare module "fastify" {
    interface FastifyRequest {
        /** 由 JWT 中间件注入的 user_id (未认证时为 undefined) */
        userId?: number;
    }
}
/**
 * 注册 JWT 鉴权钩子到 Fastify 实例
 *
 * 对所有非白名单请求:
 *   1. 提取 Authorization: Bearer <token>
 *   2. 验证 JWT
 *   3. 注入 request.userId
 *   4. 验证失败返回 401
 */
export declare function registerAuthHook(app: FastifyInstance): void;
//# sourceMappingURL=auth.d.ts.map