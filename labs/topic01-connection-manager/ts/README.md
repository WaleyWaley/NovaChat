# 实验 01：WebSocket 连接管理器（TS 版）

## 目标

手写一个简化版的 `ConnectionManager`，理解：

1. 为什么需要 `userId → entry` 和 `WebSocket → userId` 两个 Map
2. 心跳检测怎么做
3. 同用户多端互踢怎么实现
4. 单播 / 广播 / 踢人的 API 设计

## 文件结构

```
ts/
├── src/
│   ├── MiniConnectionManager.ts   # 核心：需要你填充实现
│   ├── MiniWebSocketServer.ts     # WS 服务器：也需要少量填充
│   └── test-client.ts             # 测试客户端
├── package.json
└── tsconfig.json
```

## 第一步：安装依赖

```bash
cd labs/topic01-connection-manager/ts
npm install
```

## 第二步：填充 MiniConnectionManager.ts

按文件里的 `TODO` 顺序实现：

1. `register`
2. `unregister`
3. `getByUserId`
4. `isOnline`
5. `getOnlineCount`
6. `getOnlineUserIds`
7. `sendToUser`
8. `sendToUsers`
9. `kickUser`
10. `refreshHeartbeat`
11. `startHeartbeat`
12. `stopHeartbeat`
13. `disconnectAll`

每实现一个，就思考一下：

- 这个方法为什么要操作两个 Map？
- 如果这里不加锁/检查，会出现什么竞态？（TS 是单线程事件循环，但异步 close 回调仍可能乱序）
- `readyState === 1` 不检查会出什么问题？

## 第三步：填充 MiniWebSocketServer.ts

完成：

- `pushToUser`
- `kickUser`
- `ws.on("close")` 里的注销逻辑
- （可选）未认证消息拦截：参考 NovaChat 网关，未认证时只允许 `auth` 和 `ping`

## 第四步：运行测试

### 启动服务器

```bash
npm run dev:server
```

### 启动客户端（开多个终端窗口）

```bash
# 终端 A
npm run dev:client -- alice

# 终端 B
npm run dev:client -- bob

# 终端 C（用同样的 username，测试互踢）
npm run dev:client -- alice
```

## 第五步：验证清单

- [ ] 两个不同用户登录后，服务器在线数显示 2
- [ ] 同一用户登录两次，旧客户端收到 `Replaced by new connection` 关闭
- [ ] 客户端停发 ping 后，大约 15 秒内被服务端以 code=4002 断开
- [ ] 服务端主动调用 `kickUser` 时，目标客户端收到 `kicked` 消息并断开
- [ ] `sendToUsers` 能正确返回 delivered 和 missed

## 思考题（面试 Q&A）

1. 为什么用两个 Map？只用一个 `Map<userId, WebSocket>` 行不行？
2. 心跳间隔 5 秒、超时 15 秒，这个参数在真实生产环境应该怎么定？
3. 如果用户刚被 `kickUser`，立刻又重连，会不会出现旧连接的 `close` 回调把新连接误删？你的 `unregister` 是怎么避免这个竞态的？
4. `sendToUser` 返回 false 后，调用方应该怎么做？（结合 NovaChat 的 `deliverUpdateToUser` 想想）

## 参考答案

完成实验后，可以对比 NovaChat 真实代码：

- `gateway/src/ws/connection.ts`
- `gateway/src/main.ts` 中的 `/ws` 路由和消息分发
