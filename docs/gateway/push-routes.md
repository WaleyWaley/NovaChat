# PushService 推送路由 (`routes/push.ts`)

**文件位置**: `src/routes/push.ts`

## 技术职责

该文件注册了一组 **C++ 后端推送到 WebSocket 客户端**的 HTTP 端点，路径前缀为 `/nova.gateway.PushService`。与常规的客户端 API 不同，这些端点的调用者是 **C++ 微服务**（message-service、user-service 等），而非客户端应用。

### 六个 RPC 端点

| 端点 | 功能 | 调用方 |
|------|------|--------|
| `PushUpdate` | 向单个在线用户推送 Update 事件（如新消息通知） | message-service (PushDispatcher) |
| `PushToUsers` | 批量向多个用户推送 Update 事件（群消息场景） | message-service |
| `KickUser` | 强制断开指定用户的 WebSocket 连接，6 种 KickReason | user-service |
| `IsUserOnline` | 查询单个用户是否在线（全局：本地 + Redis） | message-service |
| `BatchOnlineCheck` | 批量检查多个用户的在线状态（全局：本地 + Redis pipeline） | message-service |
| `NotifyGateway` | 网关间事件通知（上线/下线广播、配置重载、会话清除） | 其他网关或运维系统 |

### 核心设计

#### 1. 幂等去重
`push_id` 字段实现推送幂等。C++ 服务因网络重试可能发送重复推送，网关端通过 `connectionManager.isDuplicatePush(push_id)` 检查，重复的推送直接返回 `delivered: true` 而不实际发送。

#### 2. TTL 过滤
`ttl_seconds` 参数支持推送存活时间。若推送从 C++ 服务发出到网关处理的时间超过 TTL，则跳过推送（避免用户上线后收到过时通知）。当前为框架预留，C++ 侧暂未设置。

#### 3. 离线跳过
`skip_offline` 参数让发送方标记"用户离线时无需推送"的场景（如输入状态指示器）。

#### 4. 全局在线查询（Phase 2.3 升级）

`IsUserOnline` 和 `BatchOnlineCheck` 采用**本地 + Redis 两级查询**：

```
IsUserOnline(userId):
  1. connectionManager.isOnline(userId)  → 本地在线? → 返回 true + lastSeen
  2. gatewayRedis.isUserOnline(userId)   → Redis 有记录? → 返回 true + 来自哪个网关
  3. 都不在 → 返回 false (用户离线)

BatchOnlineCheck(userIds):
  1. 先查本地 ConnectionManager (筛选出本地在线用户)
  2. 对剩余用户批量查 Redis (gatewayRedis.batchCheckOnline)
  3. 合并结果 → { online_user_ids, offline_user_ids }
```

#### 5. KickUser Redis 同步
踢人时同步从 Redis 删除在线路由表记录（`gatewayRedis.setUserOffline(userId)`），防止 C++ 服务继续向已断开的用户推送。

## 业务角色

在 NovaChat 的 BFF 架构中，**网关同时是反向推送的入口**。C++ 微服务处理完业务逻辑后（如 message-service 存储了一条新消息），需要通过网关将更新实时推送到目标用户的 WebSocket 连接上。`pushRoutes` 就是实现这一反向通信路径的关键组件。

典型推送场景：
- **新消息通知**：用户 A 发消息给 B → message-service 存储 → PushDispatcher → HTTP POST `PushUpdate` → 本文件 → `connectionManager.sendToUser(B)` → WebSocket 推给 B
- **强制下线**：账号在其他设备登录/被封禁 → user-service 调 `KickUser` → 网关发送 `kicked` 消息 + 关闭连接
- **在线状态查询**：发消息前 message-service 调 `IsUserOnline` 判断目标是否在线，决定走实时推送还是离线存储
- **群批量推送**：群消息 → message-service 调 `PushToUsers` → 网关推给本地在线的所有群成员

## 系统连接

- **`../ws/connection.js`** (`connectionManager`)：核心依赖，维护 userId → WebSocket 连接的映射。`sendToUser` / `sendToUsers` / `isOnline` / `isDuplicatePush`。
- **`../redis/client.js`** (`gatewayRedis`)：Phase 2.3 新增依赖，提供全局在线查询（`isUserOnline` / `batchCheckOnline` / `setUserOffline`）。
- **`../ws/protocol.js`** (`buildUpdate`, `buildKicked`)：构造 NovaChat WebSocket 协议的 ServerMessage。
- **鉴权与限流白名单**：PushService 路径被列入 `NO_AUTH` 和限流白名单，因为调用方是 C++ 内部服务。
- **C++ PushDispatcher** (`message-service/push_dispatcher.cc`)：主要调用方，通过 `brpc::Channel(PROTOCOL_HTTP)` → HTTP POST → 本文件端点。
