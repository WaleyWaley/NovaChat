# 消息数据访问层 — `message_dao.h` / `message_dao.cc`

## 技术职责

`MessageDao` 是 NovaChat Message Service 的**数据访问层**，封装了所有对消息数据的持久化操作。对外提供统一的接口，内部采用**双模式存储**：MySQL 持久化（`--enable_mysql` 启用）+ 内存回退（未启用或连接失败时）。

### 存储模式（Phase 4）

```cpp
// server.cc 中 --enable_mysql 时 20 次指数退避重试连接 (与 user-service 一致)
dao.InitMySql(addr, port, user, passwd, db, pool_size);   // 失败 → 内存回退

// 每个 DAO 方法内:
if (mysql_ && mysql_->IsReady()) {
    // MySQL 路径: 直接返回结果
} else {
    // 内存路径: std::lock_guard + vector/unordered_set (Phase 1-3 原逻辑)
}
```

- **MySQL 可用**：全部读写落库 `messages` 表，重启不丢数据
- **MySQL 不可用**：回退内存存储，message-service 照常运行（数据重启丢失）
- 接口完全不变，对 `MessageServiceImpl` 透明

### 数据结构

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

### 去重机制

`SaveMessage` 接收可选的 `idempotency_key` 参数，两种模式下分别实现：

- **MySQL 模式**：`INSERT IGNORE` + `uq_idempotency` 唯一索引 = **原子去重**。撞唯一键时 `mysql_affected_rows() == 0` → 返回 `nullopt`（通过 `MySqlPool::ExecuteAffected` 获取）。空 key 走普通 `INSERT`（NULL 永不冲突、不吞错误）
- **内存模式**：`idempotency_keys_` 集合，命中 → `nullopt`；超过 10,000 条时全量清空防内存增长

### 存储与排序

- **MySQL 模式**：`ORDER BY message_id DESC LIMIT n`（Snowflake ID 按时间递增 ⇒ ID 降序 = 时间降序）
- **内存模式**：`std::vector<MessageRecord>` + `std::lower_bound` 降序插入，`GetMessages` 遍历天然最新优先

### 每个方法的 MySQL 实现

| 方法 | SQL 形态 | 说明 |
|------|---------|------|
| `SaveMessage` | `INSERT IGNORE`（有 key）/ `INSERT`（无 key） | `ExecuteAffected` 判重；`is_silent` 存 `flags` bit1 |
| `GetMessages` | `SELECT ... WHERE to_peer_* AND message_id < offset_id ORDER BY message_id DESC LIMIT n` | 游标分页下推 SQL；`from_user_id AS from_peer_id`、`(flags & 2) AS is_silent` 别名对齐字段 |
| `FindById` | `SELECT ... WHERE message_id = ? LIMIT 1` | |
| `AckMessages` | `UPDATE ... SET status = ? WHERE ... AND status < ?` | `status < new_status` 保证只升不降（幂等下沉到 SQL）；affected 即更新计数 |
| `GetSyncState` | `SELECT MAX(message_id), MAX(IF(status>=3, message_id, NULL)), SUM(IF(status<3,1,0)) ...` | 一条聚合替代三次扫描 |
| `IsDuplicate` / `Count` | `SELECT COUNT(*) ...` | |

### 线程安全

- **MySQL 模式**：无需加锁（数据在 MySQL，MySqlPool 内部处理并发）
- **内存模式**：所有方法使用 `std::lock_guard<std::mutex>` 保护，互斥锁 `mu_` 声明为 `mutable` 以支持 const 方法中的加锁操作

## 业务角色

`MessageDao` 是 Message Service 的**存储抽象层**。它将消息的增删查逻辑与业务处理（`MessageServiceImpl`）解耦：

1. **消息存储**：`SendMessage` 业务逻辑生成 Snowflake ID 和 MessageRecord，交给 DAO 持久化。
2. **历史查询**：`GetMessages` 支持 offset_id 游标分页，客户端可以逐页拉取历史消息（Telegram 风格的 Timeline 模型）。
3. **去重保障**：通过 `idempotency_key`（MySQL 唯一索引 / 内存集合），防止网络重试导致的消息重复存储。
4. **同步支持**：`GetSyncState` 让客户端在上线时快速判断哪些对话有新消息，避免全量拉取。

**Phase 4（当前状态）**：MySQL 持久化已上线，`--enable_mysql` 时消息落库 `messages` 表，重启不丢；未启用/连接失败时自动回退内存存储。

## 系统连接

- **上层调用**：`MessageServiceImpl`（RPC 实现层）调用所有 CRUD、ACK 和 SyncState 方法。
- **依赖于 `MySqlPool`**（common 库）：`InitMySql` 自建连接池（`unique_ptr` 持有，与 UserDao 一致）；`ExecuteAffected` 提供受影响行数（判重/ACK 计数）。
- **ID 来源**：`message_id` 由调用方（`MessageServiceImpl`）通过 `Snowflake::NextId()` 预生成后传入。
- **表结构**：`services/scripts/docker/init.sql` 的 `messages` 表（Phase 4 加了 `from_peer_type`/`status`/`idempotency_key` 列 + `uq_idempotency` 唯一索引）。
- **命名空间**：`nova::message::MessageDao`，独立于 `user-service` 的 `UserDao`。
