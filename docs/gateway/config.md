# config/index.ts — 网关配置管理

## 技术职责

`config/index.ts` 是网关应用的集中配置管理模块，其核心功能包括：

1. **定义配置接口**：`GatewayConfig` 类型定义了所有配置字段的 TypeScript 类型签名，覆盖服务器、后端地址、JWT、WebSocket、限流、Session 等多个维度。
2. **加载配置**：`loadConfig()` 函数按照"环境变量优先，默认值兜底"的策略读取配置。每个字段都拥有合理的生产级默认值（如 `WS_MAX_CONNECTIONS` 默认 50000，`RATE_LIMIT_PER_USER` 默认 100 qps），确保开发环境开箱即用。
3. **导出单例**：将 `loadConfig()` 的返回值导出为全局常量 `config`，各模块直接引用，避免重复解析。
4. **快捷判断**：导出 `isDev` 和 `isProd` 布尔值，方便在其他模块中根据环境改变行为（如日志级别、错误信息详略）。

配置项按用途可分为：

| 类别 | 字段 | 说明 |
|------|------|------|
| 服务器 | `PORT`, `HOST`, `NODE_ENV` | 监听地址与运行环境 |
| 节点标识 | `WORKER_ID` | 用于 Snowflake ID 生成和日志标识 |
| 后端地址 | `USER_SERVICE_URL`, `MESSAGE_SERVICE_URL` | C++ 微服务地址 |
| JWT | `JWT_SECRET`, `JWT_EXPIRES_IN`, `JWT_PUBLIC_KEY_PATH`, `JWT_EXTRA_KEYS` | 令牌签发与验证 |
| WebSocket | `WS_MAX_CONNECTIONS`, `WS_HEARTBEAT_INTERVAL`, `WS_CONNECTION_TIMEOUT` | 连接管理参数 |
| 限流 | `RATE_LIMIT_PER_USER`, `RATE_LIMIT_PER_IP` | 令牌桶速率限制 |
| 幂等去重 | `PUSH_DEDUP_SIZE` | 推送去重缓存大小 |
| Session | `SESSION_EXPIRES_IN`, `SESSION_CLEANUP_INTERVAL` | 设备会话 TTL 与清理周期 |

## 业务角色

在 NovaChat 即时通讯系统中，配置模块决定了网关的行为边界和部署拓扑：

- **无状态化**：所有环境相关的参数（如后端地址、密钥）都通过配置注入，使得网关实例可以在不同环境（开发/测试/生产）间迁移而不需要修改代码。
- **水平扩展支持**：`WORKER_ID` 让每个网关节点在分布式部署中获得唯一标识，配合连接管理器和 Session 存储，支撑多节点水平扩展。
- **安全兜底**：JWT 相关配置（密钥、公钥路径、额外密钥轮转）集中在此管理，后续可以扩展为热加载机制，支持不停机密钥轮换。

## 系统连接

- **入口模块** (`main.ts`)：直接引用 `config` 和 `isDev`，控制服务器监听参数和错误信息暴露。
- **日志模块** (`utils/logger.ts`)：通过 `config.NODE_ENV` 和 `config.WORKER_ID` 设置日志级别和全局标签。
- **所有路由与客户端模块**：间接通过 `config` 获取后端服务 URL、JWT 密钥等连接参数。
- **中间件** (限流器、鉴权钩子)：使用 `config` 中的阈值和密钥配置其行为。
- **Phase 3 规划**：代码中有明确的 TODO 注释，后续将支持 SIGHUP 信号触发的配置热加载，届时配置模块将增加运行时刷新能力，并可能对接 Consul/Etcd 实现服务发现。
