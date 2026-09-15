// =============================================================================
// NovaChat — MySQL 连接池实现 (Phase 3: libmysqlclient + 线程池)
//
// 架构:
//   ┌─────────────┐     ┌──────────────────┐     ┌──────────┐
//   │  bthread    │     │  Worker pthreads │     │  MySQL   │
//   │  (协程)     │────→│  (每个一个连接)   │────→│  Server  │
//   │             │←────│                  │←────│          │
//   │  wait()+    │     │  mysql_real_     │     │          │
//   │  yield()    │     │  query() 阻塞    │     │          │
//   └─────────────┘     └──────────────────┘     └──────────┘
//
// bthread 安全: CountdownEvent::wait() 挂起 bthread (释放 pthread)
//               signal() 唤醒 bthread 继续执行
// =============================================================================

#include "nova/mysql_pool.h"
#include "nova/logger.h"

#include <mysql/errmsg.h>

#include <sstream>
#include <cstring>
#include <chrono>

namespace nova {

// ============================= 析构 ==========================================

MySqlPool::~MySqlPool() {
    running_ = false;
    queue_cv_.notify_all();
    conn_cv_.notify_all();

    for (auto& w : workers_) {
        if (w.joinable()) w.join();
    }

    for (auto& c : connections_) {
        if (c.mysql) {
            mysql_close(c.mysql);
            c.mysql = nullptr;
        }
    }
}

// ============================= 初始化 ========================================

bool MySqlPool::Init(const std::string& addr, int port,
                     const std::string& user, const std::string& passwd,
                     const std::string& db, int pool_size) {
    if (pool_size <= 0) pool_size = 1;
    if (pool_size > 64) pool_size = 64;

    db_ = db;
    // 保存连接参数: 探活失败重建连接时用
    addr_ = addr; port_ = port; user_ = user; passwd_ = passwd;

    // 1. 创建所有 MySQL 连接
    for (int i = 0; i < pool_size; i++) {
        MYSQL* mysql = mysql_init(nullptr);
        if (!mysql) {
            NOVA_LOG_ERROR << "MySqlPool: mysql_init failed for connection " << i;
            return false;
        }

        // 设置连接选项
        unsigned int timeout = 5;
        mysql_options(mysql, MYSQL_OPT_CONNECT_TIMEOUT, &timeout);
        mysql_options(mysql, MYSQL_OPT_READ_TIMEOUT, &timeout);

        // 注意: 不开启 MYSQL_OPT_RECONNECT —
        //   1) 该选项 8.0.34 起弃用, 8.4 起不生效
        //   2) 静默重连会丢失会话状态 (如 utf8mb4 字符集) 且使 prepared
        //      statement 句柄失效 (官方文档明确警告二者不兼容)
        //   探活改由 AcquireConnection 的 mysql_ping 显式完成。

        MYSQL* conn = mysql_real_connect(
            mysql, addr.c_str(), user.c_str(), passwd.c_str(),
            db.c_str(), port, nullptr, 0);

        if (!conn) {
            NOVA_LOG_ERROR << "MySqlPool: mysql_real_connect failed for connection "
                           << i << ": " << mysql_error(mysql);
            mysql_close(mysql);
            return false;
        }

        // 设置 UTF-8
        mysql_set_character_set(conn, "utf8mb4");

        connections_.push_back({conn, false});
    }

    NOVA_LOG_INFO << "MySqlPool: " << pool_size << " connections established to "
                  << addr << ":" << port << "/" << db;

    // 2. 启动pool_size个 std::thread(pthread) WorkerThread
    // 1 个 pthread worker 最多同时持有 1 条 mysql 连接，pool_size 个 pthread worker 就是 pool_size 条 mysql 连接
    for (int i = 0; i < pool_size; i++) {
        // 调用成员函数需要显示传入 this 指针
        workers_.emplace_back(&MySqlPool::WorkerThread, this, i);
    }

    ready_ = true;
    NOVA_LOG_INFO << "MySqlPool: Thread pool started (" << pool_size << " workers)";
    return true;
}

// ============================= 连接管理 ======================================

MYSQL* MySqlPool::AcquireConnection() {
    std::unique_lock<std::mutex> lock(conn_mu_);
    conn_cv_.wait(lock, [this] {
        for (auto& c : connections_) {
            if (!c.in_use) return true;
        }
        return false;
    });

    for (auto& c : connections_) {
        if (!c.in_use) {
            // 探活: 连接空闲超过 MySQL wait_timeout (默认 8h) 会被服务端杀掉,
            // 第一条查询会报 "server has gone away"。ping 失败则显式重建
            // (重建后重新设置字符集 — 禁用自动重连后必须手动兜底)。
            if (mysql_ping(c.mysql) != 0) {
                NOVA_LOG_WARN << "MySqlPool: connection lost, reconnecting...";
                MYSQL* nc = mysql_real_connect(
                    c.mysql, addr_.c_str(), user_.c_str(), passwd_.c_str(),
                    db_.c_str(), port_, nullptr, 0);
                if (!nc) {
                    NOVA_LOG_ERROR << "MySqlPool: reconnect failed: "
                                   << mysql_error(c.mysql);
                } else {
                    mysql_set_character_set(nc, "utf8mb4");
                }
            }
            c.in_use = true;
            return c.mysql;
        }
    }
    return nullptr;  // unreachable
}

void MySqlPool::ReleaseConnection(MYSQL* conn) {
    std::lock_guard<std::mutex> lock(conn_mu_);
    for (auto& c : connections_) {
        if (c.mysql == conn) {
            c.in_use = false;
            conn_cv_.notify_one();
            return;
        }
    }
}

// ============================= 工作线程 ======================================

void MySqlPool::WorkerThread(int worker_id) {
    (void)worker_id;    // 暂时没用到编号，避免编译器警告
    
    while (running_) {
        Task task;
        // 锁开始
        {   
            std::unique_lock<std::mutex> lock(queue_mu_);
            // 队伍不为空或者线程池不运行就释放锁
            queue_cv_.wait(lock, [this] {
                return !task_queue_.empty() || !running_;
            });
            if (!running_ && task_queue_.empty()) break;
            task = std::move(task_queue_.front());
            task_queue_.pop();
        } // 锁释放

        // 获取连接 (阻塞等待可用连接)
        MYSQL* conn = AcquireConnection();

        if (task.params) {
            // 参数化路径: mysql_stmt_prepare/bind/execute (防 SQL 注入)
            ExecutePreparedTask(conn, task);
        } else {
        // 同步阻塞执行 SQL (在专用 pthread 上, 不影响 bthread 调度)
        int rc = mysql_real_query(conn, task.sql.c_str(), task.sql.size());

        if (rc != 0) {
            // 查询失败
            *task.result = butil::Status(-1,
                std::string("MySQL error: ") + mysql_error(conn));
        } else if (task.is_query) {
            // SELECT: 读取结果集
            // 此刻：所有select返回的数据，已经全部在你的nova程序进程内存里了！
            MYSQL_RES* res = mysql_store_result(conn);
            if (!res) {
                *task.result = butil::Status(-1,
                    std::string("mysql_store_result failed: ") + mysql_error(conn));
            } else {
                int ncols = mysql_num_fields(res);
                MYSQL_FIELD* fields = mysql_fetch_fields(res);

                std::vector<std::string> col_names;
                for (int i = 0; i < ncols; i++) {
                    col_names.push_back(fields[i].name);
                }

                // 解析所有行
                if (task.rows) {
                    // 方式 A: QueryAll: 收集全部行到vector
                    MYSQL_ROW row;
                    while ((row = mysql_fetch_row(res))) {  //循环取行，NULL表示取完
                        Row r;  
                        for (int i = 0; i < ncols; i++) {
                            r[col_names[i]] = row[i] ? row[i] : "";
                        }
                        task.rows->push_back(std::move(r));
                    }
                } else if (task.row_cb && task.cb_mutex) {
                    // 方式 B: Query —— 每行调一次回调(流式,内存友好)
                    MYSQL_ROW row;
                    while ((row = mysql_fetch_row(res))) {
                        Row r;
                        for (int i = 0; i < ncols; i++) {
                            r[col_names[i]] = row[i] ? row[i] : "";
                        }
                        {
                            std::lock_guard<std::mutex> cb_lock(*task.cb_mutex);
                            (*task.row_cb)(r);
                        }
                    }
                }

                mysql_free_result(res);
                *task.result = butil::Status::OK();
            }
        } else {
            // INSERT/UPDATE/DELETE: 成功
            // Phase 4: 默认语义 (未设置 CLIENT_FOUND_ROWS) — 实际变更的行数
            if (task.affected) *task.affected = mysql_affected_rows(conn);
            *task.result = butil::Status::OK();
        }
        }   // else (非参数化路径) 结束

        // 释放连接
        ReleaseConnection(conn);    // 标记连接空闲，notify 等待者

        // 关键：pthread 唤醒等待的 bthread
        task.done->signal();            
    }
}

// ============================= 参数化执行 ======================================

void MySqlPool::ExecutePreparedTask(MYSQL* conn, const Task& task) {
    MYSQL_STMT* stmt = mysql_stmt_init(conn);
    if (!stmt) {
        *task.result = butil::Status(-1,
            std::string("mysql_stmt_init failed: ") + mysql_error(conn));
        return;
    }

    // --- 1. prepare: SQL 结构固定, 用户数据一律 ? 占位 ---
    if (mysql_stmt_prepare(stmt, task.sql.c_str(), task.sql.size()) != 0) {
        *task.result = butil::Status(-mysql_stmt_errno(stmt),
            std::string("MySQL prepare error: ") + mysql_stmt_error(stmt));
        mysql_stmt_close(stmt);
        return;
    }

    // --- 2. 参数缓冲区先落定 (vector 扩容会使指针失效, 两遍式构造) ---
    std::vector<std::string> str_bufs;
    std::vector<int64_t> i64_bufs;
    str_bufs.reserve(task.params->size());
    i64_bufs.reserve(task.params->size());
    for (const auto& p : *task.params) {
        if (std::holds_alternative<std::string>(p)) {
            str_bufs.push_back(std::get<std::string>(p));
        } else {
            i64_bufs.push_back(std::get<int64_t>(p));
        }
    }

    std::vector<MYSQL_BIND> binds;
    size_t si = 0, ii = 0;
    for (const auto& p : *task.params) {
        MYSQL_BIND b{};
        if (std::holds_alternative<std::string>(p)) {
            b.buffer_type = MYSQL_TYPE_STRING;
            b.buffer = str_bufs[si].data();
            b.buffer_length = str_bufs[si].size();
            si++;
        } else {
            b.buffer_type = MYSQL_TYPE_LONGLONG;
            b.buffer = &i64_bufs[ii];
            b.is_unsigned = true;   // schema 中 ID/时间戳列均为 BIGINT UNSIGNED
            ii++;
        }
        binds.push_back(b);
    }
    if (!binds.empty() && mysql_stmt_bind_param(stmt, binds.data()) != 0) {
        *task.result = butil::Status(-mysql_stmt_errno(stmt),
            std::string("MySQL bind_param error: ") + mysql_stmt_error(stmt));
        mysql_stmt_close(stmt);
        return;
    }

    // --- 3. execute ---
    if (mysql_stmt_execute(stmt) != 0) {
        // 错误码 = -errno: 调用方据此区分 (如 -1062 唯一键冲突 = 重复)
        *task.result = butil::Status(-mysql_stmt_errno(stmt),
            std::string("MySQL execute error: ") + mysql_stmt_error(stmt));
        mysql_stmt_close(stmt);
        return;
    }

    // --- 4. 结果处理 ---
    if (task.is_query) {
        MYSQL_RES* meta = mysql_stmt_result_metadata(stmt);
        if (!meta) {
            *task.result = butil::Status(-1,
                "mysql_stmt_result_metadata failed (statement has no result set?)");
            mysql_stmt_close(stmt);
            return;
        }
        int ncols = mysql_num_fields(meta);
        MYSQL_FIELD* fields = mysql_fetch_fields(meta);

        std::vector<std::string> col_names;
        for (int i = 0; i < ncols; i++) col_names.push_back(fields[i].name);

        // 每列定长文本缓冲: 本库最大列为 VARCHAR(4096)×4B(utf8mb4) = 16KB, 64KB 充裕
        constexpr unsigned long kBufSize = 64 * 1024;
        std::vector<std::vector<char>> bufs(ncols, std::vector<char>(kBufSize));
        std::vector<unsigned long> lengths(ncols);
        // 注意: MySQL 8.0 起 MYSQL_BIND.is_null 是 bool* (my_bool 已移除),
        // 且不能用 vector<bool> (位压缩无法取址), 用堆数组
        std::unique_ptr<bool[]> is_null(new bool[ncols]);
        std::vector<MYSQL_BIND> rb(ncols);
        for (int i = 0; i < ncols; i++) {
            rb[i].buffer_type = MYSQL_TYPE_STRING;   // 统一按文本取 (Row = map<string,string>)
            rb[i].buffer = bufs[i].data();
            rb[i].buffer_length = kBufSize;
            rb[i].length = &lengths[i];
            rb[i].is_null = &is_null[i];
        }
        if (mysql_stmt_bind_result(stmt, rb.data()) != 0) {
            *task.result = butil::Status(-1,
                std::string("mysql_stmt_bind_result failed: ") + mysql_stmt_error(stmt));
            mysql_free_result(meta);
            mysql_stmt_close(stmt);
            return;
        }
        if (mysql_stmt_store_result(stmt) != 0) {
            *task.result = butil::Status(-1,
                std::string("mysql_stmt_store_result failed: ") + mysql_stmt_error(stmt));
            mysql_free_result(meta);
            mysql_stmt_close(stmt);
            return;
        }

        while (mysql_stmt_fetch(stmt) == 0) {
            Row r;
            for (int i = 0; i < ncols; i++) {
                r[col_names[i]] = is_null[i] ? "" : std::string(bufs[i].data(), lengths[i]);
            }
            if (task.rows) {
                task.rows->push_back(std::move(r));
            } else if (task.row_cb && task.cb_mutex) {
                std::lock_guard<std::mutex> cb_lock(*task.cb_mutex);
                (*task.row_cb)(r);
            }
        }
        mysql_free_result(meta);
        *task.result = butil::Status::OK();
    } else {
        if (task.affected) *task.affected = mysql_stmt_affected_rows(stmt);
        *task.result = butil::Status::OK();
    }

    mysql_stmt_close(stmt);
}

// ============================= Execute =======================================

butil::Status MySqlPool::Execute(const std::string& sql) {
    if (!ready_) return butil::Status(-1, "MySQL pool not initialized");

    butil::Status result;
    bthread::CountdownEvent done(1);

    {
        std::lock_guard<std::mutex> lock(queue_mu_);
        task_queue_.push({sql, false, &result, &done, nullptr, nullptr, nullptr, nullptr, nullptr});
    }
    // 唤醒一个等待的 Worker 线程
    queue_cv_.notify_one();

    // 挂起当前 bthread, 释放 pthread 给其他 bthread 使用
    // Worker pthread 执行完 MySQL 查询后会 signal(), 唤醒此 bthread
    done.wait();

    return result;
}

// ============================= ExecuteAffected ===============================

butil::Status MySqlPool::ExecuteAffected(const std::string& sql, int64_t* affected) {
    if (!ready_) return butil::Status(-1, "MySQL pool not initialized");

    if (affected) *affected = 0;  // 失败时保持 0, 防止调用方误读为"0 行受影响"

    butil::Status result;
    bthread::CountdownEvent done(1);

    {
        std::lock_guard<std::mutex> lock(queue_mu_);
        task_queue_.push({sql, false, &result, &done, nullptr, nullptr, nullptr, affected, nullptr});
    }
    queue_cv_.notify_one();

    done.wait();

    return result;
}

// ============================= Query =========================================

butil::Status MySqlPool::Query(const std::string& sql,
                               std::function<void(const Row&)> row_cb) {
    if (!ready_) return butil::Status(-1, "MySQL pool not initialized");

    butil::Status result;
    bthread::CountdownEvent done(1);
    std::mutex cb_mutex;  // 保护回调的线程安全

    {
        std::lock_guard<std::mutex> lock(queue_mu_);
        task_queue_.push({sql, true, &result, &done, nullptr, &row_cb, &cb_mutex, nullptr, nullptr});
    }
    queue_cv_.notify_one();

    done.wait();
    return result;
}

// ============================= QueryAll ======================================

butil::Status MySqlPool::QueryAll(const std::string& sql,
                                  std::vector<Row>* rows) {
    if (!ready_) return butil::Status(-1, "MySQL pool not initialized");

    butil::Status result;
    bthread::CountdownEvent done(1);

    {
        std::lock_guard<std::mutex> lock(queue_mu_);
        task_queue_.push({sql, true, &result, &done, rows, nullptr, nullptr, nullptr, nullptr});
    }
    queue_cv_.notify_one();

    done.wait();
    return result;
}

// ============================= 参数化公共接口 =================================

butil::Status MySqlPool::ExecutePrepared(const std::string& sql,
                                         const std::vector<SqlParam>& params) {
    if (!ready_) return butil::Status(-1, "MySQL pool not initialized");

    butil::Status result;
    bthread::CountdownEvent done(1);

    {
        std::lock_guard<std::mutex> lock(queue_mu_);
        task_queue_.push({sql, false, &result, &done, nullptr, nullptr, nullptr, nullptr, &params});
    }
    queue_cv_.notify_one();
    done.wait();
    return result;
}

butil::Status MySqlPool::ExecutePreparedAffected(const std::string& sql,
                                                 const std::vector<SqlParam>& params,
                                                 int64_t* affected) {
    if (!ready_) return butil::Status(-1, "MySQL pool not initialized");

    if (affected) *affected = 0;  // 失败时保持 0, 防止调用方误读为"0 行受影响"

    butil::Status result;
    bthread::CountdownEvent done(1);

    {
        std::lock_guard<std::mutex> lock(queue_mu_);
        task_queue_.push({sql, false, &result, &done, nullptr, nullptr, nullptr, affected, &params});
    }
    queue_cv_.notify_one();
    done.wait();
    return result;
}

butil::Status MySqlPool::QueryAllPrepared(const std::string& sql,
                                          const std::vector<SqlParam>& params,
                                          std::vector<Row>* rows) {
    if (!ready_) return butil::Status(-1, "MySQL pool not initialized");

    butil::Status result;
    bthread::CountdownEvent done(1);

    {
        std::lock_guard<std::mutex> lock(queue_mu_);
        task_queue_.push({sql, true, &result, &done, rows, nullptr, nullptr, nullptr, &params});
    }
    queue_cv_.notify_one();
    done.wait();
    return result;
}

}  // namespace nova
