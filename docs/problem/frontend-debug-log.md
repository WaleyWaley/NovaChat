# Web 前端调试日志 — 关键问题修复记录

> 时间: 2026-07-18
> 涉及: gateway (TS) + web (HTML/JS)

---

## 问题 1：发送消息一直显示 "sending..."

**症状**：发送方发出消息后，状态始终为 `sending...`，不会变成 `✓`。

**排查**：网关日志显示 `Forwarding message to message-service`，消息已成功存储和推送，但前端没收到确认。

**根因**：proto3 默认值省略。message-service 返回 `{"message":{...},"is_new":true}` — `error_code: 0` 被省略（proto3 默认值不序列化）。网关代码检查 `result.error_code !== 0`，但 `result.error_code` 为 `undefined`（JavaScript），`undefined !== 0` 为 `true`，误判为错误，走了错误分支返回了 error response。

**文件**：`gateway/src/main.ts`

**修复**：`result.error_code && result.error_code !== 0` — 先判断字段是否存在。

---

## 问题 2：接收方收不到消息

**症状**：推送链路正常（Push reached gateway），但接收方浏览器始终收不到。

**排查**：gateway 日志 `[sendToUser] key="undefined"` — target_user_id 为 undefined。

**根因**：bRPC 的 json2pb 序列化使用 camelCase（`targetUserId`），但 gateway PushService 用 snake_case（`target_user_id`）解构请求体。字段名不匹配导致 `target_user_id` 为 `undefined`。

**文件**：`gateway/src/routes/push.ts`

**修复**：兼容两种格式 `target_user_id ?? targetUserId`。

---

## 问题 3：发送方名字显示为 `User <id>`

**症状**：收到消息时对方名字显示 `User 336828881845620740` 而非实际用户名 `bbb`。

**根因**：WebSocket 推送数据中 `fromPeer` 只包含 `id`（Snowflake int64），不包含 `username`。前端只能用 ID 显示，但 ID 是 64 位数字，截断显示后 6 位也不友好。

**修复**：
1. 搜索用户时将名字缓存在 `State.userNames` (Map<string, string>)
2. 缓存持久化到 `localStorage`（刷新不丢失）
3. 点击对话时同步更新缓存

**文件**：`web/js/app.js`

---

## 问题 4：Snowflake 64-bit ID 精度丢失导致 ConnectionManager 匹配失败

**症状**：`ConnectionManager.isOnline(target)` 返回 false，但 `getOnlineUserIds()` 包含 target。日志显示 `targetInList: false`。

**排查**：Snowflake ID (如 `336826344656605200`) 超过 JavaScript `Number.MAX_SAFE_INTEGER` (2^53)，`JSON.parse` 后丢失精度。`Map.get(number)` 和 `Map.get(string)` 可能匹配不上。

**修复**：ConnectionManager 内部统一用 `String(userId)` 作为 Map 键，所有 public 方法接受 `number | string` 参数并自动转换。

**文件**：`gateway/src/ws/connection.ts`

---

## 问题 5：自己发的消息重新打开对话后丢失

**症状**：aaa 给 bbb 发消息，关闭对话再打开，只能看到 bbb 的回复，看不到 aaa 自己发的。

**根因**：`send()` 函数通过 `addMessage()` 渲染到 DOM 但未存入 `State.chats`。`receiveMessage` 推送到 `State.chats`。重新打开对话时从 `State.chats` 恢复，只有收到的消息。

**修复**：`send()` 中同时将消息对象 push 到 `State.chats.get(peerId).messages`。

**文件**：`web/js/app.js`

---

## 问题 6：WebSocket 连接竞态导致消息推送失败

**症状**：用户刷新页面后，`ConnectionManager` 中找不到该用户，推送返回 `delivered: false`。

**根因**：旧 WebSocket 的 `close` 事件在**新连接注册之后**才触发。`unregister(old_socket)` 删除了新连接的 `byUserId` 条目。

**修复**：`unregister()` 中检查被注销的 socket 是否是当前活跃连接（`entry.ws !== ws`），不匹配则跳过。

**文件**：`gateway/src/ws/connection.ts`

---

## 问题 7：favicon.ico 404

**症状**：浏览器请求 `/favicon.ico` 返回 404。

**修复**：添加 `web/favicon.svg`。

---

> **总结**：6 个关键 bug，2 个是 bRPC 序列化约定不一致（proto3 默认值省略 + camelCase），2 个是 JavaScript Number 精度问题（Snowflake 64-bit ID），2 个是前端状态管理遗漏（消息存储 + 竞态）。
