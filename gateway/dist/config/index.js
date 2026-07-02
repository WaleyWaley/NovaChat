/**
 * 网关配置 — 集中管理所有环境变量与默认值
 *
 * 读取优先级: 环境变量 > 默认值
 * Phase 3: 支持热加载 (SIGHUP / GATEWAY_CONFIG_RELOAD 事件)
 */
function loadConfig() {
    return {
        PORT: parseInt(process.env.GATEWAY_PORT || "3000", 10),
        HOST: process.env.GATEWAY_HOST || "0.0.0.0",
        NODE_ENV: process.env.NODE_ENV || "development",
        WORKER_ID: parseInt(process.env.WORKER_ID || "1", 10),
        USER_SERVICE_URL: process.env.USER_SERVICE_URL || "http://127.0.0.1:8001",
        MESSAGE_SERVICE_URL: process.env.MESSAGE_SERVICE_URL || "http://127.0.0.1:8002",
        JWT_SECRET: process.env.JWT_SECRET || "novachat-dev-secret-change-in-production",
        JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "24h",
        WS_MAX_CONNECTIONS: parseInt(process.env.WS_MAX_CONNECTIONS || "50000", 10),
        WS_HEARTBEAT_INTERVAL: parseInt(process.env.WS_HEARTBEAT_INTERVAL || "30", 10),
        WS_CONNECTION_TIMEOUT: parseInt(process.env.WS_CONNECTION_TIMEOUT || "60", 10),
        RATE_LIMIT_PER_USER: parseInt(process.env.RATE_LIMIT_PER_USER || "100", 10),
        RATE_LIMIT_PER_IP: parseInt(process.env.RATE_LIMIT_PER_IP || "200", 10),
        PUSH_DEDUP_SIZE: parseInt(process.env.PUSH_DEDUP_SIZE || "10000", 10),
    };
}
/** 全局单例配置 */
export const config = loadConfig();
/** 开发模式快捷判断 */
export const isDev = config.NODE_ENV === "development";
export const isProd = config.NODE_ENV === "production";
//# sourceMappingURL=index.js.map