/**
 * 健康检查路由
 *
 * GET /health — 网关存活性检查，被负载均衡器和监控系统使用
 */
import { connectionManager } from "../ws/connection.js";
const startTime = Date.now();
export async function healthRoutes(app) {
    app.get("/health", async (_request, _reply) => {
        return {
            status: "ok",
            service: "novachat-gateway",
            version: "0.1.0",
            uptime: Math.floor((Date.now() - startTime) / 1000),
            onlineCount: connectionManager.getOnlineCount(),
            timestamp: Date.now(),
        };
    });
}
//# sourceMappingURL=health.js.map