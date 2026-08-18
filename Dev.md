# NovaChat 开发日志

> 最后更新: 2026-07-30
> 当前阶段: Phase 3 完成 / Phase 4 进行中 — WebRTC 信令 + Web 前端

---

## 一、项目概述

NovaChat 是基于 BFF 异构微服务架构的分布式即时通讯（IM）与实时音视频（RTC）平台。

- **接入层**: TypeScript + Fastify + ws（WebSocket 长连接管理、JWT 鉴权、业务路由）
- **核心层**: C++20 + bRPC + Protobuf（消息同步引擎、流媒体 SFU 转发）
- **通信**: TS 网关 → HTTP/JSON → bRPC 自动转 Protobuf → C++ 服务；C++ 服务间纯二进制 Protobuf RPC
- **存储**: MySQL（元数据 + 离线消息）+ Redis（在线路由表 + 缓存）

---

## 二、技术选型

| 层面 | 选型 | 理由 |
|------|------|------|
| TS 网关框架 | **Fastify** | 高性能 HTTP 框架，比 Express 快 2-3x |
| WebSocket | **ws** | 原生实现，轻量高效 |
| Proto → TS | **ts-proto / protobuf-ts** | 编译期类型检查，网关侧也能享受强类型 |
| bRPC 调用方式 | TS 网关发 HTTP/JSON → bRPC 自动转 Protobuf | 无需在 Node 侧引入 C++ 扩展 |
| C++ Redis | **brpc::Channel** (Redis 协议模式) | 复用 bRPC 的事件循环和 bthread，避免多套 I/O 模型混用 |
| C++ MySQL | **brpc::Channel** (MySQL 协议模式) | 同上，统一 I/O 模型 |
| 分布式 ID | **Snowflake** (本地生成) | 零网络开销，毫秒级生成，趋势递增天然适配 Timeline 模型 |
| C++ 日志 | **双缓冲异步日志** | Phase 3 接入，避免日志刷盘阻塞业务线程 |
| 服务发现 | 开发环境: 配置文件硬编码 IP:Port；生产环境: Consul/Etcd | 渐进式复杂度 |

---

## 三、项目目录结构

```
NovaChat/
├── NovaChat.md                     # 项目设计文档
├── Dev.md                          # 本文件 — 开发日志
├── README.md                       # 项目 README
│
├── proto/                          # 共享 Protobuf 协议定义
│   ├── common/
│   │   └── common.proto            # 通用枚举、ErrorCode、基础类型
│   ├── user/
│   │   └── user.proto              # UserService RPC
│   ├── message/
│   │   └── message.proto           # MessageService RPC
│   ├── gateway/
│   │   └── push.proto              # PushService (反向推送接口)
│   └── media/
│       └── media.proto             # (Phase 4) RTC 信令
│
├── gateway/                        # TS BFF 接入网关
│   ├── package.json
│   ├── tsconfig.json
│   ├── src/
│   │   ├── main.ts
│   │   ├── config/
│   │   ├── auth/
│   │   ├── ws/
│   │   ├── routes/
│   │   ├── clients/
│   │   ├── middleware/
│   │   └── utils/
│   └── tests/
│
├── services/                       # C++ 核心微服务
│   ├── common/                     # 共享 C++ 库
│   │   ├── CMakeLists.txt
│   │   ├── include/nova/
│   │   │   ├── config.h
│   │   │   ├── logger.h
│   │   │   ├── snowflake.h
│   │   │   ├── mysql_pool.h
│   │   │   └── redis_client.h
│   │   └── src/
│   │       ├── config.cpp
│   │       ├── logger.cpp
│   │       ├── snowflake.cpp
│   │       ├── mysql_pool.cpp
│   │       └── redis_client.cpp
│   │
│   ├── user-service/
│   │   ├── CMakeLists.txt
│   │   ├── server.cc
│   │   ├── user_service_impl.h/cc
│   │   ├── user_dao.h/cc
│   │   └── conf/
│   │
│   ├── message-service/
│   │   ├── CMakeLists.txt
│   │   ├── server.cc
│   │   ├── message_service_impl.h/cc
│   │   ├── message_dao.h/cc
│   │   ├── push_dispatcher.h/cc
│   │   └── conf/
│   │
│   └── media-service/              # (Phase 4)
│       └── ...
│
├── scripts/
│   ├── proto-gen.sh
│   ├── start-dev.sh
│   └── docker/
│
├── docker-compose.yml
├── CMakeLists.txt                  # 顶层 CMake
├── .clang-format
└── .eslintrc.js
```

---

## 四、核心架构设计

### 4.1 消息推送链路 (单聊)

```
A 发送消息给 B:

  Client A  ──WebSocket──→  Gateway Node 1  ──HTTP/JSON──→  Message Service
       (type:send,             (路由: SendMessage)          │
        to:B, msg:...)                                      │
                                                            │ 1. Snowflake 生成 msg_id
                                                            │ 2. 写入 MySQL
                                                            │ 3. 查 Redis: B 在 Gateway Node 2
                                                            │ 4. bRPC 反向调用 PushService
                                                            │    → Gateway Node 2
                                                            │
  Client B  ←──WebSocket──  Gateway Node 2  ←──bRPC────────┘
       (type:msg,
        from:A, msg:...)
```

### 4.2 bRPC HTTP/Protobuf 自动转换

TS 网关发送 JSON Body 的 HTTP POST 到 C++ 服务，bRPC 的 `http+pb` 协议自动将 JSON 反序列化为强类型 Protobuf 对象。

```
  gateway/src/clients/user_client.ts:
    fetch("http://user-service:8001/nova.user.UserService/Register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice", password: "***" }),
    })
      ↓
  bRPC 自动 JSON → Protobuf: RegisterReq{username:"alice", password:"***"}
      ↓
  C++ user_service_impl.cc: 直接拿到 RegisterReq 结构体
```

### 4.3 Redis 在线路由表

- Key: `user:online:<user_id>`
- Value: `{"gateway_addr": "10.0.1.5:3000", "last_heartbeat": 1718360000}`
- TTL: 30s（网关定时刷新 heartbeat 续期）
- C++ 消息服务发消息前查此表，找到目标用户所在的网关节点，直接 bRPC 反向推送。

---

## 五、开发路线图

### Phase 1: 基础设施搭建 (进行中)

