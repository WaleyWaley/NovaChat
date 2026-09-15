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
#include <variant>

#include <butil/status.h>
#include <bthread/countdown_event.h>
#include <mysql/mysql.h>

namespace nova {

using Row = std::map<std::string, std::string>;

// SQL 参数值 (参数化查询用): 目前 DAO 只用 string / int64
using SqlParam = std::variant<std::string, int64_t>;

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

    // 执行写操作并返回受影响行数 (Phase 4: INSERT IGNORE 去重检测 / ACK 计数)
    // affected 可为 nullptr (等价于 Execute)
    butil::Status ExecuteAffected(const std::string& sql, int64_t* affected);

    // 执行查询 (SELECT)
    // row_cb: 每行结果回调
    butil::Status Query(const std::string& sql,
                        std::function<void(const Row&)> row_cb);

    // 查询并返回所有行
    butil::Status QueryAll(const std::string& sql, std::vector<Row>* rows);

    // ==================== 参数化查询 (Prepared Statement) =====================
    //
    // SQL 中的用户输入一律用 ? 占位, 参数经 mysql_stmt_bind_param 绑定 —
    // 数据与 SQL 结构完全分离, 杜绝注入 (手工转义在 NO_BACKSLASH_ESCAPES
    // sql_mode 下会失效, 不可依赖)。
    //
    // 错误码约定: 失败时 Status.error_code() = -mysql_errno (如 -1062 = 唯一键冲突),
    // error_str() 为 mysql 错误信息。调用方可据此区分"重复"与"其他错误"。

    // 参数化写操作
    butil::Status ExecutePrepared(const std::string& sql,
                                  const std::vector<SqlParam>& params);

    // 参数化写操作 + 受影响行数
    butil::Status ExecutePreparedAffected(const std::string& sql,
                                          const std::vector<SqlParam>& params,
                                          int64_t* affected);

    // 参数化查询, 返回所有行
    butil::Status QueryAllPrepared(const std::string& sql,
                                   const std::vector<SqlParam>& params,
                                   std::vector<Row>* rows);

    bool IsReady() const { return ready_; }
    const std::string& Database() const { return db_; }

private:
    // 任务定义
    struct Task {
        std::string sql;
        bool is_query;
        butil::Status* result;
        // bthread::CountdownEvent 用于挂起当前 bthread, 等待 Worker 完成
        bthread::CountdownEvent* done;
        // 查询结果
        std::vector<Row>* rows;           // QueryAll 用
        std::function<void(const Row&)>* row_cb;  // Query 回调
        std::mutex* cb_mutex;             // 回调线程安全锁
        int64_t* affected;                // ExecuteAffected 用: 受影响行数
        const std::vector<SqlParam>* params;  // 非空 → mysql_stmt 参数化执行
    };

    // 获取一个空闲连接 (阻塞直到有可用连接)
    MYSQL* AcquireConnection();
    void ReleaseConnection(MYSQL* conn);

    // 参数化任务执行 (mysql_stmt 路径, 在工作线程上运行)
    void ExecutePreparedTask(MYSQL* conn, const Task& task);

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
    // 通知 pthread 有新任务可执行
    std::condition_variable queue_cv_;
    // 专用 pthread 线程池
    std::vector<std::thread> workers_;
    std::atomic<bool> running_{true};

    std::string db_;
    bool ready_ = false;

    // 连接重建参数 (探活失败时用)
    std::string addr_, user_, passwd_;
    int port_ = 0;
};

}  // namespace nova
