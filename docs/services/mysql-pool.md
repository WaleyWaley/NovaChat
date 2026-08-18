# NovaChat MySQL 连接池 (`mysql_pool.h` / `mysql_pool.cpp`)

## 技术职责

`MySqlPool` 类是对 **MySQL C API** 的线程池封装，为 NovaChat 的 C++ 微服务提供关系型数据库访问能力。采用 **专用 pthread 工作线程 + CountdownEvent 同步** 的设计，避免 MySQL 的阻塞 I/O 影响 bthread 协程调度。

### 核心设计

```
业务 bthread                    Worker pthread (N 个)
────────────                    ──────────────────
Execute(sql)
  ├─ 构造 Task { sql, type, countdown_event }
  ├─ 推入任务队列 (task_queue_)
  └─ event.Wait()               WorkerThread():
                                     ├─ 从队列取任务
                                     ├─ mysql_real_query()   ← 阻塞 I/O (在 pthread 上)
                                     ├─ 解析结果集 (列计数 → 列定义 → 数据行)
                                     ├─ 回调 row_cb() / 存储到 rows_
                                     └─ event.Signal()       ← 唤醒等待的 bthread
         ← bthread 被唤醒
         读取结果
```

### 连接池

```cpp
std::vector<MYSQL*> connections_;  // N 个 MySQL 连接
// Round-robin 分发:
size_t idx = rr_idx_.fetch_add(1) % pool_size_;
MYSQL* conn = connections_[idx];
```

默认 8 个连接，通过 `std::atomic<size_t>` 实现无锁 Round-Robin 分发。

### 主要接口

| 方法 | 用途 | 实现 |
|------|------|------|
| `Init(addr, port, user, passwd, db, pool_size)` | 初始化连接池 | 创建 N 个 MYSQL 连接（UTF-8 字符集）+ 启动 N 个 pthread 工作线程 |
| `Execute(sql)` | 执行写操作（INSERT/UPDATE/DELETE） | 返回 `butil::Status`（成功或携带错误信息） |
| `Query(sql, row_cb)` | 执行 SELECT 查询，每行回调 | `row_cb` 在 pthread 上下文中执行 |
| `QueryAll(sql, rows)` | 便捷方法，一次性收集所有行 | `Row` = `map<string, string>`（列名 → 列值） |

### 响应解析

MySQL 文本协议返回格式：

```
2                           ← 列数
user_id\t...\t...\n         ← 列定义 (每列一行, Tab 分隔)
username\t...\t...\n
123456\talice\n              ← 数据行 (Tab 分隔)
789012\tbob\n
EOF\t                        ← 结束标记
```

解析流程：列数 → 跳过列定义 → 解析数据行（Tab 分隔）→ 跳过 EOF → 构造 `Row` 对象。

### 为什么用专用 pthread 而不是 bthread？

MySQL C API (`libmysqlclient`) 的 `mysql_real_query()` 是**阻塞 I/O**，不兼容 bRPC 的 bthread 协程模型。如果在 bthread 上直接调用，会阻塞整个 pthread 工作线程，导致其他协程饥饿。

解决：将阻塞的 MySQL 操作放到独立的 `std::thread`（pthread）上执行，通过 `butil::CountdownEvent` 实现 bthread ↔ pthread 之间的同步通知。

## 业务角色

在 NovaChat 系统中，MySQL 用于持久化存储**关系型数据**：

- **用户数据**：用户账号、个人资料（用户名、头像、Bio 等）→ `users` 表
- **消息记录**（Phase 4+）：聊天消息的持久化存储，支持历史消息查询 → `messages` 表

连接池是数据库访问的基础设施层。在高并发 IM 场景下，每个请求不应独立创建/销毁 MySQL 连接，连接池统一管理连接生命周期。

## 系统连接

- **依赖于 `logger` 模块**：所有操作记录日志。
- **依赖于 MySQL C API** (`libmysqlclient`)：编译链接 `mysqlclient` 库。
- **被业务 DAO 层使用**：`UserDao` 用于读写用户表，所有 SQL 操作通过 `MySqlPool` 执行。
- **与 Snowflake 配合**：Snowflake 生成的 ID 作为 MySQL 表的主键（`BIGINT UNSIGNED`）。
- **SQL Schema**：`scripts/docker/init.sql` 定义了 `users` 和 `messages` 建表语句，docker-compose 启动时自动执行。
