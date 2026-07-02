# utils/logger.ts — 日志工具

## 技术职责

`utils/logger.ts` 是对高性能日志库 **pino** 的封装，为整个网关提供统一的日志输出能力：

1. **创建全局 logger 实例**：根据运行环境自动选择日志级别——开发环境为 `debug`，生产环境为 `info`，避免开发时遗漏调试信息，同时确保生产环境日志量可控。
2. **开发体验优化**：开发环境下启用 `pino-pretty` 传输层，输出带颜色和可读时间戳（`HH:MM:ss.l`）的日志，隐藏 `pid` 和 `hostname` 等干扰项，提升本地开发效率。
3. **注入全局上下文**：在每个日志条目的 `base` 字段中自动附加 `worker_id`（节点唯一标识）和 `env`（运行环境），便于在分布式部署中按节点和环境过滤日志。
4. **提供子日志工厂**：`createRequestLogger(requestId)` 函数基于全局 logger 创建一个携带 `requestId` 的子 logger，用于单次请求的全链路追踪。

## 业务角色

在 NovaChat 即时通讯系统中，日志模块是运维可观测性的基础：

- **问题排查**：统一的日志格式（JSON 结构化）和一致的字段命名（`err`、`userId`、`sessionId`、`ip` 等），使开发者和运维人员能够快速定位问题。WebSocket 连接的建立、认证、错误、关闭等关键事件均有日志输出。
- **全链路追踪**：`createRequestLogger` 为每个 HTTP 请求创建带 `requestId` 的子 logger，将一次请求在前端、网关、后端各层的日志关联起来，是后期构建 APM 追踪能力的基础。
- **运维告警**：`logger.fatal` 在网关启动失败时使用，`logger.error` 在 RPC 调用失败、Session 创建失败时使用，结构化的日志可以与 ELK、Splunk 等日志平台对接，配置告警规则。

## 系统连接

- **配置模块** (`config/index.ts`)：日志级别和全局标签（`worker_id`、`env`）来源于配置模块的 `config.NODE_ENV` 和 `config.WORKER_ID`。
- **入口模块** (`main.ts`)：最主要的消费者，在服务器启动、HTTP 请求处理、WebSocket 连接生命周期、RPC 代理调用等所有关键路径上使用 logger 记录事件与异常。
- **所有路由模块和服务客户端**：间接使用 logger 输出业务日志，依赖其统一的格式和级别控制。
- **Phase 3 规划**：代码注释中计划将 logger 替换为向 C++ 双缓冲日志系统发送的桥接层，届时此模块将承担网关到 C++ 日志管道的适配职责，实现前后端日志的统一收集。