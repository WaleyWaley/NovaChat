/**
 * PushService HTTP 端点 — C++ 服务反向推送的入口
 *
 * 调用方: C++ 核心服务 (message-service / user-service) 通过 bRPC HTTP Channel
 * 实现方: TS 网关 (本文件)
 *
 * 这些端点处于 JWT 白名单中，由 C++ 服务内部调用，不经过客户端鉴权。
 * 网关根据在线路由表查找目标用户的 WebSocket 连接并推送。
 */
import type { FastifyInstance } from "fastify";
export declare function pushRoutes(app: FastifyInstance): Promise<void>;
//# sourceMappingURL=push.d.ts.map