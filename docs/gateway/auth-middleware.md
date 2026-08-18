# JWT 鉴权中间件 (`middleware/auth.ts`)

**文件位置**: `src/middleware/auth.ts`

## 技术职责

该文件实现了一个 **Fastify preHandler 钩子**，为网关的所有 HTTP/WebSocket 请求执行 JWT 访问令牌验证。它扩展了 Fastify 的 `FastifyRequest` 类型，注入 `userId` 和 `sessionId` 两个字段，供后续路由处理函数使用。

### 四级分层白名单

| 级别 | 匹配路径 | 行为 |
|------|----------|------|
| Tier 1 — NO_AUTH | `/health`, `/api/auth/register`, `/api/auth/login`, PushService 内部路径（`/nova.gateway.PushService/*`） | **完全跳过鉴权**，直接放行。这些是系统入口（注册/登录）或内部服务通信（健康检查/推送） |
| Tier 2 — REFRESH_TOKEN | `/api/auth/refresh` | 放行请求，由 handler **自行校验 body 中的 `refresh_token`**（与 access_token 正交的独立鉴权路径） |
| Tier 3 — PUBLIC | `/api/users/check-username/` | **可选认证**：有 Bearer token 则验证并注入 `userId` 和 `sessionId`；没有也不拒绝，放行未登录请求 |
| Tier 4 — PROTECTED | 所有其他路由 | **强制校验 Bearer token**，验证失败返回 401 |

### 差异化错误码映射

鉴权失败时返回与 `common.proto` 对齐的业务错误码：

| 错误类型 | error_code | 含义 |
|----------|-----------|------|
| `EXPIRED` | **1002** (AUTH_KEY_EXPIRED) | Token 已过期，客户端应使用 refresh_token 刷新 |
| `SESSION_INVALIDATED` | **1003** (SESSION_EXPIRED) | Session 已被撤销（用户主动登出或修改密码），不可恢复 |
| `INVALID` | **1004** (TOKEN_INVALID) | 签名无效、格式错误、缺少密钥或 Token 已损坏 |

### 请求增强

通过 TypeScript 模块声明合并（`declare module "fastify"`）为 Fastify 的请求对象注入两个字段：
- `request.userId: number` — 当前已认证用户的 ID
- `request.sessionId: string` — 当前 session 标识符

下游路由和 WebSocket 处理器可直接通过 `request.userId` 获取用户身份，无需再次解析 Token。

## 业务角色

在 NovaChat 的 BFF 架构中，网关是所有客户端请求的**统一入口**。该中间件承担了**身份认证网关**的核心职责——在请求到达业务逻辑之前，先确认调用方的身份合法性。

四级白名单的设计体现了精细的权限粒度：
- **NO_AUTH** 路由是系统入口（注册/登录）或内部服务通信，天然不需要客户端令牌；
- **REFRESH_TOKEN** 端点使用独立的 refresh_token 机制，与 access_token 的鉴权路径正交；
- **PUBLIC** 端点（如检查用户名是否可用）需要在未登录状态下访问，但如果用户已登录则可获得增强体验（如标记该用户名为"自己"）；
- **PROTECTED** 覆盖所有业务 API，确保未授权者无法访问用户数据。

## 系统连接

- **`../auth/jwt.js`**: 调用 `verifyAccessToken` 完成 JWT 签名的实际校验和 payload 解析。
- **Fastify Request**: 通过 TypeScript 模块声明合并注入 `userId` 和 `sessionId`，下游路由和 WebSocket 处理器直接读取。
- **限流中间件** (`rate_limiter.ts`): 同样运行在 `preHandler` 阶段，且位于鉴权之后——限流器可以安全地依赖 `request.userId` 进行**用户维度**的限流。
- **注册/登录路由** (`user.ts`): 注册和登录端点被列入 NO_AUTH 白名单，因为用户在完成这些操作之前还没有 token。
- **PushService 路由** (`push.ts`): 列入 NO_AUTH 白名单，因为调用方是 C++ 内部微服务（不需要客户端 JWT）。
