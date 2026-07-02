# JWT 鉴权模块 (`jwt.ts`)

## 技术职责

本模块是 NovaChat 网关层 **Token 验证** 的核心入口，负责验证客户端请求中携带的 JWT（JSON Web Token）。它提供了两套验证路径：

- **`verifyAccessToken`** — 验证 access_token。先解码 Token 头部提取 `kid`，到 `keyStore` 中查找对应公钥，再用 `jsonwebtoken` 库校验 RS256/HS256 签名和过期时间；最后通过 `sessionStore` 检查该会话是否已被撤销。三步形成一个完整的鉴权链路。
- **`verifyRefreshToken`** — 验证 refresh_token。逻辑与 access_token 类似，但**不检查 session 失效状态**，因为 refresh token 拥有独立的生命周期。
- **`signToken`** — 签发 Token 对（access + refresh）。**仅用于开发/mock 场景**，生产环境由 C++ user-service 签发。
- **`extractUserIdFromAuthHeader`** — 便捷函数，从 HTTP `Authorization: Bearer <token>` 头部提取并验证 Token，返回 `user_id`。

## 业务角色

在 NovaChat 这样的分布式即时通讯系统中，网关是用户的"前门"。每一条消息、每一次操作都需要确认"你是谁"。本模块就是前门上的**安检闸机**：

1. **身份验证** — 用户登录后获得 JWT，此后每次 WebSocket/HTTP 请求都携带 Token，本模块验证其真伪和有效期。
2. **会话失效检测** — 当用户登出或修改密码时，对应的 session 被标记为失效。本模块在验证 Token 时会主动检查 session 状态，确保已登出的 Token 立即失效，无法继续使用，实现**即时登出**。
3. **区分错误类型** — 返回 `EXPIRED` / `INVALID` / `SESSION_INVALIDATED` 三种错误，让上层业务（如 WebSocket 管理器）能够做出差异化响应（如引导刷新 Token、拒绝连接等）。

## 系统集成

- **`keys.ts`** — 依赖 `keyStore` 获取验证密钥。生产环境使用 RS256 公钥，开发环境回退到 HS256 共享密钥。
- **`session.ts`** — 依赖 `sessionStore.getSync` 同步查询 session 是否失效。Phase 2.2 升级 Redis 后验证会改为异步。
- **C++ user-service** — 生产环境的 Token 由 C++ user-service 用 RS256 私钥签发，本模块仅持有公钥做验证，严格遵循"网关只验证、不签名"的安全原则。
