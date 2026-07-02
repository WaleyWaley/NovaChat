/**
 * NovaChat Gateway — 入口文件
 *
 * 启动流程:
 *   1. 加载配置
 *   2. 创建 Fastify 实例 (含 pino logger)
 *   3. 注册插件 (CORS, WebSocket)
 *   4. 注册中间件钩子 (JWT 鉴权, 限流)
 *   5. 注册路由 (health, PushService, user API)
 *   6. 注册 WebSocket 处理器 (客户端长连接)
 *   7. 启动 HTTP 服务器
 *   8. 优雅关闭
 */
export {};
//# sourceMappingURL=main.d.ts.map