# 实验 01：WebSocket 连接管理器

这是 NovaChat 工程训练的第一个模块，对应项目中的：

- `gateway/src/ws/connection.ts`
- `gateway/src/ws/handlers/call_room.ts`（信令转发也依赖连接管理）
- `gateway/src/main.ts`（WebSocket 入口）

## 双语言对照

| 概念 | TS 实现 | C++ 实现 |
|---|---|---|
| 连接表 | `Map` | `std::map` |
| 并发模型 | 单线程事件循环 | 多线程 + `std::mutex` |
| 心跳 | `setInterval` | `std::thread` |
| 连接对象 | `WebSocket` | 模拟 `Connection` |

## 学习路径

建议先完成 **TS 版**，因为它能直接跑起来，效果最直观。理解后再做 **C++ 版**，重点体会"为什么 C++ 要加锁"。

## 目录

- `ts/` — TypeScript 版（可运行的 WebSocket 服务器 + 客户端）
- `cpp/` — C++ 版（基于 cpp-httplib 的真实 WebSocket 服务器）

## 开始学习

1. 进入 `ts/` 目录，按 `ts/README.md` 操作
2. 完成后再进入 `cpp/`，按 `cpp/README.md` 操作
3. 每完成一个方法，回答对应的思考题

## 完成后你会掌握

- 长连接管理的双向索引设计
- 心跳检测的原理和参数选择
- 同用户多端互踢的实现
- 单播 / 广播 / 踢人的 API 设计
- C++ 多线程下共享数据保护的基本模式

## 关联面试题

1. 为什么用两个 Map 管理连接？
2. 心跳间隔和超时时间怎么定？
3. 同用户重连时旧连接的 close 回调会不会误删新连接？
4. 推送失败时调用方应该怎么做？
5. C++ 里持锁时为什么不能做 IO/close？
