# gateway/src/main.ts — 网关入口文件逐段讲解

> 生成日期: 2026-08-19
> 对象: `gateway/src/main.ts`（635 行）
> 前置: 已学过 `fullstack-from-zero-2026-08-05.md`（HTTP/WebSocket/JSON 基础）

---

## 0. 一句话概括

`main.ts` 是网关的**总指挥**。它做三件大事：

```
① 开店 (createApp):  装好货架(路由)、装好电话总机(WebSocket)、定好规矩(鉴权)
② 营业 (main):       开灯(listen)、启动各种定时器(心跳/清理)
③ 打烊 (shutdown):   关定时器、擦白板、挂断所有电话、关门
```

---

## 1. 文件结构地图（4 大块）

```
main.ts 一共 635 行，按执行顺序分 4 块:

第 1 块 (59-518 行):  createApp() — 搭建整个应用
   ├── 61-64:   创建 Fastify 实例
   ├── 67-76:   注册插件 (CORS, WebSocket)
   ├── 79-80:   注册中间件钩子 (鉴权, 限流)
   ├── 83-85:   注册 HTTP 路由 (health, push, user)
   ├── 88-498:  WebSocket 处理器 ← 最大的部分, 411 行
   │            ├── 108-190: 消息接收 + 类型分发 (switch)
   │            ├── 193-209: 连接关闭处理
   │            ├── 220-308: handleAuth (登录)
   │            ├── 310-315: handlePing (心跳)
   │            ├── 317-359: handleSendMessage (发消息)
   │            ├── 361-409: handleRoomSignal (多人房间) ← 新增
   │            ├── 411-423: handleCallSignal (1v1 通话信令)
   │            ├── 425-439: handleTyping / handleReadReceipt (占位)
   │            └── 441-496: handleRpc (通用 RPC 代理)
   ├── 501-506:   404 处理
   └── 509-515:   全局错误处理

第 2 块 (527-557 行):  proxyUserService() — RPC 代理辅助函数

第 3 块 (563-604 行):  main() — 启动流程

第 4 块 (607-631 行):  shutdown — 优雅关闭
```

---

## 2. 第 1 块：createApp() — 搭店面

### 2.1 Fastify 是什么？（61-64 行）

```typescript
const app = Fastify({
  logger: false,      // 不用 Fastify 自带的日志, 用我们自己的 pino
  trustProxy: true,   // 信任反向代理 (Nginx) 传来的真实 IP
});
```

**Fastify** 是一个 Node.js 的 HTTP 服务器框架（相当于 Express，但快 2-3 倍）。它管的是"收到 HTTP 请求 → 找到对应处理函数 → 返回响应"这件事。

**`trustProxy: true`**：用户 → Nginx(:80) → 网关(:3000)。网关看到的 IP 永远是 Nginx 的 IP。开了这个选项，Fastify 会从请求头里挖出**用户的真实 IP**。

### 2.2 插件注册（67-76 行）

```typescript
await app.register(fastifyCors, { origin: true, credentials: true });
await app.register(fastifyWebsocket, {
  options: { maxPayload: 64 * 1024 },   // 单条 WS 消息最大 64KB
});
```

**CORS（跨域资源共享）**：浏览器安全规则——网页只能请求同域名的服务器。开了 CORS 后允许前端跨域调网关。`origin: true` 是开发期全放行（生产应该收紧）。

**WebSocket 插件**：Fastify 原生只支持 HTTP，加这个插件才能处理 WebSocket 连接。`maxPayload: 64KB` 防止有人发超大消息打爆内存。

### 2.3 中间件钩子（79-80 行）

```typescript
registerAuthHook(app);        // 鉴权: 每个请求先查"你是谁"
registerRateLimitHook(app);   // 限流: 每个请求先查"你是不是刷太快"
```

这两个是**钩子（Hook）**——不是路由，而是"每个请求进来都要先过这两关"的检查站：

```
HTTP 请求进来 → [鉴权检查] → [限流检查] → 才轮到真正的路由处理
                失败返回 401      失败返回 429
```

具体逻辑在 `middleware/auth.ts` 和 `middleware/rate_limiter.ts`，main.ts 只负责"装上"。

### 2.4 HTTP 路由注册（83-85 行）

```typescript
await app.register(healthRoutes);   // GET /health          → 健康检查
await app.register(pushRoutes);     // POST /PushService/*  → C++ 反向推送入口
await app.register(userRoutes);     // POST /api/auth/* 等  → 用户 API
```

