# server.js — NovaChat Mock User Service（契约验证服务器）

## 技术说明

`server.js` 是一个用 Node.js 编写的轻量级 HTTP 服务器，位于 `scripts/mock-user-service/` 目录下，用于模拟 C++ user-service 的 bRPC HTTP+pb 端点，与 TypeScript BFF 网关进行端到端集成测试。

### 架构与实现

**1. HTTP 端点格式**
服务匹配 bRPC 的 HTTP+pb 协议格式：
```
POST http://localhost:8001/nova.user.UserService/{Method}
```
其中 `{Method}` 对应 `user.proto` 中定义的 RPC 方法名（Register、Login、GetUserProfile 等）。

**2. 内存数据存储**
使用 `Map` 实现的内存数据库，与 C++ `user_dao.h` 的 Phase 1 实现一致：
- `usersById`：user_id → 用户记录
- `usersByUsername`：username → user_id
- `sessions`：refresh_token → 会话记录
- `nextUserId`：简单自增 ID（Phase 2 由 Snowflake 替代）

**3. RPC 处理器**
完整实现了 UserService 的全部 11 个 RPC 方法，包含与 C++ `user_service_impl.cc` 一致的参数校验逻辑：
- 用户名格式校验（字母开头、3-32 字符、字母数字下划线）
- 密码长度校验（8-128 字符）
- 用户名唯一性校验
- 账户软删除状态检查（`is_deleted` 标记）

**4. Token 管理**
- 使用 `jsonwebtoken` 库签发真实 JWT Token，与网关的 `auth/jwt.ts` 共享同一密钥。
- Access Token 有效期 24h，Refresh Token 有效期 30d。
- 支持 Token 轮转（Refresh Token Rotation）——刷新时旧 Token 立即作废。
- 手机号脱敏显示（`+86*****123` 格式）。

**5. 辅助端点**
- `GET /status`：健康检查，返回在线用户数和服务状态。
- CORS 支持，允许开发环境跨域访问。

### 启动方式

```bash
node scripts/mock-user-service/server.js
# 默认端口 8001，可通过 PORT 环境变量修改
```

## 业务角色

在 NovaChat 的开发流程中，C++ 微服务的编译和部署周期较长，而 TypeScript 网关层需要频繁调试。此 Mock 服务在开发阶段替代真实的 C++ user-service，让前端和网关团队可以独立进行开发与测试，无需搭建完整的 C++ 服务环境。它完整实现了 user.proto 中定义的所有 RPC 合约，确保网关与最终 C++ 实现之间的接口一致性，是典型 BFF 架构中"契约优先"开发实践的关键工具。
