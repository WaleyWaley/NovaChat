# User Service 服务入口 — `server.cc`

## 技术职责

`server.cc` 是 NovaChat User Service 的**主入口文件**，负责初始化并启动一个 bRPC 服务器。其执行流程分为以下阶段：

1. **配置解析**：使用 `gflags` 解析命令行参数，包括监听端口（默认 8001）、监听地址（`0.0.0.0`）、Snowflake Worker ID（集群内唯一）、MySQL/Redis 连接参数等。
2. **日志初始化**：调用 `nova::InitLogger("user_service")` 启动日志系统，输出服务启动信息，便于运维监控。
3. **Snowflake ID 生成器**：根据 `worker_id` 创建 `nova::Snowflake` 实例，用于分布式全局唯一用户 ID 和 Token 的生成。
4. **DAO 层创建**：实例化 `UserDao`。Phase 1 阶段使用内存存储模拟，Phase 2 后将连接 MySQL 连接池和 Redis 客户端进行真实持久化。
5. **服务实现绑定**：将 `UserServiceImpl` 实例注册到 bRPC `Server` 对象中，声明 `SERVER_DOESNT_OWN_SERVICE`（服务对象由调用方管理生命周期）。
6. **服务启动**：调用 `server.Start(ep, &options)` 启动 bRPC 服务器，然后阻塞于 `RunUntilAskedToQuit()` 等待操作系统信号。
7. **优雅退出**：收到退出信号后，关闭日志系统并退出。

## 业务角色

在 NovaChat 的 BFF 架构中，User Service 是一个**独立的 C++ 微服务**，部署在端口 **8001**，专门处理所有用户账户相关的操作。它对外暴露 **12 个 bRPC 方法**（涵盖注册、登录、资料查询、搜索、密码修改、账户注销等），不直接面向客户端，而是由 TypeScript 网关层将 HTTP 请求转换为 bRPC 调用转发过来。

该服务是 NovaChat 用户体系的核心——所有用户身份的创建、认证、信息维护均依赖它。

## 系统连接

- **上游**：TypeScript BFF Gateway，HTTP → bRPC 反向代理
- **下游**：MySQL（用户数据持久化）和 Redis（Session/Token 缓存），Phase 2 就绪
- **同级服务**：与其他 C++ 微服务（如 message-service）通过 bRPC 集群通信
- **组件依赖**：`nova/common.h`（常量与版本）、`nova/config.h`（配置框架）、`nova/logger.h`（日志）、`nova/snowflake.h`（ID 生成）、`user_service_impl.h`（RPC 实现）、`user_dao.h`（数据访问层）

启动命令示例：

```
./nova_user_service --flagfile=conf/user_service.flags
```

健康检查端点：`http://<addr>:8001/status`
