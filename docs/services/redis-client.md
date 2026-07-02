# NovaChat Redis 客户端 (`redis_client.h` / `redis_client.cpp`)

## 技术职责

`RedisClient` 类是对 **bRPC Redis 协议** (`brpc::PROTOCOL_REDIS`) 的轻量封装，为 NovaChat 的 C++ 微服务提供高性能内存数据访问。底层通过 `brpc::Channel` 发送 RESP 协议命令，I/O 自动挂载到 bthread，实现非阻塞式 Redis 通信。

功能覆盖三大数据类型操作：

- **Key/Value 操作**：`Set`（支持 TTL）、`Get`、`Del`、`Exists`、`Expire`、`TTL`。
- **Hash 操作**：`HSet`、`HGet`、`HDel`、`HGetAll`，用于存储结构化对象。
- **Set 操作**：`SAdd`、`SRem`、`SIsMember`、`SMembers`，用于集合管理。

**当前状态：Phase 1 桩实现**。`Init()` 仅记录日志标记就绪，其余所有方法均返回"Redis 不可用"错误。Phase 2 将通过 `brpc::Channel::CallMethod` 发送 RESP 命令并解析返回结果。

## 业务角色

在 NovaChat 即时通讯系统中，Redis 是**核心内存数据库**，承担多个关键业务场景：

- **在线路由表**：`user:online:<user_id> → gateway_addr`，记录每个在线用户所连接的网关地址。消息送达时，发件方服务根据此表查询收件方所在的网关，实现跨网关消息投递。
- **会话缓存**：`session:<token> → user_id`，缓存用户登录会话，避免每次请求都查询 MySQL。配合 `kAccessTokenTTL` / `kRefreshTokenTTL` 实现令牌自动过期。
- **频率限制**：`rate:<user_id>:<action>`，防止 API 滥用（如登录重试、消息发送频率控制）。
- **消息队列**（Phase 3 计划）：Redis List / Stream 可作为轻量级消息队列，用于跨服务异步通信。

这些场景的共同特点是：**高吞吐、低延迟、允许少量数据丢失**。Redis 的内存访问特性完美匹配 IM 系统的在线状态查询和路由转发需求。

## 系统连接

- **依赖于 `logger` 模块**：`Init()` 中记录初始化日志。
- **依赖于 bRPC 框架**：通过 `brpc::Channel` 发送 Redis RESP 协议命令。bRPC 的 bthread 模型确保 Redis 操作不会阻塞服务的主线程。
- **被网关服务使用**：网关维护用户长连接时，定期向 Redis 刷新在线路由表（`kHeartbeatInterval`），同时从 Redis 读取对方用户的网关地址用于消息转发。
- **被业务服务使用**：用户服务在登录/登出时操作会话缓存；消息服务在发送消息时查询在线状态。
- **与 `common.h` 配合**：`kSessionRouteTTL`（30 秒）用于在线路由表的 Key TTL，确保用户断线后路由记录自动过期。
