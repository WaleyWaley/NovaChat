/**
 * 网关配置 — 集中管理所有环境变量与默认值
 *
 * 读取优先级: 环境变量 > 默认值
 * Phase 3: 支持热加载 (SIGHUP / GATEWAY_CONFIG_RELOAD 事件)
 */

export interface GatewayConfig {
  // 服务器
  PORT: number;
  HOST: string;
  NODE_ENV: string;

  // 本网关节点的唯一 ID (用于 Snowflake worker_id 和日志标识)
  WORKER_ID: number;

  // C++ 后端服务地址 (Phase 1: 配置文件硬编码; Phase 3: Consul/Etcd)
  USER_SERVICE_URL: string;
  MESSAGE_SERVICE_URL: string;

  // JWT
  JWT_SECRET: string;
  JWT_EXPIRES_IN: string; // 如 "1h", "7d"

  // Phase 2.1: JWT 密钥管理
  JWT_PUBLIC_KEY_PATH: string; // RS256 公钥 PEM 文件路径
  JWT_EXTRA_KEYS: string;      // JSON 格式额外密钥 (轮转测试)

  // WebSocket
  WS_MAX_CONNECTIONS: number; // 单节点最大连接数
  WS_HEARTBEAT_INTERVAL: number; // 心跳间隔 (秒)
  WS_CONNECTION_TIMEOUT: number; // 连接超时 (秒)

  // 限流 (Phase 1: 内存令牌桶; Phase 2: Redis)
  RATE_LIMIT_PER_USER: number; // 每用户每秒最大请求数
  RATE_LIMIT_PER_IP: number;

  // 幂等去重
  PUSH_DEDUP_SIZE: number; // 缓存最近 N 个已处理的 push_id

  // Phase 2.1: Session 管理
  SESSION_EXPIRES_IN: string;       // Session TTL，如 "7d"
  SESSION_CLEANUP_INTERVAL: number; // 清理间隔 ms (默认 300000 = 5min)
}

function loadConfig(): GatewayConfig {
  return {
    PORT: parseInt(process.env.GATEWAY_PORT || "3000", 10),
    HOST: process.env.GATEWAY_HOST || "0.0.0.0",
    NODE_ENV: process.env.NODE_ENV || "development",

    WORKER_ID: parseInt(process.env.WORKER_ID || "1", 10),

    USER_SERVICE_URL: process.env.USER_SERVICE_URL || "http://127.0.0.1:8001",
    MESSAGE_SERVICE_URL: process.env.MESSAGE_SERVICE_URL || "http://127.0.0.1:8002",

    JWT_SECRET: process.env.JWT_SECRET || "novachat-dev-secret-change-in-production",
    JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || "24h",

    JWT_PUBLIC_KEY_PATH: process.env.JWT_PUBLIC_KEY_PATH || "",
    JWT_EXTRA_KEYS: process.env.JWT_EXTRA_KEYS || "",

    WS_MAX_CONNECTIONS: parseInt(process.env.WS_MAX_CONNECTIONS || "50000", 10),
    WS_HEARTBEAT_INTERVAL: parseInt(process.env.WS_HEARTBEAT_INTERVAL || "30", 10),
    WS_CONNECTION_TIMEOUT: parseInt(process.env.WS_CONNECTION_TIMEOUT || "60", 10),

    RATE_LIMIT_PER_USER: parseInt(process.env.RATE_LIMIT_PER_USER || "100", 10),
    RATE_LIMIT_PER_IP: parseInt(process.env.RATE_LIMIT_PER_IP || "200", 10),

    PUSH_DEDUP_SIZE: parseInt(process.env.PUSH_DEDUP_SIZE || "10000", 10),

    SESSION_EXPIRES_IN: process.env.SESSION_EXPIRES_IN || "7d",
    SESSION_CLEANUP_INTERVAL: parseInt(
      process.env.SESSION_CLEANUP_INTERVAL || "300000",
      10
    ),
  };
}

/** 全局单例配置 */
export const config = loadConfig();

/** 开发模式快捷判断 */
export const isDev = config.NODE_ENV === "development";
export const isProd = config.NODE_ENV === "production";
