# 实验 07：MySQL 连接池 + 专用工作线程

对应 NovaChat 的：

- `services/common/include/nova/mysql_pool.h`
- `services/common/src/mysql_pool.cpp`

## 背景

业务代码跑在 bRPC 的 **bthread（协程）** 里，而 `libmysqlclient` 的 `mysql_real_query()` 是**同步阻塞**调用。

如果在 bthread 里直接调用 MySQL，会阻塞整条 pthread，拖垮同线程上的所有协程。

NovaChat 的解法：

```
bthread(业务)  --提交 SQL-->  任务队列  -->  专用 pthread(Worker)  --mysql_real_query--> MySQL
     |                                              |
     +--- CountdownEvent.wait() (挂起自己) <--- signal() (执行完唤醒)
```

本实验让你用 **真实 MySQL** 亲手实现这套连接池。

## 目录

- `cpp/` — C++ 版（真实 MySQL + 连接池 + 工作线程）

## 双语言说明

本专题只做 C++。它是纯后端并发/数据库主题，TS 侧没有对应实现。

## 开始学习

进入 `cpp/`，按 `cpp/README.md` 操作（先跑 `start_mysql.ps1`）。

## 完成后你会掌握

- 连接池 + 任务队列 + 工作线程的完整设计
- 阻塞 I/O 为什么必须隔离到专用线程
- `CountdownEvent` / `latch` 这种"一次性同步"原语的用途
- 用 `SELECT SLEEP(n)` 暴露"池大小 = 并发上限"的工程直觉
