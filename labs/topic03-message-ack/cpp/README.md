# 实验 03：消息 ACK + 已读回执（C++ 版）

## 目标

手写 NovaChat 的**消息确认（ACK）机制**，回答这三个面试题：

1. **ACK 是怎么做的？** —— 接收方发 `max_read_msg_id`，服务端批量把 `msg_id <= max` 的消息标记为已读。
2. **如何确认？** —— ACK 本身有回执（rpc_result），发送方收到 `UPDATE_MESSAGE_READ` 把单勾变双勾。
3. **服务端没收到 ACK 怎么办？** —— 幂等设计：重复 ACK 不会出错，下次读到还会再 ACK。

对应真实代码：`services/message-service/message_dao.cc`（`AckMessages` / `GetSyncState` / `GetAckedSenders`）。

## 消息模型（1:1 对话的"收件箱视图"）

```
alice(1) 发消息给 bob(2)  →  INSERT ... to_peer_id = 2   (bob 的收件箱)
bob(2) 发消息给 alice(1)  →  INSERT ... to_peer_id = 1   (alice 的收件箱)
```

每张收件箱以 `to_peer_id` 为键做 ACK 和同步。bob 读消息 = 把 `to_peer_id=2` 里 `msg_id <= max` 的消息标记 READ。

## 消息状态机

```
SENT(1)  --投递-->  DELIVERED(2)  --对端已读-->  READ(3)
```

本 lab 主要验证 `SENT → READ`，以及"**只升不降**"（已 READ 不会被 DELIVERED 降级）。

## 前置：启动 MySQL

```powershell
cd labs/topic03-message-ack\cpp
powershell -ExecutionPolicy Bypass -File start_mysql.ps1
```

## 文件结构

```
cpp/
├── start_mysql.ps1 / stop_mysql.ps1
├── build.ps1                      # 复用 lab07 的 mini_mysql_pool (通过 -I 引用并一起编译)
├── mini_message_dao.h             # 接口
├── mini_message_dao.cc            # ★ 你要实现的 TODO
└── main.cc                        # 测试入口 (已提供)
```

## 编译运行

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
.\topic03_message_ack.exe
```

当前骨架会抛 TODO；实现后应输出 `18 passed, 0 failed`。

## 你要实现的 4 个方法（mini_message_dao.cc）

### 1. `save_message(from, to, text)`

- `id = next_id()`（**应用侧生成雪花 ID**，已提供）
- `INSERT INTO messages(message_id, ..., status=SENT, ...) VALUES(...)`
- 返回 `id`

> ⚠️ **为什么不用 AUTO_INCREMENT + `LAST_INSERT_ID()`？** 这是本 lab 的关键工程点（见下面"踩坑"）。

### 2. `ack_messages(to_peer_id, max_ack, new_status)`（核心）

```sql
UPDATE messages SET status = ?
WHERE to_peer_type = 1 AND to_peer_id = ?
  AND message_id <= ? AND status < ?     -- status < new_status: 只升不降
```

- 批量：一条 SQL 确认 `<= max` 的所有消息
- `status < new_status`：已 READ 的不会被重复计数，也不会被降级 → **幂等**
- 返回受影响行数（`execute_affected`）

### 3. `get_acked_senders(to_peer_id, max_ack)`

```sql
SELECT DISTINCT from_peer_id FROM messages
WHERE to_peer_type = 1 AND to_peer_id = ? AND message_id <= ? AND from_peer_type = 1
```

找出这些被 ACK 的消息的发送者（用于反向推送"已读"给他们）。

### 4. `get_sync_state(to_peer_id)`

```sql
SELECT MAX(message_id) AS latest,
       MAX(IF(status >= 3, message_id, NULL)) AS last_ack,
       SUM(IF(status < 3, 1, 0)) AS unread
FROM messages WHERE to_peer_type = 1 AND to_peer_id = ?
```

空对话时 MAX/SUM 返回 NULL → 得到 `""` → `parse_i64` 转成 0。

## 踩坑记录（重要）：AUTO_INCREMENT 在连接池下不可靠

第一版用 `message_id AUTO_INCREMENT` + `SELECT LAST_INSERT_ID()` 拿 id，结果 18 个测试挂了 9 个。

原因：**`LAST_INSERT_ID()` 是按连接（connection）生效的**。连接池有 4 条连接，`INSERT` 落到 worker A，`SELECT LAST_INSERT_ID()` 落到 worker B（另一条连接）→ 拿到的是 B 的 last_insert_id，根本不是刚插入的那条。

**这正是 NovaChat 用雪花 ID 的原因**：`message_id` 由服务用 `nova::Snowflake` 生成，写进 `INSERT`，完全不依赖连接上下文。本 lab 用简化版雪花（`next_id()`，已提供）。

## 测试覆盖（main.cc）

| 用例 | 验证点 |
|---|---|
| 2. save_message | id 递增 |
| 3. 初始同步状态 | latest / last_ack=0 / unread=5 |
| 4. ACK 到第 3 条 | 更新 3 条, last_ack 前进, unread 减少 |
| 5. 幂等 | 重复 ACK 返回 0 |
| 6. senders | 反向通知集合 = {alice} |
| 7. 只升不降 | DELIVERED 不覆盖 READ |
| 8. 读完剩余 | 再更新 2 条, unread=0 |
| 9. alice 反向读 | 更新 3 条, unread=0 |

## 完整 ACK 链路（本 lab 聚焦 DAO 层）

真实系统里，DAO 之上还有网关和推送：

```
接收方客户端
  └─ 打开对话 → 取最后一条对方消息 id → WS 发 { type:"read", max_read_msg_id }
网关 ws/handlers/messaging.ts
  └─ handleReadReceipt → messageClient.ackMessage(...)  (peer.id 用鉴权 userId, 不可伪造)
message-service AckMessage RPC
  └─ dao.AckMessages(...)          ← 本 lab 实现的核心
  └─ dao.GetAckedSenders(...)      ← 本 lab 实现
  └─ 给每个发送者 push UPDATE_MESSAGE_READ
发送方客户端
  └─ 收到已读 → 把 status='sent' 的消息升级成 'received' (✓✓)
```

## 思考题（面试 Q&A）

1. 为什么 ACK 用 `msg_id <= max` 批量确认，而不是每条单独确认？
2. `status < new_status` 这个条件同时解决了哪两个问题？（幂等 + 只升不降）
3. ACK 本身丢了怎么办？你的设计里靠哪两个机制兜底？（幂等 + 客户端重读）
4. 为什么 AUTO_INCREMENT + `LAST_INSERT_ID()` 在连接池下会出错？雪花 ID 怎么绕开它？
5. `get_sync_state` 里 `MAX(IF(status>=3, message_id, NULL))` 为什么用 IF + NULL？
6. `peer.id` 为什么不能信任客户端传的值，要用网关鉴权后的 userId？

## 完成后对比

- `services/message-service/message_dao.cc`
- `services/message-service/message_service_impl.cc`（AckMessage → 反向推送）
- `gateway/src/ws/handlers/messaging.ts`（handleReadReceipt）
- `web/src/store/useAppStore.ts`（markActiveChatRead / markMessagesReceived）
