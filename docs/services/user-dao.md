# 用户数据访问层 — `user_dao.h` / `user_dao.cc`

## 技术职责

`UserDao`（Data Access Object）是 NovaChat User Service 的**数据访问层**，封装了所有对用户数据和会话数据的持久化操作。对外提供统一的接口，内部支持 MySQL + Redis + 内存三种存储后端，可独立降级。

### 数据结构

- **`UserRecord`**：用户记录，包含 user_id、username、password_hash、first_name/last_name、bio、avatar_photo_id、phone、`is_deleted` 软删除标志、时间戳、`username_changed_at`（用户名修改频率控制）。
- **`SessionRecord`**：会话记录，包含 user_id、refresh_token、设备信息（device_type/device_name）、过期时间和创建时间。

### 接口分类

| 类别 | 方法 | 用途 |
|------|------|------|
| **初始化** | `InitMySql` / `InitRedis` | 初始化 MySQL 连接池和 Redis 客户端，失败自动回退内存 |
| **用户 CRUD** | `CreateUser` | 创建用户，返回 `optional<UserRecord>` |
| | `FindById` / `FindByUsername` | 按主键或用户名查找（排除已删除） |
| | `UpdateProfile` | 更新姓名/Bio/头像（只覆盖非空字段） |
| | `ChangeUsername` / `ChangePassword` | 修改用户名或密码，更新映射和时间戳 |
| | `DeleteUser` | 软删除（设置 `is_deleted=true`，清除 username 映射） |
| | `UsernameExists` | 检查用户名唯一性 |
| | `SearchUsers` | 前缀匹配 username 或 first_name，支持 offset_id 分页 |
| | `GetUsersByIds` | 批量查询 |
| **Session 管理** | `CreateSession` | 存储 refresh_token → Session 映射 |
| | `FindSession` | 按 refresh_token 查找 |
| | `DeleteSession` | 删除单条 session（用于登出或 token 轮转） |
| | `DeleteAllSessions` | 清空指定用户的所有 session（强制登出） |

### 三模式存储架构

```
UserDao 对外接口:
  CreateUser / FindById / FindByUsername / ...

内部路由:
  if (mysql_ && mysql_->IsReady())
    → MySQL (持久化：INSERT/SELECT/UPDATE/DELETE)
  else
    → 内存 std::unordered_map (回退)

  if (redis_ && redis_->IsReady())
    → Redis (Session: SET/GET/DEL + user_sess:<uid> Set)
  else
    → 内存 std::unordered_map (回退)
```

每个 DAO 方法遵循**"先试持久化，失败回退内存"**的双路径模式。

### Redis Session 数据结构

```
类型 1: Session 值
  Key:   sess:<refresh_token>
  Value: <user_id>|<expires_at>|<device_type>|<device_name>|<created_at>
  TTL:   (expires_at - now) 秒

类型 2: 用户 → Session 反向索引 (用于 DeleteAllSessions)
  Key:   user_sess:<user_id>
  Value: Set of <refresh_token>
```

Session 操作流程：
- `CreateSession` → `SET sess:<token> "<uid>|<exp>|<dev>|<name>" EX <ttl>` + `SADD user_sess:<uid> <token>`
- `FindSession` → `GET sess:<token>` → 解码 value → 检查是否过期
- `DeleteSession` → `GET sess:<token>`（获取 uid）→ `DEL sess:<token>` + `SREM user_sess:<uid> <token>`
- `DeleteAllSessions` → `SMEMBERS user_sess:<uid>` → 逐个 `DEL sess:<tokenN>` → `DEL user_sess:<uid>`

### MySQL 用户 CRUD（示例）

```cpp
CreateUser:
  sql = "INSERT INTO users (user_id, username, password_hash, first_name, ...) VALUES (...)";
  mysql_->Execute(sql);
  // 失败 → 内存 users_by_id_[user_id] = record

FindByUsername:
  sql = "SELECT * FROM users WHERE username = '...' AND is_deleted = 0";
  mysql_->QueryAll(sql, rows);
  // 失败 → 遍历 users_by_username_ map
```

字符串通过手动转义（`'` → `\'`）构造 SQL，Phase 3+ 可升级为参数化查询。

### 开发模式 vs 生产模式

**开发模式**（不加 `--enable_mysql --enable_redis`）：
- 用户数据：内存 `unordered_map` + `mutex`
- Session：内存 `unordered_map` + `mutex`
- 优势：零外部依赖，启动即用

**生产模式**（加 `--enable_mysql --enable_redis`）：
- 用户数据：MySQL（`docker-compose` 自动执行 `init.sql` 建表）
- Session：Redis（带 TTL 自动过期）
- 优势：持久化、分布式共享

## 业务角色

`UserDao` 是 NovaChat 用户数据的**存储抽象层**。它将业务逻辑（在 `UserServiceImpl` 中）与数据存储技术解耦：

- **MySQL 路径**：关系型数据持久化，重启不丢数据，适合生产环境
- **Redis 路径**：Session 带 TTL 自动过期，分布式共享（多网关节点可共享 Session 状态）
- **内存回退**：开发环境零配置，MySQL/Redis 故障时服务不中断

## 系统连接

- **上层调用**：`UserServiceImpl`（RPC 实现层）调用所有 CRUD 与 Session 方法
- **下层依赖**：`nova::MySqlPool`（MySQL 连接池，Round-robin 分发）和 `nova::RedisClient`（Redis 客户端，15 个命令）
- **前端无关**：DAO 层不感知 protobuf 消息，只操作内部 `UserRecord`/`SessionRecord` 结构体
- **线程安全**：通过 `std::mutex mu_` 保护全部内存数据；MySQL/Redis 的并发由 brpc::Channel 和连接池保障
