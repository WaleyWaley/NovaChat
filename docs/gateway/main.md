# main.ts — NovaChat 网关入口

## 技术职责

`main.ts` 是整个网关进程的启动入口。它完成以下核心工作：

### 1. 创建 Fastify 实例
- 初始化 HTTP 服务器，关闭内置 logger（改用项目统一的 pino 实例）
- 启用 `trustProxy` 以正确获取客户端真实 IP

### 2. 注册插件与中间件
- `@fastify/cors`：跨域支持（`origin: true, credentials: true`）
- `@fastify/websocket`：WebSocket 升级支持（`maxPayload: 64KB`）
- JWT 鉴权钩子（`registerAuthHook`）→ 四级白名单
- 令牌桶限流钩子（`registerRateLimitHook`）→ IP + 用户双重限流

### 3. 注册 HTTP 路由
- `healthRoutes` → `GET /health`（健康检查）
- `pushRoutes` → `/nova.gateway.PushService/*`（C++ 反向推送入口，6 个端点）
- `userRoutes` → `/api/auth/*` + `/api/users/*`（用户 REST API，12 个端点）

### 4. WebSocket 长连接入口 (`/ws`)
连接建立后发送 `welcome` 帧，然后进入消息分发循环：

| 消息类型 | 处理函数 | 说明 |
|----------|----------|------|
| `auth` | `handleAuth` | JWT 认证 → ConnectionManager 注册 → Redis 在线路由表写入 → 延迟 Session 创建 |
| `ping` | `handlePing` | 心跳响应 + `refreshHeartbeat` 续期 |
| `send_msg` | `handleSendMessage` | 转发到 `messageClient.sendMessage()` → C++ message-service |
| `typing` | `handleTyping` | 输入状态指示（Phase 2 桩，预留转发到 message-service） |
| `read` | `handleReadReceipt` | 已读回执（Phase 2 桩，预留转发到 message-service） |
| `rpc` | `handleRpc` | 通用 RPC 代理，支持 UserService 的 9 个方法 |

未认证时只接受 `auth` 和 `ping` 消息，其他类型返回 `1004 (Authentication required)`。

### 5. RPC 代理 (`proxyUserService`)
将 WebSocket 的通用 RPC 调用路由到具体的方法实现：
- `GetUserProfile` → `userClient.getUserProfile()`
- `GetUsers` / `UpdateProfile` / `ChangeUsername` / `CheckUsername` / `SearchUsers` / `ChangePassword`
- 自动注入 `userId`（网关已鉴权，C++ 后端信任此值）

### 6. 启动流程

```
main():
  1. createApp()
  2. gatewayRedis.connect()         ← Redis 连接
  3. app.listen(PORT, HOST)        ← HTTP 监听
  4. connectionManager.startHeartbeat()    ← 本地心跳检测
  5. onlineRegistry.startHeartbeat()       ← Redis 路由表心跳
  6. sessionStore.startCleanupTimer()      ← Session 定时清理
  7. 等待 SIGINT/SIGTERM
```

### 7. 优雅关闭
收到 `SIGINT`/`SIGTERM` 后：
```
1. connectionManager.stopHeartbeat()
2. onlineRegistry.stopHeartbeat()
3. sessionStore.stopCleanupTimer()
4. onlineRegistry.shutdown()        → 清除 Redis 中本网关所有在线用户
5. gatewayRedis.disconnect()        → 断开 Redis 连接
6. connectionManager.disconnectAll("Server shutting down")  → 通知所有连接关闭
7. app.close()                      → 停止 HTTP 服务器
```

## 业务角色

在 NovaChat 即时通讯系统中，网关是所有客户端（移动端、Web 端）的唯一连接入口。`main.ts` 承担了 **流量入口 + 协议转换 + 鉴权关口 + 路由代理** 四重角色：

- **统一接入**：所有客户端通过 HTTP API 或 WebSocket 连接到网关，由网关统一验证身份后再向后端服务转发请求。
- **连接管理**：维护每个客户端的 WebSocket 连接状态，支持心跳保活、在线计数、多端互踢。
- **消息代理**：客户端发送消息 → `messageClient.sendMessage()` → C++ message-service（生成 ID → 存储 → 反向推送）。
- **RPC 桥接**：提供通用 RPC 代理机制，让客户端通过 WebSocket 调用 C++ 微服务接口，网关注入鉴权上下文。
- **在线路由**：管理 Redis 全局在线路由表，支撑跨网关消息推送。

## 系统连接

- **配置模块** (`config/index.ts`)：读取 `PORT`、`HOST`、`WORKER_ID`、`GATEWAY_ADDR` 等配置。
- **日志模块** (`utils/logger.ts`)：所有日志输出统一使用 pino。
- **中间件**：`middleware/auth.ts`（JWT 鉴权）和 `middleware/rate_limiter.ts`（限流）。
- **路由模块**：`routes/health.ts`、`routes/push.ts`、`routes/user.ts`。
- **WebSocket 协议** (`ws/protocol.ts`)：定义了 6 种客户端消息 + 6 种服务端消息。
- **连接管理器** (`ws/connection.ts`)：维护 userId ↔ WebSocket 映射。
- **在线注册器** (`ws/online_registry.ts`)：同步在线状态到 Redis 全局路由表。
- **Redis 客户端** (`redis/client.ts`)：Redis 读写操作。
- **认证模块**：`auth/jwt.ts`、`auth/keys.ts`、`auth/session.ts`。
- **C++ 后端客户端**：`clients/user_client.ts`（12 个 RPC）、`clients/message_client.ts`（消息发送与拉取）。
- **C++ 微服务**：`user-service:8001`、`message-service:8002`。
- **Docker**：通过 `gateway:3000` 服务名被 C++ PushDispatcher 反向调用。
