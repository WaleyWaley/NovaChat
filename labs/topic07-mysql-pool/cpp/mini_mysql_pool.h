#pragma once

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <latch>
#include <map>
#include <memory>
#include <mutex>
#include <queue>
#include <string>
#include <thread>
#include <vector>

#include <mysql.h>

namespace lab {

using Row = std::map<std::string, std::string>;
using Rows = std::vector<Row>;

/**
 * MySQL 连接池 + 专用工作线程池。
 *
 * 设计动机 (对照 NovaChat 的 services/common/include/nova/mysql_pool.h):
 *   - libmysqlclient 的 mysql_real_query() 是同步阻塞调用。
 *   - 如果在"业务线程"上直接调用, 该线程会被 DB I/O 卡住。
 *   - 解决: 把阻塞调用甩给专用工作线程 (pthread), 业务线程只提交任务 + 等待完成。
 *
 * 对应关系:
 *   - bthread 业务协程        -> 本 lab 里的"调用线程" (main 里用 std::thread 模拟)
 *   - 专用 pthread 工作线程    -> std::thread worker
 *   - bthread::CountdownEvent -> std::latch done{1}
 *
 * 结构: pool_size 个 MySQL 连接 == pool_size 个 worker 线程 (每个 worker 独占一条连接)。
 */
class MiniMySqlPool {
 public:
    MiniMySqlPool() = default;
    ~MiniMySqlPool();

    MiniMySqlPool(const MiniMySqlPool&) = delete;
    MiniMySqlPool& operator=(const MiniMySqlPool&) = delete;

    /**
     * 初始化: 建立 pool_size 条连接 + 启动 pool_size 个 worker。
     * @return 是否成功
     */
    bool init(const std::string& host, int port,
              const std::string& user, const std::string& passwd,
              const std::string& db, int pool_size = 4);

    bool is_ready() const { return ready_; }
    int pool_size() const { return static_cast<int>(workers_.size()); }

    /** 执行写操作 (INSERT/UPDATE/DELETE), 返回是否成功 */
    bool execute(const std::string& sql);

    /** 执行写操作, 返回受影响行数; 失败返回 -1 */
    int64_t execute_affected(const std::string& sql);

    /** 执行查询, 返回所有行 (失败返回空) */
    Rows query(const std::string& sql);

 private:
    /** 一个待执行的任务 */
    struct Task {
        std::string sql;
        bool is_query = false;
        // 结果
        bool ok = false;
        int64_t affected = 0;
        Rows rows;
        // 完成同步 (对应 bthread::CountdownEvent)
        bthread::CountdownEvent done{1};
    };

    /** worker 主循环 (worker_id 决定使用哪条连接) */
    void worker_loop(int worker_id);

    /** 在给定连接上执行一条 SQL, 填入 task */
    void run_task(MYSQL* conn, Task& task);

    /** 提交任务并等待完成, 返回任务 (读结果用) */
    std::shared_ptr<Task> submit(std::shared_ptr<Task> task);

    // pool_size 条连接, 每条被一个 worker 独占
    std::vector<MYSQL*> connections_;
    // pool_size 个 worker 线程
    std::vector<std::thread> workers_;

    // 任务队列 (生产者=调用线程, 消费者=worker)
    std::queue<std::shared_ptr<Task>> task_queue_;
    std::mutex queue_mu_;
    std::condition_variable queue_cv_;

    std::atomic<bool> running_{true};
    bool ready_ = false;
};

}  // namespace lab
