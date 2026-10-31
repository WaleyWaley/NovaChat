# 实验 03：消息 ACK + 已读回执

对应 NovaChat 的：

- `services/message-service/message_dao.cc`（AckMessages / GetSyncState / GetAckedSenders）
- `gateway/src/ws/handlers/messaging.ts`（handleReadReceipt）
- `web/src/store/useAppStore.ts`（markActiveChatRead / markMessagesReceived）

## 背景

IM 的"已读回执"链路：

```
接收方读消息 → 发 max_read_msg_id → 服务端批量标记已读 → 反向推送给发送方 → 单勾变双勾 ✓✓
```

核心难点不在"发回执"，而在**确认语义**：批量、只升不降、幂等。本实验让你用真实 MySQL 亲手实现这套 DAO。

## 顺带踩了一个真实坑

连接池里 `LAST_INSERT_ID()` 不可靠（按连接生效，INSERT 和 SELECT 落不同连接）——这正是 NovaChat 用雪花 ID 生成 `message_id` 的原因。本 lab 用简化版雪花。

## 目录

- `cpp/` — C++ 版（真实 MySQL + 复用 lab07 的连接池）

## 双语言说明

本专题只做 C++（DAO 层是后端主题）。完整链路里的网关（TS）和前端已在你读过的代码里，README 有对照。

## 开始学习

进入 `cpp/`，按 `cpp/README.md` 操作（先 `start_mysql.ps1`）。

## 完成后你会掌握

- 批量 ACK 的 SQL 设计（`msg_id <= max AND status < new`）
- 幂等更新 / 只升不降的语义
- SyncState（latest / last_ack / unread）的聚合查询
- 雪花 ID vs AUTO_INCREMENT 的取舍
