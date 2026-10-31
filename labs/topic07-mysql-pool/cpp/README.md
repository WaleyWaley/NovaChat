# 实验 07：MySQL 连接池 + 专用工作线程（C++ 版）

## 目标

手写一个 **MySQL 连接池 + 工作线程池**，理解 NovaChat 后端最关键的一个并发模式：

> **`mysql_real_query()` 是同步阻塞的。如果在业务线程上直接调用，业务线程会被 DB I/O 卡住。解决办法：把阻塞调用甩给专用工作线程，业务线程只提交任务并等待完成。**

对应 NovaChat 真实代码：`services/common/include/nova/mysql_pool.h`。

## 对照关系

| 原版（NovaChat） | 本 lab（无 bRPC 环境） |
|---|---|
| bthread 业务协程 | 调用线程（`main` 里用 `std::thread` 模拟） |
| 专用 pthread 工作线程 | `std::thread` worker |
| `bthread::CountdownEvent` | `std::latch`（C++20） |
| `mysql_real_query` 阻塞 | 同样是 `mysql_real_query`（**真实 MySQL**） |
| 连接池 + 任务队列 | 相同设计 |

> 原版之所以用 bthread，是因为业务跑在协程里、不能阻塞 pthread。本 lab 用普通线程模拟"业务侧"，重点是体会**阻塞 I/O 必须隔离到专用线程**这个工程结论。

## 前置：启动本地 MySQL

lab 自带一个脚本，会用一个**独立数据目录**起一个本地 MySQL 实例（端口 3307，root 免密），不碰系统里已有的 MySQL 数据：

```powershell
cd labs/topic07-mysql-pool/cpp
powershell -ExecutionPolicy Bypass -File start_mysql.ps1
```

首次会初始化数据目录，之后复用。想停掉：

```powershell
powershell -ExecutionPolicy Bypass -File stop_mysql.ps1
```

> 如果你的 MySQL 不在默认路径，加 `-MysqlRoot "你的路径"`。

## 文件结构

```
cpp/
├── start_mysql.ps1 / stop_mysql.ps1   # MySQL 生命周期
├── build.ps1                          # g++ 编译 (链接 libmysqlclient)
├── mini_mysql_pool.h                  # 接口 + 内部结构
├── mini_mysql_pool.cc                 # ★ 你要实现的 TODO
└── main.cc                            # 测试入口 (已提供)
```

## 编译运行

```powershell
powershell -ExecutionPolicy Bypass -File build.ps1
.\topic07_mysql_pool.exe
```

`build.ps1` 会自动把 `libmysql.dll` 复制到当前目录，运行时无需改 PATH。

当前骨架会因 TODO 抛异常；实现后应输出 `9 passed, 0 failed`。

## 你要实现的部分（mini_mysql_pool.cc）

### 1. `init(host, port, user, passwd, db, pool_size)`

- 建立 `pool_size` 条 MySQL 连接（`mysql_init` → `mysql_real_connect` → `mysql_set_character_set`）
- 启动 `pool_size` 个 worker 线程，每个绑定一条连接（`connections_[worker_id]`）

### 2. `worker_loop(worker_id)`（核心：生产者-消费者）

```
while (true) {
    wait 直到队列非空 或 正在关闭
    若 队列空 且 关闭 -> break
    取出一个 task
    run_task(conn, *task)     // 阻塞的 mysql_real_query 在这里执行
    task->done.count_down()   // 唤醒 submit() 里等待的调用线程
}
```

### 3. `run_task(conn, task)`

- `mysql_real_query(...)` 执行 SQL
- 若是查询：`mysql_store_result` → 遍历 `mysql_fetch_row` 填 `task.rows`
- 否则：`mysql_affected_rows` 填 `task.affected`

### 4. `submit(task)`

```
加锁 push 到 task_queue_ -> 解锁
queue_cv_.notify_one()
task->done.wait()          // 阻塞直到 worker 执行完
return task
```

### 5. `execute` / `execute_affected` / `query`

构造 `Task`（设置 `is_query`），`submit`，然后读结果。

### 6. 析构函数

`running_ = false` → `notify_all` → join 所有 worker → `mysql_close` 所有连接。

## 测试覆盖（main.cc）

| 用例 | 验证点 |
|---|---|
| 1. init | `is_ready`、`pool_size == 4` |
| 2. 建表 | DROP / CREATE |
| 3. 并发插入 | 20 线程 × 10 条 = 200 条全成功 |
| 4. 校验行数 | `COUNT == 200` |
| 5. 并发查询 | 40 线程并发 SELECT 全部正确 |
| 6. 并发上限 | pool_size=4，20 × `SELECT SLEEP(0.2)` ≈ **1030ms** |
| 7. 对比 | pool_size=20，同样 20 个 ≈ **216ms** |

用例 6/7 是关键：它直观展示了"连接池大小 = 并发上限"。`pool_size=4` 时 20 个慢查询只能 4 个 4 个地跑，所以是 ~5×0.2s；`pool_size=20` 时全并发，~0.2s。

## 关键工程点

1. **每条连接只被一个 worker 使用**：MySQL 连接不是线程安全的，不能两个线程同时用一条连接。用 `connections_[worker_id]` 保证独占。
2. **锁内只操作队列，不在锁内跑 SQL**：`worker_loop` 取任务时短暂持锁，`run_task` 在锁外执行。
3. **`std::latch` 对应 `bthread::CountdownEvent`**：worker 完成后 `count_down()`，`submit` 里 `wait()`。这是一次性的"等一个任务完成"。
4. **优雅关闭**：`running_ = false` + `notify_all` 唤醒所有 worker，worker 处理完剩余队列后退出，再 join。

## 思考题（面试 Q&A）

1. 为什么 `mysql_real_query` 不能直接在业务线程/协程上调用？
2. 原版为什么用 `bthread::CountdownEvent` 而不是 mutex+condition_variable？它和 `std::latch` 有什么共同点？
3. 为什么连接的个数要等于 worker 的个数？多于/少于会怎样？
4. `worker_loop` 里为什么必须在锁外调用 `run_task`？如果在锁内会怎样？
5. 关闭时如果队列里还有任务，你的实现会丢弃还是执行完？两种策略各适合什么场景？
6. 如果某个 worker 的 SQL 永久卡住（比如锁等待），会对池造成什么影响？怎么缓解？

## 完成后对比

- `services/common/include/nova/mysql_pool.h`
- `services/common/src/mysql_pool.cpp`
