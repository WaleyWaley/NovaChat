# 在线状态注册器 (`ws/online_registry.ts`)

## 技术职责

`OnlineRegistry` 是网关**本地连接状态**与 **Redis 全局路由表**之间的桥梁。它负责将本网关节点的在线用户同步到 Redis，使 C++ message-service 能够查询到任意用户所在的网关节点。

### 核心流程

```
用户上线 (认证成功)
  → OnlineRegistry.onUserOnline(userId)
    → gatewayRedis.setUserOnline(userId)
      → Redis: SET user:online:<userId> {...} EX 30

用户下线 (连接断开)
  → OnlineRegistry.onUserOffline(userId)
    → gatewayRedis.setUserOffline(userId)
      → Redis: DEL user:online:<userId>

定时心跳 (每 15 秒)
  → OnlineRegistry.startHeartbeat()
    → connectionManager.getOnlineUserIds()
    → gatewayRedis.refreshHeartbeats(userIds)  [pipeline 批量刷新]

网关关闭 (SIGINT/SIGTERM)
  → OnlineRegistry.shutdown()
    → stopHeartbeat()
    → gatewayRedis.clearGatewayUsers(userIds)  [pipeline 批量删除]
```

### 主要方法

| 方法 | 触发时机 | 行为 |
|------|----------|------|
| `onUserOnline(userId, username)` | 用户 WebSocket 认证成功 | 写 Redis `user:online:<userId>` |
| `onUserOffline(userId)` | 用户 WebSocket 断开 | 删 Redis key |
| `startHeartbeat()` | 网关启动时 | 启动定时器，按 `ONLINE_HEARTBEAT_INTERVAL` 周期批量刷新 TTL |
| `stopHeartbeat()` | 网关关闭时 | 停止定时器 |
| `shutdown()` | 网关优雅关闭 | 停止心跳 + 清除 Redis 中本网关所有用户 |

### 设计要点

- **Redis 不可用不阻塞**：所有方法在 `gatewayRedis.connected === false` 时静默跳过，不影响网关正常服务。
- **批量刷新**：心跳定时器每周期一次性从 `connectionManager.getOnlineUserIds()` 获取所有在线用户 ID，通过 Redis pipeline 批量刷新 TTL，避免逐个刷新的网络开销。
- **心跳周期 = TTL 的一半**：`ONLINE_HEARTBEAT_INTERVAL=15s`，`REDIS_ONLINE_TTL=30s`，确保即使一次心跳失败，下次仍然在 TTL 过期前完成刷新。

## 业务角色

在 NovaChat 多网关架构中，`OnlineRegistry` 解决了**跨网关消息路由**的核心问题：

1. **全局可见性**：用户 A 连接 Gateway-1，用户 B 连接 Gateway-2。A 发消息给 B 时，C++ message-service 通过 Redis 全局路由表查到 B 在 Gateway-2 上，然后 HTTP 调用 Gateway-2 的 PushService 实现推送。
2. **故障自动清理**：如果网关异常崩溃（未执行 shutdown），Redis Key 在 TTL 过期后自动删除，用户被视为离线。消息服务走离线存储路径。
3. **优雅关闭**：正常退出时 `shutdown()` 立即清除本网关所有在线用户，避免 C++ 服务向已关闭的网关推送消息。

## 系统连接

- **`connectionManager`** (`ws/connection.ts`)：提供 `getOnlineUserIds()` 获取本地在线用户列表。
- **`gatewayRedis`** (`redis/client.ts`)：实际执行 Redis 读写操作。
- **`config/index.ts`**：读取 `GATEWAY_ADDR`、`ONLINE_HEARTBEAT_INTERVAL`。
- **`main.ts`**：启动时调用 `startHeartbeat()`，关闭时调用 `shutdown()`。
- 导出全局单例 `onlineRegistry`。
