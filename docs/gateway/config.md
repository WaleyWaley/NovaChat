# config/index.ts — 网关配置管理

## 技术职责

`config/index.ts` 是网关应用的集中配置管理模块，其核心功能包括：

1. **定义配置接口**：`GatewayConfig` 类型定义了所有配置字段的 TypeScript 类型签名，覆盖服务器、后端地址、JWT、WebSocket、限流、Session、Redis 在线路由等多个维度。
2. **加载配置**：`loadConfig()` 函数按照"环境变量优先，默认值兜底"的策略读取配置。每个字段都拥有合理的生产级默认值（如 `WS_MAX_CONNECTIONS` 默认 50000，`RATE_LIMIT_PER_USER` 默认 100 qps），确保开发环境开箱即用。
3. **导出单例**：将 `loadConfig()` 的返回值导出为全局常量 `config`，各模块直接引用，避免重复解析。
4. **快捷判断**：导出 `isDev` 和 `isProd` 布尔值，方便在其他模块中根据环境改变行为（如日志级别、错误信息详略）。

### 配置项全表

| 类别 | 字段 | 默认值 | 说明 |
|------|------|--------|------|
| **服务器** | `PORT` | 3000 | HTTP 监听端口 |
| | `HOST` | 0.0.0.0 | 监听地址 |
| | `NODE_ENV` | development | 运行环境 |
| | `WORKER_ID` | 1 | 节点唯一标识（用于日志和 Snowflake） |
| | `GATEWAY_ADDR` | localhost:3000 | 本网关节点的外部可达地址（C++ 服务反向推送用） |
| **后端地址** | `USER_SERVICE_URL` | http://127.0.0.1:8001 | C++ user-service 地址 |
| | `MESSAGE_SERVICE_URL` | http://127.0.0.1:8002 | C++ message-service 地址 |
| **JWT** | `JWT_SECRET` | (dev default) | HS256 共享密钥（开发回退） |
| | `JWT_EXPIRES_IN` | 3600s | Access Token 有效期 |
| | `JWT_PUBLIC_KEY_PATH` | — | RS256 公钥 PEM 文件路径（生产环境） |
| | `JWT_EXTRA_KEYS` | — | JSON 格式的额外密钥（密钥轮转） |
| **WebSocket** | `WS_MAX_CONNECTIONS` | 50000 | 全局连接上限 |
| | `WS_HEARTBEAT_INTERVAL` | 30s | 心跳检测间隔 |
| | `WS_CONNECTION_TIMEOUT` | 60s | 心跳超时阈值（超过则断开） |
| **限流** | `RATE_LIMIT_PER_USER` | 100 qps | 每用户最大请求速率 |
| | `RATE_LIMIT_PER_IP` | 200 qps | 每 IP 最大请求速率 |
| **推送去重** | `PUSH_DEDUP_SIZE` | 10000 | ConnectionManager 中 push_id 去重缓存大小 |
| **Session** | `SESSION_EXPIRES_IN` | "7d" | Session 默认有效期 |
| | `SESSION_CLEANUP_INTERVAL` | 300000 (5min) | Session 清理定时器间隔 |
| **Redis 在线路由** | `REDIS_ADDR` | 127.0.0.1:6379 | Redis 服务器地址 |
| | `REDIS_PASSWORD` | — | Redis 密码 |
| | `REDIS_ONLINE_TTL` | 30s | 在线路由表 Key 的 TTL |
| | `ONLINE_HEARTBEAT_INTERVAL` | 15s | 网关向 Redis 刷新在线心跳的间隔 |

### 心跳参数设计

`ONLINE_HEARTBEAT_INTERVAL=15s` 和 `REDIS_ONLINE_TTL=30s` 形成 **"2:1 覆盖比"**：即使一次心跳因网络抖动失败，下一次 15 秒后的刷新仍在 30 秒 TTL 过期之前完成，保证在线状态的连续性。

## 业务角色

在 NovaChat 即时通讯系统中，配置模块决定了网关的行为边界和部署拓扑：

- **无状态化**：所有环境相关的参数（如后端地址、密钥）都通过配置注入，使得网关实例可以在不同环境（开发/测试/生产）间迁移而不需要修改代码。
- **水平扩展支持**：`WORKER_ID` 和 `GATEWAY_ADDR` 让每个网关节点在分布式部署中获得唯一标识，配合 Redis 在线路由表支撑多节点水平扩展。
- **安全兜底**：JWT 相关配置（密钥、公钥路径、额外密钥轮转）集中在此管理，支持 RS256/HS256 双模式。

## 系统连接

- **入口模块** (`main.ts`)：直接引用 `config` 和 `isDev`，控制服务器监听参数和错误信息暴露。
- **日志模块** (`utils/logger.ts`)：通过 `config.NODE_ENV` 和 `config.WORKER_ID` 设置日志级别和全局标签。
- **所有路由与客户端模块**：间接通过 `config` 获取后端服务 URL、JWT 密钥等连接参数。
- **中间件** (限流器、鉴权钩子)：使用 `config` 中的阈值和密钥配置其行为。
- **Redis 客户端** (`redis/client.ts`)：使用 `REDIS_ADDR`、`REDIS_PASSWORD`、`REDIS_ONLINE_TTL`、`ONLINE_HEARTBEAT_INTERVAL`。
- **在线注册器** (`ws/online_registry.ts`)：使用 `GATEWAY_ADDR` 和 `ONLINE_HEARTBEAT_INTERVAL`。
