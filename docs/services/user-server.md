# User Service 服务入口 — `server.cc`

## 技术职责

`server.cc` 是 NovaChat User Service 的**主入口文件**，负责初始化并启动一个 bRPC 服务器。执行流程分为以下阶段：

### 启动流程

```
1. 配置解析 (gflags)
   → port=8001, listen_addr=0.0.0.0, worker_id=1
   → MySQL/Redis 连接参数

2. 日志初始化
   → InitLogger("user_service")
   → 输出版本号、监听地址、Worker ID

3. Snowflake ID 生成器
   → worker_id 校验 (0–1023)
   → Snowflake 实例化 (worker_id=1)

4. DAO 层创建 (UserDao)
   → if --enable_mysql: InitMySql(addr, port, user, passwd, db, pool_size)
   → if --enable_redis: InitRedis(addr, port, password)
   → 任一失败 → 自动回退内存存储
   → 输出日志: "UserDao initialized (user storage: MySQL|in-memory, session storage: Redis|in-memory)"

5. 服务实现绑定
   → UserServiceImpl(&snowflake, &user_dao)
   → server.AddService(&service_impl, SERVER_DOESNT_OWN_SERVICE)

6. 启动监听
   → server.Start(ep, &options)
   → 输出 RPC 端点列表 + 健康检查地址

7. 等待退出信号
   → server.RunUntilAskedToQuit()

8. 优雅关闭 (Phase 3.4)
   → server.Stop(5000) — 排空 5 秒后退出
   → ShutdownLogger()
```

### gflags 配置项

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--port` | 8001 | 监听端口 |
| `--listen_addr` | 0.0.0.0 | 监听地址 |
| `--worker_id` | 1 | Snowflake Worker ID（集群唯一，user-service 固定为 1） |
| `--enable_mysql` | false | 启用 MySQL（用户数据持久化） |
| `--enable_redis` | false | 启用 Redis（Session 缓存） |
| `--mysql_addr` | 127.0.0.1 | MySQL 地址 |
| `--mysql_port` | 3306 | MySQL 端口 |
| `--mysql_db` | novachat | 数据库名 |
| `--mysql_pool_size` | 8 | 连接池大小 |
| `--redis_addr` | 127.0.0.1 | Redis 地址 |
| `--redis_port` | 6379 | Redis 端口 |

### 启动模式

**开发模式**（零外部依赖）：
```bash
./nova_user_service --flagfile=conf/user_service.flags
# 不加 --enable_mysql --enable_redis
# 用户数据: 内存
# Session:  内存
# 密码:     PBKDF2-SHA256
```

**生产模式**（完整持久化）：
```bash
./nova_user_service --flagfile=conf/user_service.flags \
    --enable_mysql --enable_redis
# 用户数据: MySQL (docker-compose 自动建表)
# Session:  Redis (自动 TTL 过期)
# 密码:     PBKDF2-SHA256
```

### 优雅关闭（Phase 3.4）

```cpp
server.Stop(5000);  // 5 秒排空时间
```

`Stop(5000)` 停止接受新连接 → 等待现有请求完成（最多 5 秒）→ 超时后强制关闭。

## 业务角色

在 NovaChat 的 BFF 架构中，User Service 是一个**独立的 C++ 微服务**，部署在端口 **8001**，专门处理所有用户账户相关的操作。对外暴露 **12 个 bRPC 方法**（注册、登录、资料查询、搜索、密码修改、账户注销），不直接面向客户端，由 TypeScript 网关层将 HTTP 请求转换为 bRPC 调用转发过来。

该服务是 NovaChat 用户体系的核心——所有用户身份的创建、认证、信息维护均依赖它。

## 系统连接

- **上游**：TypeScript BFF Gateway（HTTP → bRPC）
- **下游**：MySQL（用户数据持久化）+ Redis（Session 缓存）
- **同级服务**：与 message-service（:8002）通过 bRPC 通信
- **组件依赖**：`nova/common.h`（常量）、`nova/config.h`（配置）、`nova/logger.h`（日志）、`nova/snowflake.h`（ID 生成）、`user_service_impl.h`（RPC 实现）、`user_dao.h`（数据访问层）
- **健康检查**：`http://<addr>:8001/status`（bRPC 内置）
