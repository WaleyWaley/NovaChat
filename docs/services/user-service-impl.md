# User Service RPC 实现 — `user_service_impl.h` / `user_service_impl.cc`

## 技术职责

这两个文件实现了 `user.brpc.h` 中定义的 `UserServiceBase` 抽象类，提供 **12 个 RPC 方法的完整业务逻辑**。

### 构造与依赖注入

构造函数接收两个非拥有指针：`Snowflake*`（分布式 ID 生成器）和 `UserDao*`（数据访问层）。生命周期由 `server.cc` 管理，便于测试时注入 mock 对象。

### 12 个 RPC 方法分 5 组

#### 1. 认证（4 个）

| 方法 | 说明 | 关键逻辑 |
|------|------|----------|
| `Register` | 注册新用户 | 校验 username/password/first_name 格式 → 检查用户名唯一性 → `snowflake_->NextId()` 生成 user_id → `nova::HashPassword()` PBKDF2 哈希 → `dao_->CreateUser()` → 签发 Token → `dao_->CreateSession()` |
| `Login` | 用户名 + 密码登录 | 查找用户 → `nova::CheckPassword()` 验证（常数时间比较） → 签发 Token → 创建 Session |
| `RefreshToken` | Token 轮转 | 查找旧 session → 检查过期 → 删除旧 session → 创建新 session → 返回新 Token 对（防重放攻击） |
| `Logout` | 登出 | 调用 `dao_->DeleteAllSessions(user_id)` 清除所有 session |

#### 2. 资料查询（2 个）

| 方法 | 说明 |
|------|------|
| `GetUserProfile` | 按 user_id 或 username（`oneof identifier`）查询。对其他用户隐藏 phone 字段 |
| `GetUsers` | 批量查询（限制 `kMaxBatchSize`，返回不含 phone） |

#### 3. 资料修改（4 个）

| 方法 | 说明 | 安全策略 |
|------|------|----------|
| `UpdateProfile` | 更新 first_name / last_name / bio / avatar_photo_id | 只覆盖非空字段 |
| `ChangeUsername` | 修改用户名 | 1 小时内限制修改一次（`username_changed_at` 检查）；成功后清除所有 session |
| `CheckUsername` | 预检查用户名格式及可用性 | 仅检查，不修改 |
| `ChangePassword` | 修改密码 | 先验证旧密码 → PBKDF2 哈希新密码 → **清除所有 session 强制所有设备重新登录** |

#### 4. 搜索（1 个）

| 方法 | 说明 |
|------|------|
| `SearchUsers` | 按 query 前缀匹配 username 或 first_name，offset_id 分页，上限 50。返回结果隐藏 phone |

#### 5. 账户管理（1 个）

| 方法 | 说明 |
|------|------|
| `DeleteAccount` | 密码二次确认 → 软删除（`is_deleted=true`）→ 清除所有 session |

### 密码安全

使用 `nova::HashPassword()` / `nova::CheckPassword()`（定义在 `services/common/src/password.cpp`）：

- **算法**：PBKDF2-HMAC-SHA256，100,000 次迭代，16 字节随机 Salt，32 字节派生密钥
- **格式**：`$pbkdf2-sha256$100000$<hex_salt>$<hex_hash>`
- **向后兼容**：`CheckPassword` 自动识别 Phase 1 的 `"hash:"` 前缀明文格式并提示升级
- **时序安全**：XOR-accumulate 常数时间比较，防时序攻击

### Token 签发

Phase 2 改造后，`Register` 和 `Login` 返回 `access_token`（1 小时 TTL）和 `refresh_token`（30 天 TTL）。生产环境中 Token 由 C++ user-service 用 RS256 私钥签发，网关持有公钥验证。

### ClosureGuard 保证

每个 RPC 方法体均使用 `brpc::ClosureGuard done_guard(done)`，确保无论成功或异常，`done->Run()` 都能被正确调用，避免 bRPC 资源泄漏。

## 业务角色

`UserServiceImpl` 是 User Service 的**业务逻辑层**。它定义了 NovaChat 用户账户的完整生命周期——从注册到注销的所有操作规则：

- 用户名必须唯一且符合格式（字母开头，3-32 字符，仅字母数字下划线）
- 密码哈希使用 OWASP 推荐的 PBKDF2-SHA256
- 修改密码后强制踢除所有已有登录
- 修改用户名有 1 小时频率限制
- 手机号只对本人可见
- 账户删除为软删除

这些规则直接对标 Telegram 的用户体系设计。

## 系统连接

- **接口定义**：继承自 `user.brpc.h` 中的 `UserServiceBase`，由 bRPC 框架路由请求到对应方法
- **数据持久化**：通过 `UserDao` 接口操作数据，支持 MySQL + Redis + 内存三模式
- **密码安全**：通过 `nova::HashPassword` / `nova::CheckPassword`（`services/common/src/password.cpp`）进行 PBKDF2 哈希
- **上游调用方**：TypeScript 网关将 HTTP RESTful 请求翻译为 Protobuf 请求后调用
- **ID 依赖**：使用 `Snowflake`（由 `server.cc` 创建，worker_id=1）生成 user_id
