# 用户相关 REST API 路由

**文件位置**: `src/routes/user.ts`

## 技术职责

该文件注册了所有与用户账号和资料相关的 HTTP 端点，路由前缀为 `/api`。它扮演着**协议翻译层**的角色——接收客户端的 RESTful 请求，将参数映射为与 `user.proto` 对齐的请求结构，通过 `userClient` 转发给 C++ user-service 微服务，并将结果返回给客户端。

端点按功能分为四组：

### 1. 认证相关（无需鉴权或使用 refresh_token）
| 路由 | 方法 | 功能 |
|------|------|------|
| `/api/auth/register` | POST | 注册新用户（注册即登录，返回 Token） |
| `/api/auth/login` | POST | 用户名+密码登录 |
| `/api/auth/refresh` | POST | 使用 refresh_token 轮转 access_token |
| `/api/auth/logout` | POST | 登出（需鉴权），同时清除所有服务端 session |

### 2. 资料查询（需鉴权）
| 路由 | 方法 | 功能 |
|------|------|------|
| `/api/users/:id` | GET | 按 user_id 或 @username 查询单个用户 |
| `/api/users/batch` | POST | 批量获取用户资料（上限 100 个） |

### 3. 资料修改（均需鉴权）
| 路由 | 方法 | 功能 |
|------|------|------|
| `/api/users/me` | PATCH | 更新个人资料（姓名、简介、头像） |
| `/api/users/me/username` | PUT | 修改用户名 |
| `/api/users/me/password` | PUT | 修改密码（成功后清除所有旧 session） |
| `/api/users/me` | DELETE | 删除账户（需验证密码） |

### 4. 搜索与检查（无需鉴权或公开可用）
| 路由 | 方法 | 功能 |
|------|------|------|
| `/api/users/check-username/:username` | GET | 检查用户名可用性 |
| `/api/users/search` | GET | 按 username/first_name 前缀搜索用户 |

## 业务角色

在 NovaChat 系统中，用户模块是**所有业务的基础**——没有用户身份，消息、群组、频道等功能无从谈起。该路由文件实现了网关层面的用户管理 API，是客户端与 C++ 用户服务之间的**唯一桥梁**。

关键业务逻辑包括：
- **注册即登录**：注册成功后直接返回 Token，省去额外的登录步骤，优化用户体验；
- **Session 管理**：登出和改密码时调用 `sessionStore` 清除服务端 session，确保旧的 token 立即失效，这是 Phase 2.1 的安全增强；
- **密码修改安全策略**：改密码成功后强制清除所有设备上的 session，要求用户使用新密码重新登录，防止密码泄露后的持续访问；
- **用户名全局唯一性**：通过 `/check-username` 端点支持在注册前预检用户名可用性，提升注册流程的友好度。

## 系统连接

- **`../clients/user_client.js`**: 所有端点的核心依赖，封装了与 C++ user-service 的 gRPC/bRPC 通信逻辑。网关不直接操作数据库，所有用户数据的读写都通过此客户端转发。
- **`../auth/session.js`** (`sessionStore`): 在登出和改密码时调用，负责管理用户的 session 状态，与 JWT 鉴权中间件形成完整的认证闭环。
- **鉴权中间件** (`auth.ts`): `register`、`login` 端点列入 NO_AUTH 白名单；`check-username` 列入 PUBLIC 白名单；其他端点通过 Tier 4 保护强制校验 token。
- **C++ user-service**: 实际的业务逻辑执行者，处理密码哈希、数据库读写、Token 签发等操作。