- [x] 1.1 创建 proto 目录结构和 `common.proto` ✅ 2026-06-17
- [x] 1.2 编写 `user.proto` (UserService RPC 定义) ✅ 2026-06-17
- [x] 1.3 编写 `push.proto` (网关反向推送接口) ✅ 2026-06-17
- [x] 1.4 搭建 C++ `services/common/` 共享库骨架 ✅ 2026-06-17
- [x] 1.5 实现 Snowflake ID 生成器 ✅ 2026-06-17
- [x] 1.6 搭建 C++ `user-service` 骨架 (bRPC Server + 12 RPC 桩) ✅ 2026-06-20
- [x] 1.7 搭建 TS Gateway 骨架 (Fastify + ws) ✅ 2026-06-26
- [x] 1.8 编写 `proto-gen.sh` 一键代码生成脚本 + CMake ProtoGen 模块 ✅ 2026-06-20
- [x] 1.9 TS Gateway → user-service 调用链路跑通 ✅ 2026-06-28

### Phase 2: 核心 IM 通信闭环

- [x] 2.1 JWT 鉴权 (网关侧) ✅ 2026-07-01
- [x] 2.2 user-service: 注册/登录 RPC + Redis 缓存 Session ✅ 2026-06-21
- [x] 2.3 WebSocket 连接管理 + Redis 全局在线路由表 ✅ 2026-06-21
- [x] 2.4 message-service: 发送消息 + MySQL 存储 ✅ 2026-07-09
- [x] 2.5 反向推送: message-service → bRPC PushService → 网关 → WebSocket ✅ 2026-07-10
- [x] 2.6 单聊消息端到端跑通 ✅ 2026-07-10

### Phase 3: 性能优化与存储落地

- [x] 3.1 离线消息 Timeline 拉取 ✅ 2026-07-10
- [x] 3.2 消息 ACK / 去重机制 ✅ 2026-07-10
- [x] 3.3 双缓冲异步日志接入 ✅ 2026-07-10
- [x] 3.4 连接池、健康检查、优雅关闭 ✅ 2026-07-10

### Phase 4: 进阶 RTC ✅ 2026-08-04

- [x] 4.1 WebRTC 信令协议 (Gateway call_signal + room_signal 中继) ✅
- [x] 4.2 1v1 WebRTC 音频通话 (P2P 直连 + 全屏通话 UI + 计时器) ✅
- [x] 4.3 多人语音房间 (Mesh 模式, RoomManager, 邀请机制) ✅
- [x] 4.4 Telegram 风格暗色 Web UI (彩色头像 + 消息气泡 + 未读红点 + Toast 通知) ✅
- [x] 4.5 SFU 媒体中继 → 跳过 (太重, Mesh 模式已满足需求) ✅

---

## 六、执行日志

### 2026-06-17

- **15:18** — 创建 `NovaChat.md` 项目设计文档
- **15:40** — 技术选型讨论，确定: Fastify + ws / ts-proto / brpc::Channel(Redis+MySQL) / Snowflake
- **16:00** — 创建 `Dev.md`，记录完整架构设计、目录结构、技术选型、开发路线图和执行日志
- **16:20** — 创建 proto 目录结构 (`proto/common/`, `user/`, `message/`, `gateway/`, `media/`)
- **16:20** — 编写 `proto/common/common.proto`，参考 Telegram 协议设计，包含:
  - **Peer 抽象**: 统一用户/群组/频道三种对话类型，携带 access_hash 防枚举
  - **ErrorCode**: 6 大类 40+ 精确错误码 (Auth 1000–1099, User 1100–1199, Peer 1200–1299, Message 1300–1399, Media 1400–1499, Rate 1500–1599, Internal 5000–5099)
  - **User / Chat**: 完整用户资料和群组信息结构，含 ChatMemberRole 五级权限体系
  - **Message**: 15 种消息类型 + 5 种消息状态 + 17 种富文本 Entity 类型
  - **Media**: FileReference 通用文件引用 (支持图片/视频/音频/语音/文档)
  - **Update 事件模型**: 14 种 UpdateType，WebSocket 单通道统一下发
  - **Pagination**: Telegram 风格 offset_id 分页
  - **SyncState**: PTS/QTS 增量同步模型
  - **Poll / Location / Contact**: 投票、位置、联系人内联消息结构
- **16:25** — 编写 `proto/user/user.proto`，UserService 共 12 个 RPC:
  - **认证**: Register (用户名+密码注册即登录, 返回 Token) / Login / RefreshToken (Token 轮转) / Logout
  - **资料查询**: GetUserProfile (支持 user_id 或 username 单查) / GetUsers (批量查, max 100)
  - **资料修改**: UpdateProfile / ChangeUsername (Telegram 限制修改频率) / CheckUsername / ChangePassword
  - **搜索**: SearchUsers (username/first_name 前缀匹配, offset_id 分页)
  - **账户管理**: DeleteAccount (密码二次确认)
  - 所有响应统一携带 `nova.common.ErrorCode` + `error_message`
  - `oneof identifier` 支持按 user_id 或 username 查用户
- **16:30** — 编写 `proto/gateway/push.proto`，PushService 共 6 个 RPC:
  - **PushUpdate**: 单用户推送 — C++ 服务查 Redis 路由表找到目标网关 → 调此 RPC → 网关通过 WebSocket 推给目标用户
  - **PushToUsers**: 批量推送 — 群消息场景, 一次 RPC 推给同一网关上的多个在线群成员 (max 500)
  - **KickUser**: 强制断开 — 6 种 KickReason (Token过期/账户注销/多端互踢/维护/封禁/管理员强T)
  - **IsUserOnline**: 在线探测 — 发消息前快速判断目标是否在线, 决定走实时推送还是离线存储
  - **BatchOnlineCheck**: 批量在线检查 — 群消息发前一次性获知所有成员在线分布, 返回 online/offline 两组列表
  - **NotifyGateway**: 网关间事件通知 — 用户上下线广播、配置重载、会话清除
  - 关键设计: `push_id` (Snowflake) 实现幂等去重, 防止 bRPC 重试导致消息重复推送
  - `ttl_seconds` 推送存活时间: 超过 TTL 后即便用户上线也不再推送, 避免旧消息骚扰
