# NovaChat — 网关（Gateway）详解

> 网关是整个系统的"前台接待大厅"。所有客户端都只和网关说话，网关再替它们去后端办事。

---

## 目录

1. [为什么需要网关？](#1-为什么需要网关)
2. [网关的四个核心职责](#2-网关的四个核心职责)
   - [职责 1：连接保持器 — 管理海量 WebSocket 长连接](#职责-1连接保持器--管理海量-websocket-长连接)
   - [职责 2：安全守门人 — JWT 鉴权 + 限流](#职责-2安全守门人--jwt-鉴权--限流)
   - [职责 3：协议翻译官 — HTTPJSON--c-protobuf](#职责-3协议翻译官--httpjson--c-protobuf)
   - [职责 4：反向推送的终点站 — C++ 服务调网关](#职责-4反向推送的终点站--c-服务调网关)
3. [网关 vs 后端服务：责任边界](#3-网关-vs-后端服务责任边界)
4. [多网关部署：水平扩展](#4-多网关部署水平扩展)
5. [总结](#5-总结)

---

## 1. 为什么需要网关？

### 没有网关的架构 — 客户端直连后端

```
┌──────┐ ───TCP 长连接───→  user-service    (:8001)
│Client│ ───TCP 长连接───→  message-service (:8002)
│      │ ───TCP 长连接───→  media-service   (:8003)
└──────┘

问题:
  1. 客户端要维护 3 条 TCP 连接（耗电、占内存）
  2. 每个服务都要自己处理鉴权、限流、TLS 加密（重复代码）
  3. 后端服务地址暴露给客户端（安全风险）
  4. 客户端升级时需要后端所有服务配合（耦合）
```

### 有网关的架构 — 客户端只连网关

```
┌──────┐  1 条 WebSocket    ┌──────────┐ ──HTTP──→ user-service    (:8001)
│Client│ ════════════════→  │ Gateway  │ ──HTTP──→ message-service (:8002)
└──────┘                    │ (TS BFF) │ ──HTTP──→ media-service   (:8003)
                            └──────────┘

好处:
  1. 客户端只需维护 1 条连接
  2. 鉴权/限流/TLS 全部在网关统一处理
  3. 后端服务地址对外不可见
  4. 后端服务拆分/升级/迁移对客户端透明
```

---

## 2. 网关的四个核心职责

### 职责 1：连接保持器 — 管理海量 WebSocket 长连接

这是网关最底层的职能。IM 系统需要服务端能**主动推送消息给客户端**（收到新消息时不需要刷新页面），所以不能用普通的 HTTP 请求-响应模式，必须是**长连接**。

```
客户端 A                      网关                       客户端 B
────────                      ────                       ────────
│                             │                             │
│ ═══ WebSocket 连接 ═══════  │  ═══ WebSocket 连接 ═══════ │
│      (一直连着)              │       (一直连着)             │
│                             │                             │
│  发普通 HTTP 拿历史消息:      │                             │
│  GET /messages  ──────────→ │ ──→ message-service         │
│                     ←────── │ ←── 返回历史消息             │
│                             │                             │
│                             │  ← message-service 推送:     │
│                             │    "有新消息给 B"            │
│                             │ ──→ 找到 B 的 WebSocket     │
│                             │     直接推给 B               │
│                             │                     ← 收到! │
│                             │                             │
│  用户 A 不知道网关的存在       │  网关知道每个连接是谁         │
│  它只知道自己连着"服务器"     │  (userId → WebSocket 映射)  │
```

**网关内部维护的核心数据结构**：

```typescript
// userId → WebSocket 连接的映射表
const onlineUsers = new Map<int64, WebSocket>();

// 用户上线时:
onlineUsers.set(userId, websocket);

// 推送消息给用户 B 时:
const ws = onlineUsers.get(targetUserId);
if (ws) {
    ws.send(JSON.stringify(messageUpdate));
}
```

### 职责 2：安全守门人 — JWT 鉴权 + 限流

客户端发来的每个请求，网关都是第一道关卡。C++ 后端不需要关心"这个请求是谁发的、有没有权限"。

```
┌──────────┐     WebSocket msg      ┌──────────────┐      HTTP POST        ┌──────────────┐
│  Client  │  { type: "send_msg",   │   Gateway    │  { user_id: 123,      │  message-    │
│          │    token: "eyJh...",   │              │    msg: "hello" }     │  service     │
│          │    to: 456,            │  ① 验 JWT:   │                       │              │
│          │    msg: "hello" }      │    解析 token │                       │  ③ 信任网关  │
│          │───────────────────────→│    ↓          │──────────────────────→│    直接处理  │
│          │                       │    user_id=123│                       │              │
│          │                       │    ↓          │                       │              │
│          │                       │  ② 检查限流:  │                       │              │
│          │                       │    这个用户   │                       │              │
│          │                       │    1 秒发了   │                       │              │
│          │                       │    100 条?    │                       │              │
│          │                       │    ↓ 是 → 拒绝│                       │              │
│          │                       │    ↓ 否 → 放行│                       │              │
└──────────┘                       └──────────────┘                       └──────────────┘
```

**关键设计 — 边界鉴权**：C++ 后端收到的请求中带有网关注入的 `user_id`，后端**信任网关已验证过身份**，不再重复校验。

### 职责 3：协议翻译官 — HTTP/JSON ↔ C++ Protobuf

这是 NovaChat BFF 架构的核心巧思：

```
客户端 ←──WebSocket (JSON)──→ 网关 ←──HTTP (JSON)──→ bRPC/Protobuf ←→ C++ 服务

                    网关在这里做协议转换
                    左边说"JSON 方言"  右边说"Protobuf 官话"
```

在 NovaChat 中，**网关不需要手写 Protobuf 编解码**。因为 bRPC 的 `http+pb` 模式让 C++ 服务直接接收 HTTP/JSON 请求。网关只需要：

```typescript
// 网关做的就是发 HTTP 请求，C++ 服务自己理解 JSON
const resp = await fetch(
    "http://user-service:8001/nova.user.UserService/Register",
    {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice", password: "***" })
    }
);
// bRPC 在 C++ 侧自动把 JSON 转成 Protobuf
```

**这就是 bRPC 节约的代码量**：如果 C++ 服务只能用 Protobuf 二进制协议，网关就得引入 protobuf 库、生成 TS 代码、手写编解码。现在网关只需 `fetch()`。

### 职责 4：反向推送的终点站 — C++ 服务调网关

这是 NovaChat 架构中最特殊的通信方向——**C++ 服务主动调用网关**。

传统 HTTP 架构中，只有客户端调服务端。但 IM 系统中，服务端需要主动告诉客户端"你有新消息"。因为客户端只连网关，所以 C++ 服务需要通过网关才能触达用户。

```
消息发送的完整链路:

A 发 "Hello" 给 B
═══════════════════

Step 1: A → 网关 (WebSocket)
  { type: "send_msg", to: 456, msg: "Hello" }

Step 2: 网关 → message-service (HTTP)
  POST /nova.message.MessageService/SendMessage
  { from: 123, to: 456, msg: "Hello" }

Step 3: message-service 处理:
  ├─ Snowflake 生成 msg_id
  ├─ 写入 MySQL
  └─ 查 Redis: B 在线，连在 gateway-node-2

Step 4: message-service → 网关 (HTTP, bRPC 反向推送)
  POST /nova.gateway.PushService/PushUpdate
  { target_user_id: 456, update: { type: "NEW_MESSAGE", ... } }
       │
       └── 网关收到这个 HTTP 请求
          ├─ 查到 B 的 WebSocket 连接
          └─ ws.send(JSON.stringify(update))
                  │
                  └── B 收到新消息！
```

**在这个场景中，网关同时扮演了两个角色**：

- 对外（客户端）：WebSocket 服务端
- 对内（C++ 服务）：HTTP 服务端（`PushService` 接口的实现者）

---

## 3. 网关 vs 后端服务：责任边界

| 关注点 | 网关 (TS Gateway) | C++ 后端服务 |
|-------|------------------|-------------|
| 连接管理 | ✅ 维护 WebSocket 长连接 | ❌ 无状态，不保持连接 |
| 鉴权 | ✅ JWT 校验、Session 管理 | ❌ 信任网关注入的 user_id |
| 限流 | ✅ 每用户/每 IP 频率控制 | ❌ |
| 协议转换 | ✅ 接收客户端 JSON，发 HTTP 给后端 | ❌ (bRPC 自动处理) |
| 业务逻辑 | ❌ 不处理 IM 业务逻辑 | ✅ 消息存储、有序投递、ACK |
| 在线路由 | ✅ 注册/维护 Redis 在线表 | ✅ 查表后反向推送 |
| 消息推送 | ✅ WebSocket 推给客户端 | ❌ 通过 HTTP 调网关的 PushService |
| 性能敏感计算 | ❌ Node.js 不适合 CPU 密集 | ✅ C++ 榨干 CPU |

---

## 4. 多网关部署：水平扩展

当用户量增长到单台网关扛不住时，部署多台网关：

```
                        ┌──────────────┐
          ┌─────────────│  Redis       │  (在线路由表)
          │             │  user:123 →  │
          │             │  gateway-1   │
          │             │  user:456 →  │
          │             │  gateway-3   │
          │             └──────────────┘
          │                    ↑
          │       注册/查询在线位置  │
          │                    │
  ┌───────┴──┬────────┬────────┴──┬────────────┐
  │          │        │           │            │
  ▼          ▼        ▼           ▼            ▼
┌──────┐ ┌──────┐ ┌──────┐   ┌──────┐    ┌──────────┐
│Gate-1│ │Gate-2│ │Gate-3│   │user- │    │message-  │
│(深圳)│ │(上海)│ │(北京)│   │svc   │    │svc       │
└──────┘ └──────┘ └──────┘   └──────┘    └──────────┘
    │        │        │
    │        │        │
 用户A     用户B    用户C
(连深圳) (连上海)  (连北京)

场景: A(深圳) 发消息给 C(北京):
  1. A → Gate-1 (WebSocket): "给 C 发 Hello"
  2. Gate-1 → message-service (HTTP): { from: A, to: C, msg: "Hello" }
  3. message-service 查 Redis: C 在 Gate-3
  4. message-service → Gate-3 (HTTP Push): { target: C, ... }
  5. Gate-3 → C (WebSocket): "A 说 Hello"
```

**每一台网关只负责自己身上的客户端**，它们之间不直接通信。C++ message-service 充当了"中央调度"，通过查 Redis 在线路由表决定推送到哪台网关。

---

## 5. 总结

```
                              ┌─────────────────────────┐
                              │       GATEWAY            │
                              │                          │
  客户端只跟一个人说话 ──────→ │  "您好，请问要办什么业务？"   │
                              │                          │
                              │  ① 请出示证件 (JWT 鉴权)   │
                              │  ② 你刚才已经来过3次了      │
                              │     请稍后再来 (限流)      │
                              │  ③ 注册业务 → 转 user 部   │ ──→ user-service
                              │  ④ 发消息   → 转 message 部│ ──→ message-service
                              │  ⑤ 您有 new_msg → 请查收   │ ←── message-service 来电
                              │     (WebSocket 推送)      │
                              └─────────────────────────┘
```

**本质上**，网关不处理任何 IM 业务逻辑（不存消息、不建群、不推流），它是**纯粹的 I/O 层**——把所有 CPU 密集的计算都转发给 C++ 后端，自己只专注于"接待大量客户并正确分发请求"。

这也正是 BFF（Backend For Frontend）模式的核心思想：**前端需要什么，BFF 就给什么，后端服务不需要为前端定制**。

---

> **最后更新**: 2026-06-21
> **相关文档**: [[NovaChat.md]] (项目设计) | [[ProjectDiscription.md]] (数据流转) | [[Dev.md]] (开发日志)
