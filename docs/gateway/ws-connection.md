# WebSocket 连接管理器 (`ws/connection.ts`)

## 技术职责

`ConnectionManager` 是网关最核心的数据结构，维护所有在线用户的 WebSocket 连接状态。它本质上是一个**内存中的在线路由表**，支撑消息推送和连接生命周期管理。

### 核心数据结构

- **`byUserId`** (`Map<number, ConnectionEntry>`) — 用户 ID 到连接实体的映射，用于按用户推送消息
- **`bySocket`** (`Map<WebSocket, number>`) — WebSocket 实例到用户 ID 的反查映射，用于 `close` 事件快速清理
- **`processedPushIds`** (`Set<number>`) — 已处理推送 ID 的去重缓存，实现推送幂等

每个 `ConnectionEntry` 记录 WebSocket 引用、用户 ID/用户名、连接时间戳和最后心跳时间。

### 主要功能

#### 连接注册与注销 (`register` / `unregister`)
- `register()` 先检查全局容量上限 (`WS_MAX_CONNECTIONS`)，超过则拒绝
- 同一用户已有连接时，执行旧连接踢出（支持多端互踢），发送 `kicked` 消息后延迟 100ms 关闭
- `unregister()` 由 WebSocket `close` 事件触发，双向清理映射关系

#### 消息推送 (`sendToUser` / `sendToUsers`)
- 单用户推送：通过 `userId` 查找对应 WebSocket，序列化为 JSON 发送
- 批量推送：遍历用户列表，返回成功送达和未送达的两组 ID 列表

#### 心跳检测 (`startHeartbeat` / `refreshHeartbeat`)
- 启动定时器（`WS_HEARTBEAT_INTERVAL` 秒）扫描所有连接
- 超过 `WS_CONNECTION_TIMEOUT` 未收到心跳的连接被主动关闭（调用 `kickUser`）
- `refreshHeartbeat()` 由 ping 消息处理函数调用，更新时间戳

#### 踢人 (`kickUser`)
- 先发送 `kicked` 消息通知客户端（携带 reason 和 message）
- 延迟 100ms 后关闭连接，确保客户端有足够时间接收踢出通知
- 同步触发 `unregister` 清理映射表

#### 幂等去重 (`isDuplicatePush`)
- 基于 `Set<number>` 实现 LRU 风格的去重缓存
- 超过 `PUSH_DEDUP_SIZE`（默认 10000）时清理 **最旧的一半**（`Array.from(set).slice(0, half)`），而非全量清空

#### 优雅关闭 (`disconnectAll`)
- 遍历所有连接先发送关闭帧（`ws.close(1001, reason)`），再清空映射表
- 配合 `main.ts` 的关闭流程，确保线上用户收到下线通知

### 单例模式

文件末尾导出全局单例 `connectionManager`，所有路由和中间件共享此实例。

## 业务角色

ConnectionManager 是 NovaChat 实时通信能力的**连接枢纽**。它维护了"哪些用户在线"这一核心状态，是消息推送、多端互踢、在线状态感知等功能的基础。网关的所有消息收发最终都落在这个模块上。

## 系统关联

- 由 WebSocket 入口 (`main.ts` 中 `/ws` 处理器) 在连接建立/断开时调用 `register` / `unregister`
- `sendToUser` / `sendToUsers` 被 PushService 路由 (`push.ts`) 用于推送消息
- `kickUser` 由 C++ 后端通过 PushService 的 `KickUser` 端点触发
- 心跳数据与 `config.WS_HEARTBEAT_INTERVAL`（30s）、`WS_CONNECTION_TIMEOUT`（60s）联动
- `isDuplicatePush` + `processedPushIds` 被 PushService 用于幂等去重
- `getOnlineUserIds()` 被 `onlineRegistry` 用于批量心跳刷新