- **16:35** — 搭建 C++ 共享库骨架 `services/common/` (Phase 1.4–1.5), 全新创建 12 个文件:
  - **`CMakeLists.txt`**: 构建 `libnova_common.a`, 仅依赖 bRPC, 自动查找 BRPC_ROOT
  - **`include/nova/common.h`**: 命名空间 `nova`, Timestamp 类型, 所有项目级常量 (消息限制/Snowflake参数/Token TTL/在线路由等)
  - **`include/nova/config.h`** + **`src/config.cpp`**: gflags 封装 (Init/LoadFlagFile/便捷 Getter)
  - **`include/nova/logger.h`** + **`src/logger.cpp`**: 日志宏代理 `NOVA_LOG_INFO/WARN/ERROR/FATAL/VLOG` → butil logging, Phase 3 替换点统一
  - **`include/nova/snowflake.h`** + **`src/snowflake.cpp`**: 完整 Snowflake 实现 (41-bit timestamp + 10-bit worker + 12-bit seq), 线程安全 (atomic+mute), 时钟回拨检测 (≤5ms spin / >5ms FATAL)
  - **`include/nova/mysql_pool.h`** + **`src/mysql_pool.cpp`**: brpc::Channel 池化封装 (Round-robin 分发), Phase 1 留接口, Phase 2 在 DAO 层实现 SQL 具体逻辑
  - **`include/nova/redis_client.h`** + **`src/redis_client.cpp`**: 完整 Redis 客户端 (15 个命令: Set/Get/Del/Exists/Expire/TTL, HSet/HGet/HDel/HGetAll, SAdd/SRem/SIsMember/SMembers), 基于 brpc::Channel + PROTOCOL_REDIS
  - **顶层 `CMakeLists.txt`**: 聚合构建, C++20, 导出 compile_commands.json
  - **`.clang-format`**: Google 风格, 4 空格缩进, 100 列宽

### 2026-06-20

- **Phase 1.8 — Proto 代码生成体系**:
  - 编写 **`scripts/proto-gen.sh`**: 一键生成脚本, 支持 `cpp|ts|all` 三种模式
    - 自动查找 protoc 和 protoc-gen-brpc (PATH → BRPC_ROOT → 系统路径)
    - C++: 生成 `.pb.h/.pb.cc` (Protobuf 消息) + `.brpc.h/.brpc.cc` (bRPC Service 桩)
    - TS: 预留 protobuf-ts / ts-proto 生成接口 (Phase 1.7 接入)
    - 彩色日志输出, 生成文件计数
  - 编写 **`cmake/ProtoGen.cmake`**: CMake 构建期自动生成 Proto 代码
    - `add_custom_command` 在构建时自动调用 protoc
    - 编译产出为 `libnova_proto.a` 静态库
    - 自动处理 proto 文件间依赖 (import)
    - 关闭生成代码的 Wunused-parameter / Wsign-compare 警告
  - 重构顶层 **`CMakeLists.txt`**: 将 bRPC 查找提升到顶层的全局共享
  - 简化 **`services/common/CMakeLists.txt`**: 移除重复的 bRPC find 逻辑

- **Phase 1.6 — C++ user-service 骨架 (全新 7 个文件)**:
  - **`server.cc`**: bRPC Server 入口
    - gflags 配置: port / listen_addr / worker_id / MySQL / Redis
    - 启动流程: Config → Logger → Snowflake → UserDao → UserServiceImpl → brpc::Server
    - 内置 `/status` 健康检查端点 (bRPC 原生)
    - 优雅关闭: `RunUntilAskedToQuit()` 等待 SIGINT/SIGTERM
  - **`user_service_impl.h/cc`**: 完整的 12 个 RPC 实现 (Phase 1 功能性桩)
    - **认证**: Register (用户名+密码注册即登录) / Login / RefreshToken (Token 轮转) / Logout
    - **资料查询**: GetUserProfile (user_id 或 username 查) / GetUsers (批量查, max 100)
    - **资料修改**: UpdateProfile / ChangeUsername (1 小时修改频率限制) / CheckUsername / ChangePassword (修改后清除所有 Session)
    - **搜索**: SearchUsers (前缀匹配, offset_id 分页, 手机号脱敏)
    - **账户管理**: DeleteAccount (密码二次确认 + 软删除)
    - 完整的参数校验: username 格式 (字母开头+字母数字下划线+3-32字符) / password 长度 (8-128) / 批量限制
    - Phase 2 替换点标注: Token → JWT RS256 / 密码哈希 → bcrypt / Session → Redis
  - **`user_dao.h/cc`**: 数据访问层 (Phase 1: 内存存储; Phase 2: MySQL + Redis)
    - 线程安全: `std::mutex` 保护所有操作
    - 用户 CRUD: CreateUser / FindById / FindByUsername / UpdateProfile / ChangeUsername / ChangePassword / DeleteUser
    - Session 管理: CreateSession / FindSession / DeleteSession / DeleteAllSessions
    - 搜索: 前缀匹配 username/first_name (case-insensitive)
    - Phase 2 接口预留: InitMySql / InitRedis
    - 软删除: is_deleted 标记, username 映射同步清理
  - **`user_dao.h`**: DAO 接口定义, UserRecord / SessionRecord 内部结构
  - **`conf/user_service.flags`**: 示例配置文件 (port=8001, worker_id=1)
  - 更新 `nova/common.h`: 添加 `kVersion = "0.1.0"` 版本常量

- **文件变更汇总**: 新建 10 个文件, 修改 3 个文件
  - 新建: `scripts/proto-gen.sh`, `cmake/ProtoGen.cmake`
  - 新建: `services/user-service/CMakeLists.txt`, `server.cc`, `user_service_impl.h`, `user_service_impl.cc`, `user_dao.h`, `user_dao.cc`, `conf/user_service.flags`
  - 修改: `CMakeLists.txt` (顶层, 新增 bRPC 查找 + ProtoGen + user-service 子目录)
  - 修改: `services/common/CMakeLists.txt` (移除重复的 bRPC find 逻辑)
  - 修改: `services/common/include/nova/common.h` (新增 kVersion 常量)

### 2026-06-21

- **文档**: 编写 **`ProjectDiscription.md`** — 中文详细说明 HTTP Body 数据在整个系统中的流转过程:
  - **9 个章节**: 架构速览 → TS 发起 → bRPC JSON/Protobuf 转换 → C++ 服务处理 → 响应回程 → 完整逐帧回放 → C++ 内部二进制 RPC → 反向推送 → 设计决策与常见疑问
  - **逐帧回放**: 9 帧展示一次 Register 请求中数据的完整形态变化 (JS 对象 → JSON 字符串 → TCP 字节流 → bRPC 解析 → Protobuf 对象 → 业务逻辑 → 响应 Protobuf → JSON 字符串 → HTTP Response)
  - 覆盖 bthread 协程调度、int64 JSON 精度处理、proto3 默认值行为、ClosureGuard 机制等底层细节
  - 附录标注了每个概念在项目代码中的对应文件和行号

