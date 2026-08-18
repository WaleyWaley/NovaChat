# 网关 Redis 客户端 (`redis/client.ts`)

## 技术职责

`GatewayRedis` 是对 **ioredis** 库的封装，负责网关层与 Redis 之间的所有交互。它是 NovaChat 全局在线路由表在网关侧的唯一读写入口。

### 核心数据结构

**在线路由表 Key 格式**：`user:online:<user_id>`
**Value（JSON）**：
```json
{"gateway_addr": "10.0.1.5:3000", "last_heartbeat": 1718360000}
```

每个在线用户的 Redis Key 带有 TTL（默认 30 秒，由 `REDIS_ONLINE_TTL` 配置），心跳刷新时续期。

### 连接管理

- **懒连接**（`lazyConnect: true`）：启动时不立即连接，首次操作时才建立连接。
- **自动重试**（`retryStrategy`）：最多重试 10 次，退避策略 `min(times × 200ms, 5000ms)`。超过 10 次放弃重试。
- **离线队列关闭**（`enableOfflineQueue: false`）：Redis 不可用时直接返回失败，不堆积请求。
- **事件监听**：`connect` / `error` / `close` 三个事件自动更新 `_connected` 状态并记录日志。

### 主要方法

| 方法 | 用途 |
|------|------|
| `setUserOnline(userId)` | 写入在线路由表（SET + EX TTL） |
| `setUserOffline(userId)` | 删除在线路由表 Key |
| `refreshHeartbeat(userId)` | 刷新单个用户的 `last_heartbeat` 并续期 TTL |
| `refreshHeartbeats(userIds)` | **批量心跳刷新**（使用 Redis pipeline，两阶段：先 GET 批量读取，再 SET 批量写回） |
| `isUserOnline(userId)` | 全局在线查询（返回 `OnlineEntry` 或 null） |
| `batchCheckOnline(userIds)` | **批量在线检查**（Redis pipeline），返回 `{online: Map, offline: number[]}` |
| `clearGatewayUsers(userIds)` | 网关关闭时批量删除本节点所有在线用户 |

### 优雅降级

所有方法在 Redis 未连接时返回 `false` / `null` / 空结果，**不抛出异常**。网关在 Redis 不可用时仅记录日志，`IsUserOnline` 只返回本节点结果，跨节点推送依赖 C++ message-service 直连网关重试。

## 业务角色

在多网关部署的 NovaChat 架构中，`GatewayRedis` 是**全局在线路由表的写入者和查询者**：

1. **写入在线状态**：用户认证成功后，`onlineRegistry` 调用 `setUserOnline` 将用户注册到 Redis 全局路由表。
2. **心跳维护**：定时器（每 15 秒）调用 `refreshHeartbeats` 批量刷新 TTL，防止 Key 过期导致跨节点用户被误判为离线。
3. **跨节点查询**：`PushService/IsUserOnline` 和 `BatchOnlineCheck` 通过 `isUserOnline` / `batchCheckOnline` 判断目标用户是否在他网关上在线。
4. **优雅关闭**：网关节点的 `shutdown()` 调用 `clearGatewayUsers` 批量清理，防止僵尸路由记录。

## 系统连接

- **`online_registry.ts`**：主要消费者，调用 `setUserOnline` / `setUserOffline` / `refreshHeartbeats` / `clearGatewayUsers`。
- **`push.ts`**：调用 `isUserOnline` / `batchCheckOnline` 实现跨网关在线状态查询。
- **`config/index.ts`**：读取 `REDIS_ADDR`、`REDIS_PASSWORD`、`REDIS_ONLINE_TTL`、`ONLINE_HEARTBEAT_INTERVAL`。
- **`ioredis`**：底层 Redis 客户端库（`^5.4.1`），提供 pipeline 和连接管理能力。
- 导出全局单例 `gatewayRedis`。
