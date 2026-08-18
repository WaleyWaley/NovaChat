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
        // 自动重连
        bool reconnect = true;
        mysql_options(mysql, MYSQL_OPT_RECONNECT, &reconnect);

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

    // 2. 启动工作线程 (每个连接一个专用 pthread)
    for (int i = 0; i < pool_size; i++) {
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
    (void)worker_id;

    while (running_) {
        Task task;
        {
            std::unique_lock<std::mutex> lock(queue_mu_);
            queue_cv_.wait(lock, [this] {
                return !task_queue_.empty() || !running_;
            });
            if (!running_ && task_queue_.empty()) break;
            task = std::move(task_queue_.front());
            task_queue_.pop();
        }

        // 获取连接 (阻塞等待可用连接)
        MYSQL* conn = AcquireConnection();

        // 同步阻塞执行 SQL (在专用 pthread 上, 不影响 bthread 调度)
        int rc = mysql_real_query(conn, task.sql.c_str(), task.sql.size());

        if (rc != 0) {
            // 查询失败
            *task.result = butil::Status(-1,
                std::string("MySQL error: ") + mysql_error(conn));
        } else if (task.is_query) {
            // SELECT: 读取结果集
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
                    // QueryAll: 收集全部行
                    MYSQL_ROW row;
                    while ((row = mysql_fetch_row(res))) {
                        Row r;
                        for (int i = 0; i < ncols; i++) {
                            r[col_names[i]] = row[i] ? row[i] : "";
                        }
                        task.rows->push_back(std::move(r));
                    }
                } else if (task.row_cb && task.cb_mutex) {
                    // Query with callback
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
            *task.result = butil::Status::OK();
        }

        // 释放连接
        ReleaseConnection(conn);

        // 唤醒等待的 bthread
        task.done->signal();
    }
}

// ============================= Execute =======================================

butil::Status MySqlPool::Execute(const std::string& sql) {
    if (!ready_) return butil::Status(-1, "MySQL pool not initialized");

    butil::Status result;
    bthread::CountdownEvent done(1);

    {
        std::lock_guard<std::mutex> lock(queue_mu_);
        task_queue_.push({sql, false, &result, &done, nullptr, nullptr, nullptr});
    }
    queue_cv_.notify_one();

    // 挂起当前 bthread, 释放 pthread 给其他 bthread 使用
    // Worker pthread 执行完 MySQL 查询后会 signal(), 唤醒此 bthread
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
        task_queue_.push({sql, true, &result, &done, nullptr, &row_cb, &cb_mutex});
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
        task_queue_.push({sql, true, &result, &done, rows, nullptr, nullptr});
    }
    queue_cv_.notify_one();

    done.wait();
    return result;
}

}  // namespace nova
