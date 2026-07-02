# NovaChat 日志系统 (`logger.h` / `logger.cpp`)

## 技术职责

`logger` 模块是 NovaChat 的日志封装层，Phase 1 直接代理到 **Google glog** 日志库，对外提供统一的日志宏接口。采用 inline 函数方式实现，头文件即实现，`.cpp` 文件为 Phase 3 的双缓冲异步日志预留占位。

核心内容包括：

- **初始化/关闭**：`InitLogger(name, log_dir)` 调用 `google::InitGoogleLogging`，设置日志输出目录（默认 `./logs`），同时输出到文件和 stderr。`ShutdownLogger()` 用于进程退出前安全关闭日志系统。
- **日志宏**：`NOVA_LOG_INFO` / `NOVA_LOG_WARN` / `NOVA_LOG_ERROR` / `NOVA_LOG_FATAL` 对应 glog 的不同级别；`NOVA_VLOG` / `NOVA_DLOG_INFO` / `NOVA_DVLOG` 提供条件日志和调试日志支持。
- **Phase 3 扩展点**：`.cpp` 文件已被注释标记为 Phase 3 双缓冲异步日志的替换点。届时只需修改宏定义出的底层实现，所有调用方代码无需改动，体现接口与实现分离的设计。

## 业务角色

在分布式 IM 系统中，日志是排查故障、监控系统运行的命脉。NovaChat 的日志宏被所有 C++ 微服务广泛使用，覆盖以下场景：

- **服务启动流程**：记录配置加载、数据库连接、监听端口等关键节点的状态。
- **请求处理跟踪**：RPC 请求的接收与响应、用户登录/登出、消息收发等业务操作。
- **异常与错误**：Redis/MySQL 连接失败、配置缺失、时钟回拨等非正常状态的报警。
- **调试辅助**：`NOVA_VLOG` 提供分级调试输出，开发环境可开、生产环境可关。

统一日志封装也意味着后续切换到自研高性能异步日志时，不需要修改业务代码的任何一行。

## 系统连接

- **被所有 C++ 模块引用**：`config.cpp` / `snowflake.cpp` / `mysql_pool.cpp` / `redis_client.cpp` 均使用 `NOVA_LOG_*` 宏记录日志。
- **依赖 glog 库 (butil logging)**：butil 是 bRPC 框架的底层工具库，直接提供 glog 兼容接口。
- **与 `Config` 配合**：服务的 `main()` 函数中通常先调用 `Config::Init()`，随后调用 `InitLogger()` 完成日志系统初始化。
