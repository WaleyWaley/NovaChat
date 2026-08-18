# message.proto — 消息服务协议定义

## 技术说明

`message.proto` 定义了 NovaChat 消息服务的 RPC 接口和请求/响应消息结构。文件位于 `proto/nova/message/` 包下，依赖 `nova/common/common.proto` 中的基础类型。

### RPC 接口

| RPC | 用途 | Phase |
|-----|------|-------|
| `SendMessage` | 发送消息（支持幂等去重） | 2.4 |
| `GetMessages` | Timeline 历史消息拉取（offset_id 分页） | 2.4 |
| `AckMessage` | 消息送达/已读确认 | 3 |
| `GetSyncState` | 上线时获取多对话同步状态（最新 msg_id + 未读计数） | 3 |

### SendMessage

**请求** (`SendMessageReq`)：
- `from_peer` / `to_peer`：发送方和接收方（`Peer` 抽象，统一用户/群组/频道）
- `msg_type`：消息类型（文本/图片/视频等，由 `MessageType` 枚举定义）
- `text`：文本内容
- `reply_to_msg_id`：引用回复的消息 ID
- `is_silent`：静默发送（不下发推送通知）
- `idempotency_key`（Phase 3）：幂等去重键，由客户端生成。重复请求返回 `is_new=false`，不重复存储

**响应** (`SendMessageResp`)：
- 返回完整的 `Message` 对象（含 Snowflake 生成的 `message_id` 和 `created_at`）
- `is_new` 字段：`true` 表示新消息，`false` 表示此 `idempotency_key` 已处理过

### GetMessages（Timeline 分页）

**请求** (`GetMessagesReq`)：
- `peer`：指定对话（单聊/群聊/频道）
- `limit`：单页数量（最大 100）
- `offset_id`：游标（`0` = 最新，否则返回 `message_id < offset_id` 的消息）
- `load_newer`：是否加载更新的消息

**响应** (`GetMessagesResp`)：
- `messages`：消息列表（按 message_id 降序，最新在前）
- `has_more`：是否还有更早的消息
- `next_offset_id`：下一页的游标

### AckMessage（Phase 3）

- **请求**：`user_id` + `peer` + `max_ack_msg_id`（确认此 ID 及之前所有消息）+ `status`（`DELIVERED` 或 `READ`）
- 语义：对该对话中所有 `message_id <= max_ack_msg_id` 的消息更新状态

### GetSyncState（Phase 3）

- **请求**：`user_id` + 每个对话的本地已知状态（`SyncState` 列表）
- **响应**：每个对话在服务器端的最新状态（`pts`=最新 msg_id, `seq`=未读计数, `date`=最后已读 msg_id）
- 用途：客户端上线时批量查询有哪些对话有新消息，实现增量同步

## 业务角色

`message.proto` 是 NovaChat **消息系统的通信契约**。它定义了消息从发送到存储再到推送的完整生命周期：

1. **发送**：客户端通过 WebSocket 的 `send_msg` 发送，网关转换为 `SendMessageReq` → C++ message-service 处理。
2. **存储**：message-service 生成 Snowflake ID 后调用 DAO 持久化（当前为内存，Phase 4+ 可升级 MySQL）。
3. **推送**：非静默消息触发 PushDispatcher → 网关 PushService → WebSocket → 目标用户。
4. **确认**：客户端收到消息后发送 `AckMessage` 确认送达/已读，服务端更新消息状态。
5. **同步**：用户上线时通过 `GetSyncState` 发现新消息，再用 `GetMessages` 拉取具体内容。

## 系统连接

- **依赖**：`nova/common/common.proto`（`Peer`、`Message`、`MessageType`、`MessageStatus`、`SyncState`、`ErrorCode`）
- **C++ 实现**：`services/message-service/message_service_impl.cc`（4 个 RPC 方法）
- **TS 客户端**：`gateway/src/clients/message_client.ts`（封装 `SendMessage` + `GetMessages`）
- **proto-gen**：通过 `proto-gen.sh` 生成 `.pb.h/.pb.cc` 和 `.brpc.h/.brpc.cc`
