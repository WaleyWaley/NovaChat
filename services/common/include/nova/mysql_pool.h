#pragma once

// =============================================================================
// NovaChat — MySQL 连接池 (Phase 3: libmysqlclient + 线程池)
//
// 设计要点:
//   - bthread 是用户态协程, libmysqlclient 的 mysql_real_query() 是同步阻塞的
//   - 如果在 bthread 中直接调用, 会阻塞整个 pthread (影响所有同线程 bthread)
//   - 解决: 连接池 + 专用 pthread 线程池
//     - bthread 将 SQL 提交到任务队列后, CountdownEvent::wait() 挂起自身
//     - 专用 pthread 执行 mysql_real_query() (阻塞不影响 bthread 调度)
//     - 执行完毕后 signal() 唤醒 bthread, 返回结果
//
// 使用:
//   MySqlPool pool;
//   pool.Init("127.0.0.1", 3306, "root", "pass", "novachat", 8);
//   pool.Execute("INSERT INTO users VALUES (...)");        // 写操作
//   pool.QueryAll("SELECT * FROM users", &rows);          // 读操作
// =============================================================================

#include <vector>
#include <atomic>
#include <string>
#include <functional>
#include <memory>
#include <thread>
#include <mutex>
#include <condition_variable>
#include <queue>
#include <map>

#include <butil/status.h>
#include <bthread/countdown_event.h>
#include <mysql/mysql.h>

namespace nova {

using Row = std::map<std::string, std::string>;

class MySqlPool {
public:
    MySqlPool() = default;
    ~MySqlPool();

    MySqlPool(const MySqlPool&) = delete;
    MySqlPool& operator=(const MySqlPool&) = delete;

    // 初始化连接池
    // pool_size: MySQL 连接数 = 专用 pthread 数
    bool Init(const std::string& addr, int port,
              const std::string& user, const std::string& passwd,
              const std::string& db, int pool_size = 8);

    // 执行写操作 (INSERT / UPDATE / DELETE)
    butil::Status Execute(const std::string& sql);

    // 执行查询 (SELECT)
    // row_cb: 每行结果回调
    butil::Status Query(const std::string& sql,
                        std::function<void(const Row&)> row_cb);

    // 查询并返回所有行
    butil::Status QueryAll(const std::string& sql, std::vector<Row>* rows);

    bool IsReady() const { return ready_; }
    const std::string& Database() const { return db_; }

private:
    // 任务定义
    struct Task {
        std::string sql;
        bool is_query;
        butil::Status* result;
        bthread::CountdownEvent* done;
        // 查询结果
        std::vector<Row>* rows;           // QueryAll 用
        std::function<void(const Row&)>* row_cb;  // Query 回调
        std::mutex* cb_mutex;             // 回调线程安全锁
    };

    // 获取一个空闲连接 (阻塞直到有可用连接)
    MYSQL* AcquireConnection();
    void ReleaseConnection(MYSQL* conn);

    // 工作线程: 从队列取任务, 执行同步 MySQL 调用, 完成后唤醒 bthread
    void WorkerThread(int worker_id);

    // 连接管理
    struct ConnEntry {
        MYSQL* mysql;
        bool in_use = false;
    };
    std::vector<ConnEntry> connections_;
    std::mutex conn_mu_;
    std::condition_variable conn_cv_;

    // 任务队列 + 线程池
    std::queue<Task> task_queue_;
    std::mutex queue_mu_;
    std::condition_variable queue_cv_;
    std::vector<std::thread> workers_;
    std::atomic<bool> running_{true};

    std::string db_;
    bool ready_ = false;
};

}  // namespace nova
