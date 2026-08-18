# 消息数据流 + Redis 白板客户端 — 对话学习笔记

> 生成日期: 2026-08-18
> 来源: 对话学习内容整理
> 前置阅读: `fullstack-from-zero-2026-08-05.md`（从零学全栈）

---

## 第一部分：一条消息的完整传输旅程

> 对应代码：`web/js/api.js`、`gateway/src/main.ts`、`gateway/src/clients/message_client.ts`、
> `services/message-service/message_service_impl.cc`、`services/message-service/message_dao.cc`、
> `services/message-service/push_dispatcher.cc`、`gateway/src/routes/push.ts`、`gateway/src/ws/connection.ts`

### 全景图

```
Alice (浏览器)              Gateway (:3000)            message-service (:8002)       Bob (浏览器)
     │                            │                            │                         │
     │ ① WebSocket JSON           │                            │                         │
     ├───────────────────────────►│ ② HTTP POST + JSON         │                         │
     │                            ├───────────────────────────►│                         │
     │                            │   (bRPC json2pb 转 Protobuf)│                         │
     │                            │                            │ ③ 校验+去重+存储         │
     │                            │                            │ ④ PushDispatcher         │
     │                            │ ⑤ HTTP POST PushUpdate     │                         │
     │                            │◄───────────────────────────┤                         │
     │                            │ ⑥ 查 ConnectionManager     │                         │
     │                            │   找到 Bob 的 socket         │                         │
     │                            ├────────────────────────────────────────────────────────►│ ⑦ ws.send
     │ ⑧ rpc_result 确认          │                                                        │
     │◄───────────────────────────┤                                                        │
```

### 第 1 步：Alice 点击发送（浏览器 → 网关）

`web/js/api.js:150-164`：

```javascript
sendMessage(peerId, text) {
  const seq = this._nextSeq();   // 客户端消息序号, 用于匹配响应
  this._send({
    type: 'send_msg',
    seq,
    payload: {
      peer_type: 1,      // 1 = USER (单聊)
      peer_id: peerId,   // Bob 的 user_id
      msg_type: 0,       // 0 = TEXT
      text,              // "Hello Bob!"
    }
  });
  return seq;
}
```

**此时线上的数据**：

```json
{"type":"send_msg","seq":10,"payload":{"peer_type":1,"peer_id":"333...","msg_type":0,"text":"Hello Bob!"}}
```

**为什么有 `seq`？** 客户端用 seq 匹配请求和响应（等会儿确认回来时带同一个 seq）。

### 第 2 步：网关接收并转发

`gateway/src/main.ts:311-353` 的 `handleSendMessage()`：

```typescript
async function handleSendMessage(msg: ClientSendMessage) {
  // 关键设计: currentUserId 是 Alice 登录时记录的
  // 网关做身份注入 —— 客户端不能伪造 "我是谁"
  const result = await messageClient.sendMessage({
    from_peer: { type: 1, id: currentUserId },   // ← 网关注入!
    to_peer:   { type: msg.payload.peer_type, id: msg.payload.peer_id },
    msg_type:  msg.payload.msg_type ?? 0,
    text:      msg.payload.text,
  });
}
```

**安全设计点**：客户端只告诉网关"发给谁、发什么"，"我是谁"由网关从 JWT 解出。

### 第 3 步：网关 → C++ 消息服务（HTTP POST）

`gateway/src/clients/message_client.ts:60-74`：

```typescript
const url = `http://message-service:8002/nova.message.MessageService/SendMessage`;
const response = await fetch(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),          // JS 对象 → JSON 字符串
  signal: AbortSignal.timeout(5000),   // 5 秒超时
});
```

### 第 4 步：bRPC 的魔法 — JSON 自动变 Protobuf

请求到达 C++ 服务后，bRPC 在调用业务代码**之前**自动完成转换：

```
HTTP 请求到达 bRPC Server
  ├─ 1. 解析 URL: "/nova.message.MessageService/SendMessage"
  │     → 服务名 + 方法名
  ├─ 2. 查 ServiceDescriptor 找到 SendMessage 方法
  ├─ 3. 看方法签名: input_type = SendMessageReq
  ├─ 4. 创建空的 SendMessageReq 对象
  ├─ 5. json2pb: 把 JSON body 逐字段填入 (强类型校验!)
  └─ 6. 调用 SendMessage(controller, &req, &resp, done)
