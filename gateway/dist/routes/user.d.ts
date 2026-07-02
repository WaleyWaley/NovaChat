/**
 * 用户相关 REST API 端点 — 客户端通过 HTTP 调用的路由
 *
 * 每个端点:
 *   1. JWT 中间件已提取 user_id → request.userId
 *   2. 构造请求 body (与 user.proto 对齐)
 *   3. 调用 userClient 转发到 C++ user-service
 *   4. 返回响应给客户端
 *
 * 路由前缀: /api
 */
import type { FastifyInstance } from "fastify";
export declare function userRoutes(app: FastifyInstance): Promise<void>;
//# sourceMappingURL=user.d.ts.map