这是网关的"HTTP 面孔"。记住：**HTTP 请求走这三个路由文件，WebSocket 消息走下面的 handler**——两条完全不同的通道。

---

## 3. WebSocket 处理器（88-498 行）— 核心中的核心

### 3.1 连接建立（88-105 行）

```typescript
app.get("/ws", { websocket: true }, (socket: WebSocket, req: FastifyRequest) => {
  // 有人连上 ws://gateway:3000/ws 就会执行这里
```

**注意写法**：`app.get("/ws", { websocket: true }, 回调函数)`。加了 `{ websocket: true }` 后，这个路径不再处理普通 HTTP GET，而是处理 WebSocket 升级请求。

回调执行 = 一个用户"拨通了电话"。回调里的代码是**每个连接一套独立状态**：

```typescript
let authenticated = false;          // 这个人验证过身份了吗?
let currentUserId: number | null = null;   // 他是谁?
let currentUsername = "";
let currentSessionId: string | null = null;
```

**关键概念：闭包（Closure）**。这四个变量是"这个连接私有"的。1000 个用户连接 = 1000 套互相独立的变量。下面的 handleAuth/handleSendMessage 等函数都定义在这个回调**里面**（第 220 行注释写着"闭包内, 可访问 socket / authenticated / currentUserId"），它们共享这套状态。

**为什么这么设计？** 每个连接就是一个"客户"，客户的资料（身份、状态）跟着连接走。用闭包绑定状态，代码不用到处传参数。

连接建立后立刻发欢迎帧（100-105 行）：

```typescript
socket.send(JSON.stringify({
  type: "welcome",
  payload: { version: "0.1.0", message: "NovaChat Gateway" },
}));
```

客户端收到 welcome 就知道"电话通了，可以报身份了"。

### 3.2 消息接收与分发（108-190 行）— 总机接线逻辑

```typescript
socket.on("message", (rawData: Buffer) => {
  // 每次客户端发消息, 都走这里
```

处理流程像一个三层漏斗：

```
第一层: JSON.parse 成功吗?（108-119 行）
  ├─ 失败 → 回 error 1302 "Invalid JSON"
  └─ 成功 → 继续

第二层: 有 type 和 seq 字段吗?（121-128 行）
  ├─ 没有 → 回 error 1302 "Invalid message format"
  └─ 有 → 继续

第三层: 认证过了吗?（134-141 行）
  ├─ 没认证且不是 auth/ping → 回 error 1004 "Authentication required"
  │    (没登录的人只许"登录"和"报心跳"两种操作)
  └─ 通过 → 进入 switch 分发
```

然后是最核心的 **switch 分发**（143-189 行）——根据 `type` 字段找对应的处理函数：

| type | 处理函数 | 干什么 |
|------|---------|--------|
| `auth` | handleAuth | 登录认证 |
| `ping` | handlePing | 心跳，回 pong |
| `send_msg` | handleSendMessage | 转发消息给 C++ |
| `typing` | handleTyping | 正在输入（占位） |
| `read` | handleReadReceipt | 已读回执（占位） |
| `call_signal` | handleCallSignal | 1v1 通话信令转发 |
| `room_signal` | handleRoomSignal | 多人房间信令 |
| `rpc` | handleRpc | 通用 RPC 代理 |
| 其他 | 回 error | 未知类型 |

**这就是网关的"总机接线员"**：收到一个消息，看一眼 type，插到对应的线路上。

### 3.3 连接关闭处理（193-209 行）

```typescript
socket.on("close", (_code, _reason) => {
  if (authenticated && currentUserId !== null) {
    connectionManager.unregister(socket);          // ① 从内存接线板拔掉
    onlineRegistry.onUserOffline(currentUserId);   // ② 擦 Redis 白板
  }
});
```

用户挂电话（或断网、心跳超时被踢）时做两件清理：**内存里删连接 + Redis 里擦在线状态**。缺一个都会出问题：只删内存不擦 Redis → 别的网关以为他还在线；只擦 Redis 不删内存 → 内存泄漏。

### 3.4 handleAuth — 登录（220-308 行）

完整流程：

