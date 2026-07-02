# NovaChat 配置加载器 (`config.h` / `config.cpp`)

## 技术职责

`Config` 类是对 **Google gflags** 命令行参数解析库的轻量封装，负责管理 NovaChat 所有 C++ 微服务的启动配置。采用 Phase 1 直接使用 gflags、Phase 3 可扩展为 YAML/JSON 配置文件的渐进式设计。

核心功能：

- **`Init(argc, argv, usage)`**：在服务 `main()` 入口调用，解析命令行参数并设置帮助信息。调用后各服务通过 `FLAGS_*` 全局宏直接读取配置（如 `FLAGS_listen_port`）。
- **`LoadFlagFile(path)`**：从文件加载额外配置，等价于命令行 `--flagfile=path`。适用于不同部署环境（开发/测试/生产）分别提供配置文件的场景。
- **类型化读取方法**：`GetStringFlag` / `GetInt32Flag` / `GetInt64Flag` / `GetBoolFlag` / `GetDoubleFlag`，提供基于字符串查询的便捷接口，支持在运行时动态读取任意 gflags 的值。
- 实现文件调用 `NOVA_LOG_INFO` 记录初始化日志，方便排查启动问题。

## 业务角色

在 NovaChat 系统中，每个 C++ 微服务（如用户服务 `user-service`、消息服务 `message-service`、网关 `gateway`）都需要在启动时获知自身的监听端口、对端服务的 RPC 地址、数据库连接信息、Redis 地址等运行时参数。`Config` 将这一需求统一化——所有服务使用相同的初始化流程和配置读取方式。

这种设计避免各服务各自造轮子解析命令行或配置文件，也便于统一运维：在容器化部署场景下，只需通过 `--flagfile` 或环境变量注入参数即可。

## 系统连接

- **被所有 C++ 微服务的 `main()` 函数直接调用**：每个服务启动时第一件事就是调用 `Config::Init()`。
- **依赖 `logger` 模块**：`Init()` 和 `LoadFlagFile()` 内部记录日志。
- **属于 Phase 1 简化实现**：目前直接使用 gflags 原生 `FLAGS_*` 宏。Phase 3 计划替换为 YAML/JSON 配置加载，但对外接口不变，对调用方透明。
- gflags 的 `--flagfile` 机制使得 NovaChat 的配置天然支持多环境差异化部署，无需额外开发配置中心客户端。
