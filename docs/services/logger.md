# NovaChat C++ 日志系统 (`logger.h` / `logger.cpp`)

## 技术职责

`logger.h` 是对 **glog**（Google Logging Library）的宏封装，为 NovaChat 的所有 C++ 微服务提供统一的日志输出接口。`logger.cpp` 为 Phase 3 双缓冲异步日志预留实现空间。

### 日志宏

| 宏 | 级别 | 用途 |
|------|------|------|
| `NOVA_LOG_INFO` | INFO | 关键业务流程和状态变更 |
| `NOVA_LOG_WARN` | WARNING | 可恢复的异常（Redis/MySQL 回退等） |
| `NOVA_LOG_ERROR` | ERROR | 操作失败 |
| `NOVA_LOG_FATAL` | FATAL | 无法恢复的错误（ClockRollback、端口绑定失败）、记录后终止进程 |
| `NOVA_VLOG(n)` | VERBOSE | 详细调试日志（n 越大越详细，生产环境通常关闭） |
| `NOVA_DLOG_INFO` | DEBUG | 仅在 DEBUG 编译模式下输出的日志 |
| `NOVA_DVLOG(n)` | DEBUG VERBOSE | DEBUG 编译模式下的详细日志 |

### 初始化

`InitLogger(service_name)` 在服务 `main()` 中调用，功能包括：
1. 设置 glog 相关信息（日志目录、最小级别）
2. **启用 glog 内置异步缓冲**：`FLAGS_logbufsecs = 30`，日志在内存中缓冲 30 秒后批量刷盘，避免频繁 I/O 阻塞业务线程（Phase 3.3 优化）
3. 记录服务名称用于日志前缀

### Phase 3：双缓冲异步日志

glog 已内置异步缓冲（`--logbufsecs=30`），性能满足 Phase 3 需求。当前 `InitLogger` 自动设置该参数。独立的手工双缓冲实现（Double-Buffering）留作可选优化——如需更细粒度的日志控制（如支持 Protobuf 结构化日志），可在 `logger.cpp` 中扩展。

## 业务角色

在 NovaChat 分布式即时通讯系统中，日志模块是**运维可观测性的基础**：

- **问题排查**：所有服务使用统一的日志宏，日志自动带有服务名称前缀，便于在分布式环境中按服务过滤。
- **性能保护**：`logbufsecs=30` 批量刷盘机制避免高并发下日志 I/O 成为瓶颈。
- **致命错误保障**：`NOVA_LOG_FATAL` 在致命错误（如时钟严重回拨、Worker ID 配置错误）时记录日志并终止进程，防止系统在异常状态下运行。

## 系统连接

- 被所有 C++ 微服务的 `server.cc` 入口调用 `nova::InitLogger("service_name")` 和 `nova::ShutdownLogger()`。
- 所有 NovaChat C++ 源码通过 `NOVA_LOG_*` 宏输出日志（而非直接调用 `LOG(INFO)`）。
- `logger.cpp` 预留了 Phase 3+ 自定义双缓冲实现的空间，接口不变只需替换 `.cpp` 文件内容。
- 与 bRPC 的 `glog` 依赖共用同一个日志基础设施，无需额外配置。