```

**强类型校验发生在进业务代码之前**——JSON 里字段类型不对，bRPC 直接拒绝。

### 第 5 步：C++ 处理 — 校验、去重、存储

`services/message-service/message_service_impl.cc:44-130`：

```cpp
void MessageServiceImpl::SendMessage(controller, request, response, done) {
    brpc::ClosureGuard done_guard(done);   // RAII: 函数返回时自动通知 bRPC

    // 1. 参数校验 (text 非空、长度 ≤ 4096、peer 合法)
    // 2. Snowflake 生成消息 ID (全局唯一, 趋势递增)
    // 3. 去重 + 存储 (message_dao.cc:15-54)
    //    - idempotency_key 已处理过? → 返回 is_new=false
    //    - 按 message_id 降序插入 messages_ vector (std::mutex 保护)
    // 4. 填充响应 (给 Alice 的确认)
    // 5. 触发推送 (给 Bob):
    if (!request->is_silent() && request->to_peer().type() == PEER_TYPE_USER) {
        update.set_type(UPDATE_NEW_MESSAGE);
        push_->PushToUser(Bob_id, update);   // ← 反向推送!
    }
}
```

**`brpc::ClosureGuard` 是 bRPC 新手最常见 bug 的解法**：忘了调 `done->Run()` 请求会永远挂起（客户端超时）。RAII 保证无论从哪个 return 出去都会通知框架。

### 第 6 步：反向推送 — C++ 主动呼叫网关

`services/message-service/push_dispatcher.cc:55-99`：

```cpp
// 1. Protobuf → JSON 字符串
MessageToJsonString(req, &json_body);

// 2. 创建指向网关的 HTTP Channel
brpc::Channel channel;
options.protocol = brpc::PROTOCOL_HTTP;   // C++ 当 HTTP 客户端!
channel.Init("gateway:3000", &options);

// 3. 构造 HTTP POST
cntl.http_request().uri() = "/nova.gateway.PushService/PushUpdate";
cntl.request_attachment().append(json_body);

// 4. 同步写法, bthread 协程自动挂起 (不阻塞线程)
channel.CallMethod(nullptr, &cntl, nullptr, nullptr, nullptr);

// 5. 失败检查
if (cntl.Failed()) return false;  // 推送失败不丢! 消息已存, Bob 上线拉取
```

**推送里带了完整消息内容**（message_id + from + text），Bob 客户端收到可直接渲染，不需要再发请求拉取。

### 第 7 步：网关 PushService 接收推送，找到 Bob 的 socket

`gateway/src/routes/push.ts:108-159`：

```typescript
// 1. push_id 幂等去重 — 防 bRPC 重试导致重复推送
if (push_id && connectionManager.isDuplicatePush(push_id)) {
    return { delivered: true };   // 假装成功, 不再推第二次
}

// 2. 构造 WS 消息
const serverMsg = buildUpdate(update.type, data);

// 3. 查本地 ConnectionManager: Bob 在这个网关节点上吗?
const delivered = connectionManager.sendToUser(String(target_user_id), serverMsg);

// 4. 推送失败 → 1.5 秒后重试一次 (Bob 可能正在重连)
if (!delivered) setTimeout(() => connectionManager.sendToUser(...), 1500);
```

`connection.ts:72-79` 的 `sendToUser()`：

```typescript
sendToUser(userId, message) {
  const entry = this.byUserId.get(key);        // user_id → 连接, O(1) 哈希查找
  if (!entry || entry.ws.readyState !== 1) return false;  // 不在线
  entry.ws.send(JSON.stringify(message));      // JS 对象 → JSON → WS 帧
  return true;
}
```

**`byUserId` Map 怎么来的？** Bob 登录时 `main.ts:261` 的 `handleAuth()` 调 `connectionManager.register(Bob_id, username, socket)`，把 user_id ↔ WebSocket 连接存进 Map。

### 第 8 步：Bob 的浏览器收到消息

`web/js/api.js:113-123` + `web/js/app.js:146-156`：

```javascript
// api.js — 收到 WS 帧
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.type === 'update') this._messageHandler(msg.payload);
};

