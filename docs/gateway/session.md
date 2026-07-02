# Session 会话管理 (`session.ts`)

## 技术职责

本模块提供 `SessionStore` 接口及其内存实现 `InMemorySessionStore`，负责 NovaChat 网关层的**会话生命周期管理**。

核心数据结构：

- **`sessions` Map** — `sessionId → Session` 的主存储，记录会话的创建时间、过期时间、设备信息、失效状态等。
- **`userIndex` Map** — `userId → Set<sessionId>` 的反向索引，用于快速查找某用户的所有活跃会话。

关键方法覆盖完整的会话生命周期：

- **`create`** — 创建新会话，同时维护反向索引，幂等设计避免重复创建。
- **`get` / `getSync`** — 按 sessionId 查询，`getSync` 专为 `verifyAccessToken` 的同步调用场景提供（Phase 2.2 升级 Redis 后移除）。
- **`invalidate`** — 标记单个会话为失效（用户主动登出）。
- **`invalidateAllForUser`** — 标记用户所有会话为失效（修改密码、账号删除等安全事件）。
- **`updateActivity`** — 更新最后活跃时间。
- **`cleanup`** — 定期清理已过期或失效超过 24 小时的会话，防止内存泄漏。

## 业务角色

在 NovaChat 中，会话管理是 **"即时登出"和"安全控制"** 的核心机制：

1. **即时登出** — 用户点击"登出"时，网关立即标记对应 session 为失效。由于 JWT 在过期前理论上一直有效，如果没有 session 失效机制，登出后 Token 仍可被使用。本模块配合 JWT 验证，实现了**登出即失效**的关键安全特性。
2. **安全事件响应** — 用户修改密码或账号被盗后恢复账号时，`invalidateAllForUser` 能一键作废所有旧会话，强制所有设备重新登录。
3. **多设备管理** — 通过 `findByUserId` 可以查询用户所有设备上的会话状态，为"在线设备列表"等功能提供数据支撑。
4. **资源控制** — 定时清理机制自动回收过期 session，确保内存不会被长期堆积的无效会话耗尽。

## 系统集成

- **`jwt.ts`** — `verifyAccessToken` 在签名验证通过后调用 `sessionStore.getSync` 检查 session 是否被撤销，若已失效则返回 `SESSION_INVALIDATED` 错误。
- **WebSocket 管理器** — 客户端登出请求和修改密码请求会触发 `invalidate` 或 `invalidateAllForUser` 调用。
- **Phase 2.2 升级路径** — 当前为内存实现（Map），未来升级为 Redis 后 `SessionStore` 接口保持不变，仅切换实现类，对上层代码透明。
