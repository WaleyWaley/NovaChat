# main.ts — NovaChat 网关入口

## 技术职责

`main.ts` 是整个网关进程的启动入口。它完成以下核心工作：

1. **创建 Fastify 实例**：初始化 HTTP 服务器，关闭内置 logger（改用项目统一的 pino 实例），启用 `trustProxy` 以正确获取客户端 IP。
2. **注册插件与中间件**：先后注册 `@fastify/cors`（跨域支持）和 `@fastify/websocket`（WebSocket 升级支持，限制最大消息载荷 64KB），以及 JWT 鉴权钩子和令牌桶限流钩子。
3. **注册 HTTP 路由**：挂载健康检查（health）、推送（push）和用户（user）三组路由模块。
4. **建立 WebSocket 长连接入口**：在 `/ws` 路径上绑定 WebSocket 处理器，管理连接生命周期、消息分发与状态管理。
5. **实现 RPC 代理**：将对 `nova.user.UserService` 的 WS RPC 调用转换为对 C++ user-service 的 gRPC/HTTP 调用，自动注入已鉴权的 `user_id`。
6. **启动与优雅关闭**：监听配置的端口和主机，启动心跳检测与 session 清理定时器，注册 SIGINT/SIGTERM 信号处理函数实现平滑关闭。

## 业务角色

在 NovaChat 即时通讯系统中，网关是所有客户端（移动端、桌面端、Web 端）的唯一连接入口。`main.ts` 承担了 **流量入口 + 协议转换 + 鉴权关口** 三重角色：

- **统一接入**：所有客户端通过 HTTP API 或 WebSocket 连接到网关，由网关统一验证身份后再向后端服务转发请求。
- **连接管理**：WebSocket 处理器维护每个客户端的连接状态，支持心跳保活、在线计数、连接注销等功能，是维持客户端实时在线的基础设施。
- **消息代理**：客户端的消息发送、已读回执、输入指示等实时消息流经 WebSocket 处理器，目前处于 Phase 1 实现占位，Phase 2 将转发到后端的 message-service。
- **RPC 桥接**：提供通用 RPC 代理机制，让客户端通过 WebSocket 调用 C++ 微服务的接口，网关在此过程中注入鉴权上下文，简化客户端实现。

## 系统连接

- **配置模块** (`config/index.ts`)：读取 `config.PORT`、`config.HOST`、`config.WORKER_ID` 等配置项，控制启动行为。
- **日志模块** (`utils/logger.ts`)：所有日志输出统一使用该模块，便于全链路追踪和运维。
- **中间件**：`middleware/auth.ts`（JWT 鉴权）和 `middleware/rate_limiter.ts`（限流）在路由层之前执行。
- **路由模块**：`routes/health.ts`、`routes/push.ts`、`routes/user.ts` 处理 HTTP 请求。
- **WebSocket 协议** (`ws/protocol.ts`)：定义了客户端与网关之间的消息格式（auth、ping、send_msg、typing、read、rpc 等类型）。
- **连接管理器** (`ws/connection.ts`)：维护用户 ID 到 WebSocket 连接的映射，支持多设备登录和跨节点推送。
- **认证模块**：`auth/jwt.ts` 提供令牌签发与验证，`auth/session.ts` 管理设备会话生命周期。
- **C++ 后端客户端** (`clients/user_client.ts`)：向 user-service C++ 微服务发起真实调用，实现用户资料查询、搜索、密码修改等业务功能。
