# 推送分发器 — `push_dispatcher.h` / `push_dispatcher.cc`

## 技术职责

`PushDispatcher` 是 message-service 中负责**将消息实时推送到网关**的模块。它构建了 NovaChat 消息推送的最后一段链路：C++ 后端 → 网关 → WebSocket → 用户。

### 推送链路

```
message-service (C++)
  │
  ├─ SendMessage 存储消息
  ├─ 构造 Update (UPDATE_NEW_MESSAGE)
  └─ PushDispatcher::PushToUser(to_user_id, update)
       │
       └─ CallGatewayPush(req)
            │
            ├─ protobuf → JSON 序列化
            ├─ brpc::Channel (PROTOCOL_HTTP)
            ├─ POST /nova.gateway.PushService/PushUpdate
            │  Content-Type: application/json
            │  Body: PushUpdateReq (JSON)
            │
            └─ Gateway PushService
                 │
                 ├─ connectionManager.sendToUser()
                 └─ ws.send(JSON) → 用户实时收到消息
```

### 主要方法

| 方法 | 用途 |
|------|------|
| `Init(gateway_addr)` | 配置网关地址（如 `"gateway:3000"`） |
| `PushToUser(user_id, update)` | 推送 Update 给单个用户 |
| `PushToUsers(user_ids, update)` | 批量推送，返回 `{delivered, missed}` 计数 |
| `CallGatewayPush(req)` | 底层 HTTP POST 调用网关 PushService |

### 核心实现细节

**`CallGatewayPush`** 的完整流程：

1. **JSON 序列化**：使用 `google::protobuf::util::MessageToJsonString` 将 `PushUpdateReq` 序列化为 JSON 字符串，配置 `always_print_primitive_fields = true` 确保所有字段都在 JSON 中出现。
2. **bRPC HTTP Channel**：创建 `brpc::Channel`，协议 `PROTOCOL_HTTP`，超时 3 秒，最大重试 1 次。
3. **构造 HTTP 请求**：`POST /nova.gateway.PushService/PushUpdate`，`Content-Type: application/json`，Body 为 JSON 字符串。
4. **发送与错误处理**：通过 `channel.CallMethod(nullptr, &cntl, nullptr, nullptr, nullptr)` 发送，使用 `cntl.Failed()` 检查是否成功。

### 设计简化

**不查 Redis 在线路由表**。PushDispatcher 直接将推送请求发送到网关，由网关的 PushService 自己判断用户是否在线：
- 在线 → WebSocket 实时下发
- 离线 → 跳过推送（消息已存储在 message-service，用户上线后通过 Timeline 拉取）

这种设计避免了 C++ 服务依赖 Redis（减少外部依赖），将"用户是否在线"的判断逻辑集中在网关层。

## 业务角色

在 NovaChat 的消息全链路中，PushDispatcher 是**实时推送的最后一公里**：

1. **实时性保障**：消息存储成功后立即触发推送，延迟仅受网络往返时间（通常 < 5ms 内网）影响。
2. **静默过滤**：`is_silent=true` 的消息（如输入状态指示器）不会触发推送，由 `MessageServiceImpl` 在调用前过滤。
3. **用户类型判断**：仅对 `PEER_TYPE_USER` 推送，群消息暂未实现群成员分发（Phase 4+ 功能）。
4. **失败容忍**：推送失败不影响消息存储结果。消息已持久化在 MessageDao 中，用户可通过 Timeline 拉取补回。

## 系统连接

- **上层调用**：`MessageServiceImpl::SendMessage` 在消息存储成功后调用 `PushToUser`。
- **网关 PushService**：`PushUpdate` 端点（`gateway/src/routes/push.ts`），查找 ConnectionManager → WebSocket 下发。
- **protobuf 依赖**：`nova/common/common.pb.h`（`Update`）+ `nova/gateway/push.pb.h`（`PushUpdateReq`）。
- **bRPC HTTP Channel**：使用 `brpc::Channel` + `PROTOCOL_HTTP` 发起 HTTP POST，复用 bRPC 的事件循环。
- **网关地址**：当前硬编码 `"gateway:3000"`（Docker 网络中的服务名），通过 `Init()` 配置。
