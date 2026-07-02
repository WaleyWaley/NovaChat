# WebSocket 消息协议 (`ws/protocol.ts`)

## 技术职责

该文件定义了客户端与 TypeScript 网关之间所有 WebSocket 消息的 **TypeScript 类型系统**，包括消息结构、类型守卫和构造器函数。消息序列化格式为 JSON。

### 消息分类

**客户端到网关 (ClientMessage)** — 共 6 种：

| 类型 | 用途 |
|---|---|
| `auth` | 携带 `access_token` 完成登录认证 |
| `send_msg` | 发送聊天消息，指定对端类型/ID、消息内容 |
| `ping` | 心跳保活 |
| `typing` | 输入状态指示 |
| `read` | 已读回执，携带 `max_read_msg_id` |
| `rpc` | 通用 RPC 代理，指定 `service` + `method` + `body`，由网关转发给 C++ 后端 |

**网关到客户端 (ServerMessage)** — 共 6 种：

| 类型 | 用途 |
|---|---|
| `auth_ok` | 认证成功，返回 `user_id` 和 `username` |
| `error` | 操作失败的错误码和描述 |
| `update` | 服务端主动推送（新消息、用户状态变更、输入指示等），**无 seq** |
| `pong` | 心跳响应 |
| `kicked` | 被踢下线通知 |
| `rpc_result` | RPC 代理调用结果 |

### 设计原则

- **请求-响应匹配**：客户端生成的 `seq` 字段将请求与响应一一对应，支持并发请求
- **透传设计**：网关不解析业务 payload，对 `send_msg`、`update` 等消息的业务字段仅做透传，保持与 C++ 后端的解耦
- **统一推送通道**：参考 Telegram MTProto 的 Update 模型，所有服务端事件（新消息、状态更新、输入指示）通过同一个 `update` 消息下发，客户端根据 `update_type` 分发处理

### 辅助工具

- `isClientMessage()` / `getMessageType()` — 运行时类型守卫，用于消息解析时的安全类型判断
- `buildXxx()` 系列构造器 — 网关内部构造 ServerMessage 的便捷函数

## 业务角色

在 NovaChat 的 BFF (Backend For Frontend) 架构中，`protocol.ts` 是 **网关与客户端之间的通信契约**。它划定了网关的能力边界：

- 网关不处理业务逻辑，只做**路由**（将 `rpc`、`send_msg` 等转发给 C++ 服务）和**推送**（将 C++ 下发的 `update` 事件广播给在线用户）
- 该文件定义了客户端 SDK 与网关交互的全部 API 表面，是两端协同开发的基础

## 系统关联

- 由 `connection.ts` 中的 `ConnectionManager` 在消息收发时引用这些类型
- `auth` 消息会触发调用 `clients/user_client.ts` 中的登录/注册 RPC
- `rpc` 消息通过 `BrpcClient` 转发到对应 C++ 微服务
- 路由层 (`src/routes/`) 根据消息 `type` 分发到对应的处理函数