// app.js — 渲染到聊天窗口
if (payload.update_type === 0) {    // UPDATE_NEW_MESSAGE
  receiveMessage(payload.data);     // 提取消息 → 渲染气泡 → 未读 +1
}
```

**Bob 收到的完整数据**：

```json
{"type":"update","payload":{"update_type":0,"data":{
  "new_message":{"message_id":333855523432570880,
                 "from_peer":{"type":1,"id":333855473985916928},
                 "text":"Hello Bob!"}}}}
```

### 第 9 步：确认回到 Alice（发送回执）

```
C++ SendMessage() 返回 → bRPC pb2json → HTTP 200
→ 网关 messageClient 拿到结果
→ main.ts:339-344: socket.send(buildRpcResult(msg.seq, 0, "", {message_id, status:"sent"}))
→ Alice 收到: {"type":"rpc_result","seq":10,"payload":{"error_code":0,"data":{"status":"sent"}}}
→ app.js addSentConfirmation(seq=10) → 匹配临时气泡 → "⋯" 变成 "✓"
```

### 数据形态变化总表

一条 "Hello Bob!" 的**七次形态变化**：

```
① 浏览器 JS 对象    { type:"send_msg", payload:{...} }
   ↓ JSON.stringify
② WebSocket 帧      '{"type":"send_msg","seq":10,...}'
   ↓ 网关解析 + 重组
③ HTTP JSON Body    '{"from_peer":{"type":1,"id":...},"text":"Hello Bob!"}'
   ↓ bRPC json2pb (自动!)
④ C++ Protobuf      SendMessageReq { text: "Hello Bob!" }
   ↓ 业务逻辑 (存储)
⑤ 推送 JSON Body    '{"target_user_id":...,"update":{...}}'
   ↓ 网关处理 + 重组
⑥ WebSocket 帧      '{"type":"update","payload":{...}}'
   ↓ Bob 浏览器 JSON.parse
⑦ Bob 的 JS 对象    { type:"update", payload:{...} }
```

### 三个关键问题

**Q1: Bob 离线了怎么办？**
推送失败 → `delivered: false`。但消息已在第 5 步存储。Bob 上线后 `GetMessages`（offset_id 分页）拉取遗漏。= "先存储、后推送、推送失败靠拉取兜底"。

**Q2: 消息会不会发两次？**
两层防御：
- C++ 层（`message_dao.cc:20-32`）：`idempotency_key` → `is_new=false`
- 网关层（`connection.ts:123-132`）：`push_id` → 跳过重复推送

**Q3: 怎么知道消息真的到 Bob 手里？**
`status: "sent"` 只表示"服务器已存储"。完整链：SENT → DELIVERED（Bob 客户端确认收到）→ READ（已读），由 Phase 3 的 `AckMessage` RPC 驱动。

---

## 第二部分：`gateway/src/redis/client.ts` — 网管的在线名单白板

> 对应代码：`gateway/src/redis/client.ts`（315 行）

### 一句话概括

网关用它记录"当前哪些用户在线、连在哪个网关上"——就像公寓楼前台的**白板**。

### 白板上的格子长什么样？

```
Redis 里实际存的东西:

key (盒子的标签)        value (盒子里塞的纸条)
user:online:1000   →   {"gateway_addr":"10.0.1.5:3000","last_heartbeat":1718360000000}
user:online:1001   →   {"gateway_addr":"10.0.1.5:3000","last_heartbeat":1718360001000}
```

- `gateway_addr`：用户连在哪个网关（多网关部署时用）
- `last_heartbeat`：最后一次"报平安"时间
- key 用 `user:online:` 前缀是 Redis 命名习惯（相当于目录）

### 逐个方法讲解

**1. `connect()`（35-82 行）— 连接白板**

```typescript
this.client = new Redis({
  lazyConnect: true,              // 不立即连接, 等显式 connect()
  retryStrategy: (times) => {
    if (times > 10) return null;              // 重试 10 次放弃
    return Math.min(times * 200, 5000);       // 指数退避: 200ms→400ms→...→5s
  },
  enableOfflineQueue: false,      // 关键! 断连时不排队, 直接失败
});
```

- `retryStrategy`（指数退避）：连不上时等待时间逐渐变长，避免疯狂重试把 Redis 打得更惨
- `enableOfflineQueue: false`：在线状态是**转瞬即逝**的数据，排队补发没意义——**失败比错误的数据好**

**2. `setUserOnline()`（104-125 行）— 用户上线贴纸条**

```typescript
await this.client.set(
  `user:online:${userId}`,
  JSON.stringify(entry),
  "EX",                        // 设置过期时间
  config.REDIS_ONLINE_TTL      // 30 秒
);
```

**TTL 30 秒 + 15 秒心跳刷新 = 自动下线检测**：

```
Alice 在线 → 贴纸条(30秒有效) → 每15秒刷新(重新活30秒) → ...
Alice 掉线 → 没人刷新 → 30秒后纸条自动消失 → 全世界知道她下线
```

不用手动清理掉线用户，Redis 的 TTL 自动干这个活。

**3. `refreshHeartbeats()`（156-223 行）— 批量刷新纸条**

用 **pipeline（管道）** 把 1 万次网络往返变成 2 次：

```typescript
// 第一次 pipeline: 批量读 (1 次往返读完 1 万个 key)
const pipeline = this.client.pipeline();
for (const userId of userIds) pipeline.get(`user:online:${userId}`);
const results = await pipeline.exec();

