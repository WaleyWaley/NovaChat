# user.proto — NovaChat 用户服务 RPC 定义

## 技术说明

`user.proto` 定义了 NovaChat UserService 的全部 RPC 接口及请求/响应消息结构，位于 `proto/nova/user/` 包下，依赖 `common.proto` 中的公共类型（ErrorCode、UserProfile 等）。

### RPC 接口清单

UserService 共定义 **11 个 RPC 方法**，按功能域分为六组：

**1. 认证相关**
- `Register`（注册）：接收用户名、密码、姓名、手机号等，返回用户 ID、Access Token 和 Refresh Token。设计上"注册即登录"，减少客户端交互步骤。
- `Login`（登录）：用户名密码登录，返回 Token 及用户资料。携带设备信息用于多端会话管理。
- `RefreshToken`（刷新令牌）：支持 Token 轮转（Refresh Token Rotation）——每次刷新时旧 Refresh Token 立即失效，提升安全性。
- `Logout`（登出）：清除用户会话。

**2. 资料查询**
- `GetUserProfile`（单用户查询）：支持按 `user_id` 或 `username`（@用户名）两种标识符查询，使用 `oneof` 实现二选一。
- `GetUsers`（批量查询）：单次最多 100 个用户 ID，返回顺序与请求 ID 顺序对应，不存在的条目返回默认空实例。

**3. 资料修改**
- `UpdateProfile`（更新资料）：支持修改 firstName、lastName、Bio、头像等。Username 不允许在此修改，Telegram 风格限制为每 15–30 天改一次。
- `ChangeUsername`（修改用户名）：独立的 RPC 以施加更严格的变更频率限制。

**4. 用户名操作**
- `CheckUsername`（可用性检查）：注册流程中实时校验用户名是否被占用。

**5. 搜索**
- `SearchUsers`（搜索用户）：支持 username 或 first_name 前缀匹配，基于 `offset_id` 的分页模型（向下翻页）。

**6. 账户管理**
- `ChangePassword`（修改密码）：需要旧密码验证，修改后清除所有活跃 Session（安全措施）。
- `DeleteAccount`（删除账户）：需密码二次确认，软删除（标记 `is_deleted`）。

### 设计要点

- **Token 体系**：Access Token（24h 短效）+ Refresh Token（30d 长效），所有 Token 使用 JWT 签发。`refresh_token` 支持轮转，旧 Token 立即作废。
- **密码处理**：明文密码仅在网关与服务之间的 TLS 加密通道中传输，服务端收到后立即进行 bcrypt 哈希并丢弃明文。
- **设备管理**：Login 请求携带 `device_name` 和 `device_type`，为后续多端登录管理和 "其他设备已登录" 互踢场景做准备。

## 业务角色

UserService 是 NovaChat 的用户中心服务，负责整个用户生命周期的管理——从注册登录到资料维护再到账户注销。在 BFF 架构中，TypeScript 网关将客户端的 HTTP/WebSocket 请求转化为对 C++ UserService 的 RPC 调用，用户服务处理完毕后网关再将结果返回客户端。这套定义涵盖了即时通讯应用对用户系统的全部核心需求，并预留了多端登录、Token 轮转等高级安全机制。
