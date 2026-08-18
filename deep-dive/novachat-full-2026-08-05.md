# NovaChat — 秋招面试项目深度讲解

> 生成日期: 2026-08-05
> 模式: full
> 目标: 帮助你向面试官完整、自信地讲解你的项目

---

## 目录

1. [电梯演讲 — 30 秒讲清楚你的项目](#1-电梯演讲)
2. [架构全景图](#2-架构全景图)
3. [模块逐一深讲](#3-模块逐一深讲)
4. [数据流 — 面试中最容易被问到的链路](#4-数据流)
5. [技术选型与设计决策（高频问题）](#5-技术选型与设计决策)
6. [面试常见追问 & 回答思路](#6-面试常见追问)
7. [关键技术概念速查](#7-关键技术概念速查)
8. [代码索引 — 面试官问到任何一个功能，你知道去哪找](#8-代码索引)
9. [学习资源](#9-学习资源)

---

## 1. 电梯演讲

> **30 秒版**
>
> NovaChat 是一个基于 BFF 异构微服务架构的分布式即时通讯平台。接入层用 TypeScript + Fastify 做 WebSocket 长连接网关，核心层用 C++ + bRPC 做高性能消息处理。已实现单聊消息端到端闭环——包括消息存储、反向推送、ACK 确认、幂等去重、离线拉取——以及 1v1 WebRTC 音频通话。部署在 Docker Compose 环境，6 个容器协同工作。

> **60 秒版（加上技术亮点）**
>
> NovaChat 是一个分布式 IM + RTC 平台。核心设计是 BFF 异构微服务架构：TypeScript 网关处理 5 万级 WebSocket 长连接和 JWT 鉴权，C++ 服务通过 bRPC 的 `http+pb` 协议自动将 JSON 转为强类型 Protobuf 处理业务逻辑。消息系统采用 Telegram 风格设计——Snowflake 分布式 ID、Timeline 游标分页、PTS 增量同步、PushDispatcher 反向推送。消息可靠性通过三层保障：idempotency_key 去重 + Snowflake 有序 ID + ACK 确认机制。Phase 4 实现了 WebRTC 1v1 音频通话，信令通过网关中继，媒体流 P2P 直传。全套系统通过 Docker Compose 6 容器编排。

---

## 2. 架构全景图

### 2.1 物理拓扑

```
┌─────────────────────────────────────────────────────────────────────┐
│                        客户端 (浏览器 / App)                          │
│                   HTTP :80 + WebSocket /ws                          │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                    ┌────────▼────────┐
                    │  Nginx (:80)    │  ← 静态文件 + 反向代理
                    │  web/           │
                    └────────┬────────┘
                             │ /ws → gateway:3000
                             │ /api/ → gateway:3000
                    ┌────────▼────────┐
                    │  Gateway (:3000) │  ← TS + Fastify + ws
                    │  gateway/src/   │     BFF 接入层
                    └──┬──────────┬───┘
                       │ HTTP POST│ HTTP POST
              ┌────────▼────┐ ┌──▼───────────┐
              │ User Service │ │ Message       │
              │ (:8001)      │ │ Service(:8002)│ ← C++20 + bRPC
              │ C++          │ │ C++           │   核心业务层
              └────┬─────────┘ └──┬────┬───────┘
                   │              │    │ 反向推送(PushService)
          ┌────────▼────┐  ┌──────▼┐   │
          │   MySQL     │  │ Redis │◄──┘
          │   :3306     │  │ :6379 │
          └─────────────┘  └───────┘
```

### 2.2 逻辑分层

```
┌──────────────────────────────────────────────┐
│              表现层 (Web Frontend)             │  web/js/* — 静态 SPA
├──────────────────────────────────────────────┤
│              接入层 (BFF Gateway)              │  gateway/ — TS + Fastify
│  鉴权 / 限流 / WebSocket / 路由 / 信令中继      │
├──────────────────────────────────────────────┤
│              业务层 (Microservices)            │  services/ — C++ + bRPC
│  user-service / message-service / (media)     │
├──────────────────────────────────────────────┤
│              基础设施层 (Infrastructure)        │
│  MySQL 持久化 / Redis 缓存+路由表 / Snowflake   │
└──────────────────────────────────────────────┘
```

---

## 3. 模块逐一深讲

### 3.1 Proto 协议层 (`proto/`)

**是什么**：4 个 Protobuf 文件定义了整个系统的接口契约。所有语言（TS/C++）从同一个 proto 生成代码。

**为什么这样设计**：

| 设计点 | 为什么 | 对比/替代 |
|--------|--------|----------|
| Peer 抽象（User/Chat/Channel 统一） | 发消息时不需要 if-else 判断目标类型，一个 `Peer {type, id, access_hash}` 统一路由 | 微信拆分为 `toUser`/`toGroup`，代码到处分支 |
| `access_hash` 字段 | 防止 ID 枚举遍历（攻击者不能通过 user_id++ 扫全站） | Telegram 同款设计，比单纯的 UUID 更难猜测 |
| 40+ 精确 ErrorCode | 客户端可对每个错误做精确 UI 反馈（"用户名已占用" vs "用户名格式错误"） | 如果只返回 500 Internal Error，客户端没法给用户友好提示 |
| `offset_id` 游标分页 | 比 `LIMIT/OFFSET` 省数据库（不走全表扫描），在 Timeline 场景下只需要 `WHERE message_id < offset_id ORDER BY message_id DESC LIMIT N` | `OFFSET 1000 LIMIT 20` 需要扫描 1020 行再丢弃前 1000 行 |
| PTS/QTS 增量同步 | 客户端只需记住上次同步的 PTS 值，就能增量拉取所有变更，不用全量刷 | Telegram 同款，比轮询高效一个数量级 |

**关键文件**：
- `proto/nova/common/common.proto` — 通用类型库 (ErrorCode, Peer, Message, Update, Pagination)
- `proto/nova/user/user.proto` — UserService 12 RPC
- `proto/nova/message/message.proto` — MessageService 4 RPC (Send/Get/Ack/Sync)
- `proto/nova/gateway/push.proto` — PushService 6 RPC (反向推送 + 在线探测)

---

### 3.2 C++ 共享基础库 (`services/common/`)

编译产出 `libnova_common.a`，所有 C++ 微服务链接这个静态库。

**核心设计决策：所有 I/O 统一走 brpc::Channel**

```
传统做法:  Redis → hiredis (epoll)      ← 三套不同的 I/O 模型
           MySQL → libmysqlclient (阻塞)   混在一起难以维护
           日志 → glog (同步写)

NovaChat:  Redis → brpc::Channel + RESP  ← 全部复用 bRPC 事件循环
           MySQL → brpc::Channel + 协议解析  + bthread 协程
           日志 → glog (内置异步缓冲)        一套模型统一调度
```

**各模块职责**：

| 模块 | 面试要点 |
|------|---------|
| **Snowflake** | 本地生成不依赖网络，趋势递增天然适配 Timeline。**时钟回拨处理**：≤5ms 自旋等待，>5ms FATAL（实际部署靠对时服务保障） |
| **Redis 客户端** | 手动构建/解析 RESP 协议（Redis 序列化协议），不走 hiredis 避免额外线程。支持 15 个命令（SET/GET/Hash/Set/Sorted Set） |
| **MySQL 连接池** | Round-robin 轮询分发，Query/QueryAll 两个接口（分别对应流式读和全量读） |
| **PBKDF2 密码** | OWASP 推荐，10 万次迭代 + 16 字节随机 Salt，**常数时间比较防时序攻击** |
| **日志** | glog 封装 + 30 秒异步缓冲刷盘 |

**面试深入点**：
- **为什么不用 hiredis？** hiredis 会创建自己的事件循环线程，和 bRPC 的 bthread 模型冲突（两个调度器互相不知道对方在跑什么）
- **为什么 PBKDF2 不用 bcrypt？** bcrypt 是独立 C 库，PBKDF2 走 OpenSSL（bRPC 的传递依赖），零额外引入
- **时钟回拨为什么会发生？** 虚拟机迁移、NTP 校时、管理员手动改时。Snowflake 做防卫性检测是工业标准

---

### 3.3 用户服务 (`services/user-service/`, :8001)

**职责**：管理"人"的信息。12 个 RPC，分 5 组：

```
认证:     Register / Login / RefreshToken / Logout
查询:     GetUserProfile (by id/username) / GetUsers (batch ≤100)
修改:     UpdateProfile / ChangeUsername(1h 频率限制) / CheckUsername / ChangePassword(清除所有 Session)
搜索:     SearchUsers (前缀匹配, offset_id 游标分页)
管理:     DeleteAccount (密码二次确认 + 软删除)
```

**启动流程 (`server.cc`)**：

```
Config → Logger → Snowflake(worker_id) → UserDao(MySQL/内存)
→ UserServiceImpl(&snowflake, &dao) → brpc::Server::Start(:8001)
→ RunUntilAskedToQuit()  ← 优雅关闭
```

**DAO 双模式设计**：

```
生产环境:  --enable_mysql --enable_redis
  User   → MySQL (users 表)
  Session → Redis (sess:<token> → uid|exp|device)

开发环境:  不加任何 flag
  全部走内存 (std::map + std::mutex)
  零依赖即可跑起来, 新人克隆就能调试
```

**面试深入点**：
- **Register 为什么是注册即登录？** IM 场景下注册完成就应该进入 App，不需要额外一步登录。Telegram/WhatsApp 都是这个模式
- **ChangePassword 为什么清除所有 Session？** 安全考虑：密码修改后，之前用旧密码签发的所有 token 应立即失效。否则恶意持有者还能继续操作
- **软删除怎么实现？** `is_deleted=true` 标记 + username 映射同步清理。数据不物理删除，支持账户恢复和审计追溯

---

### 3.4 消息服务 (`services/message-service/`, :8002)

**职责**：管理消息的完整生命周期。4 个 RPC：

```
SendMessage:   Snowflake 生 msg_id → idempotency_key 去重
               → DAO 存储 → (非静默) PushDispatcher 反向推送

GetMessages:   Timeline 模型, WHERE to_peer=X AND msg_id < offset_id
               ORDER BY msg_id DESC LIMIT N → has_more + next_offset_id

AckMessage:    批量更新消息状态 DELIVERED/READ
               (更新 WHERE msg_id <= max_ack_msg_id 且状态 < 目标状态)

GetSyncState:  上线时批量查各对话的 latest_msg_id + unread_count
```

**PushDispatcher 简化设计**（面试高频点）：

```
传统做法（复杂）:  消息服务 → 查 Redis 在线路由表 → 找到目标网关 → 推送
NovaChat（简单）:  消息服务 → 直接向网关推送 PushUpdate
                   网关自己判断用户是否在线

好处:
  1. C++ 服务不依赖 Redis（减少外部依赖）
  2. "在线判断"逻辑统一在网关层（ConnectionManager + Redis）
  3. 推送失败不丢消息（用户上线后 GetMessages 拉取）
```

**消息可靠性三层保障**：

```
┌────────────────────────────────────────────────────────┐
│ 第一层: 不丢                                            │
│   存储成功 → 推送 → 推送失败 → 用户上线 → GetMessages    │
│                                                        │
│ 第二层: 不重                                            │
│   idempotency_key (C++ DAO, 10000 缓存)                  │
│   + push_id (Gateway, 10000 LRU)                       │
│                                                        │
│ 第三层: 可确认                                          │
│   AckMessage → DELIVERED/READ → GetSyncState → 未读计数  │
└────────────────────────────────────────────────────────┘
```

**面试深入点**：
- **idempotency_key 去重怎么做的？** DAO 层缓存已处理的 key → unordered_set（最多 10000，超过全量清空）。重复 key 返回 `is_new=false` 但不报错
- **为什么 idempotency_key 去重放 C++ 层而不是网关？** 网关可能水平扩展多实例，放在 C++ 消息服务层是单点权威，不会被多实例产生的时间窗口绕过
- **Timeline 分页为什么用 offset_id 而不是 page_num？** 消息是实时插入的，如果 A 翻了第 1 页，此时 B 发了新消息，A 翻第 2 页时会看到第 1 页的重复。offset_id 以消息 ID 为锚点，完全避免了"翻页时新消息打乱已有结果"的问题

---

### 3.5 网关 (`gateway/`, :3000)

**职责**：BFF（Backend For Frontend）接入层。客户端只和它说话。19 个源文件。

**四个面孔**：

```
面孔 1 — WebSocket 服务端 (对客户端)
  ws://gateway:3000/ws
  消息: auth / send_msg / ping / typing / read / rpc / call_signal

面孔 2 — HTTP 客户端 (对 C++ 服务)
  user_client.ts    → POST user-service:8001
  message_client.ts → POST message-service:8002

面孔 3 — HTTP 服务端 (PushService, C++ 反向推送)
  POST /nova.gateway.PushService/PushUpdate
  → 查本地 WS 连接 → 推给目标用户

面孔 4 — 信令中继 (WebRTC, Phase 4 新增)
  call_signal → 查 ConnectionManager → 转发给对方 WS
```

**核心模块逐个看**：

| 模块 | 文件 | 面试可讲的点 |
|------|------|-------------|
| **JWT 鉴权** | `auth/jwt.ts` + `auth/keys.ts` | 支持 RS256(生产)+HS256(开发)，kid-based 密钥轮转。verifyAccessToken 同步检查 Session 是否已失效 |
| **Session 管理** | `auth/session.ts` | token↔userId 双向索引，定时清理。ChangePassword/Logout 时批量失效 |
| **鉴权中间件** | `middleware/auth.ts` | **四级白名单**：NO_AUTH(register/login) → REFRESH_TOKEN → PUBLIC(可选鉴权) → PROTECTED(强制)。差异化错误码：EXPIRED→1002, INVALIDATED→1003, BAD_TOKEN→1004 |
| **限流** | `middleware/rate_limiter.ts` | 令牌桶算法，按 IP + userId 双重限流。内存实现，不依赖外部服务 |
| **WS 连接管理** | `ws/connection.ts` | userId↔WebSocket 双向 Map，push_id 幂等去重(10000 LRU)，心跳超时(30s)自动断开 |
| **在线路由表** | `ws/online_registry.ts` + `redis/client.ts` | 上线写 Redis → 15s 批量心跳刷新 TTL=30s → 离线删 Key。pipeline 批量操作减少网络往返 |
| **bRPC 客户端** | `clients/base.ts` | 封装 HTTP POST → bRPC `http+pb` 端点格式。自动超时 + 错误包装 |
| **Web 前端** | `web/` | Phase 4 新增。纯静态 SPA + Nginx 托管。WebRTC 1v1 音频通话 |

**面试深入点**：

- **为什么是 BFF 架构？** 网关做认证、限流、协议转换，让 C++ 服务专心处理业务逻辑。客户端协议的复杂性（WebSocket 帧格式、JSON 解析、JWT 验证）全部隔离在网关层
- **bRPC `http+pb` 自动转换是怎么工作的？** TS 发 HTTP POST + JSON Body → bRPC 收到后解析 URL 中的服务名和方法名 → 根据 Protobuf ServiceDescriptor 找到对应的 Request 类型 → `json2pb` 自动反序列化 JSON → C++ 拿到强类型 struct。**零适配层，不需要写任何 JSON 解析代码**
- **Redis 在线路由表为什么用 pipeline？** 网关同时有 1 万在线用户，15 秒一次批刷。如果逐个操作就是 1 万次 RTT，pipeline 合并为 1 次网络往返
- **RS256 vs HS256 的区别？** HS256 是对称密钥（共享 secret），适合开发/单服务。RS256 是非对称（公钥验证，私钥签发），生产环境可以在不暴露签名的前提下让网关独立验证 token

---

### 3.6 Web 前端 + WebRTC 通话 (`web/`, Phase 4)

**文件结构**：
```
web/
├── index.html          ← 单页应用入口
├── js/api.js           ← API 层 (REST + WebSocket)
├── js/app.js           ← 主应用逻辑 (690 行, 含通话 ~180 行)
├── css/style.css       ← Telegram 暗色主题 (CSS 变量体系)
├── nginx/default.conf  ← 反向代理 (WS 升级 + API 转发)
└── favicon.svg
```

**WebRTC 1v1 通话架构**：

```
┌──────────────────────────────────────────────┐
│           信令路径 (经过 Gateway)              │
│                                              │
│  Alice ──call_signal──▶ Gateway ──▶ Bob      │
│  Alice ◀──call_signal── Gateway ◀── Bob      │
│                                              │
│  信令类型: call_start / answer /             │
│            ice_candidate / call_end          │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│         媒体路径 (P2P, 不经过 Gateway)         │
│                                              │
│  Alice ◀══════ SRTP Audio ═══════▶ Bob      │
│                                              │
│  STUN: stun.l.google.com:19302 (开发)        │
│  拓扑: P2P Mesh (Phase 4.6 升级为 SFU)       │
└──────────────────────────────────────────────┘
```

**通话流程（完整步骤）**：

```
1. Alice 点 📞 → navigator.mediaDevices.getUserMedia({audio:true})
2. Alice 创建 RTCPeerConnection → createOffer() → setLocalDescription(offer)
3. Alice → ws.send(call_signal: call_start + SDP offer)
4. Gateway → 查 ConnectionManager → ws.send(Bob, call_signal: call_start)
5. Bob 收到 → 显示来电 UI (接听/拒绝按钮)
6. Bob 点"接听" → getUserMedia → setRemoteDescription(Alice的offer)
7. Bob → createAnswer() → setLocalDescription(answer)
8. Bob → ws.send(call_signal: answer + SDP answer) → Gateway → Alice
9. Alice → setRemoteDescription(Bob的answer)
10. ICE candidates 互相交换 (NAT 打洞)
11. P2P SRTP 音频流已通 🔊
12. 任一方挂断 → ws.send(call_signal: call_end) → 关闭 PC + 停止 tracks
```

**面试深入点**：
- **为什么信令走 Gateway 但媒体走 P2P？** 信令（SDP/ICE candidate）是少量控制信息，走服务器做路由是自然的。媒体流是大数据量（每秒几千个音频包），如果走服务器会消耗大量带宽和对端延迟。P2P 直连延迟最低
- **NAT 打洞为什么需要 STUN？** 大部分设备在 NAT 后面，不知道自己的公网 IP:Port。STUN 服务器告诉设备"你在公网上是什么地址"，然后通过信令通道交换这个地址，双方才能直连
- **P2P 的局限性？** 对称 NAT 打洞成功率不是 100%（约 92% 能通），生产需要 TURN 中继兜底。多人通话 P2P Mesh（N 个连接 × N-1 个对端）带宽爆炸，必须升级 SFU

---

## 4. 数据流

### 4.1 注册流程（完整链路）

```
⓪ App: { type: "rpc", payload: { service: "UserService", method: "Register", body: {...} } }

① Gateway ──HTTP POST──▶ user-service:8001/nova.user.UserService/Register
   Body: {"username":"alice","password":"***","first_name":"Alice"}

② bRPC: 解析 URL → service="nova.user.UserService" + method="Register"
         → JSON → RegisterReq (自动转换)

③ UserServiceImpl::Register():
   ├─ ValidateUsername("alice")  → 3-32 chars, 字母开头, 字母数字下划线
   ├─ ValidatePassword("***")    → 8-128 chars
   ├─ dao->UsernameExists("alice") → false
   ├─ snowflake->NextId()        → user_id = 333855473985916928
   ├─ HashPassword("***")        → "$pbkdf2-sha256$100000$abcd...$ef01..."
   ├─ dao->CreateUser(...)       → MySQL INSERT
   ├─ SignToken(access+refresh)  → JWT (RS256/HS256)
   ├─ dao->CreateSession(token)  → Redis SET sess:<token> "uid|exp|dev"
   └─ return { user_id, access_token, refresh_token, user }

④ bRPC: RegisterResp → JSON → HTTP 200
⑤ Gateway → App: { error_code: 0, user_id: ..., access_token: "..." }
```

### 4.2 发送消息 → 对方实时收到（完整链路）

```
① Alice: ws.send({ type: "send_msg", payload: { peer_id: Bob, text: "Hello" } })

② Gateway: handleSendMessage()
   → messageClient.sendMessage({from_peer, to_peer, text})
   → POST message-service:8002/nova.message.MessageService/SendMessage

③ message-service: SendMessage()
   ├─ ValidateSendRequest()
   ├─ snowflake->NextId()              → msg_id = 333855523432570880
   ├─ idempotency_key 去重             → unodered_set check → 新消息
   ├─ dao->SaveMessage(record)         → 内存/MySQL 存储
   ├─ response: {message_id, from, to, text, is_new=true}
   └─ PushDispatcher::PushToUser(Bob)
       ├─ 构造 PushUpdateReq {target_user_id, update: UPDATE_NEW_MESSAGE}
       ├─ protobuf → JSON
       └─ brpc::Channel → HTTP POST → gateway:3000
           /nova.gateway.PushService/PushUpdate

④ Gateway: push.ts → PushUpdate handler
   ├─ push_id 幂等去重
   ├─ connectionManager.isOnline(Bob)?
   ├─ YES → ws.send(Bob, { type: "update", payload: { update_type: 0, data: {...} } })
   │        → Bob 实时收到!
   └─ NO  → {delivered: false} (消息已存, Bob 上线拉取)

⑤ Gateway → Alice: ws.send({ type: "rpc_result", data: { message_id: ..., status: "sent" } })
```

### 4.3 bRPC JSON↔Protobuf 自动转换

这是项目最大的技术亮点之一，面试官很可能会追问：

```
数据在各层级的形态:

JS Object           { username: "alice", password: "***" }
  ↓ JSON.stringify
JSON String         '{"username":"alice","password":"***"}'
  ↓ HTTP POST Body
TCP 字节流          010010100101...
  ↓ bRPC 解析 URL → 找到 Service+Method → 找到 Request 类型
  ↓ json2pb 自动转换
C++ Protobuf        RegisterReq { set_username("alice"); set_password("***"); }
  ↓ 业务逻辑处理
C++ Protobuf        RegisterResp { set_user_id(333...); set_access_token("eyJ..."); }
  ↓ pb2json 自动转换
JSON String         '{"user_id":333...,"access_token":"eyJ..."}'
  ↓ HTTP 200
JS Object           { user_id: 333..., access_token: "eyJ..." }
```

**关键点**：TS 网关不需要引入 Protobuf 库、不需要代码生成、不需要 C++ 扩展。`fetch()` 发 JSON 就行，bRPC 在 C++ 侧完成所有格式转换。这就是 bRPC `http+pb` 协议的威力——网关保持轻量，强类型在服务端保证。

---

## 5. 技术选型与设计决策

### 5.1 为什么 bRPC 而不是 gRPC？

| 对比维度 | bRPC | gRPC |
|---------|------|------|
| HTTP+JSON 支持 | 原生 `http+pb` 协议，JSON 自动转 Protobuf | 需要 grpc-gateway 额外组件 |
| TS 调用 C++ | 直接 `fetch("url", {body: JSON})` | 需要 grpc-web + envoy proxy |
| 协程模型 | bthread (M:N 协程, 同步写异步跑) | 线程池 + 回调 |
| 服务治理 | 内置 `/status` `/vars` 监控页面 | 需要 Prometheus + Grafana |
| 学习曲线 | 较陡（中文文档为主，社区较小） | 文档丰富（英文），生态大 |

**一句话**：bRPC 的 `http+pb` 让 TS 网关调用 C++ 服务的时候不需要任何 glue code，这个优势在异构语言微服务架构中是决定性的。

### 5.2 为什么 TypeScript 网关而不是 C++ 网关？

| 对比维度 | TypeScript (我们的选择) | C++ |
|---------|------------------------|-----|
| WebSocket 开发效率 | ws 库一行代码启动，生态成熟 | 需要 beast/websocketpp，代码量大 |
| JWT/加密库 | jsonwebtoken 一行调用 | 需要自己集成 OpenSSL JWT |
| I/O 模型 | 事件循环天然适合 5 万连接 | 需要 epoll + 协程手动管理 |
| 性能上限 | 单机 5-10 万连接 | 单机百万连接 |
| 招聘难度 | Node.js 工程师好招 | C++ 网络工程师难招 |

**一句话**：BFF 层的业务逻辑是"鉴权 + 路由 + 转发"，计算量可忽略不计，Node.js 的性能完全过剩。把 C++ 留给真正吃 CPU 的消息处理和流媒体转发。

### 5.3 为什么 Snowflake 而不是 UUID？

| 对比维度 | Snowflake | UUID v4 | 数据库自增 ID |
|---------|-----------|---------|-------------|
| 趋势递增 | ✅ 适配 Timeline 排序 | ❌ 完全随机 | ✅ |
| 生成方式 | 本地生成，零网络 | 本地生成 | 需要 DB 往返 |
| 大小 | 64-bit (8 bytes) | 128-bit (16 bytes) | 32/64-bit |
| 分布式 | ✅ 通过 worker_id 区分节点 | ✅ 天然分布式 | ❌ 单点 |
| 时钟依赖 | 需要时钟同步 | 无 | 无 |

**一句话**：Snowflake 是"趋势递增"和"分布式友好"的唯一交集。UUID 不能做 Timeline 排序（插入时每次随机 I/O），数据库自增 ID 在多实例场景下冲突。

### 5.4 为什么 PBKDF2 而不是 bcrypt？

- bRPC → Protobuf → OpenSSL（传递依赖）。PBKDF2 走 OpenSSL EVP 的 `PKCS5_PBKDF2_HMAC`，**零额外依赖**
- bcrypt 需要额外安装 `libbcrypt`
- OWASP 推荐：100,000 次迭代的 PBKDF2-SHA256 安全性等同于 bcrypt

### 5.5 为什么 PushDispatcher 不查 Redis？

传统方案中消息服务先查 Redis 在线路由表再决定推送目标。我们的简化设计：

**好处**：
- 消息服务不依赖 Redis（减少故障面）
- "在线判断"逻辑集中在网关层（总有一处权威答案）
- 推送失败不丢消息（用户上线 GetMessages 拉取）

**代价**：
- 离线用户每条消息多一次 HTTP 调用（但用户在线率通常很高，实际浪费很少）

---

## 6. 面试常见追问 & 回答思路

### Q1: "你的系统能支持多少人同时在线？"

**回答思路**：
- Gateway 单节点：Node.js WebSocket 5 万连接（内存 + CPU 够用，瓶颈是文件描述符）
- 水平扩展：Gateway 多实例 + Nginx/HAProxy 做 WS 负载均衡。不同用户路由到不同 Gateway 节点，在线路由表（Redis）保证跨节点消息可达
- C++ 服务：bRPC 的 bthread 模型百万级 QPS 无压力
- 存储：MySQL 单表水平分表（按 user_id hash），Redis Cluster 分片
- 回答要点：**"先讲单机极限，再讲水平扩展方案，最后说当前阶段是开发环境"**

### Q2: "消息丢失了怎么办？"

**回答思路**：
- **不会丢**：消息先存储再推送，推送失败不重试（用户上线 GetMessages 拉取全量遗漏）
- **不会重**：idempotency_key（C++ DAO）+ push_id（Gateway）双重去重
- **可验证**：AckMessage 机制 → DELIVERED/READ。GetSyncState 上线时对账
- 回答要点：**"先讲三层保障机制，再举具体的代码例子（idempotency_key 在 message_dao.cc 的 unordered_set 缓存）"**

### Q3: "为什么不用 Kafka/RabbitMQ 做消息队列？"

**回答思路**：
- 当前规模 P2P 推送无需消息队列。直接 HTTP 调用延迟更低
- 如果未来需要异步解耦（群发、离线推送通知、消息分析），会在 message-service 和 PushDispatcher 之间引入 Kafka
- 回答要点：**"先承认消息队列的价值，再解释当前阶段不需要（避免过度设计），最后给出演进路径"**

### Q4: "WebSocket 断线了怎么处理？"

**回答思路**：
- 客户端 30s 心跳 ping，网关收到后刷新心跳时间戳
- 心跳超时 30s → Gateway 主动断开 → 触发 close 事件 → unregister ConnectionManager + Redis DEL 在线状态
- 客户端 `api.js` 自动重连：非正常关闭 (code !== 1000 && !== 4001) → 3 秒后重连 → 重新 auth
- 重连后：GetSyncState 拉取离线期间的遗漏消息
- 回答要点：**"客户端自动重连 + 服务端心跳检测 + 重连后增量同步"**

### Q5: "你项目中最大的技术挑战是什么？"

**回答思路（建议挑一个深讲）**：

**选项 A — bRPC JSON/Protobuf 自动转换的理解与调试**：
- 需要理解 Protobuf 的 DescriptorPool/ServiceDescriptor/MethodDescriptor 机制
- proto3 默认值行为：0/""/false 在 JSON 序列化时默认省略，导致 TS 侧拿到的对象可能少字段
- 解决方案：在 gateway 侧用 `result.error_code ?? 0` 而非 `result.error_code || 0`（区分 undefined 和 0）

**选项 B — 消息去重的双重保障设计**：
- 为什么需要两层去重？因为 C++ DAO 层的 idempotency_key 防的是"客户端重复发送"，Gateway 层的 push_id 防的是"bRPC 重试导致重复推送"
- 两个去重层的缓存上限（10000）和淘汰策略（全量清空）的设计考量

**选项 C — 手写 bRPC Service Stubs**：
- protoc-gen-brpc 在 Docker 环境不可用，决定手写
- 需要深入理解 DescriptorPool::BuildFile 动态构建 ServiceDescriptor
- JSON→Protobuf 转换依赖正确的 FieldDescriptor 注册（字段名、编号、类型、label）

### Q6: "你对这个项目下一步的规划是什么？"

**回答思路**：
1. **C++ media-service SFU**：当前 P2P 只能 1v1，SFU 支持多人语音。核心挑战是低延迟音频流转发 (<200ms)
2. **群聊功能**：当前的 Peer 抽象已经支持群组，但缺少群组创建/成员管理/群消息推送
3. **消息已读/未读**：AckMessage 已实现基础设施，需要前端 UI 对接
4. **TURN 服务**：生产环境 NAT 穿透需要自建 coturn
5. **服务发现**：从配置硬编码升级到 Consul/Etcd 动态注册

---

## 7. 关键技术概念速查

面试中可能被追问的概念，确保你能解释清楚：

| 概念 | 在项目中的体现 | 一句话解释 |
|------|-------------|----------|
| **BFF** | gateway/ 作为 Backend For Frontend | 为前端定制的后端中间层，负责鉴权、聚合、协议转换 |
| **bthread** | bRPC 的 M:N 协程 | 用户态协程，同步写代码，底层异步执行。一个 pthread 上可以跑上千个 bthread |
| **Protobuf** | proto/ 下所有 .proto 文件 | 语言无关的序列化协议，二进制格式，比 JSON 小 3-10 倍 |
| **Timeline 模型** | GetMessages 按 msg_id 降序 | 以时间线为索引的消息存储，天然适合 IM 场景的"向上翻历史" |
| **PTS/QTS** | proto 中定义的 SyncState | Telegram 的增量同步机制，PTS = 每个对话的更新序列号 |
| **反向推送** | PushDispatcher → PushService | 服务端有消息要发时主动"回头"通知网关，而不是客户端轮询 |
| **幂等去重** | idempotency_key + push_id | 同一个操作执行多次结果不变。IM 中防止用户看到重复消息 |
| **Snowflake** | services/common/src/snowflake.cpp | 分布式唯一 ID 算法，Twitter 开源。64-bit 中嵌入时间戳保证趋势递增 |
| **PBKDF2** | services/common/src/password.cpp | 密码哈希算法。加盐 + 多轮迭代让暴力破解成本极高 |
| **JWT** | gateway/src/auth/jwt.ts | JSON Web Token。无状态认证方案，token 自包含用户信息 |
| **STUN** | web/js/app.js : rtcConfig | NAT 穿透协议。告诉设备"你的公网地址是什么" |
| **SFU** | (待实现) | Selective Forwarding Unit。服务器收流后选择性转发给各参与者，多人通话的标准架构 |
| **LRU** | ConnectionManager push 去重 | Least Recently Used。缓存淘汰策略，踢出最久没使用的 |

---

## 8. 代码索引

面试官问到任何一个功能，你能马上指出文件位置：

### 我想改...

| 需求 | 文件 | 关键方法 |
|------|------|----------|
| 注册/登录逻辑 | `services/user-service/user_service_impl.cc` | `Register()` / `Login()` |
| 密码规则 | `services/user-service/user_service_impl.cc` | `ValidatePassword()` |
| 密码哈希算法 | `services/common/src/password.cpp` | `HashPassword()` / `CheckPassword()` |
| 分布式 ID 生成 | `services/common/src/snowflake.cpp` | `NextId()` |
| 发消息 | `services/message-service/message_service_impl.cc` | `SendMessage()` |
| 消息去重 | `services/message-service/message_dao.cc` | `idempotency_key` 检查 |
| 消息推送 | `services/message-service/push_dispatcher.cc` | `PushToUser()` / `CallGatewayPush()` |
| 拉取历史 | `services/message-service/message_service_impl.cc` | `GetMessages()` |
| ACK 确认 | `services/message-service/message_service_impl.cc` | `AckMessage()` |
| WebSocket 消息格式 | `gateway/src/ws/protocol.ts` | 全部 14 个消息类型 |
| WS 连接管理 | `gateway/src/ws/connection.ts` | `ConnectionManager` |
| 在线路由表 | `gateway/src/redis/client.ts` + `ws/online_registry.ts` | |
| JWT 鉴权 | `gateway/src/middleware/auth.ts` | 四级白名单 |
| JWT 验证 | `gateway/src/auth/jwt.ts` | `verifyAccessToken()` |
| 网关 → C++ 调用 | `gateway/src/clients/user_client.ts` + `message_client.ts` | |
| WebRTC 信令 | `gateway/src/main.ts` | `handleCallSignal()` |
| WebRTC 前端 | `web/js/app.js` | `startCall()` / `acceptCall()` / `hangUp()` |
| Proto 接口 | `proto/nova/*/` | .proto 文件 |

### 关键常量在哪

| 常量 | 文件 | 值 |
|------|------|-----|
| 消息最大长度 | `services/common/include/nova/common.h` | `kMaxMessageLen = 4096` |
| 用户名规则 | `services/common/include/nova/common.h` | 3-32 chars, 字母开头 |
| Token 有效期 | `services/common/include/nova/common.h` | access=1h, refresh=30d |
| 在线 TTL | `services/common/include/nova/common.h` | 30 秒 |
| 心跳间隔 | `services/common/include/nova/common.h` | 15 秒 |
| Snowflake epoch | `services/common/include/nova/common.h` | 2024-01-01 |
| PBKDF2 迭代次数 | `services/common/src/password.cpp` | 100,000 |
| 去重缓存上限 | `services/message-service/message_dao.cc` | 10,000 |
| 网关连接上限 | `gateway/src/config/index.ts` | 50,000 |

---

## 9. 学习资源

### 核心依赖官方文档

| 技术 | 文档 |
|------|------|
| bRPC | https://github.com/apache/brpc/blob/master/docs/cn/overview.md (中文) |
| Protobuf | https://protobuf.dev/programming-guides/proto3/ |
| Fastify | https://fastify.dev/docs/latest/ |
| ws (WebSocket) | https://github.com/websockets/ws |
| WebRTC | https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API |
| Snowflake | https://en.wikipedia.org/wiki/Snowflake_ID |
| PBKDF2 | https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html |

### 推荐深度阅读

| 主题 | 资源 |
|------|------|
| Telegram 协议设计哲学 | https://core.telegram.org/mtproto — 我们的 Peer 抽象、Update 事件模型、PTS 同步都是参考它 |
| bRPC bthread 原理 | https://github.com/apache/brpc/blob/master/docs/cn/bthread.md |
| IM 系统架构演进 | "从 0 到 1 设计即时通讯系统" — 很多中文技术博客有系统讲解 |
| WebRTC 信令与 NAT 穿透 | https://webrtc.org/getting-started/peer-connections |

---

## 附录: 面试"自述项目"模板

面试官通常第一句话："请介绍一下你的项目"。下面是建议的 2-3 分钟自述：

> "我做的是一个分布式的即时通讯和实时音视频平台，叫做 NovaChat。
>
> 架构上用了**异构微服务**：接入层是 TypeScript + Fastify 写的网关，核心业务用 C++ + bRPC。为什么这样分？因为网关主要是 I/O 密集型的 WebSocket 连接管理，Node.js 很擅长；C++ 用在前端业务逻辑重但是需要高性能的消息处理和流媒体转发。
>
> 两个语言之间怎么通信呢？这里有一个亮点——我们用 bRPC 的 http+pb 协议，TS 网关发 HTTP + JSON Body，bRPC 在 C++ 侧自动把 JSON 转成强类型的 Protobuf 对象。也就是说网关只需要 `fetch()` 就能调用 C++ 微服务，零适配代码。
>
> 消息系统的可靠性用了三层保障：第一层保证不丢——先存储再推送，推送失败的话用户上线拉取离线消息；第二层保证不重——C++ 层用 idempotency_key 去重，网关层用 push_id 去重；第三层可确认——AckMessage 机制让发送方知道消息是否送达和已读。
>
> 目前单聊消息全链路已经跑通——注册登录、发消息、实时推送、离线拉取、ACK 确认都完成了。最新加了一个 WebRTC 1v1 音频通话功能，信令通过网关中继，媒体流 P2P 直连。整套系统用 Docker Compose 编排了 6 个容器。
>
> 下一步计划是写 C++ SFU 支持多人语音通话。"

---

> **提示**: 写好之后对着镜子讲两遍，确保能在 2-3 分钟内流畅说完。面试官会从你的介绍中追问，所以你提的每一个技术点都是你准备好的"钩子"——只有你真正理解的才放进自述里。
