# Message Service 服务入口 — `server.cc`

## 技术职责

`server.cc` 是 NovaChat Message Service 的**主入口文件**，负责初始化并启动一个 bRPC 服务器。与 user-service 的启动流程对称，但使用 `worker_id=2`（Snowflake 集群唯一标识）。

### 启动流程

```
1. 配置解析 (gflags)
   → port=8002, listen_addr=0.0.0.0, worker_id=2
   → MySQL/Redis 连接参数 (预留)

2. 日志初始化
   → InitLogger("message_service")

3. Snowflake ID 生成器
   → worker_id 校验 + Snowflake 实例化

4. 核心组件创建
   → MessageDao (内存存储)
   → PushDispatcher (直连 gateway:3000)

5. 服务实现绑定
   → MessageServiceImpl(&snowflake, &dao, &push)
   → server.AddService()

6. 启动监听
   → server.Start(ep, &options)
   → RunUntilAskedToQuit()

7. 优雅关闭
   → server.Stop(5000) — 排空 5s 后退出
   → ShutdownLogger()
```

### gflags 配置项

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--port` | 8002 | 监听端口 |
| `--listen_addr` | 0.0.0.0 | 监听地址 |
| `--worker_id` | 2 | Snowflake Worker ID（集群唯一） |
| `--enable_mysql` | false | 启用 MySQL 持久化（Phase 4+） |
| `--enable_redis` | false | 启用 Redis（Phase 4+） |

### PushDispatcher 初始化

```cpp
push.Init("gateway:3000");
```

硬编码网关地址为 Docker 网络中的服务名 `gateway:3000`。PushDispatcher 通过此地址向网关的 PushService 发起 HTTP POST 推送。

### 优雅关闭（Phase 3.4）

```cpp
server.RunUntilAskedToQuit();
server.Stop(5000);  // 5 秒排空时间
```

`Stop(5000)` 的行为：
1. 停止接受新连接
2. 等待现有请求完成（最多 5 秒）
3. 超时后强制关闭

### 启动命令

```bash
./nova_message_service --flagfile=conf/message_service.flags
```

## 业务角色

在 NovaChat 的 BFF 架构中，Message Service 是一个**独立的 C++ 微服务**，部署在端口 **8002**，专门处理所有消息相关的操作：

1. **消息发送**：接收客户端请求 → 生成 Snowflake ID → 存储 → 推送
2. **历史查询**：Timeline 分页拉取历史消息
3. **消息确认**：ACK 确认送达/已读
4. **同步状态**：上线时增量同步多对话状态

该服务不直接面向客户端，由 TypeScript 网关将 WebSocket 请求转换为 bRPC 调用转发过来。

## 系统连接

- **上游**：TypeScript BFF Gateway（WebSocket → HTTP POST → `/nova.message.MessageService/*`）
- **下游**：当前为内存存储（MessageDao），Phase 4+ 可接入 MySQL/Redis
- **推送**：PushDispatcher → HTTP → 网关 PushService → WebSocket → 用户
- **同级服务**：与 user-service（:8001）通过 bRPC 集群通信
- **组件依赖**：`nova/common.h`（常量）、`nova/config.h`（配置）、`nova/logger.h`（日志）、`nova/snowflake.h`（ID 生成）、`message_service_impl.h`（RPC 实现）、`message_dao.h`（数据访问层）、`push_dispatcher.h`（推送分发）
- **健康检查**：`http://<addr>:8002/status`（bRPC 内置）

### Docker Compose 中的配置

```yaml
message-service:
  image: novachat:latest
  command: nova_message_service
  ports: ["8002:8002"]
  depends_on: [mysql, redis]
  restart: unless-stopped
```