```
① 解出 token（221 行）
② verifyAccessToken 验证（223 行）
   ├─ 过期 → error 1002
   ├─ Session 被注销 → error 1003
   └─ 无效 → error 1004
③ 延迟创建 Session 记录（240-264 行）
   首次见到这个 session_id → 创建
   见过 → 更新活跃时间
④ connectionManager.register(注册进接线板)（267-279 行）
   失败(超过连接上限) → error 5002 "Server busy"
⑤ 记录身份: authenticated = true（281-284 行）
⑥ onlineRegistry.onUserOnline → 写 Redis 白板（299-301 行）
⑦ 回 auth_ok（303-307 行）
```

**面试要点**：验证顺序设计——**先验证 token，再注册连接，最后才写 Redis**。如果反过来（先写 Redis 再验证），攻击者可以发假 token 把白板弄脏。

### 3.5 handleSendMessage — 发消息（317-359 行）

```typescript
const result = await messageClient.sendMessage({
  from_peer: { type: 1, id: currentUserId },   // 网关注入"我是谁"
  to_peer:   { type: msg.payload.peer_type, id: msg.payload.peer_id },
  msg_type:  msg.payload.msg_type ?? 0,
  text:      msg.payload.text,
});
```

流程（前面数据流文档讲过）：
1. 调 C++ message-service 存消息
2. 成功 → 回 `rpc_result { message_id, status: "sent" }`
3. 失败 → 回 `rpc_result { error_code: 5001 }`

**注意 334 行的注释**：`proto3 omits error_code=0 from JSON` —— proto3 规定 0 值字段在 JSON 序列化时**默认省略**。所以成功时 `result.error_code` 是 `undefined` 而不是 `0`，判断要写 `if (result.error_code && result.error_code !== 0)`（先判断存在再判断非 0）。

### 3.6 handleRoomSignal — 多人语音房间（361-409 行）★ 新功能

这是最新的 Phase 4.1 功能：**多人语音房间（Mesh 模式）**。

先理解 Mesh 模式：**没有服务器转发媒体流，每个人直接连其他所有人**。

```
3 人房间的 Mesh 拓扑:

    Alice
    /    \
  Bob —— Carol

每个连接 = 一条独立的 P2P 音频流
3 人 = 3 条连接, 4 人 = 6 条, 10 人 = 45 条 (组合爆炸!)
```

这就是为什么 Mesh 只适合小房间（<6 人），大房间必须升级 SFU（服务器转发）。

`handleRoomSignal` 处理 5 种 action：

| action | 干什么 | 代码 |
|--------|--------|------|
| `create` | 建房间，返回 room_id + 参与者列表 | 367-370 |
| `join` | 加入房间，通知房内其他人"新人来了" | 371-381 |
| `leave` | 离开，通知剩余成员；人都走了房间解散 | 382-390 |
| `invite` | 邀请用户（前提：邀请者已在房间） | 391-398 |
| `webrtc` | Mesh 信令广播：转发给房间内**所有其他人** | 399-408 |

房间状态存在哪？`room_manager.ts`——两个 Map：

```typescript
private rooms = new Map<string, Room>();        // roomId → 房间(含参与者列表)
private userRooms = new Map<string, string>();  // userId → roomId (谁在哪个房)
```

**面试要点**：当前房间管理是**网关内存态**（进程重启房间全丢）。跨网关多人房需要把房间状态搬到 Redis。这是下一步演进方向。

### 3.7 handleCallSignal — 1v1 通话信令（411-423 行）

```typescript
const targetWs = connectionManager.getByUserId(String(to_user_id));
if (!targetWs) {
  socket.send(JSON.stringify(buildError(msg.seq, 1101, "User not online")));
  return;
}
// 转发信令给目标用户
targetWs.send(JSON.stringify(buildCallSignal(signal_type, currentUserId!, currentUsername, data)));
```

一句话：**查接线板 → 找到对方的电话线 → 原样转达**。网关不解析 SDP/ICE 内容（看不懂也没必要懂），只负责"把这包东西从 A 递给 B"。

### 3.8 handleRpc — 通用 RPC 代理（441-496 行）

客户端可以在 WebSocket 里直接调 C++ 服务的方法：

```typescript
if (msg.payload.service === "nova.user.UserService") {
  result = await proxyUserService(msg.payload.method, msg.payload.body, currentUserId!);
}
```

好处：**客户端只用一条 WebSocket 连接就能完成所有操作**——不用为了查资料再发 HTTP 请求。网关做两件事：鉴权注入（把 currentUserId 塞进请求体）+ 按服务名路由。

