# JWT 鉴权中间件

**文件位置**: `src/middleware/auth.ts`

## 技术职责

该文件实现了一个 **Fastify preHandler 钩子**，为网关的所有 HTTP/WebSocket 请求执行 JWT 访问令牌验证。它扩展了 Fastify 的 `FastifyRequest` 类型，注入了 `userId` 和 `sessionId` 两个字段，供后续路由处理函数使用。

鉴权逻辑采用**四级分层白名单**设计：

| 级别 | 白名单 | 行为 |
|------|--------|------|
| Tier 1 — NO_AUTH | `/health`, `/api/auth/register`, `/api/auth/login`, PushService 内部路径 | 完全跳过鉴权，直接放行 |
| Tier 2 — REFRESH_TOKEN | `/api/auth/refresh` | 放行请求，由 handler 自行校验 body 中的 `refresh_token` |
| Tier 3 — PUBLIC | `/api/users/check-username/` | 可选认证：有 Bearer token 则注入用户信息，没有也不拒绝 |
| Tier 4 — PROTECTED | 其他所有路由 | 强制校验 Bearer token，失败返回 401 |

失败时返回差异化的业务错误码：
- **1002 (AUTH_KEY_EXPIRED)**: Token 已过期
- **1003 (SESSION_EXPIRED)**: Session 已被撤销（登出/改密码）
- **1004 (TOKEN_INVALID)**: 签名无效、格式错误或缺少密钥

## 业务角色

在 NovaChat 的 BFF 架构中，网关是所有客户端请求的**统一入口**。该中间件承担了**身份认证网关**的核心职责——在请求到达业务逻辑之前，先确认调用方的身份合法性。没有这个中间件，任何未授权用户都能调用受保护的 API，系统安全将完全失效。

三级白名单的设计体现了精细的权限粒度：
- **NO_AUTH** 路由是系统入口（注册/登录）或内部服务通信，天然不需要客户端令牌；
- **REFRESH_TOKEN** 端点使用独立的 refresh_token 机制，与 access_token 的鉴权路径正交；
- **PUBLIC** 端点（如检查用户名是否可用）需要在未登录状态下访问，但如果用户已登录则可获得增强体验。

## 系统连接

- **`../auth/jwt.js`**: 调用 `verifyAccessToken` 函数完成 JWT 签名的实际校验和 payload 解析。
- **Fastify Request**: 通过 TypeScript 模块声明合并（`declare module "fastify"`）为请求对象注入 `userId: number` 和 `sessionId: string`，下游路由和 WebSocket 处理器直接读取。
- **限流中间件** (`rate_limiter.ts`): 同样运行在 `preHandler` 阶段，且位于鉴权之后——这意味着限流器可以安全地依赖 `request.userId` 进行用户维度的限流。
- **注册/登录路由** (`user.ts`): 注册和登录端点被列入 NO_AUTH 白名单，因为用户在完成这些操作之前还没有 token。