- **Phase 2.2 — user-service: 注册/登录 RPC + Redis 缓存 Session + PBKDF2 密码哈希** ✅:
  - **密码安全**: 新建 `services/common/include/nova/password.h` + `src/password.cpp`
    - 实现 PBKDF2-HMAC-SHA256 (OpenSSL EVP, OWASP 推荐)
    - 100,000 次迭代 + 16 字节随机 Salt + 32 字节派生密钥
    - 哈希格式: `$pbkdf2-sha256$<iter>$<hex_salt>$<hex_hash>`
    - 常数时间比较防时序攻击
    - **向后兼容**: `CheckPassword` 自动识别 Phase 1 的 `"hash:"` 前缀格式并提示升级
    - `user_service_impl.cc` 改用 `nova::HashPassword`/`nova::CheckPassword`
  - **Redis 客户端**: 重写 `services/common/src/redis_client.cpp` (桩 → 完整实现)
    - 基于 `brpc::Channel` + `brpc::PROTOCOL_REDIS`, 手动构建/解析 RESP 协议
    - 15 个命令全部实现: SET/GET/DEL/EXISTS/EXPIRE/TTL, HSet/HGet/HDel/HGetAll, SAdd/SRem/SIsMember/SMembers
    - AUTH 密码认证, 连接池复用
  - **MySQL 连接池**: 重写 `services/common/src/mysql_pool.cpp` (桩 → 完整实现)
    - 基于 `brpc::Channel` + `brpc::PROTOCOL_MYSQL`, Round-robin 池化分派
    - 解析 MySQL 文本协议响应: 列计数 → 列定义 → 数据行 → EOF 标记
    - `Execute` / `Query(row_cb)` / `QueryAll(rows)` 三个接口
  - **MySQL Schema**: 新建 `scripts/docker/init.sql`
    - `users` 表: user_id/username/password_hash/资料/软删除/时间戳, UNIQUE INDEX
    - `messages` 表: 21 列, Timeline 索引 (Phase 2.4 使用)
  - **UserDao 双模式**: 重写 `services/user-service/user_dao.cc`
    - 用户 → MySQL 优先 + 内存回退; Session → Redis 优先 + 内存回退
    - Redis Session 数据结构: `sess:<token>` → 值 (带 TTL); `user_sess:<uid>` → Set of tokens
    - 开发零依赖: 不加 `--enable_mysql/redis` 时纯内存运行
  - **server.cc**: 添加 `--enable_mysql` / `--enable_redis` 开关, 启动日志显示存储后端
  - **CMake**: `find_package(OpenSSL)` + `OpenSSL::Crypto` + 新增 password.h/cpp

- **Phase 2.3 — WebSocket 连接管理 + Redis 全局在线路由表** ✅:
  - **Redis 客户端**: 新建 `gateway/src/redis/client.ts`
    - 基于 `ioredis` npm 包, 懒连接 + 自动重试 (最多 10 次)
    - 在线路由表操作: `setUserOnline(userId)` / `setUserOffline(userId)` / `isUserOnline(userId)`
    - 批量心跳刷新: `refreshHeartbeats(userIds)` 使用 Redis pipeline 批量更新 TTL
    - 批量在线检查: `batchOnlineCheck(userIds)` 使用 Redis pipeline 批量 GET
    - 优雅降级: Redis 不可用时仅记录日志, 本地服务不受影响
    - Redis Key 格式: `user:online:<user_id>` → `{"gateway_addr":"10.0.1.5:3000","last_heartbeat":1718360000}` (JSON, TTL=30s)
  - **在线状态注册器**: 新建 `gateway/src/ws/online_registry.ts`
    - `onUserOnline(userId)` → Redis SET key + Set of online snapshots
    - `onUserOffline(userId)` → Redis DEL key
    - 心跳定时器: 每 15 秒批量刷新所有本地在线用户的 Redis TTL
    - `shutdown()` 时清除本网关所有在线用户
  - **PushService 升级**: 更新 `gateway/src/routes/push.ts`
    - `IsUserOnline`: 先查本地 ConnectionManager → 再查 Redis (跨网关用户) → 返回 `last_seen_at`
    - `BatchOnlineCheck`: 本地查完后再对剩余用户批量查 Redis
    - `KickUser` 同步从 Redis 删除在线状态
  - **配置扩展**: 更新 `gateway/src/config/index.ts`
    - `GATEWAY_ADDR`: 本网关节点的外部可达地址 (C++ 服务通过此地址回连)
    - `REDIS_ADDR` / `REDIS_PASSWORD` / `REDIS_ONLINE_TTL` / `ONLINE_HEARTBEAT_INTERVAL`
  - **启动流程**: 更新 `gateway/src/main.ts`
    - 启动时连接 Redis + 启动 onlineRegistry 心跳
    - 用户认证成功后调用 `onlineRegistry.onUserOnline()` → 写入 Redis
    - 连接断开时调用 `onlineRegistry.onUserOffline()` → 删除 Redis key
    - 优雅关闭: 清除 Redis 中本网关用户 → 断开 Redis → 关闭所有连接
  - **依赖**: `gateway/package.json` 新增 `ioredis: ^5.4.1`

### 2026-06-26

