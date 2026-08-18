# JWT 鉴权模块 (`auth/jwt.ts`)

## 技术职责

本模块是 NovaChat 网关层 **Token 验证** 的核心入口，负责验证客户端请求中携带的 JWT。当前支持两种签名算法 —— RS256（非对称，生产环境）和 HS256（共享密钥，开发回退）。

### 核心函数

#### `verifyAccessToken(token)` — 完整四级验证链路

```
1. 解码 JWT Header → 提取 kid (Key ID)
2. keyStore.getKey(kid) → 查找对应公钥/密钥
3. jwt.verify(token, key, { algorithms: [RS256/HS256] }) → 验证签名 + 过期时间
4. sessionStore.getSync(sessionId) → 检查 session 是否已被撤销
```

返回 `TokenVerifyResult` 类型化结果，区分三种错误：
- **`ok: true`** — 验证通过，返回 `{ user_id, username, session_id, exp }`
- **`EXPIRED`** — Token 已过期（返回 error_code 1002）
- **`SESSION_INVALIDATED`** — Session 已被撤销/登出/改密码（返回 error_code 1003）
- **`INVALID`** — 签名错误/格式错误/缺少密钥（返回 error_code 1004）

#### `verifyRefreshToken(token)` — Refresh Token 专用验证

逻辑与 `verifyAccessToken` 类似，但有两点关键差异：
- **不检查 session 失效状态**（refresh token 有独立生命周期，不应因 access_token 被撤销而失效）
- **只接受 `type: "refresh"` 的 claims**

#### `signToken(userId, username, sessionId)` — 签发 Token（dev/mock 专用）

使用 HS256 签发 access_token + refresh_token 对。注入 `kid` header（指向当前默认密钥）。**生产环境不使用此函数**——Token 由 C++ user-service 用 RS256 私钥签发。

#### `extractUserIdFromAuthHeader(req)` — 便捷提取函数

从 HTTP `Authorization: Bearer <token>` 头部提取并验证 Token，返回 `user_id`。用于需要快速获取用户 ID 的场景。

## 业务角色

在 NovaChat 分布式即时通讯系统中，网关是用户的"前门"。每一条消息、每一次操作都需要确认身份。本模块就是前门上的**安检闸机**：

1. **身份验证** — 用户登录后获得 JWT，此后每次 WebSocket/HTTP 请求都携带 Token，本模块验证其真伪和有效期。
2. **会话失效检测** — 用户登出或修改密码时，对应 session 被 `sessionStore.invalidate()` 标记为失效。`verifyAccessToken` 的第四步检查确保已登出的 Token 立即失效，实现**即时登出**。
3. **密钥轮转支持** — 通过 `kid` 机制支持多密钥共存，旧密钥签发的 Token 在有效期内仍然可用，新请求使用新密钥。实现零停机密钥轮换。
4. **差异化错误码** — 返回 `EXPIRED` / `INVALID` / `SESSION_INVALIDATED` 三种错误，上层业务（WebSocket 管理器、中间件）据此做出差异化响应。

## 系统集成

- **`keys.ts`** — 依赖 `keyStore.getKey(kid)` 获取验证密钥。生产环境使用 RS256 公钥，开发环境回退到 HS256 共享密钥。
- **`session.ts`** — 依赖 `sessionStore.getSync()` 同步查询 session 是否失效。这是 Java/TS 环境下 JWT 验证必须同步的特性（`jwt.verify` 是同步调用）。
- **C++ user-service** — 生产环境的 Token 由 C++ user-service 用 RS256 私钥签发，本模块仅持有公钥做验证，严格遵循"网关只验证、不签名"的安全原则。
- **WebSocket 连接 (`main.ts`)** — `handleAuth` 调用 `verifyAccessToken` 完成连接级认证。
- **鉴权中间件 (`auth.ts`)** — `extractUserIdFromAuthHeader` 为 HTTP 路由提供身份提取。
