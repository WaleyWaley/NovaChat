# Message Service RPC 实现 — `message_service_impl.h` / `message_service_impl.cc`

## 技术职责

`MessageServiceImpl` 实现了 `message.proto` 中定义的 `MessageServiceBase` 抽象类，提供 **4 个 RPC 方法的完整业务逻辑**。

### 构造与依赖注入

构造函数接收三个非拥有指针：
- `Snowflake*`：分布式 ID 生成器（生成 message_id）
- `MessageDao*`：数据访问层（消息存储与查询）
- `PushDispatcher*`：推送分发器（实时推送触发）

生命周期由 `server.cc` 管理，便于测试时注入 mock 对象。

### 4 个 RPC 方法

#### 1. SendMessage — 发送消息

完整处理流程：

```
参数校验 (ValidateSendRequest)
  → Snowflake::NextId() 生成 message_id
  → 构建 MessageRecord
  → dao_->SaveMessage(record, idempotency_key)  [含去重检查]
  → 填充响应 Protobuf (message_id, created_at, is_new)
  → 如果 !is_silent 且 to_peer 是用户:
      → 构造 Update (UPDATE_NEW_MESSAGE)
      → push_->PushToUser(to_peer_id, update)  [触发实时推送]
```

参数校验规则：
- `from_peer` 和 `to_peer` 必须存在
- `to_peer.type` 不能是 `PEER_TYPE_UNKNOWN`
- 文本消息不能为空
- 文本长度不能超过 `kMaxMessageLen`

去重逻辑：如果 `idempotency_key` 已存在，返回 `error_code=OK` + `is_new=false`，不存储消息也不推送。

#### 2. GetMessages — Timeline 历史拉取

```
参数校验 (peer 必须有效)
  → limit 边界处理 (1–100, 默认 20)
  → dao_->GetMessages(peer, limit, offset_id)
  → 填充消息列表 + has_more 标记
```

支持 offset_id 游标分页：`offset_id=0` 从最新开始，否则返回 `message_id < offset_id` 的历史消息，`has_more` 标记是否还有更早消息。

#### 3. AckMessage — 消息确认（Phase 3）

```
参数校验 (peer + max_ack_msg_id > 0)
  → 映射 status (DELIVERED→2, READ→3)
  → dao_->AckMessages(peer, max_ack_msg_id, status)
  → 返回更新数量
```

确认该对话中所有 `message_id <= max_ack_msg_id` 的消息，将其状态更新为 DELIVERED 或 READ。仅升级不降级（`msg.status < new_status` 才更新）。

#### 4. GetSyncState — 同步状态查询（Phase 3）

```
遍历请求中的 peer_states
  → dao_->GetSyncStates(peers)
  → 返回每个对话的 latest_msg_id / last_ack_msg_id / unread_count
```

用户上线时批量查询多个对话的服务器端状态，客户端据此判断哪些对话有新消息并决定是否需要拉取。

### ClosureGuard 保证

每个 RPC 方法体均使用 `brpc::ClosureGuard done_guard(done)`，确保无论成功或异常，`done->Run()` 都能被正确调用，避免资源泄漏。

## 业务角色

`MessageServiceImpl` 是 Message Service 的**业务逻辑层**，定义了 NovaChat 消息从发送到确认的完整生命周期：

1. **消息发送**：生成全局唯一 ID → 存储 → 触发推送（静默消息跳过推送）。
2. **历史查询**：提供分页拉取能力，支持客户端离线后上线补拉遗漏消息。
3. **送达确认**：客户端告知服务端消息已送达/已读，服务端更新内部状态。
4. **增量同步**：用户上线时先查询同步状态，再决定是否拉取具体消息，避免全量同步。

## 系统连接

- **接口定义**：继承自 `message.proto` 生成的 `MessageServiceBase`，由 bRPC 框架路由请求到对应方法。
- **数据持久化**：通过 `MessageDao` 接口操作数据，当前为内存存储。
- **推送链路**：通过 `PushDispatcher` → HTTP → 网关 PushService → WebSocket → 目标用户。
- **ID 依赖**：使用 `Snowflake`（worker_id=2）生成 message_id。
- **上游调用方**：TypeScript 网关将 WebSocket 的 `send_msg` 转换为 RPC 调用；客户端可直接通过 HTTP 调用 `GetMessages`、`AckMessage`、`GetSyncState`。
