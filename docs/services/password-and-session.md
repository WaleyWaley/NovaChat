# Phase 2.2 — C++ 侧: PBKDF2 密码哈希 + Redis Session 缓存

> **所属服务**: user-service (C++ bRPC)
> **依赖**: OpenSSL (PBKDF2), Redis (Session 缓存), MySQL (用户持久化)
> **前置 Phase**: 1.6 (user-service 骨架), 1.8 (Proto 生成)

---

## 目录

1. [概述](#1-概述)
2. [密码哈希：从明文到 PBKDF2](#2-密码哈希从明文到-pbkdf2)
3. [Redis 客户端：从桩到完整实现](#3-redis-客户端从桩到完整实现)
4. [MySQL 连接池：从桩到完整实现](#4-mysql-连接池从桩到完整实现)
5. [UserDao 双模式存储](#5-userdao-双模式存储)
6. [开发模式 vs 生产模式](#6-开发模式-vs-生产模式)
7. [文件清单](#7-文件清单)

---

## 1. 概述

Phase 2.2 的核心目标是**让 user-service 从"玩具"变成"可用"的服务**。Phase 1 中的三个临时替代方案全部替换为真实实现：

| 模块 | Phase 1 (桩) | Phase 2.2 (真实) |
|------|-------------|-----------------|
| 密码存储 | `"hash:" + 明文` | PBKDF2-HMAC-SHA256, 100K 迭代 |
| Session 存储 | `std::unordered_map` 内存 | Redis, 自动 TTL 过期 |
| 用户持久化 | `std::unordered_map` 内存 | MySQL, 重启不丢数据 |

**架构原则**: 每个模块独立可降级。Redis 不可用 → Session 回退内存；MySQL 不可用 → 用户数据回退内存。网关永远可以启动。

---

## 2. 密码哈希：从明文到 PBKDF2

### 2.1 为什么不直接用 bcrypt？

bcrypt 是更好的选择（自带 salt + 可调 cost + 抗 GPU），但需要额外引入 `libbcrypt`。OpenSSL 是 bRPC 的传递依赖，已经在系统中存在。PBKDF2-HMAC-SHA256 同样是 OWASP 推荐的密码哈希算法，且不需要新增依赖。

### 2.2 哈希格式

```
$pbkdf2-sha256$100000$a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6$d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0
│              │       │                                │
│              │       │                                └── 32 字节派生密钥 (hex)
│              │       └── 16 字节随机 Salt (hex)
│              └── 迭代次数 (OWASP 推荐 ≥100,000)
└── 算法标识
```

### 2.3 核心代码

`services/common/include/nova/password.h` — 对外接口：

```cpp
namespace nova {

// 对明文密码进行哈希，返回格式化字符串
// 每次调用生成新的随机 Salt，同一密码两次调用结果不同
std::string HashPassword(const std::string& password);

// 验证明文密码是否匹配
// 自动识别 Phase 1 的 "hash:" 前缀格式并提示升级
bool CheckPassword(const std::string& password, const std::string& hash);

}
```

`services/common/src/password.cpp` — PBKDF2 实现细节：

```cpp
// 参数
constexpr int kIterations  = 100000;   // OWASP 2023 推荐最小值
constexpr int kSaltBytes   = 16;       // 128 bits salt
constexpr int kOutputBytes = 32;       // SHA256 → 256 bits

// 核心调用
PKCS5_PBKDF2_HMAC(
    password.data(), password.size(),
    salt, kSaltBytes,
    kIterations,
    EVP_sha256(),        // HMAC-SHA256
    kOutputBytes, derived
);
```

**向后兼容设计**: `CheckPassword` 首先检查 hash 是否以 `"hash:"` 开头（Phase 1 格式），如果是则直接比较明文并打印升级警告。新密码统一使用 PBKDF2 格式存储。

**常数时间比较**: 使用 XOR-accumulate 模式避免时序攻击：

```cpp
int result = 0;
for (size_t i = 0; i < hex_computed.size(); i++) {
    result |= (hex_computed[i] ^ hex_hash[i]);
}
return result == 0;  // 不会提前返回，运行时间恒定
```

### 2.4 在 user_service_impl.cc 中的使用

Phase 1 时，`user_service_impl.cc` 在匿名 namespace 中定义了自己的 `HashPassword`/`CheckPassword`。Phase 2.2 改为使用公共库版本：

```cpp
// 之前 (Phase 1) — 匿名 namespace 中的本地函数
namespace {
    std::string HashPassword(const std::string& password) {
        return "hash:" + password;  // 明文!
    }
}

// 之后 (Phase 2.2) — 使用公共库
#include "nova/password.h"
// 调用: nova::HashPassword(password), nova::CheckPassword(password, hash)
```

---

## 3. Redis 客户端：从桩到完整实现

### 3.1 通信原理

```
C++ user-service                Redis Server
─────────────────               ────────────
brpc::Channel                   
  protocol = PROTOCOL_REDIS     
  ↓                             
  构建 RESP 命令字符串           
  *3\r\n$3\r\nSET\r\n...       
  ↓                             
  cntl.request_attachment()     
  ↓                             
  channel.CallMethod()          
  ↓               ──TCP──→      解析 RESP 命令
                                ↓
                                执行 SET mykey "hello" EX 300
                                ↓
                   ←──TCP──     +OK\r\n
  ↓
  cntl.response_attachment()
  ↓
  解析 RESP 响应 → butil::Status
```

### 3.2 RESP 协议编解码

Redis 使用 RESP (REdis Serialization Protocol)，5 种数据类型：

| 类型 | 前缀 | 示例 | 含义 |
|------|------|------|------|
| Simple String | `+` | `+OK\r\n` | 成功响应 |
| Error | `-` | `-ERR unknown\r\n` | 错误 |
| Integer | `:` | `:1000\r\n` | 整数 |
| Bulk String | `$` | `$5\r\nhello\r\n` | 字符串 |
| Array | `*` | `*2\r\n$3\r\nfoo\r\n$3\r\nbar\r\n` | 数组 |

**编码**: 把 Redis 命令转成 Array of Bulk Strings。

```cpp
// 输入: {"SET", "mykey", "hello", "EX", "300"}
// 输出: *5\r\n$3\r\nSET\r\n$5\r\nmykey\r\n$5\r\nhello\r\n$2\r\nEX\r\n$3\r\n300\r\n
std::string RespCommand(const std::vector<std::string>& parts) {
    std::string cmd;
    cmd += "*" + std::to_string(parts.size()) + "\r\n";
    for (const auto& p : parts) {
        cmd += "$" + std::to_string(p.size()) + "\r\n" + p + "\r\n";
    }
    return cmd;
}
```

**解码**: 解析 Bulk String 内容。

```cpp
// 输入: "$5\r\nhello\r\n" (原始回复)
// 输出: "hello" (提取的内容)
bool ParseBulkStringContent(const std::string& raw, size_t* pos, std::string* data);
```

### 3.3 15 个命令实现

| 分类 | 命令 | RESP 编码示例 |
|------|------|-------------|
| KV | `SET key val EX 300` | `*5\r\n$3\r\nSET\r\n...` |
| KV | `GET key` | `*2\r\n$3\r\nGET\r\n...` |
| KV | `DEL key` | `*2\r\n$3\r\nDEL\r\n...` |
| KV | `EXISTS key` | `*2\r\n$6\r\nEXISTS\r\n...` |
| KV | `EXPIRE key 300` | `*3\r\n$6\r\nEXPIRE\r\n...` |
| KV | `TTL key` | `*2\r\n$3\r\nTTL\r\n...` |
| Hash | `HSET key field val` | `*4\r\n$4\r\nHSET\r\n...` |
| Hash | `HGET key field` | `*3\r\n$4\r\nHGET\r\n...` |
| Hash | `HDEL key field` | `*3\r\n$4\r\nHDEL\r\n...` |
| Hash | `HGETALL key` | `*2\r\n$7\r\nHGETALL\r\n...` |
| Set | `SADD key member` | `*3\r\n$4\r\nSADD\r\n...` |
| Set | `SREM key member` | `*3\r\n$4\r\nSREM\r\n...` |
| Set | `SISMEMBER key m` | `*3\r\n$9\r\nSISMEMBER\r\n...` |
| Set | `SMEMBERS key` | `*2\r\n$8\r\nSMEMBERS\r\n...` |

所有命令通过同一个 `SendCommand()` 底层方法执行，错误统一通过 `butil::Status` 返回。

---

## 4. MySQL 连接池：从桩到完整实现

### 4.1 通信原理

```
C++ user-service                  MySQL Server
─────────────────                 ────────────
brpc::Channel (多个, Round-robin)
  protocol = PROTOCOL_MYSQL
  ↓                               
  发送 SQL 文本                    
  cntl.request_attachment()        
    .append("SELECT * FROM users")
  ↓                               
  channel.CallMethod()             
  ↓               ──TCP──→        bRPC 处理 MySQL 握手/认证
                                  ↓
                                  执行 SQL
                                  ↓
                   ←──TCP──       返回文本协议结果集
  ↓
  cntl.response_attachment()
  ↓
  解析文本协议 → Row 回调
```

### 4.2 响应解析

MySQL 文本协议返回格式：

```
2                           ← 列数
user_id\t...\t...\n         ← 列定义 (每列一行, Tab 分隔属性)
username\t...\t...\n
123456\talice\n              ← 数据行 (Tab 分隔)
789012\tbob\n
EOF\t                        ← 结束标记 (可选)
```

解析逻辑：

```cpp
butil::Status MySqlPool::Query(const std::string& sql,
                               std::function<void(const Row&)> row_cb) {
    // 1. 发送 SQL
    // 2. 获取响应
    // 3. 解析: 列数 → 跳过列定义 → 解析数据行 → 跳过 EOF
    // 4. 每行回调 row_cb({"user_id": "123456", "username": "alice"})
}
```

### 4.3 Round-robin 连接池

```cpp
brpc::Channel* MySqlPool::PickChannel() {
    size_t idx = rr_idx_.fetch_add(1, std::memory_order_relaxed) % pool_size_;
    return channels_[idx].get();
}
```

多个 Channel 实例以 Round-robin 方式分派 SQL 请求，避免单连接瓶颈。

### 4.4 SQL Schema

`scripts/docker/init.sql` 定义了建表语句：

```sql
CREATE TABLE IF NOT EXISTS users (
    user_id       BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    username      VARCHAR(32) NOT NULL,
    password_hash VARCHAR(256) NOT NULL,
    first_name    VARCHAR(64) NOT NULL,
    last_name     VARCHAR(64) NOT NULL DEFAULT '',
    bio           VARCHAR(256) NOT NULL DEFAULT '',
    avatar_photo_id VARCHAR(128) NOT NULL DEFAULT '',
    phone         VARCHAR(20) NOT NULL DEFAULT '',
    is_deleted    TINYINT(1) NOT NULL DEFAULT 0,
    created_at    BIGINT UNSIGNED NOT NULL,
    updated_at    BIGINT UNSIGNED NOT NULL,
    username_changed_at BIGINT UNSIGNED NOT NULL DEFAULT 0,
    UNIQUE INDEX idx_username (username),
    INDEX idx_created_at (created_at),
    INDEX idx_first_name (first_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

docker-compose 启动时自动执行 `init.sql`。

---

## 5. UserDao 双模式存储

### 5.1 设计理念

UserDao 是 user-service 的**统一数据访问层**。对外提供稳定的接口，对内根据配置选择存储后端：

```
UserDao 对外接口:
  CreateUser / FindById / FindByUsername / UpdateProfile / ...
  CreateSession / FindSession / DeleteSession / ...

内部:
  ┌─────────────────────────────────────┐
  │  if (mysql_ && mysql_->IsReady())   │
  │    → MySQL (持久化)                  │
  │  else                               │
  │    → 内存 std::unordered_map (回退)  │
  ├─────────────────────────────────────┤
  │  if (redis_ && redis_->IsReady())   │
  │    → Redis (带 TTL, 自动过期)        │
  │  else                               │
  │    → 内存 std::unordered_map (回退)  │
  └─────────────────────────────────────┘
```

### 5.2 Session 的 Redis 数据结构

```
类型 1: Session 值
  Key:   sess:<refresh_token>
  Value: <user_id>|<expires_at>|<device_type>|<device_name>|<created_at>
  TTL:   (expires_at - now) 秒

类型 2: 用户 → Session 索引
  Key:   user_sess:<user_id>
  Value: Set of <refresh_token>
  用途: DeleteAllSessions (登出所有设备 / 改密码)
```

**Session 操作流程**:

```
CreateSession(session):
  SET sess:<token> "<uid>|<exp>|<dev>|<name>" EX <ttl>
  SADD user_sess:<uid> <token>

FindSession(token):
  GET sess:<token> → 解码 value → 检查是否过期

DeleteSession(token):
  GET sess:<token> → 解码获得 uid
  DEL sess:<token>
  SREM user_sess:<uid> <token>

DeleteAllSessions(uid):
  SMEMBERS user_sess:<uid> → [token1, token2, ...]
  循环 DEL sess:<tokenN>
  DEL user_sess:<uid>
```

### 5.3 MySQL 用户 CRUD 示例

```cpp
std::optional<UserRecord> UserDao::CreateUser(...) {
    if (mysql_ && mysql_->IsReady()) {
        // MySQL 路径
        std::string sql = "INSERT INTO users (...) VALUES (...)";
        butil::Status st = mysql_->Execute(sql);
        if (st.ok()) return record;
    }
    // 内存回退
    std::lock_guard lock(mu_);
    users_by_id_[user_id] = record;
    return record;
}
```

每个 DAO 方法遵循同样的双路径模式：先试 MySQL/Redis → 失败回退内存。

---

## 6. 开发模式 vs 生产模式

### 6.1 开发模式（零外部依赖）

```bash
./nova_user_service --flagfile=conf/user_service.flags
# 不加 --enable_mysql --enable_redis
# 用户数据: 内存 map
# Session:  内存 map
# 密码:     PBKDF2-SHA256 (只在内存中)
```

### 6.2 生产模式（完整持久化）

```bash
# 先启动 MySQL 和 Redis
docker-compose up -d mysql redis

# 再启动 user-service
./nova_user_service --flagfile=conf/user_service.flags \
    --enable_mysql --enable_redis
# 用户数据: MySQL (docker-compose 自动执行 init.sql 建表)
# Session:  Redis (带 TTL 自动过期)
# 密码:     PBKDF2-SHA256
```

### 6.3 启动日志

```
UserDao initialized (user storage: MySQL, session storage: Redis, password: PBKDF2-SHA256)
```

或：

```
UserDao initialized (user storage: in-memory, session storage: in-memory, password: PBKDF2-SHA256)
```

---

## 7. 文件清单

| 文件 | 动作 | 说明 |
|------|------|------|
| `services/common/include/nova/password.h` | 新建 | 密码哈希接口 |
| `services/common/src/password.cpp` | 新建 | PBKDF2 实现 |
| `services/common/src/redis_client.cpp` | 重写 | RESP 编解码 + 15 命令 |
| `services/common/src/mysql_pool.cpp` | 重写 | MySQL 文本协议解析 |
| `services/common/CMakeLists.txt` | 修改 | +password +OpenSSL |
| `services/user-service/user_dao.cc` | 重写 | MySQL/Redis 双模式 |
| `services/user-service/user_service_impl.cc` | 修改 | 用 `nova::HashPassword` |
| `services/user-service/server.cc` | 修改 | +`--enable_mysql/redis` |
| `services/user-service/conf/user_service.flags` | 修改 | +开关说明 |
| `scripts/docker/init.sql` | 新建 | users + messages 建表 |
| `gateway/package.json` | 修改 | +ioredis 依赖 |

---

> **最后更新**: 2026-07-12
> **当前状态**: 全部实现已完成（PBKDF2 密码哈希 + Redis Session + MySQL 持久化 + 内存回退）
> **相关文档**: [[./user-dao.md]] (UserDao 三模式存储) | [[./user-server.md]] (user-service 启动) | [[../gateway/online-routing.md]] (网关侧在线路由)
