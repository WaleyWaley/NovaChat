# NovaChat — 代码全景梳理

> 一份文档讲清楚 NovaChat 所有代码的业务职责和数据流向。
> 配合实际文件和行号，看完就能上手改代码。

---

## 目录

1. [项目全景图](#1-项目全景图)
2. [业务层：每个服务做什么](#2-业务层每个服务做什么)
3. [数据流：一条消息的完整旅程](#3-数据流一条消息的完整旅程)
4. [代码索引：改什么功能找哪个文件](#4-代码索引改什么功能找哪个文件)
5. [当前进度与架构决策](#5-当前进度与架构决策)

---

## 1. 项目全景图

```
┌────────────────────────────────────────────────────────────────────┐
│                        NovaChat 项目结构                            │
│                                                                    │
│  proto/                    ← 接口定义 (语言无关的"合同")             │
│  services/common/          ← C++ 共享库 (Snowflake/Redis/MySQL/密码) │
│  services/user-service/    ← C++ 用户服务 (注册/登录/资料)          │
│  services/message-service/ ← C++ 消息服务 (发送/存储/推送/ACK/同步)  │
│  gateway/                  ← TS 网关 (WebSocket/HTTP/鉴权/在线路由)  │
│  scripts/                  ← 构建脚本 (proto-gen / docker)          │
│  cmake/                    ← CMake 模块                             │
│  docs/                     ← 文档                                   │
└────────────────────────────────────────────────────────────────────┘
```

**5 个 Docker 容器**：

```
                    ┌──────────┐   ┌──────────┐
                    │  MySQL   │   │  Redis   │
                    │  :3306   │   │  :6379   │
                    └────┬─────┘   └────┬─────┘
                         │              │
              ┌──────────┴──────┬───────┴──────────┐
              │                 │                   │
         ┌────▼─────┐    ┌──────▼──────┐    ┌───────▼──────┐
         │  user-   │    │  message-   │    │   gateway    │
         │  service │    │  service    │    │   (TS BFF)   │
         │  :8001   │    │  :8002      │    │   :3000      │
         │  (C++)   │    │  (C++)      │    │   (Node.js)  │
         └──────────┘    └─────────────┘    └──────────────┘
              │                 │                   │
              └─────────────────┴───────────────────┘
                        内部通信走 HTTP+JSON
```

---

## 2. 业务层：每个服务做什么

### 2.1 user-service (C++ bRPC, 端口 8001)

**一句话**：管理用户的"人"信息——谁能用这个系统、他是谁。

**入口文件**：`services/user-service/server.cc`
**核心逻辑**：`services/user-service/user_service_impl.cc`（640 行）
**数据层**：`services/user-service/user_dao.cc`（688 行）

**12 个 RPC 方法，分 5 组**：

```
认证:    Register / Login / RefreshToken / Logout
         └─ Register = 注册即登录, 直接返回 Token
         └─ RefreshToken = Token 轮转, 旧 token 立即失效
         └─ Logout = 清除所有 Session

资料:    GetUserProfile / GetUsers
         └─ GetUserProfile 支持按 user_id 或 username 查
         └─ GetUsers 批量查, max 100 个

修改:    UpdateProfile / ChangeUsername / CheckUsername / ChangePassword
         └─ ChangePassword 后清除所有 Session (强制重登)
         └─ ChangeUsername 有频率限制 (1 小时)

搜索:    SearchUsers
         └─ username / first_name 前缀匹配

管理:    DeleteAccount
         └─ 需要密码二次确认 + 软删除
```

**关键代码路径**（一次 Register 请求）：

```
server.cc:116  UserServiceImpl service_impl(&snowflake, &user_dao);
server.cc:125  server.AddService(&service_impl, ...)    ← 注册到 bRPC
server.cc:139  server.Start(...)                         ← 开始监听 :8001
                        ↓
收到 POST /nova.user.UserService/Register
                        ↓
user.brpc.cc  CallMethod() → 根据 method->name() 分发
                        ↓
user_service_impl.cc  UserServiceImpl::Register()
  ├─ 参数校验: ValidateUsername / ValidatePassword
  ├─ snowflake_->NextId() → 生成全局唯一 user_id
  ├─ nova::HashPassword(password) → PBKDF2-SHA256 哈希
  ├─ user_dao_->CreateUser(...) → 存入 MySQL (或内存)
  ├─ 签发 access_token + refresh_token
  ├─ user_dao_->CreateSession() → 存入 Redis (或内存)
  └─ FillUserProfile() → 填充响应 JSON
```

---

### 2.2 message-service (C++ bRPC, 端口 8002)

**一句话**：管理"消息"的生命周期——谁对谁说了什么，存起来，然后推送给对方。

**入口文件**：`services/message-service/server.cc`（102 行）
**核心逻辑**：`services/message-service/message_service_impl.cc`（246 行）
**数据层**：`services/message-service/message_dao.cc`（151 行）
**推送层**：`services/message-service/push_dispatcher.cc`（102 行）

**4 个 RPC 方法**：

```
SendMessage:     发一条消息
                 ├─ Snowflake 生成 msg_id
                 ├─ idempotency_key 去重检查
                 ├─ message_dao.SaveMessage() 存储
                 ├─ 填充响应 (message_id + is_new)
                 └─ 非静默 & to_peer 是用户 → push_dispatcher.PushToUser()

GetMessages:     拉取对话历史 (Timeline 模型)
                 ├─ 按 to_peer (对话) 过滤
                 ├─ offset_id 游标分页 (向下翻)
                 └─ has_more 标记是否还有更多

AckMessage:      (Phase 3) 消息送达/已读确认
                 ├─ 更新指定对话中 <= max_ack_msg_id 的所有消息状态
                 └─ DELIVERED 或 READ

GetSyncState:    (Phase 3) 上线增量同步
                 ├─ 批量查询多对话的服务器端最新状态
                 └─ 返回 latest_msg_id + unread_count + last_ack_msg_id
```

**关键代码路径**（一次 SendMessage + Push）：

```
收到 POST /nova.message.MessageService/SendMessage
                        ↓
message_service_impl.cc:44  SendMessage()
  ├─ ValidateSendRequest() 参数校验
  ├─ snowflake_->NextId() → msg_id
  ├─ idempotency_key 去重 (重复返回 is_new=false)
  ├─ dao_->SaveMessage(record, idempotency_key) → 存储消息
  ├─ 填充 response (message_id + created_at + peer info)
  │
  └─ if (!is_silent && to_peer.type == PEER_TYPE_USER) {
        update.set_type(UPDATE_NEW_MESSAGE);
        push_->PushToUser(to_user_id, update);     ← 触发推送!
     }
                        ↓
push_dispatcher.cc:24  PushToUser()
  ├─ 构造 PushUpdateReq { target_user_id, update }
  └─ CallGatewayPush(req)
       ├─ protobuf → JSON 序列化
       ├─ brpc::Channel HTTP POST → gateway:3000
       │   /nova.gateway.PushService/PushUpdate
       └─ 返回成功/失败
```

**PushDispatcher 简化设计**：不查 Redis 在线路由表，直接向网关推送。网关 PushService 自己判断用户是否在线。在线则 WebSocket 实时下发，离线则跳过（消息已存储在 message-service，用户上线后通过 GetMessages 拉取）。

---

### 2.3 gateway (TypeScript Fastify, 端口 3000)

**一句话**：整个系统的"前台"——客户端只跟它说话，它负责接待、鉴权、转发。

**入口文件**：`gateway/src/main.ts`（557 行）
**配置**：`gateway/src/config/index.ts`（105 行）

**网关有 3 个"面孔"**：

```
面孔 1: 对客户端 — WebSocket 服务端
        客户端连接 ws://gateway:3000/ws
        发送 JSON 消息: {type: "auth"|"send_msg"|"ping"|"rpc"|"typing"|"read"}
        接收服务器推送: {type: "update"|"auth_ok"|"error"|"pong"|"kicked"|"rpc_result"}

面孔 2: 对 C++ 服务 — HTTP 客户端
        user_client.ts    → POST http://user-service:8001/...  (12 RPCs)
        message_client.ts → POST http://message-service:8002/... (2 RPCs)

面孔 3: 对 C++ 服务 — HTTP 服务端 (PushService)
        接收 C++ 服务的反向推送:
        POST /nova.gateway.PushService/PushUpdate
        网关查本地 WebSocket 连接 + Redis 全局路由表 → 推给目标用户
```

**网关的业务模块**：

```
src/
├── main.ts              ← 启动入口 + WebSocket 消息处理 + 优雅关闭
├── config/index.ts      ← 25+ 环境变量配置
├── auth/
│   ├── jwt.ts           ← JWT 验证 (RS256/HS256 + session 失效检测)
│   ├── keys.ts          ← 密钥管理 (kid → 公钥映射, 支持轮转)
│   └── session.ts       ← Session 生命周期 (InMemorySessionStore)
├── middleware/
│   ├── auth.ts          ← HTTP 鉴权中间件 (四级白名单 + 差异化错误码)
│   └── rate_limiter.ts  ← 令牌桶限流 (IP + 用户双重)
├── ws/
│   ├── connection.ts    ← ConnectionManager (userId↔WebSocket 映射 + push去重)
│   ├── protocol.ts      ← WebSocket 消息类型定义 (6 Client + 6 Server)
│   └── online_registry.ts ← Redis 在线路由表 (上下线 + 心跳 + 优雅关闭)
├── redis/client.ts      ← ioredis 封装 (在线路由表读写 + pipeline批量)
├── clients/
│   ├── user_client.ts   ← 调用 user-service (继承 BrpcClient)
│   ├── message_client.ts ← 调用 message-service (sendMessage + getMessages)
│   ├── base.ts          ← BrpcClient 基类 (HTTP POST → bRPC http+pb)
│   └── service_registry.ts ← 服务发现注册表 (user/message/media)
└── routes/
    ├── health.ts        ← /health 健康检查
    ├── push.ts          ← PushService (C++ 反向推送入口, 6个端点 + Redis 全局限流)
    └── user.ts          ← /api/auth/* + /api/users/* (12 个 REST 端点)
```

**WebSocket 消息处理流程**（`main.ts`）：

```
socket.on("message") →
  ├─ type="auth"     → verifyAccessToken → connectionManager.register
  │                    → onlineRegistry.onUserOnline → Redis 路由表
  ├─ type="ping"     → pong 回复 + refreshHeartbeat
  ├─ type="send_msg" → messageClient.sendMessage() → message-service
  │                    → 返回 message_id → 回复客户端 "sent"
  ├─ type="rpc"      → proxyUserService() → user-service → 返回结果
  ├─ type="typing"   → (Phase 4 实现)
  └─ type="read"     → (Phase 4 实现)

socket.on("close") →
  ├─ connectionManager.unregister()
  └─ onlineRegistry.onUserOffline() → Redis DEL key
```

---

## 3. 数据流：一条消息的完整旅程

### 3.1 注册流程

```
用户打开 App → 填 username/password → 点注册

Step 1: App → WebSocket → 网关
  发送: { type: "rpc", seq: 1, payload: { service: "nova.user.UserService",
    method: "Register", body: { username, password, first_name } } }

Step 2: 网关 main.ts → userClient.register()
  POST http://user-service:8001/nova.user.UserService/Register
  Content-Type: application/json
  Body: {"username":"alice","password":"***","first_name":"Alice"}

Step 3: bRPC 收到 HTTP POST
  ├─ 解析 URL → service="nova.user.UserService", method="Register"
  ├─ JSON → RegisterReq (自动转换)
  └─ 调用 UserServiceImpl::Register()

Step 4: UserServiceImpl::Register()
  ├─ ValidateUsername("alice") → OK (3-32 chars, 字母开头)
  ├─ ValidatePassword("***") → OK (8-128 chars)
  ├─ user_dao_->UsernameExists("alice") → false
  ├─ snowflake_->NextId() → user_id = 333855473985916928 (全局唯一)
  ├─ nova::HashPassword("***") → "$pbkdf2-sha256$100000$abcd...$ef01..."
  ├─ user_dao_->CreateUser(...)
  │   └─ MySQL: INSERT INTO users (...) VALUES (...)
  │   └─ 或内存: users_by_id_[user_id] = record
  ├─ 签发 Token 对 (access_token + refresh_token)
  ├─ user_dao_->CreateSession(...)
  │   └─ Redis: SET sess:<token> "<uid>|<exp>|<dev>|<name>" EX <ttl>
  │   └─ 或内存: sessions_[token] = session
  └─ 返回: { user_id, access_token, refresh_token, user: {...} }

Step 5: bRPC 响应 → RegisterResp → JSON → HTTP 200
Step 6: 网关 → WebSocket → App 收到 { error_code: 0, user_id, token }
```

### 3.2 发送消息流程 (端到端)

```
Alice 给 Bob 发 "Hello Bob!"

Step 1: Alice's App → WebSocket → 网关
  { type: "send_msg", seq: 10, payload: {
    peer_type: 1,    // PEER_TYPE_USER
    peer_id: <bob_id>,
    msg_type: 0,     // TEXT
    text: "Hello Bob!"
  }}

Step 2: 网关 main.ts handleSendMessage() → messageClient.sendMessage()
  POST http://message-service:8002/nova.message.MessageService/SendMessage
  Body: {
    from_peer: { type: 1, id: <alice_id> },
    to_peer:   { type: 1, id: <bob_id> },
    msg_type: 0,
    text: "Hello Bob!"
  }

Step 3: bRPC → message_service_impl.cc:44 SendMessage()
  ├─ ValidateSendRequest() → OK
  ├─ snowflake_->NextId() → msg_id = 333855523432570880
  ├─ idempotency_key 去重检查 → 新消息
  ├─ dao_->SaveMessage({msg_id, from, to, text, ...})
  │   └─ 内存: messages_ 按 message_id 降序插入
  ├─ 填充 response: { message_id, from_peer, to_peer, text, created_at, is_new: true }
  │
  └─ push_->PushToUser(bob_id, update)
      │
      ├─ 构造 PushUpdateReq {
      │    target_user_id: <bob_id>,
      │    update: { type: UPDATE_NEW_MESSAGE, ... }
      │  }
      │
      ├─ protobuf → JSON 序列化
      │
      └─ brpc::Channel HTTP POST → gateway:3000
          /nova.gateway.PushService/PushUpdate
          Body: {"target_user_id":<bob_id>,"update":{...}}

Step 4: 网关 push.ts PushUpdate handler
  ├─ push_id 幂等去重
  ├─ connectionManager.isOnline(bob_id) ?
  │   ├─ YES → connectionManager.sendToUser(bob_id, update)
  │   │         → ws.send(JSON.stringify(update))
  │   │         → Bob 实时收到消息! 🎉
  │   │         → 返回 { delivered: true }
  │   └─ NO  → 返回 { delivered: false }
  │             → Bob 离线, 下次上线通过 GetMessages 拉取

Step 5: 网关 → Alice's WebSocket
  { type: "rpc_result", seq: 10, payload: {
    error_code: 0,
    data: { message_id: 333855523432570880, status: "sent" }
  }}
  → Alice 看到 "已发送" ✓

Step 6: Bob 上线后, App 拉取历史
  POST http://message-service:8002/nova.message.MessageService/GetMessages
  Body: { peer: { type: 1, id: <bob_id> }, limit: 20, offset_id: 0 }
  → 返回 Alice 的消息 → Bob 看到 "Hello Bob!"
```

### 3.3 数据在各层级的形式

```
层级                    数据形态                        示例
────                    ────────                        ────
App (客户端)            JS Object                       { type: "send_msg", payload: {...} }
WebSocket Wire          JSON 字符串                     '{"type":"send_msg","payload":{...}}'
网关 (TS)               TS interface                    ClientSendMessage
网关 → C++ (HTTP)       JSON body                       '{"from_peer":{"type":1,...},...}'
bRPC 解析后             C++ Protobuf 对象               SendMessageReq { from_peer(), to_peer(), text() }
C++ 内部                C++ struct                      MessageRecord { message_id, text, ... }
DAO 存储                MySQL 行 / 内存 vector           (message_id, from_id, to_id, text, created_at)
PushDispatcher → 网关   JSON body                       '{"target_user_id":...,"update":{...}}'
响应 bRPC               C++ Protobuf 对象               SendMessageResp { message(), error_code() }
bRPC → JSON             JSON 字符串                     '{"message":{"message_id":...,"text":"..."}}'
网关 → App              JSON → JS Object                { type: "update", payload: {...} }
```

---

## 4. 代码索引：改什么功能找哪个文件

### 我要改...

| 需求 | 文件 | 关键方法 |
|------|------|----------|
| 改注册逻辑 | `services/user-service/user_service_impl.cc` | `Register()` |
| 改密码规则 | `services/user-service/user_service_impl.cc` | `ValidatePassword()` |
| 改用户名规则 | `services/user-service/user_service_impl.cc` | `ValidateUsername()` |
| 改 Token 签发 | `services/user-service/user_service_impl.cc` | `Register()` / `Login()` |
| 改密码哈希 | `services/common/src/password.cpp` | `HashPassword()` / `CheckPassword()` |
| 改用户存储 (加字段) | `proto/nova/common/common.proto` | `UserProfile` message |
| 改用户存储 (换数据库) | `services/user-service/user_dao.cc` | `CreateUser` / `FindById` |
| 改 Session 格式 | `services/user-service/user_dao.cc` | `CreateSession` / `EncodeSession` |
| 改 SendMessage 逻辑 | `services/message-service/message_service_impl.cc` | `SendMessage()` |
| 改消息去重策略 | `services/message-service/message_dao.cc` | `SaveMessage()` / `Idempotency` |
| 改消息 ACK | `services/message-service/message_service_impl.cc` | `AckMessage()` |
| 改同步状态 | `services/message-service/message_service_impl.cc` | `GetSyncState()` |
| 改推送策略 | `services/message-service/push_dispatcher.cc` | `PushToUser()` / `CallGatewayPush()` |
| 改推送目标网关 | `services/message-service/server.cc` | `push.Init()` |
| 改消息存储 (换数据库) | `services/message-service/message_dao.cc` | `SaveMessage` / `GetMessages` |
| 改 WebSocket 消息格式 | `gateway/src/ws/protocol.ts` | `ClientMessage` / `ServerMessage` |
| 改 WS 连接管理 | `gateway/src/ws/connection.ts` | `ConnectionManager` |
| 改在线路由表 | `gateway/src/redis/client.ts` + `gateway/src/ws/online_registry.ts` | |
| 改网关 → C++ 调用 | `gateway/src/clients/user_client.ts` | 或 `message_client.ts` |
| 改 JWT 鉴权规则 | `gateway/src/middleware/auth.ts` | 白名单 |
| 改 JWT 验证逻辑 | `gateway/src/auth/jwt.ts` | `verifyAccessToken()` |
| 改网关路由 | `gateway/src/routes/push.ts` | PushService 6 个端点 |
| 改配置项 | `gateway/src/config/index.ts` | `GatewayConfig` |
| 改 Docker 编排 | `docker-compose.yml` | services 段 |
| 改 Docker 构建 | `Dockerfile` | 两个 stage |
| 改 proto 接口 | `proto/nova/*/` | .proto 文件 |
| 新加一个 RPC | proto + impl.cc + impl.h + brpc stub | 4 个文件 |

### 关键常量在哪

| 常量 | 文件 | 说明 |
|------|------|------|
| 消息长度限制 | `services/common/include/nova/common.h` | `kMaxMessageLen = 4096` |
| 用户名长度 | `services/common/include/nova/common.h` | `kMinUsernameLen=3, kMax=32` |
| Token TTL | `services/common/include/nova/common.h` | `kAccessTokenTTL=3600, kRefreshTokenTTL=2592000` |
| 在线路由 TTL | `services/common/include/nova/common.h` | `kSessionRouteTTL=30` |
| 心跳间隔 | `services/common/include/nova/common.h` | `kHeartbeatInterval=15` |
| Snowflake epoch | `services/common/include/nova/common.h` | `kSnowflakeEpoch = 1704067200000` (2024-01-01) |
| 密码哈希参数 | `services/common/src/password.cpp` | `kIterations=100000, kSaltBytes=16` |
| 去重缓存上限 | `services/message-service/message_dao.cc` | `10000`（超过全量清空） |
| 推送去重缓存 | `gateway/src/config/index.ts` | `PUSH_DEDUP_SIZE = 10000` |
| 网关连接上限 | `gateway/src/config/index.ts` | `WS_MAX_CONNECTIONS = 50000` |

---

## 5. 当前进度与架构决策

### Phase 完成情况

| Phase | 内容 | 状态 |
|-------|------|------|
| 1 | 基础设施搭建（proto/C++ 骨架/TS 网关骨架/调用链路） | ✅ |
| 2.1 | JWT 鉴权（RS256 + HS256 + kid 轮转 + Session 失效） | ✅ |
| 2.2 | 注册/登录 + PBKDF2 密码 + Redis Session + MySQL | ✅ |
| 2.3 | WebSocket 连接 + Redis 全局在线路由表 | ✅ |
| 2.4 | 发送消息 + 存储 + Timeline 分页 | ✅ |
| 2.5 | 反向推送（message → HTTP → gateway → WebSocket） | ✅ |
| 2.6 | 单聊端到端（注册 → 发消息 → 推送 → 接收） | ✅ |
| 3.1 | 离线消息 Timeline 拉取 | ✅ |
| 3.2 | 消息 ACK 确认 + idempotency_key 去重 | ✅ |
| 3.3 | 双缓冲异步日志（glog logbufsecs=30） | ✅ |
| 3.4 | 连接池、健康检查、优雅关闭（server.Stop(5000)） | ✅ |
| 4 | 音视频 RTC（WebRTC 信令 + SFU 流转发） | 待开始 |

### 消息到达保障机制（Phase 3 完整闭环）

```
消息不丢:  存储成功 → 推送 → 推送失败 → 用户上线 → GetMessages 拉取
消息不重:  idempotency_key 去重（C++ DAO 层） + push_id 去重（网关层）
消息有序:  Snowflake 趋势递增 ID → 按 message_id 降序存储/查询
消息确认:  AckMessage → DELIVERED / READ → GetSyncState → 未读计数
```

### 为什么 bRPC 而不是 gRPC？

- bRPC 原生支持 HTTP+JSON 协议：TS 网关只需要 `fetch()`，不需要引入 protobuf 库
- bthread 协程：同步代码写业务，底层全异步不阻塞
- 内置服务发现、健康检查、监控页面（`/status` + `/vars`）

### 为什么 TS 网关而不是 C++ 网关？

- Node.js 擅长处理海量 I/O（WebSocket 连接），单机 5 万连接没问题
- npm 生态丰富：ioredis、jsonwebtoken、pino 日志
- 业务逻辑简单（路由 + 鉴权 + 转发），不需要 C++ 的性能

### 为什么 Snowflake 而不是 UUID？

- Snowflake 趋势递增，天然适配 Timeline 排序
- 生成不需要网络调用（vs 数据库自增 ID）
- 64-bit，存储和索引效率高

### 为什么 PBKDF2 而不是 bcrypt？

- OpenSSL 已经是 bRPC 的传递依赖，零额外依赖
- OWASP 推荐，安全性等同 bcrypt 当迭代次数 ≥ 100,000
- 常数时间比较，防时序攻击

### 为什么 PushDispatcher 不查 Redis 路由表？

- 简化设计："在线判断"集中在网关层
- 减少 C++ 服务的外部依赖（不依赖 Redis）
- 网关 PushService 自己判断用户是否在线（本地 ConnectionManager + Redis）

### 为什么手写 bRPC stubs 而不是 protoc-gen-brpc？

- protoc-gen-brpc 需要 bRPC 源码编译，Docker 环境不可靠
- 手写 stubs (~200 行) 可控、可调试
- 动态 DescriptorPool 保证了与 bRPC 框架的兼容

---

> **最后更新**: 2026-07-12
> **相关文档**: [[../Dev.md]] (开发日志) | [[../ProjectDiscription.md]] (数据流) | [[../Gateway.md]] (网关) | [[./docker-usage.md]] (Docker)