- **Phase 1.7 — TS Gateway 骨架搭建完成** ✅:
  - **新建 20 个文件**，覆盖网关全部 8 个模块:
  
  - **项目根文件**:
    - **`gateway/package.json`**: 依赖 Fastify 4.x + @fastify/websocket + @fastify/cors + jsonwebtoken + pino, dev 脚本 tsx watch
    - **`gateway/tsconfig.json`**: ES2022 + NodeNext + strict mode

  - **配置层** (`src/config/`):
    - **`config/index.ts`**: 集中环境变量管理，15 个配置项（端口/后端地址/JWT/WS/限流/去重），提供开发默认值

  - **工具层** (`src/utils/`):
    - **`logger.ts`**: pino 封装，开发环境 pino-pretty 美化，支持 requestId 注入

  - **认证层** (`src/auth/`):
    - **`jwt.ts`**: signToken / verifyToken / extractUserIdFromAuthHeader，Phase 1 HMAC-SHA256，Phase 2 升级 RS256

  - **WebSocket 层** (`src/ws/`):
    - **`protocol.ts`**: 完整消息协议类型系统 — ClientMessage (6 种: auth/send_msg/ping/typing/read/rpc) + ServerMessage (6 种: auth_ok/error/update/pong/kicked/rpc_result) + 类型守卫 + 消息构造器
    - **`connection.ts`**: ConnectionManager 类 — userId↔WebSocket 双向映射 + push_id 幂等去重 (LRU) + 心跳超时检测 + 踢人 + 优雅关闭，全部线程安全

  - **C++ 服务客户端** (`src/clients/`):
    - **`base.ts`**: BrpcClient 基类 — 封装 HTTP POST 调用，bRPC 端点格式 `{baseUrl}/{serviceName}/{methodName}`，自动超时+错误转换
    - **`service_registry.ts`**: 三服务注册表 (user/message/media)，Phase 1 配置文件硬编码，Phase 3 升级 Consul/Etcd
    - **`user_client.ts`**: UserClient — 完整封装 12 个 RPC (Register/Login/RefreshToken/Logout/GetUserProfile/GetUsers/UpdateProfile/ChangeUsername/CheckUsername/ChangePassword/SearchUsers/DeleteAccount)，类型安全，与 user.proto 对齐

  - **中间件** (`src/middleware/`):
    - **`auth.ts`**: JWT 鉴权钩子 — 白名单 (health/PushService) 跳过，提取 Authorization Bearer token，注入 request.userId，失败返回 401 + TOKEN_INVALID
    - **`rate_limiter.ts`**: 内存令牌桶限流 — 按 IP + userId 双重限流，默认 200/100 req/s，过期桶自动清理

  - **路由** (`src/routes/`):
    - **`health.ts`**: GET /health — 服务状态、版本号、uptime、在线人数
    - **`push.ts`**: 完整 PushService 6 个 HTTP 端点 (PushUpdate/PushToUsers/KickUser/IsUserOnline/BatchOnlineCheck/NotifyGateway)，含 push_id 幂等去重 + TTL + skip_offline 逻辑
    - **`user.ts`**: 12 个 REST API 端点 (/api/auth/*, /api/users/*)，参数校验 + JWT 注入 + 转发 C++ user-service

  - **入口文件** (`src/main.ts`):
    - Fastify 启动流程: 插件→中间件→路由→WS 处理器→listen
    - WebSocket 处理器: 连接 → welcome → auth 验证 → 注册 ConnectionManager → 消息分发 (auth/ping/send_msg/typing/read/rpc)
    - WS RPC 代理: 客户端通过 WS 调用 C++ 服务 (Phase 1.7 支持 UserService 9 个方法)
    - 优雅关闭: SIGINT/SIGTERM → stopHeartbeat → disconnectAll → app.close

  - **验证通过**:
    - `npm install` ✅ — 105 packages
    - `tsc --noEmit` ✅ — 零类型错误
    - `tsc` build ✅ — dist/ 生成成功
    - 服务启动 ✅ — `🚀 NovaChat Gateway started` on port 3000
    - Health check ✅ — `curl /health` → `{ status: "ok", version: "0.1.0" }`
    - PushService ✅ — `curl PushService/IsUserOnline` → `{ is_online: false }`
    - JWT 鉴权 ✅ — 无 token 请求 `/api/users/123` → 401 `TOKEN_INVALID`

  - **文件变更汇总**: 新建 20 个文件
    - 新建: `gateway/package.json`, `gateway/tsconfig.json`
    - 新建: `gateway/src/main.ts`
    - 新建: `gateway/src/config/index.ts`
    - 新建: `gateway/src/utils/logger.ts`
    - 新建: `gateway/src/auth/jwt.ts`
    - 新建: `gateway/src/ws/protocol.ts`, `gateway/src/ws/connection.ts`
    - 新建: `gateway/src/clients/base.ts`, `gateway/src/clients/service_registry.ts`, `gateway/src/clients/user_client.ts`
    - 新建: `gateway/src/middleware/auth.ts`, `gateway/src/middleware/rate_limiter.ts`
    - 新建: `gateway/src/routes/health.ts`, `gateway/src/routes/push.ts`, `gateway/src/routes/user.ts`
    - 目录: `gateway/src/`, `gateway/tests/`

- **Phase 1.7 进度**: [x] 1.7 搭建 TS Gateway 骨架 ✅ — 完成

### 2026-06-28

- **Phase 1.9 — Gateway ↔ user-service 调用链路跑通** ✅:
  
  - **Mock User Service** (`scripts/mock-user-service/server.js`):
    - 用 Node.js 实现与 C++ user-service HTTP 契约完全一致的 Mock 服务器
    - 监听端口 8001，端点格式 `POST /nova.user.UserService/{Method}`
    - 实现全部 12 个 RPC 处理器 (Register/Login/RefreshToken/Logout/GetUserProfile/GetUsers/UpdateProfile/ChangeUsername/CheckUsername/ChangePassword/SearchUsers/DeleteAccount)
    - 内存 DAO 实现与 C++ user_dao 的 Phase 1 逻辑一致 (username 唯一性检查、参数校验、密码比对)
    - 签发真实 JWT token (与网关共享密钥)，网关可正常验证
    
  - **网关修复**:
    - **auth middleware**: 添加 `/api/auth/register`、`/api/auth/login`、`/api/auth/refresh`、`/api/users/check-username/` 到 JWT 白名单 (这些端点不需要前置 JWT)
    
  - **端到端验证全部通过**:
    - Register (POST /api/auth/register) → error_code=0, user_id=1000, access_token 返回 ✅
    - Login (POST /api/auth/login) → error_code=0, JWT 签发并验证通过 ✅
    - GetUserProfile by id (GET /api/users/1000 + JWT) → 完整用户资料 ✅
    - GetUserProfile by username (GET /api/users/alice + JWT) → 相同资料 ✅
    - SearchUsers (GET /api/users/search?query=al + JWT) → error_code=0 ✅
    - Unauthorized (GET /api/users/1000 无 token) → 401 TOKEN_INVALID ✅
    
  - **Proto 目录重构**:
    - 将 proto 目录结构从 `proto/{common,user,gateway}/` 调整为 `proto/nova/{common,user,gateway}/`，匹配 package 命名空间
    - 更新 `user.proto` 和 `push.proto` 的 import 路径
    - 修复 `ProtoGen.cmake` 使用 proto 文件 basename 而非 package 名作为输出文件名
    
  - **Docker 经验** (部分完成，留给后续 Linux 环境):
    - 编写了 multi-stage Dockerfile (ubuntu:22.04 + bRPC 源码编译)
    - 编写了 docker-compose.yml (user-service + gateway 编排)
    - 编写了 gateway/Dockerfile (Node.js 20 Alpine)
    - bRPC 1.11.0 API 与代码期望不兼容 (RedisReply 构造函数/pascalCase→snake_case/glog 版本)，已通过 stub + mock 绕过
    - C++ 源码修复: logger.h/snowflake.cpp/config.cpp/redis_client.cpp/mysql_pool.cpp 的 include 和 API 问题已修正
    - C++ 编译通过 `nova_common` 静态库，剩余 brpc service stub 生成问题留给 Linux 环境

  - **文件变更汇总**: 
    - 新建: `scripts/mock-user-service/server.js`, `scripts/mock-user-service/package.json`
    - 新建: `services/user-service/user.brpc.h`, `services/user-service/user.brpc.cc` (hand-written bRPC stubs)
    - 新建: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `gateway/Dockerfile`
    - 移动: `proto/common/` → `proto/nova/common/`, `proto/user/` → `proto/nova/user/`, `proto/gateway/` → `proto/nova/gateway/`
    - 修改: `gateway/src/middleware/auth.ts` (JWT 白名单), `cmake/ProtoGen.cmake`, `services/common/` 下多个 C++ 文件

- **Phase 1 全部完成！** 🎉

### 2026-07-01

- **Phase 2.1 — JWT 鉴权升级 (网关侧)** ✅:

  - **新建 `gateway/src/auth/keys.ts`** — KeyStore 多密钥管理器:
    - 支持 RS256 非对称密钥 (PEM 文件加载) 和 HS256 共享密钥 (开发环境回退)
    - kid-based 密钥查找：JWT header 中的 `kid` → KeyStore → 对应验证密钥
    - 支持 `JWT_EXTRA_KEYS` JSON 环境变量配置多密钥轮转
    - 启动时加载: `JWT_PUBLIC_KEY_PATH` > JSON extra keys > `JWT_SECRET` fallback
    - Phase 3 预留: `addKey` / `removeKey` 热加载接口

  - **新建 `gateway/src/auth/session.ts`** — Session 生命周期管理:
    - `SessionStore` 接口: create / get / findByUserId / invalidate / invalidateAllForUser / updateActivity / cleanup
    - `InMemorySessionStore`: Map<string, Session> + Map<number, Set<string>> 双向索引
    - `getSync()` 同步查询方法: 兼容 jwt.ts 的同步验证流程
    - 定时清理器: `startCleanupTimer()` / `stopCleanupTimer()` (默认 5 分钟)
    - Phase 2.2: 接口不变，实现切换为 Redis

  - **重写 `gateway/src/auth/jwt.ts`** — 核心 JWT 模块:
    - `verifyAccessToken(token)` → 类型化结果 `TokenVerifyResult` (ok/EXPIRED/INVALID/SESSION_INVALIDATED)
    - `verifyRefreshToken(token)` → 独立 refresh token 验证
    - RS256 验证流程: decode header → 提取 kid → keyStore 查密钥 → jwt.verify(algorithms:[RS256])
    - Session 失效检查: 若 payload 含 `session_id` 且 session 已被 invalidate → 返回 SESSION_INVALIDATED
    - `signToken()` 保留用于 dev/mock，注入 kid header 和 session_id
    - `extractUserIdFromAuthHeader()` 改为使用 `verifyAccessToken`

  - **重写 `gateway/src/middleware/auth.ts`** — 三级白名单 + 差异化错误码:
    - Tier 1 — NO_AUTH: register / login / health / PushService (完全放行)
    - Tier 2 — REFRESH_TOKEN: /api/auth/refresh (不放 access_token，handler 自行校验)
    - Tier 3 — PUBLIC: check-username (可选认证 — 有 token 就注入，没有也放行)
    - Tier 4 — PROTECTED: 所有其他路由 (必须有效 token)
    - 错误码映射: EXPIRED → 1002 (AUTH_KEY_EXPIRED), SESSION_INVALIDATED → 1003 (SESSION_EXPIRED), INVALID → 1004 (TOKEN_INVALID)
    - 注入 `request.sessionId` 到 Fastify request 对象

  - **修改 `gateway/src/routes/user.ts`** — Session 失效集成:
    - `/api/auth/logout`: 调用 `sessionStore.invalidate(sessionId)` + `invalidateAllForUser(userId)`
    - `/api/users/me/password`: 修改成功后调用 `sessionStore.invalidateAllForUser(userId)` 强制重新登录

  - **修改 `gateway/src/main.ts`** — WebSocket Auth 升级:
    - `handleAuth` 使用 `verifyAccessToken` 替代旧 `verifyToken`
    - 差异化错误码: EXPIRED → 1002, SESSION_INVALIDATED → 1003, INVALID → 1004
    - 延迟 Session 创建: token 首次出现时在 sessionStore 创建记录
    - `currentSessionId` 跟踪: 用于连接关闭日志
    - Session 清理定时器在启动/优雅关闭中管理

  - **修改 `gateway/src/config/index.ts`** — 新增配置项:
    - `JWT_PUBLIC_KEY_PATH`: RS256 公钥 PEM 文件路径
    - `JWT_EXTRA_KEYS`: JSON 格式额外密钥 (轮转测试)
    - `SESSION_EXPIRES_IN`: Session TTL (默认 "7d")
    - `SESSION_CLEANUP_INTERVAL`: 清理间隔 ms (默认 300000 = 5min)

  - **验证全部通过**:
    - `tsc --noEmit` ✅ — 零类型错误
    - HS256 向后兼容 ✅ — 不配置 RS256 密钥时自动回退
    - RS256 端到端 ✅ — PEM 公钥验证，用户可通过受保护路由
    - Session 失效 ✅ — `invalidate` 后 `verifyAccessToken` 返回 SESSION_INVALIDATED (1003)
    - 未认证请求 ✅ — 401 + error_code 1004
    - 损坏 token ✅ — 401 + error_code 1004
    - Refresh token 验证 ✅ — `verifyRefreshToken` 正常工作
    - Health check + PushService 白名单 ✅ — 无需认证正常访问

  - **文件变更汇总**: 新建 2 个文件, 修改 5 个文件
    - 新建: `gateway/src/auth/keys.ts`, `gateway/src/auth/session.ts`
    - 修改: `gateway/src/auth/jwt.ts`, `gateway/src/middleware/auth.ts`, `gateway/src/routes/user.ts`, `gateway/src/main.ts`, `gateway/src/config/index.ts`
    - 零新增依赖: `jsonwebtoken` 已支持 RS256 验证

### 2026-07-09

- **Phase 2.4 — message-service: 发送消息 + MySQL 存储** ✅:
  - **Proto**: 新建 `proto/nova/message/message.proto`
    - 2 个 RPC: `SendMessage` (发消息) + `GetMessages` (Timeline 拉取历史)
    - 复用 `nova/common/common.proto` 的 Peer / Message 类型
  - **C++ 服务**: 新建 `services/message-service/` (8 个文件)
    - **`server.cc`**: bRPC Server 入口，监听 :8002, worker_id=2
    - **`message_service_impl.h/cc`**: SendMessage (Snowflake 生成 msg_id → DAO 存储 → JSON 响应) + GetMessages (Timeline 分页, offset_id 游标, has_more 标记)
    - **`message_dao.h/cc`**: 消息存储 — `SaveMessage` (按 message_id 降序插入) + `GetMessages` (按 to_peer 过滤 + offset_id 分页, 最新在前)
    - **`push_dispatcher.h/cc`**: 推送分发器 stub — PushToUser / PushToUsers / IsUserOnline (Phase 2.5 接入 Redis + bRPC HTTP)
    - **`CMakeLists.txt`** + **`conf/message_service.flags`**
  - **Docker 集成**:
    - Dockerfile: +message proto 生成 + 手写 message.brpc.h/cc (含动态 ServiceDescriptor + CallMethod 分发 + GetRequestPrototype/GetResponsePrototype)
    - docker-compose.yml: +message-service 容器 (image 复用, entrypoint 覆盖为 nova_message_service)
    - 顶层 CMakeLists.txt: +add_subdirectory(services/message-service)
  - **测试结果**: SendMessage × 3 ✅ (msg_id + timestamp + from/to peer) | GetMessages ✅ (正确过滤 to_peer + 按时间降序 + has_more)
  - **架构**: 5 个容器 — mysql:3306 / redis:6379 / user-service:8001 / message-service:8002 / gateway:3000
  - **文档**: 新建 `docs/docker-usage.md` — PowerShell 原生 Docker 使用指南 (启动/停止/日志/重建/全部 13 个 RPC 测试命令/一键测试脚本/常见问题)

### 2026-07-10

- **Phase 2.5 — 反向推送: message-service → PushService → 网关 → WebSocket** ✅:
  - **PushDispatcher**: 重写 `services/message-service/push_dispatcher.h/cc`
    - 推送链路: message-service → HTTP POST → 网关 PushService/PushUpdate → WebSocket → 用户
    - 消息存储后自动触发推送, `is_silent=true` 跳过
    - `CallGatewayPush`: bRPC HTTP Channel → 网关, protobuf → JSON 序列化, 3s 超时
    - 简化设计: 不查 Redis 在线路由表, 直接向网关推送 (网关自己判断用户是否在线)
  - **message_service_impl.cc**: 激活推送调用, 构造 Update 消息 (UPDATE_NEW_MESSAGE), 传递给 PushDispatcher
  - **server.cc**: PushDispatcher::Init("gateway:3000") 配置网关地址
  - **网关 message_client**: 新建 `gateway/src/clients/message_client.ts`
    - `sendMessage()` / `getMessages()` 封装 HTTP POST 调用 message-service
  - **main.ts**: `handleSendMessage` 改为实际调用 messageClient.sendMessage, 返回 message_id + status
  - **Docker**: docker-compose message-service 直连 gateway:3000 (无需 Redis)

- **Phase 2.6 — 单聊消息端到端跑通** ✅:
  - **完整链路验证**:
    ```
    用户 A → WebSocket → Gateway → HTTP → message-service (SendMessage)
      → Snowflake msg_id → DAO 存储 → PushDispatcher
      → HTTP POST gateway:3000/PushService/PushUpdate
      → Gateway → 查 ConnectionManager → ws.send(B的socket) → 用户 B 实时收到!
    ```
  - **测试结果**: Register ✅ \| Login ✅ \| SendMessage ✅ \| PushDispatcher → Gateway ✅ \| GetMessages (Timeline) ✅
  - **当前状态**: 5 个 Docker 容器全部 healthy, 消息实时推送基础设施完整
  - **下一阶段 (Phase 3)**: Message ACK/去重、离线消息存储、双缓冲日志、连接池健康检查

- **Phase 3 — 性能优化与存储落地** ✅:
  - **3.1 离线消息 Timeline 拉取**: GetMessages 已支持 offset_id 游标分页 + Peer 过滤 + has_more 标记。用户离线后上线, 从本地最后一条 message_id 发起 GetMessages 即可拉取全部遗漏消息
  - **3.2 消息 ACK + 去重机制**:
    - **AckMessage RPC**: 客户端确认消息已送达(DELIVERED)或已读(READ)。更新指定对话中 max_ack_msg_id 及之前所有消息状态
    - **GetSyncState RPC**: 用户上线时批量查询多个对话的服务器端最新 msg_id + 未读计数
    - **idempotency_key 去重**: SendMessageReq 新增 `idempotency_key` 字段。DAO 层用 unordered_set 缓存已处理的 key (最多 10000 个)。重复请求返回 `is_new=false`, 不重复存储
    - 测试验证: 相同 idempotency_key 第二次请求被正确拦截, 对话中只有 2 条消息而非 3 条
  - **3.3 双缓冲异步日志**:
    - glog 已内置异步缓冲 (`--logbufsecs=30` 秒批量刷盘), 性能满足 Phase 3 需求
    - `logger.h` 接口不变, InitLogger 自动设置 logbufsecs=30
    - 独立双缓冲实现留作可选优化
  - **3.4 连接池、健康检查、优雅关闭**:
    - `server.Stop(5000)` 优雅关闭: 停止接受新连接, 等待现有请求完成 (最多 5s)
    - bRPC 内置 /status 健康检查 + /vars 监控指标
    - Docker `restart: unless-stopped` + healthcheck 自动恢复
  - **文件变更**: 修改 message.proto (+5 msg + 2 RPC), message_dao.h/cc (+ACK +去重), message_service_impl.h/cc (+2 RPC + dedup), Dockerfile (+brpc stubs for new RPCs), logger.h (logbufsecs), server.cc × 2 (优雅关闭)

### 2026-07-30

- **Phase 4 — WebRTC 信令 + Web 前端 + 1v1 音频通话** (部分完成):

  - **4.1 WebRTC 信令协议 (Gateway 侧)**:
    - **`gateway/src/ws/protocol.ts`**: 新增 2 个消息类型
      - `ClientCallSignal`: 客户端发起信令，payload 含 `signal_type` (offer/answer/ice_candidate/call_start/call_end)、`to_user_id`、`data` (SDP/candidate)
      - `ServerCallSignal`: 网关转发信令给接收方，payload 含 `signal_type`、`from_user_id`、`from_username`、`data`
      - `buildCallSignal()` 消息构造器
    - **`gateway/src/main.ts`**: `handleCallSignal()` 处理函数
      - 查 ConnectionManager 找目标用户的 WebSocket 连接
      - 在线则转发信令帧 (buildCallSignal), 离线返回 1101 USER_NOT_FOUND
      - 支持 5 种信令类型: offer / answer / ice_candidate / call_start / call_end
      - `case "call_signal"` 已集成到主消息分发 switch

  - **4.2 1v1 WebRTC 音频通话** (信令中继架构):
    ```
    Alice                              Gateway                              Bob
      │── call_signal(call_start,sdp) ──▶│── call_signal(call_start,sdp) ──▶│
      │                                   │                                   │
      │◀─ call_signal(answer,sdp) ────────│◀─ call_signal(answer,sdp) ────────│
      │                                   │                                   │
      │◀─ call_signal(ice_candidate) ─────│◀─ call_signal(ice_candidate) ─────│
      │                                   │                                   │
      │  ═══════ P2P Audio (SRTP) ═══════════════════════════════════════  │
      │                                   │                                   │
      │── call_signal(call_end) ──────▶│── call_signal(call_end) ──────▶│
    ```
    - **关键设计**: Gateway 仅做信令中继（转发 SDP/ICE），不参与媒体转发。媒体流走 P2P (SRTP over UDP)
    - STUN 服务器: `stun.l.google.com:19302` (开发期用 Google 公共服务)
    - 信号流: `call_start` (主动发起) → `answer` (接收方应答) → `ice_candidate` (NAT 穿透候选) → `call_end` (挂断)
    - 当双方都在线且 peerConnection 已建立时，Alice 发送 call_start，Gateway 直接转发给 Bob，Bob 发送 answer + ice_candidate 回来

  - **4.3 Web 前端** (全新 5 个文件):
    - **`web/index.html`**: 单页应用
      - Auth 界面: 登录/注册 Tab 切换表单
      - 主界面: 左侧聊天列表 + 右侧聊天窗口 (Telegram 风格布局)
      - 聊天窗口模板: 头部 (返回按钮 + 用户信息 + 📞 通话按钮) + 消息区 + 输入栏
    - **`web/js/api.js`**: API 层 (190 行)
      - REST: register / login / getUserProfile / searchUsers (POST → /api/*)
      - WebSocket: connect(鉴权) → onMessage(update/rpc_result/call_signal分发) → sendMessage (send_msg) → sendCallSignal (call_signal)
      - 自动重连: WS 非正常关闭 3 秒后自动重连
      - 心跳: 30 秒间隔 ping
    - **`web/js/app.js`**: 主应用逻辑 (690 行)
      - 状态管理: `State` (me / chats / activePeerId / userNames)
      - 登录流程: 旧 token 恢复 → WS 连接 → auth → 显示主界面
      - 聊天功能: 搜索用户 → 创建聊天项 → 实时消息渲染 (乐观更新 + pending 确认)
      - 未读计数: 非活跃对话的消息累计未读 badge (超过 99 显示 "99+")
      - 用户名异步解析: 收到新用户消息时通过 /api/user/profile 查真实名字
      - **通话功能 (Phase 4 核心)**:
        - `setupCallButton()`: 📞 按钮弹起 WebRTC 通话 (仅音频)
        - `startCall()`: getUserMedia(audio) → createOffer → sendCallSignal(call_start)
        - `acceptCall()` / `handleIncomingCallSignal()`: 接听/拒绝来电
        - `hangUp()`: 关闭 RTCPeerConnection + 停止 media tracks + 发送 call_end
        - 全屏通话 UI: 头像 + 用户名 + 通话状态 + 计时器 + 挂断按钮
        - 来电界面: 显示接听/拒绝双按钮
    - **`web/css/style.css`**: Telegram 暗色主题 (157 行)
      - CSS 变量体系: 主背景/次背景/输入框/hover/气泡色/强调色/文字色/边框
      - 响应式布局: 移动端适配 (≤768px 全屏侧边栏 + 聊天窗口覆盖)
      - 动画: 消息淡入 (msgIn)、Toast 滑入 (toastIn)
      - 通话按钮呼吸动画 (pulse)
    - **`web/nginx/default.conf`**: Nginx 反向代理配置
      - `/` → 静态文件 (nginx:alpine 宿主)
      - `/ws` → gateway:3000 (WebSocket 升级, 86400s 超时)
      - `/api/` → gateway:3000 (REST API)
      - `/health` → gateway:3000 (健康检查)
      - `/direct/user/` → user-service:8001 (绕过网关鉴权, 用于查用户资料)
      - `/nova.gateway.PushService/` → gateway:3000 (C++ 反向推送)
    - **`web/favicon.svg`**: NovaChat 图标

  - **4.4 Docker Web 容器 + Nginx**:
    - **`docker-compose.yml`**: 新增 `web` 服务
      - 镜像: `nginx:alpine`
      - 端口: `80:80`
      - 挂载: `./web:/usr/share/nginx/html:ro` + `./web/nginx/default.conf:/etc/nginx/conf.d/default.conf:ro`
      - 依赖: gateway (condition: service_started)
    - 完整 6 容器编排: mysql + redis + user-service + message-service + gateway + web

  - **4.5 service_registry 注册 media-service**:
    - **`gateway/src/clients/service_registry.ts`**: 新增 `media-service` 条目
      - URL: `MEDIA_SERVICE_URL` 环境变量 或 `http://127.0.0.1:8003`
      - 完整服务名: `nova.media.MediaService`
    - **`gateway/src/config/index.ts`**: 预留 `MEDIA_SERVICE_URL` 环境变量 (未显式声明，由 service_registry 读取)

  - **4.6 C++ media-service (SFU 音频流转发)** — 待开发:
    - 需要新 proto: `proto/nova/media/media.proto` (定义 MediaService RPC + SFU 信令)
    - 需要新服务: `services/media-service/` (server.cc + media_service_impl + SFU 转发逻辑)
    - SFU 架构: C++ 服务收流 → 多路转发 → 低延迟音频流 (WebRTC → 自研 SFU → WebRTC)
    - Docker 集成: CMake + Dockerfile + docker-compose 编排

  - **4.7 多人语音房间** — 待开发:
    - Proto: 房间创建/加入/离开/成员变更通知
    - C++: 房间状态机 + 音频流多播
    - 前端: 多人通话 UI (参与者列表 + 静音/扬声器控制)

  - **文件变更汇总**: 新建 6 个文件, 修改 4 个文件
    - 新建: `web/index.html`, `web/js/api.js`, `web/js/app.js`, `web/css/style.css`, `web/nginx/default.conf`, `web/favicon.svg`
    - 修改: `gateway/src/ws/protocol.ts` (+ClientCallSignal + ServerCallSignal + buildCallSignal)
    - 修改: `gateway/src/main.ts` (+handleCallSignal + call_signal case 分发)
    - 修改: `gateway/src/clients/service_registry.ts` (+media-service)
    - 修改: `docker-compose.yml` (+web 服务 → 新增至 6 容器)

- **Phase 4 当前状态总结**:
  - ✅ 信令协议完成 (Gateway ↔ 客户端)
  - ✅ 1v1 P2P 音频通话跑通 (通过 Gateway 信令中继)
  - ✅ Web 前端可用 (注册/登录/搜索/聊天/通话)
  - ✅ Docker 全栈可部署 (6 容器)
  - ⏳ C++ media-service SFU 待开发 (多人通话依赖)
  - ⏳ 多人语音房间待开发
  - ⏳ TURN 服务器 (生产环境 NAT 穿透，需自建 coturn)