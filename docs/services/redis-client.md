# NovaChat Redis 客户端 (`redis_client.h` / `redis_client.cpp`)

## 技术职责

`RedisClient` 类是对 **bRPC Redis 协议** (`brpc::PROTOCOL_REDIS`) 的完整封装，为 NovaChat 的 C++ 微服务提供高性能内存数据访问。底层通过 `brpc::Channel` 发送 RESP 协议命令，I/O 自动挂载到 bthread，实现非阻塞式 Redis 通信。

### 通信原理

```
C++ Service                    Redis Server
──────────                     ────────────
brpc::Channel
  protocol = PROTOCOL_REDIS
  ↓
  构建 RESP 命令字符串
  *3\r\n$3\r\nSET\r\n...
  ↓
  cntl.request_attachment()
  ↓
  channel.CallMethod()
  ↓               ──TCP──→    解析 RESP 命令
                              ↓
                              执行命令
                              ↓
                 ←──TCP──     +OK\r\n
  ↓
  cntl.response_attachment()
  ↓
  解析 RESP 响应 → butil::Status
```

### RESP 协议编解码

Redis 使用 RESP (REdis Serialization Protocol)，5 种数据类型：

| 类型 | 前缀 | 示例 | 含义 |
|------|------|------|------|
| Simple String | `+` | `+OK\r\n` | 成功响应 |
| Error | `-` | `-ERR unknown\r\n` | 错误 |
| Integer | `:` | `:1000\r\n` | 整数 |
| Bulk String | `$` | `$5\r\nhello\r\n` | 字符串 |
| Array | `*` | `*2\r\n$3\r\nfoo\r\n$3\r\nbar\r\n` | 数组 |

**编码**：`RespCommand({"SET", "mykey", "hello", "EX", "300"})` → `*5\r\n$3\r\nSET\r\n$5\r\nmykey\r\n$5\r\nhello\r\n$2\r\nEX\r\n$3\r\n300\r\n`

**解码**：`ParseBulkStringContent("$5\r\nhello\r\n", &pos, &data)` → 提取 `"hello"`

### 15 个命令实现

| 分类 | 命令 | 方法 |
|------|------|------|
| KV | SET key val [EX ttl] | `Set(key, val, ttl_sec)` |
| KV | GET key | `Get(key)` → `optional<string>` |
| KV | DEL key | `Del(key)` |
| KV | EXISTS key | `Exists(key)` → `bool` |
| KV | EXPIRE key ttl | `Expire(key, sec)` |
| KV | TTL key | `TTL(key)` → `int` |
| Hash | HSET key field val | `HSet(key, field, val)` |
| Hash | HGET key field | `HGet(key, field)` → `optional<string>` |
| Hash | HDEL key field | `HDel(key, field)` |
| Hash | HGETALL key | `HGetAll(key)` → `vector<pair<string,string>>` |
| Set | SADD key member | `SAdd(key, member)` |
| Set | SREM key member | `SRem(key, member)` |
| Set | SISMEMBER key m | `SIsMember(key, member)` → `bool` |
| Set | SMEMBERS key | `SMembers(key)` → `vector<string>` |

所有命令通过同一个 `SendCommand()` 底层方法执行，错误统一通过 `butil::Status` 返回。`Init()` 连接成功后自动执行 `AUTH` 认证（如果设置了密码）。

## 业务角色

在 NovaChat 即时通讯系统中，Redis 是**核心内存数据库**，承担多个关键业务场景：

- **在线路由表**：`user:online:<user_id> → {gateway_addr, last_heartbeat}`。用户上线时网关写入（带 TTL 30s），C++ 消息服务发消息前查此表找到目标用户所在的网关。
- **Session 缓存**：`sess:<refresh_token> → user_id|expires_at|device_info`。user-service 在登录时写入，网关在 JWT 验证时检查。
- **用户 Session 索引**：`user_sess:<user_id> → Set of tokens`。DeleteAllSessions 时批量清除。

这些场景的共同特点是：**高吞吐、低延迟、允许 TTL 自动过期**。Redis 的内存访问特性完美匹配 IM 系统的在线状态查询和路由转发需求。

## 系统连接

- **依赖于 `logger` 模块**：`Init()` 和所有操作中记录日志。
- **依赖于 bRPC 框架**：通过 `brpc::Channel` + `PROTOCOL_REDIS` 发送 RESP 协议命令。bthread 模型确保 Redis 操作不会阻塞服务主线程。
- **被 user-service 的 UserDao 使用**：Session 的 CRUD 操作通过 RedisClient → Redis 实现。
- **被网关 Redis 客户端独立实现**：网关侧使用 `ioredis`（npm 包），与 C++ 侧 `RedisClient` 平行独立。
- **与 `common.h` 配合**：`kSessionRouteTTL`（30 秒）用于在线路由表的 Key TTL，`kHeartbeatInterval`（15 秒）用于网关心跳刷新周期。
