# TelegramLike：基于 BFF 架构的高性能分布式 IM 与实时音视频平台

> **项目定位**：面向高并发场景的异构微服务即时通讯系统 
> **核心亮点**：TypeScript 网关承载海量长连接 + 现代 C++20 引擎榨干计算性能 + bRPC 驱动的高效内部通信

## 📖 项目简介
TelegramLike（NovaChat）是一个参照 Telegram 核心逻辑设计的分布式即时通讯（IM）与实时音视频（RTC）平台。

本项目摒弃了传统的单体后端架构，采用了业界前沿的 **BFF (Backend For Frontend)** 异构微服务架构：
- 接入层利用 **TypeScript + Node.js** 极高的 I/O 吞吐能力，负责处理海量 WebSocket 长连接、JWT 鉴权与业务路由。
- 核心逻辑层采用 **现代 C++20** 编写，借助 **bRPC** 框架与底层协程（bthread）机制，实现极低延迟的消息时序同步与音视频流媒体（SFU）转发。

## 🏗️ 整体架构设计 (Architecture)

系统整体划分为三大层级：**客户端侧 -> BFF 网关层 -> C++ 核心微服务群**。

### 1. 接入网关层 (TS BFF Gateway)
- **技术栈**：TypeScript + Node.js (NestJS / Express) + Socket.io/ws
- **核心职责**：
  - **连接保持**：维护数十万级别的客户端 WebSocket 长连接。
  - **安全与鉴权**：处理 JWT Token 校验、接口限流（Rate Limiting）及防刷机制。
  - **协议转换**：作为完美的通信桥梁，接收前端的 JSON 数据，通过 bRPC 标准的 HTTP POST 调用，将其无缝传递给后端的 C++ Protobuf 接口。

### 2. 核心微服务群 (C++ Core Services)
- **技术栈**：C++20 + bRPC + Protobuf
- **通信机制**：服务间采用纯二进制 Protobuf 协议进行高速 RPC 调用，剥离 HTTP 头部开销。
- **拆分服务**：
  - **用户与鉴权服务 (User Service)**：处理基础的注册、登录与用户信息拉取，并利用 Redis 缓存高频热点状态。
  - **消息同步引擎 (Message Sync Service)**：IM 系统的绝对核心。处理群聊/单聊消息的有序投递、离线消息拉取（Timeline 模型）、消息 ACK 确认机制，保证消息**不丢、不重、严格有序**。
  - **流媒体引擎 (RTC/Media Service)**：(进阶阶段) 负责处理音视频流。采用 SFU (Selective Forwarding Unit) 模式，在服务端进行流的路由与并发分发，利用 C++ 极致榨干 CPU 性能。

### 3. 数据持久层 (Storage)
- **MySQL**：存储用户元数据、群组关系、持久化的离线消息。
- **Redis**：维护在线用户 Session 路由表（记录哪个 UserID 连接在哪个网关节点上）、高频消息队列。

## 🚀 核心技术挑战与解决方案

### 挑战一：异构系统的高效通信
传统方案需要在 TS 网关层编写繁琐的 C++ 扩展，或者引入庞大的第三方中间件。
- **解决**：利用 **bRPC 的 HTTP/Protobuf 自动转换特性**。TS 网关仅需向 C++ 服务发送携带 JSON Body 的 HTTP 请求，bRPC 底层自动将其反序列化为强类型的 C++ Protobuf 对象。实现了“前端写 JSON，后端调结构体”的优雅跨界。

### 挑战二：C++ 侧高并发网络 I/O 阻塞
如果 C++ 核心服务采用传统的线程池模型，在处理大量慢速数据库查询或网络包转发时，极易耗尽线程资源。
- **解决**：全面引入 bRPC 的 **bthread (用户态协程)** 机制。采用 M:N 调度模型，即使在代码层面使用同步的调用写法（如 `Join` 或传入 `NULL` 的 RPC 调用），底层调度器也会自动让出内核线程，实现了真正的全异步非阻塞。

### 挑战三：海量消息的分布式路由
当用户 A 在网关节点 1 上，用户 B 在网关节点 2 上，A 给 B 发消息如何精准送达？
- **解决**：利用 Redis 构建全局在线状态路由表。C++ 消息服务处理完逻辑后，通过查表得知 B 挂载的网关 IP，直接通过 bRPC 反向调用网关的“推送接口”，网关再通过 WebSocket 下发给真实用户。

## 🗺️ 开发路线图 (Roadmap)

- [ ] **Phase 1: 基础设施搭建**
  - 定义前后端通信的 Protobuf (`.proto`) 协议规范。
  - 搭建 TypeScript BFF 网关骨架，跑通 JWT 鉴权。
- [ ] **Phase 2: 核心 IM 通信闭环**
  - 使用 bRPC 搭建 C++ Message Service。
  - 实现单聊、群聊消息的发送与 WebSocket 实时推送接收。
  - 引入 Redis 完成多网关节点下的状态路由。
- [ ] **Phase 3: 性能优化与存储落地**
  - 接入 MySQL，完成离线消息的 Timeline 拉取逻辑。
  - 在 C++ 服务中接入基于双缓冲（Double-Buffering）的高性能日志系统。
- [ ] **Phase 4: 进阶 RTC 挑战**
  - 探索并引入 WebRTC / FFmpeg 相关 C++ 库。
  - 实现基础的多人语音聊天室音频流转发 (SFU)。