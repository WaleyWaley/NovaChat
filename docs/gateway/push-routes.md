# PushService 推送路由

**文件位置**: `src/routes/push.ts`

## 技术职责

该文件注册了一组 **C++ 后端推送到 WebSocket 客户端**的 HTTP 端点，路径前缀为 `/nova.gateway.PushService`。与常规的客户端 API 不同，这些端点的调用者是 C++ 微服务（message-service、user-service 等），而非客户端应用。

它实现了六种推送/管理 RPC：

| 端点 | 功能 |
|------|------|
| `PushUpdate` | 向单个在线用户推送一条更新（如新消息通知） |
| `PushToUsers` | 批量向多个用户推送更新 |
| `KickUser` | 强制断开指定用户的 WebSocket 连接 |
| `IsUserOnline` | 查询单个用户是否在线 |
| `BatchOnlineCheck` | 批量检查多个用户的在线状态 |
| `NotifyGateway` | 网关间/服务间的事件通知（框架预留，Phase 2 实现） |

核心设计特点包括：
- **幂等去重**：`push_id` 机制允许 C++ 服务安全重试，重复的推送请求会被自动识别并跳过；
- **离线跳过**：`skip_offline` 参数支持发送方标记"用户离线时无需推送"的场景（如输入状态指示器），减少不必要的处理；
- **默认踢下线消息**：为 `KickUser` 的 reason 码提供了预定义的友好消息映射，涵盖 session 过期、账号删除、多设备登录、服务维护、封号等场景。

## 业务角色

在 NovaChat 的 BFF 架构中，**网关同时是反向推送的入口**。C++ 微服务处理完业务逻辑后（如 message-service 存储了一条新消息），需要通过网关将更新实时推送到目标用户的 WebSocket 连接上。`pushRoutes` 就是实现这一反向通信路径的关键组件。

典型的推送场景包括：
- **新消息通知**：用户 A 发送消息给用户 B，message-service 存储消息后调用 `PushUpdate` 或 `PushToUsers` 通知用户 B；
- **在线状态变更**：用户上线/下线时，user-service 通知其好友列表中的用户；
- **强制下线**：账号在其他设备登录、账号被封禁时，user-service 调用 `KickUser` 断开旧连接；
- **群组更新**：群信息变更时，群服务批量推送更新给所有群成员；
- **服务维护通知**：运维操作时需要通知所有在线用户即将维护。

## 系统连接

- **`../ws/connection.js`** (`connectionManager`): 核心依赖，维护着用户 ID 到 WebSocket 连接的在线路由表。所有推送操作最终都通过它查找目标连接并发送数据。
- **`../ws/protocol.js`** (`buildUpdate`, `buildKicked`): 负责构造符合 NovaChat 通信协议的 ServerMessage 二进制/JSON 数据包，`PushUpdate` 和 `PushToUsers` 通过 `buildUpdate` 构造推送内容，`KickUser` 使用 `buildKicked` 构造踢下线通知。
- **鉴权与限流白名单** (`auth.ts`, `rate_limiter.ts`): PushService 路径被列入 NO_AUTH 和限流白名单，因为调用方是 C++ 内部服务，不通过客户端的 JWT 鉴权机制。
- **C++ 微服务** (message-service / user-service): 通过 bRPC HTTP Channel 调用这些端点，这是 NovaChat 系统中 TS 网关和 C++ 后端之间的关键通信桥梁。