// 第二次 pipeline: 批量写 (1 次往返写完 1 万个 key)
const setPipeline = this.client.pipeline();
for (...) setPipeline.set(key, 新纸条, "EX", 30);
await setPipeline.exec();
```

**为什么要先读再写？** 刷新时要保留 `gateway_addr` 字段（用户可能连在别的网关）。流程：读旧纸条 → 更新心跳时间 → 写新纸条。

**三种情况处理**（178-213 行）：
- 纸条不存在 → 写一张全新的
- 纸条在且 JSON 正常 → 更新 `last_heartbeat`，保留原 `gateway_addr`
- JSON 坏了（脏数据）→ 写一张全新的兜底

**4. `setUserOffline()`（226-237 行）— 用户下线擦纸条**

```typescript
await this.client.del(`user:online:${userId}`);   // 就一行
```

**5. `isUserOnline()`（240-251 行）— 查白板**

```typescript
const val = await this.client.get(key);
if (!val) return null;        // 纸条不存在 = 不在线
return JSON.parse(val);       // 纸条在 = 在线, 还能知道他在哪个网关
```

**6. `batchCheckOnline()`（254-292 行）— 批量查白板**

群聊场景一次查 500 个成员，同样用 pipeline 批量 GET，返回 online/offline 两个列表。

**7. `clearGatewayUsers()`（297-310 行）— 关店前擦干净**

网关关闭（重启/发版）时批量 DEL 所有纸条。**不擦的后果**：网关已关但纸条还在 → 别的服务以为用户在线 → 往死胡同推消息。**优雅关闭 = 临走前把白板擦干净。**

### 全局单例模式（313-314 行）

```typescript
export const gatewayRedis = new GatewayRedis();
```

整个网关进程**只有一个** Redis 客户端实例。Redis 连接是昂贵资源（TCP 连接 + 缓冲区），所有模块共享一个。这就是**单例模式（Singleton）**。

### 最值得面试讲的设计：优雅降级

所有方法开头都有：

```typescript
if (!this.client || !this._connected) return false;   // 连不上? 直接返回失败
```

**Redis 挂了之后**：

```
✅ 用户照样连接、聊天、发消息（连接在网关内存 Map 里）
✅ 消息照样推送（本网关用户走 ConnectionManager）
❌ 跨网关在线查询失效
❌ 心跳刷新失效
→ 整体服务降级但不崩溃
```

**面试话术**："Redis 在网关里只承担'全局在线路由表'这一件事。我做了优雅降级设计——所有 Redis 操作失败只记日志不抛异常，网关的核心功能（WebSocket 连接管理）在内存里完全不依赖 Redis。即使 Redis 完全宕机，用户依然可以连接和收发消息，只是跨网关在线查询退化成只查本地。"

### 在系统中的位置

```
用户登录 (main.ts)
  → online_registry.onUserOnline()
  → gatewayRedis.setUserOnline(1000)      ← 写白板
  → Redis: user:online:1000 = {...}
          ↑
push.ts 的 IsUserOnline 端点             ← 查白板
  ← gatewayRedis.isUserOnline(1000)
  ← C++ 服务推送前查询
```

**核心设计三要点**：TTL 自动过期（不用清理）、pipeline 批量（1 万操作 2 次往返）、优雅降级（Redis 挂了不影响核心服务）。
