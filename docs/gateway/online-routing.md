# Phase 2.3 — 网关侧: WebSocket 连接管理 + Redis 全局在线路由表

> **所属服务**: TS Gateway (Fastify + ws)
> **依赖**: Redis (ioredis), ConnectionManager (Phase 1.7)
> **前置 Phase**: 1.7 (网关骨架), 2.1 (JWT 鉴权), 2.2 (C++ Session)

---

## 目录

1. [问题：单网关 vs 多网关](#1-问题单网关-vs-多网关)
2. [解决方案：Redis 全局在线路由表](#2-解决方案redis-全局在线路由表)
3. [新文件详解](#3-新文件详解)
4. [修改文件详解](#4-修改文件详解)
5. [完整数据流](#5-完整数据流)
6. [故障模式与降级](#6-故障模式与降级)
7. [文件清单](#7-文件清单)

---

## 1. 问题：单网关 vs 多网关

### 1.1 单网关时

Phase 1.7 中，所有用户连接在同一个网关节点上。C++ message-service 想推送消息给用户 B 时，只需要知道 B 在哪个网关上。只有一个网关时，答案永远是"本节点"。

```
所有用户 ──→ 唯一的 Gateway ──→ C++ 服务
```

`ConnectionManager` 维护的 `userId → WebSocket` 映射就够用了。

### 1.2 多网关时

当用户量增长，部署多台网关后，问题来了：

```
用户 A → Gateway-1 (深圳)
用户 B → Gateway-2 (上海)

A 发消息给 B:
  Gateway-1 → message-service: {from:A, to:B, msg:"hello"}
  message-service: B 在哪个网关上??
```

**C++ message-service 需要一个全局的在线路由表**，能查到任意用户连接在哪台网关上。

---

## 2. 解决方案：Redis 全局在线路由表

### 2.1 核心思路

Redis 充当**共享的在线状态注册表**。每个网关负责：
- 自己的用户上线时 → 写入 Redis
- 自己的用户下线时 → 从 Redis 删除
- 定期刷新心跳 → 保持 key 存活 (TTL 续期)
- C++ 服务从 Redis 查询用户在哪个网关上

### 2.2 Redis 数据结构

```
Key:   user:online:<user_id>
Value: {"gateway_addr":"10.0.1.5:3000","last_heartbeat":1718360000}
TTL:   30 秒
```

- `gateway_addr`: 网关的外部可达地址，C++ 服务通过此地址 bRPC HTTP 回连
- `last_heartbeat`: 最近一次心跳时间 (unix 毫秒)
- TTL 30 秒: 如果网关崩溃不发送心跳了，30 秒后 key 自动过期 → 用户自动离线

### 2.3 心跳机制

```
Gateway 每 15 秒:
  ├─ 获取本地所有在线 userId 列表
  ├─ Redis pipeline GET 所有 user:online:<uid> key
  ├─ 对每个 key:
  │   ├─ 存在 → 更新 last_heartbeat, SET 新值 + EX 30 (续期)
  │   └─ 不存在 → SET 新值 + EX 30 (重新注册, key 曾过期)
  └─ pipeline EXEC (一次网络往返)
```

心跳间隔 = TTL / 2 = 15 秒。即使用户不活跃，只要网关还在，key 就不会过期。

### 2.4 查询路径

C++ 服务调用网关的 `IsUserOnline` 接口：

```
IsUserOnline(userId):
  Step 1: 查本地 ConnectionManager
          → 在线? 返回 {is_online: true, last_seen_at: now}

  Step 2: 查 Redis GET user:online:<userId>
          → 存在? 用户在另一个网关在线
          → 返回 {is_online: true, last_seen_at: entry.last_heartbeat}

  Step 3: 不在线
          → 返回 {is_online: false, last_seen_at: 0}
```

**关键优化**: 先查本地（最快，无网络 I/O），只有本地不在线时才查 Redis。这样可以避免对本网关在线用户做多余的 Redis 查询。

### 2.5 message-service 的简化推送设计

当前 message-service 的 `PushDispatcher` 采用简化策略：**不查 Redis 在线路由表**，直接将推送请求发送到网关。网关 PushService 自己判断用户是否在线：
- 在线 → WebSocket 实时下发
- 离线 → 跳过推送（消息已存储在 message-service，用户上线后通过 Timeline 拉取）

这种设计将"在线判断"集中在网关层，减少 C++ 服务的外部依赖（不需要 C++ 服务连接 Redis）。

---

## 3. 新文件详解

### 3.1 `gateway/src/redis/client.ts` — Redis 客户端

**职责**: 封装所有 Redis 操作，提供在线路由表的 CRUD。

```
GatewayRedis (单例)
├─ connect()          → new Redis({host, port, retryStrategy})
├─ disconnect()       → client.quit()
├─ setUserOnline(uid) → SET user:online:<uid> <json> EX 30
├─ setUserOffline(uid)→ DEL user:online:<uid>
├─ refreshHeartbeat() → 更新 last_heartbeat + 续期 TTL
├─ refreshHeartbeats()→ pipeline 批量刷新 (10ms → 批处理)
├─ isUserOnline(uid)  → GET user:online:<uid> → OnlineEntry | null
├─ batchCheckOnline() → pipeline GET 多个 key
└─ clearGatewayUsers()-> pipeline DEL 本网关所有用户
```

**降级策略**:
- `connect()` 失败 → `_connected = false`，所有 Redis 操作静默失败
- `maxRetriesPerRequest: 3` → 单次请求最多重试 3 次
- `enableOfflineQueue: false` → Redis 掉线时不排队请求，直接失败
- `retryStrategy`: 最多重连 10 次，间隔递增 (200ms → 1s → 2s → 最多 5s)

**批量操作优化**:
```typescript
// refreshHeartbeats: 用 pipeline 一次网络往返刷新所有用户
const pipeline = this.client.pipeline();
for (const userId of userIds) {
    pipeline.get(`user:online:${userId}`);
}
const results = await pipeline.exec();
// 然后再用 pipeline 批量 SET 更新后的值

// batchOnlineCheck: 同样用 pipeline 一次查询所有用户
```

### 3.2 `gateway/src/ws/online_registry.ts` — 在线状态注册器

**职责**: 连接管理器 (ConnectionManager) 和 Redis 之间的桥梁。

```
OnlineRegistry (单例)
├─ onUserOnline(uid, name) → gatewayRedis.setUserOnline(uid)
├─ onUserOffline(uid)      → gatewayRedis.setUserOffline(uid)
├─ startHeartbeat()        → setInterval(() => refreshHeartbeats())
├─ stopHeartbeat()         → clearInterval()
└─ shutdown()              → clearGatewayUsers() + stopHeartbeat()
```

**心跳实现**:
```typescript
startHeartbeat(): void {
    const intervalMs = config.ONLINE_HEARTBEAT_INTERVAL * 1000;  // 15s
    this.heartbeatTimer = setInterval(async () => {
        const userIds = connectionManager.getOnlineUserIds();
        if (userIds.length === 0) return;
        if (!gatewayRedis.connected) return;
        await gatewayRedis.refreshHeartbeats(userIds);
    }, intervalMs);
}
```

**优雅关闭**:
```typescript
async shutdown(): Promise<void> {
    this.stopHeartbeat();
    const userIds = connectionManager.getOnlineUserIds();
    await gatewayRedis.clearGatewayUsers(userIds);
    // Redis 中本网关所有在线用户被立即清除，不会等 TTL 过期
}
```

---

## 4. 修改文件详解

### 4.1 `gateway/src/config/index.ts` — 新增配置

```typescript
// 本网关节点的外部可达地址
GATEWAY_ADDR: process.env.GATEWAY_ADDR || `127.0.0.1:${...}`,

// Redis 连接
REDIS_ADDR: process.env.REDIS_ADDR || "127.0.0.1:6379",
REDIS_PASSWORD: process.env.REDIS_PASSWORD || "",

// 在线路由表 TTL
REDIS_ONLINE_TTL: 30,           // 秒
ONLINE_HEARTBEAT_INTERVAL: 15,  // 秒 (TTL 的一半)
```

### 4.2 `gateway/src/routes/push.ts` — IsUserOnline / BatchOnlineCheck 升级

**之前 (Phase 1.7)**:
```typescript
// IsUserOnline — 只查本地
is_online = connectionManager.isOnline(user_id);
last_seen_at = 0;  // TODO
```

**现在 (Phase 2.3)**:
```typescript
// 1. 先查本地
if (connectionManager.isOnline(user_id)) {
    return { is_online: true, last_seen_at: Date.now() };
}

// 2. 查 Redis — 跨网关
if (gatewayRedis.connected) {
    const entry = await gatewayRedis.isUserOnline(user_id);
    if (entry) {
        return { is_online: true, last_seen_at: entry.last_heartbeat };
    }
}

// 3. 不在线
return { is_online: false, last_seen_at: 0 };
```

`BatchOnlineCheck` 同理：先本地 → 对剩余用户批量查 Redis pipeline → 汇总。

### 4.3 `gateway/src/main.ts` — 生命周期集成

```
启动:
  gatewayRedis.connect()        // 连接 Redis
  app.listen()                  // 启动 HTTP/WS 服务
  onlineRegistry.startHeartbeat() // 启动心跳定时器
  sessionStore.startCleanupTimer()

用户认证成功 (handleAuth):
  connectionManager.register(uid, name, ws)
  onlineRegistry.onUserOnline(uid, name)  // 写入 Redis ← NEW

连接关闭 (socket.on("close")):
  connectionManager.unregister(socket)
  onlineRegistry.onUserOffline(uid)       // 删除 Redis key ← NEW

优雅关闭 (SIGINT/SIGTERM):
  onlineRegistry.stopHeartbeat()
  onlineRegistry.shutdown()               // 清除 Redis 中本网关所有用户 ← NEW
  gatewayRedis.disconnect()               // 断开 Redis ← NEW
  connectionManager.disconnectAll()
  app.close()
```

---

## 5. 完整数据流

### 5.1 用户上线

```
1. Client → WebSocket → Gateway
   { type: "auth", payload: { access_token: "eyJ..." } }

2. Gateway main.ts handleAuth():
   ├─ verifyAccessToken → { user_id: 123, username: "alice" }
   ├─ connectionManager.register(123, "alice", ws)
   │   └─ 本地: byUserId.set(123, {ws, ...})
   │
   └─ onlineRegistry.onUserOnline(123, "alice")          ← Phase 2.3
       └─ gatewayRedis.setUserOnline(123)
           └─ Redis: SET user:online:123
                     '{"gateway_addr":"gateway-1:3000","last_heartbeat":...}'
                     EX 30
```

### 5.2 消息推送 (跨网关)

```
A (gateway-1) 发消息给 B (gateway-2):

1. Gateway-1 → message-service:
   POST /nova.message.MessageService/SendMessage
   { from: A, to: B, text: "hello" }

2. message-service:
   ├─ 查 Redis: GET user:online:<B的ID>
   │   → {"gateway_addr":"gateway-2:3000","last_heartbeat":...}
   │   → B 在 gateway-2 上!                                   ← Phase 2.3 的关键
   │
   └─ bRPC HTTP → gateway-2:3000
       POST /nova.gateway.PushService/PushUpdate
       { target_user_id: B的ID, update: { type: NEW_MESSAGE, ... } }

3. gateway-2 PushService:
   ├─ connectionManager.getByUserId(B的ID)
   │   → WebSocket 对象
   └─ ws.send(JSON.stringify(update))
       → B 收到消息!
```

### 5.3 用户下线

```
1. Client B 关闭 WebSocket
   socket.on("close"):

2. connectionManager.unregister(socket)
   └─ 本地: byUserId.delete(B的ID)

3. onlineRegistry.onUserOffline(B的ID)                      ← Phase 2.3
   └─ gatewayRedis.setUserOffline(B的ID)
       └─ Redis: DEL user:online:<B的ID>

4. 此时 message-service 再查 Redis:
   GET user:online:<B的ID> → nil → B 不在线 → 存储为离线消息
```

### 5.4 心跳续期

```
每 15 秒 (所有网关同时):

Gateway-1:
  userIds = [A, C, D] (本地在线用户)
  Redis pipeline:
    GET user:online:<A> → 存在 → SET ... EX 30
    GET user:online:<C> → 存在 → SET ... EX 30
    GET user:online:<D> → 不存在! → 重新 SET ... EX 30

如果某网关崩溃，其用户 key 30 秒后自动过期 → 被标记为离线
```

---

## 6. 故障模式与降级

### 6.1 Redis 不可用

```
场景: Redis 服务器宕机

Gateway 行为:
  - gatewayRedis.connect() 失败 → _connected = false
  - onUserOnline() 静默失败 → 用户正常连接，只是不写入 Redis
  - IsUserOnline: 跳过 Redis 查询，只返回本地结果
  - 日志: "Redis not available, cross-gateway online queries disabled"

影响:
  - 单网关: 无影响
  - 多网关: C++ 服务无法跨网关推送 → 消息被存储为离线
             用户重新上线后拉取 (Phase 3.1 Timeline 拉取)

恢复:
  - Redis 恢复后不自动重连 (需要重启网关或手动触发)
  - 所有在线用户的下次心跳会重新写入 Redis
```

### 6.2 网关崩溃

```
场景: gateway-1 进程异常退出

Redis 行为:
  - 崩溃前未执行 shutdown() 清理
  - 但 user:online:* key 设置了 30s TTL
  - 30 秒后 key 自动过期 → Redis 自动清理

C++ 服务:
  - 30 秒内查 Redis → 认为用户在线 → 推送失败
  - 推送失败后标记为离线 → 消息转为离线存储
  - 30 秒后查 Redis → 用户不在线 → 直接离线存储

用户:
  - 重新连接其他网关 → 新网关写入新的 Redis key
```

### 6.3 单网关本地判断优先

```
IsUserOnline 查询顺序保证：
  1. 本地 map 查询 (无网络 I/O, <1μs)
  2. Redis GET (网络 I/O, ~1ms)
  3. 返回 false

好处: 对本节点用户查询极快，不依赖 Redis
```

---

## 7. 文件清单

| 文件 | 动作 | 说明 |
|------|------|------|
| `gateway/src/redis/client.ts` | **新建** | ioredis 封装，在线路由表 CRUD + pipeline 批量操作 |
| `gateway/src/ws/online_registry.ts` | **新建** | ConnectionManager ↔ Redis 桥梁，心跳维护 |
| `gateway/src/config/index.ts` | 修改 | +GATEWAY_ADDR, REDIS_ADDR, ONLINE_HEARTBEAT_INTERVAL 等 |
| `gateway/src/routes/push.ts` | 修改 | IsUserOnline/BatchOnlineCheck 升级为全局查询 |
| `gateway/src/main.ts` | 修改 | 启动时连 Redis + 上下线写 Redis + 优雅关闭清理 |
| `gateway/package.json` | 修改 | +ioredis |

---

> **最后更新**: 2026-06-21
> **相关文档**: [[../services/password-and-session.md]] (Phase 2.2 C++ 侧 Session 管理)
