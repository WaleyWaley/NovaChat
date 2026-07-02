# 用户数据访问层 — `user_dao.h` / `user_dao.cc`

## 技术职责

`UserDao`（Data Access Object）是 NovaChat User Service 的**数据访问层**，封装了所有对用户数据和会话数据的持久化操作。它对外提供统一的接口，内部实现的切换对上层 `UserServiceImpl` 完全透明。

### 数据结构

文件定义了两个内部记录类型：

- **`UserRecord`**：用户记录，包含 user_id、username、password_hash、first_name/last_name、bio、avatar_photo_id、phone、时间戳、`is_deleted` 软删除标志以及 `username_changed_at`（用于控制修改频率）。
- **`SessionRecord`**：会话记录，包含 user_id、refresh_token、设备信息（device_type/device_name）和过期时间。

### 接口分类

| 类别 | 方法 | 用途 |
|------|------|------|
| **初始化** | `InitMySql` / `InitRedis` | Phase 2 初始化连接池与缓存客户端 |
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

### Phase 1 vs Phase 2

- **Phase 1（当前）**：使用 `std::unordered_map` + `std::mutex` 实现线程安全的内存存储。用户表以 `user_id` 为 key 存储记录，`users_by_username_` 提供用户名到 ID 的反向索引。所有方法加 `std::lock_guard` 互斥锁。
- **Phase 2（规划）**：通过 `std::unique_ptr<nova::MySqlPool>` 和 `std::unique_ptr<nova::RedisClient>` 连接真实数据库与缓存。接口签名不变，`UserServiceImpl` 无需修改代码。

## 业务角色

`UserDao` 是 NovaChat 用户数据的**存储抽象层**。它将业务逻辑（在 `UserServiceImpl` 中）与数据存储技术解耦，使得团队可以先快速验证业务逻辑，后续再无缝切换至生产级持久化方案，而无需修改任何业务代码。

在设计上与大型 IM 系统的常见模式一致：用户数据存 MySQL（关系型、事务保障），Session/Token 存 Redis（高性能、TTL 自动过期）。`CreateUser` 中的 `user_id` 由调用方（`UserServiceImpl`）通过 Snowflake 预生成后传入，体现了分布式 ID 与存储层分离的架构思想。

## 系统连接

- **上层调用**：`UserServiceImpl`（RPC 实现层）调用 `UserDao` 的所有 CRUD 与 Session 方法
- **下层依赖**：Phase 2 将依赖 `nova::MySqlPool`（MySQL 连接池）和 `nova::RedisClient`（Redis 客户端），两者均在 `nova/` 公共库中
- **前端无关**：DAO 层不感知 protobuf 消息，只操作内部 `UserRecord`/`SessionRecord` 结构体
- **线程安全**：通过 `std::mutex mu_` 保护全部内存数据
