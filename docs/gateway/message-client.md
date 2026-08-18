# 消息服务客户端 (`clients/message_client.ts`)

## 技术职责

`messageClient` 是网关调用 C++ `message-service` 微服务的 HTTP 客户端。它通过标准的 JSON/HTTP POST 与 bRPC 的 `http+pb` 端点通信，无需在网关侧引入 Protobuf 编译产物。

### 端点格式

```
{MESSAGE_SERVICE_URL}/nova.message.MessageService/{Method}
```

例如：`http://message-service:8002/nova.message.MessageService/SendMessage`

### 封装的 RPC 方法

| 方法 | 功能 | 关键参数 |
|------|------|----------|
| `sendMessage` | 发送聊天消息 | `from_peer`, `to_peer`, `msg_type`, `text`, `is_silent` |
| `getMessages` | Timeline 拉取历史消息 | `peer`, `limit`, `offset_id` |

### 实现细节

- **超时控制**：每个请求使用 `AbortSignal.timeout(5000)` 设置 5 秒超时。
- **类型安全**：文件定义了与 `message.proto` 对齐的 TypeScript 接口（`SendMessageReq`、`SendMessageResp`、`GetMessagesReq`、`GetMessagesResp`），编译期类型检查。
- **错误处理**：HTTP 非 2xx 状态码抛出异常，附带动 `MessageService {method} failed` 的错误信息。

## 业务角色

在 NovaChat 的消息链路中，`messageClient` 是**消息管道的入口**：

1. **发送消息**：WebSocket 处理器 `handleSendMessage` 调用 `messageClient.sendMessage()`，将客户端的 `send_msg` 请求转发给 C++ message-service。消息存储、ID 生成、推送均由 C++ 侧完成。
2. **历史拉取**：客户端上线后调用 `getMessages()` 拉取离线遗漏的消息，实现 Timeline 模型。

网关不参与消息的存储和业务逻辑，仅做**协议转换与转发**。

## 系统连接

- **`main.ts`**：WebSocket 消息分发中 `handleSendMessage` 调用 `sendMessage`。
- **`config/index.ts`**：读取 `MESSAGE_SERVICE_URL` 配置（默认 `http://127.0.0.1:8002`）。
- **C++ message-service**：实际的消息处理服务，监听端口 8002，暴露 4 个 RPC（`SendMessage`、`GetMessages`、`AckMessage`、`GetSyncState`）。
- 导出全局单例 `messageClient`。
