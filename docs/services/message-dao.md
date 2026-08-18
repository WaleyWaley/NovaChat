# 消息数据访问层 — `message_dao.h` / `message_dao.cc`

## 技术职责

`MessageDao` 是 NovaChat Message Service 的**数据访问层**，封装了所有对消息数据的持久化操作。对外提供统一的接口，内部使用线程安全的内存存储。

### 数据结构

- **`MessageRecord`**：消息记录，包含 message_id、from/to peer 信息、消息类型、文本内容、引用回复 ID、静默标志、创建时间、状态（SENT/DELIVERED/READ）。
- **`PeerSyncState`**：单个对话的同步状态 — `latest_msg_id`（最新消息 ID）、`last_ack_msg_id`（最后已确认 ID）、`unread_count`（未读计数）。

### 接口分类

| 类别 | 方法 | 用途 |
|------|------|------|
| **消息 CRUD** | `SaveMessage(msg, idempotency_key)` | 存储消息；idempotency_key 非空时先去重检查 |
| | `GetMessages(peer, limit, offset_id)` | Timeline 分页拉取，按 message_id 降序 |
| | `FindById(message_id)` | 按 ID 精确查找 |
| **ACK 确认** | `AckMessages(peer, max_ack_msg_id, status)` | 将指定对话中 `<= max_ack_msg_id` 的所有消息更新为 DELIVERED/READ |
| **同步状态** | `GetSyncState(peer_type, peer_id)` | 获取单个对话的 `PeerSyncState` |
| | `GetSyncStates(peers)` | 批量获取多个对话的同步状态 |
| **去重** | `IsDuplicate(idempotency_key)` | 检查幂等键是否已存在 |
| **工具** | `Count()` | 返回当前存储的消息总数 |

### 去重机制（Phase 3）

`SaveMessage` 接收可选的 `idempotency_key` 参数：
- 如果 key 非空且已在 `idempotency_keys_` 缓存中存在 → 返回 `nullopt`，不存储消息
- 如果 key 不存在 → 插入缓存并正常存储
- 缓存超过 10,000 条时全量清空（LRU 风格的简单实现），防止内存无限增长

### 存储与排序

消息存储于 `std::vector<MessageRecord>` 中，使用 `std::lower_bound` 按 `message_id` 降序插入，确保 `GetMessages` 遍历时天然按最新优先的顺序返回。

### 线程安全

所有方法使用 `std::lock_guard<std::mutex>` 保护，互斥锁 `mu_` 声明为 `mutable` 以支持 const 方法中的加锁操作。

## 业务角色

`MessageDao` 是 Message Service 的**存储抽象层**。它将消息的增删查逻辑与业务处理（`MessageServiceImpl`）解耦：

1. **消息存储**：`SendMessage` 业务逻辑生成 Snowflake ID 和 MessageRecord，交给 DAO 持久化。
2. **历史查询**：`GetMessages` 支持 offset_id 游标分页，客户端可以逐页拉取历史消息（Telegram 风格的 Timeline 模型）。
3. **去重保障**：通过 `idempotency_key` 缓存，防止网络重试导致的消息重复存储。
4. **同步支持**：`GetSyncState` 让客户端在上线时快速判断哪些对话有新消息，避免全量拉取。

当前为**内存存储**，Phase 4+ 可升级为 MySQL 持久化，`MessageDao` 接口保持不变，对上层透明。

## 系统连接

- **上层调用**：`MessageServiceImpl`（RPC 实现层）调用所有 CRUD、ACK 和 SyncState 方法。
- **ID 来源**：`message_id` 由调用方（`MessageServiceImpl`）通过 `Snowflake::NextId()` 预生成后传入。
- **命名空间**：`nova::message::MessageDao`，独立于 `user-service` 的 `UserDao`。
- **线程安全**：通过 `std::mutex mu_` 保护全部数据操作。