`proxyUserService`（527-557 行）是具体的转发表：GetUserProfile → userClient.getUserProfile()，ChangePassword → userClient.changePassword()……**注意 533 行**：`bodyWithUser = { ...body, user_id: userId }`——客户端传的 user_id 被网关**强制覆盖**为认证身份，客户端不能查别人的敏感操作。

---

## 4. 第 3 块：main() — 启动流程（563-604 行）

```typescript
async function main() {
  const app = await createApp();            // ① 搭好店面

  const redisOk = await gatewayRedis.connect();  // ② 连 Redis 白板
  if (!redisOk) logger.warn("...");              //    失败只是警告, 不退出!

  await app.listen({ port: 3000, host: "0.0.0.0" });  // ③ 开门营业

  connectionManager.startHeartbeat();        // ④ 心跳检测定时器 (30s 检查一次)
  if (redisOk) onlineRegistry.startHeartbeat();  // ⑤ 白板刷新定时器 (15s 批量续命)
  sessionStore.startCleanupTimer();          // ⑥ Session 清理定时器 (5min 清一次)
}

main();   // 最后一行的 main() 是真正的点火
```

**三个定时器是"营业期间的后台员工"**：
- 心跳检测：30 秒扫一遍所有连接，谁 60 秒没报平安就断开
- 白板刷新：15 秒批量刷新所有在线用户的 Redis TTL
- Session 清理：5 分钟清一次过期 Session

**Redis 连接失败为什么只是警告？** 这就是之前讲的**优雅降级**——Redis 是辅助，网关核心功能（连接管理）在内存，Redis 挂了照常营业。

## 5. 第 4 块：优雅关闭（607-631 行）

```typescript
process.on("SIGINT", () => shutdown("SIGINT"));   // Ctrl+C
process.on("SIGTERM", () => shutdown("SIGTERM")); // Docker stop / kill

const shutdown = async (signal) => {
  connectionManager.stopHeartbeat();      // ① 停所有定时器
  onlineRegistry.stopHeartbeat();
  sessionStore.stopCleanupTimer();

  await onlineRegistry.shutdown();        // ② 擦干净 Redis 白板
  await gatewayRedis.disconnect();        // ③ 断开 Redis

  connectionManager.disconnectAll("Server shutting down");  // ④ 通知所有用户"打烊了"
  await app.close();                      // ⑤ 关门
  process.exit(0);
};
```

**顺序很重要**：先停新工作（定时器）→ 清理外部状态（白板）→ 通知客户（断开连接）→ 关门。如果顺序反了（先关门再擦白板），会出现"店关了但白板还写着有人在"的脏状态。

**SIGINT/SIGTERM 是什么？** 操作系统发给进程的信号。SIGINT = 终端 Ctrl+C，SIGTERM = kill 命令 / Docker stop。监听这两个信号 = "听到打烊铃声就启动打烊流程"，而不是被粗暴杀死（那样白板就脏了）。

---

## 6. 关键设计模式总结

| 模式 | 在哪 | 一句话 |
|------|------|--------|
| **闭包** | 88-498 行 | 每个连接的私有状态（authenticated/currentUserId）被回调内所有函数共享 |
| **单例** | 导入的 connectionManager/roomManager/gatewayRedis | 全局只有一个实例 |
| **责任链** | 108-141 行 | 三层漏斗：JSON 校验 → 格式校验 → 认证校验，每层不通过就拦截 |
| **分发器** | 143-189 行 switch | 按 type 路由到 8 个处理函数 |
| **优雅降级** | 567-570 行 | Redis 失败只警告，不影响核心服务 |
| **优雅关闭** | 607-631 行 | 停定时器 → 清状态 → 断连接 → 退进程 |

---

## 7. 面试可能的追问

**Q: 这个文件 635 行是不是太长了？**
答：确实偏长。WebSocket 回调里塞了 8 个 handler，理想做法是把每个 handler 抽到独立文件（如 `handlers/` 目录），main.ts 只做装配。当前是项目早期阶段，功能优先，重构留待后续。

**Q: 为什么房间管理放内存？**
答：Mesh 模式的房间是短生命周期对象，放内存最简单。跨网关多人房需要 Redis（共享状态）。当前所有用户都连同一个网关（开发环境），内存足够。

**Q: typing/read 为什么是空占位？**
答：这两类消息需要 message-service 配合（转发给对端），Phase 2 只做了协议定义，实现留到后续。当前网关收到后只记日志。
