# 用户相关 REST API 路由 (`routes/user.ts`)

**文件位置**: `src/routes/user.ts`

## 技术职责

该文件注册了所有与用户账号和资料相关的 HTTP 端点，路由前缀为 `/api`。它扮演着**协议翻译层**的角色——接收客户端的 RESTful 请求，将参数映射为与 `user.proto` 对齐的请求结构，通过 `userClient` 转发给 C++ user-service 微服务，并将结果返回给客户端。

### 认证相关（白名单路径，无需前置 JWT）

| 路由 | 方法 | 功能 | JWT 白名单 |
|------|------|------|-----------|
| `/api/auth/register` | POST | 注册新用户（注册即登录，返回 Token 对） | NO_AUTH |
| `/api/auth/login` | POST | 用户名 + 密码登录，返回 Token 对 | NO_AUTH |
| `/api/auth/refresh` | POST | 使用 refresh_token 轮转 access_token | REFRESH_TOKEN |
| `/api/auth/logout` | POST | 登出（需鉴权）→ 调用 `sessionStore.invalidate()` + `invalidateAllForUser()` 清除所有服务端 session | PROTECTED |

### 资料查询（需鉴权）

| 路由 | 方法 | 功能 |
|------|------|------|
| `/api/users/:id` | GET | 按 user_id（数字）或 @username（`@` 开头）查询单个用户资料 |
| `/api/users/batch` | POST | 批量获取用户资料（上限 100 个），返回 `profiles` 数组 |

### 资料修改（均需鉴权）

| 路由 | 方法 | 功能 |
|------|------|------|
| `/api/users/me` | PATCH | 更新个人资料（first_name, last_name, bio, avatar_photo_id） |
| `/api/users/me/username` | PUT | 修改用户名（需验证 `new_username`） |
| `/api/users/me/password` | PUT | 修改密码 → 成功后调用 `sessionStore.invalidateAllForUser(userId)` **强制所有设备重新登录** |
| `/api/users/me` | DELETE | 删除账户（需验证 `password`）→ 成功后清除所有 session |

### 搜索与检查

| 路由 | 方法 | 功能 | JWT 白名单 |
|------|------|------|-----------|
| `/api/users/check-username/:username` | GET | 检查用户名可用性 | PUBLIC（可选认证） |
| `/api/users/search` | GET | 按 username/first_name 前缀搜索用户（分页，上限 50） | PROTECTED |

### Session 失效集成

文件直接引用 `sessionStore`，在关键安全操作中触发 session 失效：

1. **登出** (`/api/auth/logout`)：先调用 `sessionStore.invalidate(sessionId)` 标记当前 session 失效，再调用 `sessionStore.invalidateAllForUser(userId)` 清除该用户所有设备 session。
2. **修改密码** (`/api/users/me/password`)：密码修改成功后调用 `sessionStore.invalidateAllForUser(userId)`，强制所有已登录设备重新认证。
3. **删除账户** (`/api/users/me` DELETE)：账户删除成功后调用 `sessionStore.invalidateAllForUser(userId)`。

## 业务角色

在 NovaChat 系统中，用户模块是**所有业务的基础**——没有用户身份，消息、群组、频道等功能无从谈起。该路由文件实现了网关层面的用户管理 API，是客户端与 C++ user-service 之间的**唯一桥梁**。

关键业务逻辑：
- **注册即登录**：注册成功后直接返回 Token 对，省去额外登录步骤。
- **Session 管理**：登出和改密码时清除服务端 session，确保旧 Token 立即失效。
- **密码修改安全策略**：改密码成功后强制清除所有设备上的 session，用户需用新密码重新登录，防止密码泄露后继续访问。
- **用户名全局唯一性**：通过 `/check-username` 支持注册前预检。

## 系统连接

- **`../clients/user_client.js`**：核心依赖，封装了与 C++ user-service 的 12 个 RPC 调用。
- **`../auth/session.js`** (`sessionStore`)：在登出、改密码、删账户时触发 session 失效。
- **鉴权中间件** (`auth.ts`)：`register`/`login` → NO_AUTH；`refresh` → REFRESH_TOKEN；`check-username` → PUBLIC；其他 → PROTECTED。
- **C++ user-service**：实际的业务逻辑执行者，处理 PBKDF2 密码哈希、MySQL 存储、Redis Session 缓存。
