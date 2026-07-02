/**
 * 网关配置 — 集中管理所有环境变量与默认值
 *
 * 读取优先级: 环境变量 > 默认值
 * Phase 3: 支持热加载 (SIGHUP / GATEWAY_CONFIG_RELOAD 事件)
 */
export interface GatewayConfig {
    PORT: number;
    HOST: string;
    NODE_ENV: string;
    WORKER_ID: number;
    USER_SERVICE_URL: string;
    MESSAGE_SERVICE_URL: string;
    JWT_SECRET: string;
    JWT_EXPIRES_IN: string;
    WS_MAX_CONNECTIONS: number;
    WS_HEARTBEAT_INTERVAL: number;
    WS_CONNECTION_TIMEOUT: number;
    RATE_LIMIT_PER_USER: number;
    RATE_LIMIT_PER_IP: number;
    PUSH_DEDUP_SIZE: number;
}
/** 全局单例配置 */
export declare const config: GatewayConfig;
/** 开发模式快捷判断 */
export declare const isDev: boolean;
export declare const isProd: boolean;
//# sourceMappingURL=index.d.ts.map