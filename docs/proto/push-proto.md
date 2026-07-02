# push.proto — NovaChat 网关推送服务 RPC 定义

## 技术说明

`push.proto` 定义了 PushService 的 RPC 接口，位于 `proto/nova/gateway/` 包下。这是一个**反向推送接口**——调用方是 C++ 后端核心服务（message-service、user-service），实现方是 TypeScript BFF 网关。C++ 服务通过 bRPC HTTP 通道向网关发起请求，网关再将数据推送至客户端 WebSocket 连接。

### RPC 接口清单

PushService 共定义 **6 个 RPC 方法**：

**1. PushUpdate（单用户推送）**
最核心的接口。C++ 服务通过 Redis 路由表查询用户所在的网关节点，然后调用此 RPC 将 `Update` 推送给指定用户。关键字段：
- `skip_offline`：为 true 时（如 Typing 指示器）用户不在线直接丢弃；为 false 时（如消息）调用方会进行离线存储。
- `push_id`：调用方生成的 Snowflake 幂等键，网关用于去重，防止 bRPC 重试导致重复推送。
- `ttl_seconds`：推送存活时间，超时后不再推送。

**2. PushToUsers（批量推送）**
群消息场景的优化接口。一次 RPC 将同一个 `Update` 推送给同一网关节点上的多个在线成员（上限 500 人），网关复制后分发给各用户 WebSocket 连接。返回值包含 `delivered_user_ids`（成功送达）和 `missed_user_ids`（离线或不在本节点），便于调用方对离线用户进行后续处理。

**3. KickUser（强制断开）**
用于 Token 失效、账户注销、多端互踢、封禁、管理员强制下线等场景。通过 `KickReason` 枚举区分不同的踢出原因，客户端据此展示对应的提示信息。

**4. IsUserOnline（在线探测）**
C++ 服务在发消息前快速判断用户是否在线，以决定是否走离线存储。返回在线状态和最近在线时间。

**5. BatchOnlineCheck（批量在线检查）**
群消息发送场景的优化接口，一次性查询最多 500 个成员的在线状态，避免逐个 RPC 调用。

**6. NotifyGateway（网关事件通知）**
用于多网关部署时的协调通信，支持的事件包括用户上下线广播、配置热重载、会话缓存清除等。

### 设计要点

- **bRPC HTTP+pb 协议**：C++ 服务使用 bRPC 框架的 HTTP + Protobuf 模式与网关通信，网关将 protobuf 反序列化后转发给 WebSocket 客户端。
- **幂等设计**：每个推送请求携带全局唯一的 `push_id`，网关侧做去重，保证 at-most-once 语义。
- **离线感知**：通过 `skip_offline`、`IsUserOnline`、`BatchOnlineCheck` 等机制区分在线/离线场景，避免不必要的推送开销。

## 业务角色

PushService 是 NovaChat BFF 架构中连接 C++ 微服务与客户端的关键桥梁。它解决了"后端服务如何将实时事件推送给用户"这一核心问题：C++ 服务不直接维护 WebSocket 连接，而是通过 PushService RPC 将事件发送给网关，由网关的 WebSocket 连接池分发给客户端。这种分层设计使得连接管理集中化，C++ 服务无需关心 WebSocket 实现细节，同时也为多网关水平扩展提供了清晰的架构边界。
