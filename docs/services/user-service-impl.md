# User Service RPC 实现 — `user_service_impl.h` / `user_service_impl.cc`

## 技术职责

这两个文件实现了 `user.brpc.h` 中定义的 `UserServiceBase` 抽象类，提供了 **12 个 RPC 方法的完整业务逻辑**。`user_service_impl.h` 声明类 `UserServiceImpl`，`user_service_impl.cc` 提供具体实现。

### 构造与依赖注入

构造函数接收两个指针参数：`Snowflake*`（分布式 ID 生成器）和 `UserDao*`（数据访问层）。采用非拥有指针设计，生命周期由调用方（`server.cc`）管理，便于单元测试时注入 mock 对象。

### 12 个 RPC 方法分类

| 分类 | 方法 | 说明 |
|------|------|------|
| **认证** | `Register` | 注册新用户，校验用户名/密码/姓名格式，检查唯一性，注册即登录（返回 token） |
| | `Login` | 用户名+密码登录，验证密码，生成 access/refresh token |
| | `RefreshToken` | Token 轮转——删除旧 session，创建新 session，防重放 |
| | `Logout` | 清除用户所有 session |
| **资料查询** | `GetUserProfile` | 按 user_id 或 username 查询，对其他用户隐藏 phone |
| | `GetUsers` | 批量查询（限制 `kMaxBatchSize`，返回不含 phone） |
| **资料修改** | `UpdateProfile` | 更新 first_name / last_name / bio / avatar_photo_id |
| | `ChangeUsername` | 修改用户名，1 小时内限制修改一次 |
| | `CheckUsername` | 预检查用户名格式及可用性 |
| | `ChangePassword` | 验证旧密码后更新密码，并清除所有已有 session 强制重新登录 |
| **搜索** | `SearchUsers` | 按 query 前缀匹配 username 或 first_name（分页，上限 50） |
| **账户管理** | `DeleteAccount` | 密码确认后软删除用户，清除所有 session |

### 辅助功能

- **Token 生成**：Phase 1 的简化实现，格式为 `tok_<user_id_hex>_<timestamp>_<snowflake_seq>`；Phase 2 将替换为 JWT RS256。
- **密码处理**：Phase 1 仅加前缀 `hash:` 后明文存储；Phase 2 将使用 bcrypt（12 轮）。
- **参数校验**：`ValidateUsername`（字母开头、仅允许字母数字下划线）和 `ValidatePassword`（长度范围检查）。
- **Session 管理**：每个登录会话记录 user_id、refresh_token、设备类型、过期时间，用于 Token 轮转和强制登出。

每个 RPC 方法体均使用 `brpc::ClosureGuard done_guard(done)` 确保无论成功或异常，`done->Run()` 都能被正确调用。

## 业务角色

`UserServiceImpl` 是 User Service 的**业务逻辑层**。它定义了 NovaChat 用户账户的生命周期——从注册到注销的所有操作规则：用户名必须唯一且符合格式；密码修改后踢除所有已有登录；用户名修改有频率限制；手机号只对本人可见；账户删除为软删除。

这些规则直接对标 Telegram 的用户体系设计。

## 系统连接

- **接口定义**：继承自 `user.brpc.h` 中的 `UserServiceBase`，由 bRPC 框架路由请求到对应方法
- **数据持久化**：通过 `UserDao` 接口操作数据，Phase 1 为内存，Phase 2 切换 MySQL+Redis
- **上游调用方**：TypeScript 网关层将 HTTP RESTful 请求翻译为对应 protobuf 请求后调用
- **ID 依赖**：使用 `Snowflake`（由 `server.cc` 创建）生成 user_id 和 token 序列号
