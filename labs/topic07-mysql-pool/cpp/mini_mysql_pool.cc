#include "mini_mysql_pool.h"

#include <iostream>

namespace lab {

MiniMySqlPool::~MiniMySqlPool() {
    // TODO: 优雅关闭
    //  1. running_ = false;
    //  2. queue_cv_.notify_all();          // 唤醒所有可能在 wait 的 worker
    //  3. for (auto& w : workers_) if (w.joinable()) w.join();
    //  4. for (MYSQL* c : connections_) mysql_close(c);
    //  5. connections_.clear(); workers_.clear();
    running_ = false;
    queue_cv_.notify_all();
    for(auto& w : workers_){
        if(w.joinable())
            w.join();
    }
    for(MYSQL* c : connections_)
        mysql_close(c);

    connections_.clear();
    workers_.clear();
}

bool MiniMySqlPool::init(const std::string& host, int port,
                         const std::string& user, const std::string& passwd,
                         const std::string& db, int pool_size) {

    if(pool_size <= 0)
        return false;
    for (int i = 0; i < pool_size; i++){
        MYSQL* c = mysql_init(nullptr);  // 新分配一个连接句柄
        if(not c)
            return false;
        // 建立连接
        if(not mysql_real_connect(c, host.c_str(), user.c_str(), passwd.c_str(), db.c_str(), port, nullptr, 0)){
            std::cerr << "connect failsed: " << mysql_error(c) << "\n";
            mysql_close(c);
            return false;
        }
        mysql_set_character_set(c, "utf8mb4");
        connections_.push_back(c);
    }

    for (int i = 0; i < pool_size; i++)
    {
        // 新线程执行 woker_looo(this, i);
        workers_.emplace_back([this, i]() { worker_loop(i); });
    }
    ready_ = true;
    return true;
}

// 消费者
void MiniMySqlPool::worker_loop(int worker_id) {
    MYSQL* conn = connections_[worker_id];
    while(true){
        std::shared_ptr<Task> task;
        {
            std::unique_lock<std::mutex> lock(queue_mu_);
            queue_cv_.wait(lock, [this] { return !task_queue_.empty() or not running_; });
            if(task_queue_.empty() and not running_)
                break;
            task = task_queue_.front();
            task_queue_.pop();
        }
        run_task(conn, *task);
        // 告诉等待这个Task的bthreadMySQL查询完成了
        task->done.signal();
    }
}

void MiniMySqlPool::run_task(MYSQL* conn, Task& task) {
    // 在连接上执行一条SQL语句的C API int mysql_real_query(MYSQL *mysql, const char *q, unsigned long length); 0成功，非0失败
    task.ok = (mysql_real_query(conn, task.sql.c_str(), static_cast<unsigned long>(task.sql.size())) == 0);

    if(not task.ok)
        return;
    
    if(task.is_query){
        MYSQL_RES* res = mysql_store_result(conn);  // 把所有行拉回本地
        
        if(not res)
            return; 

        const unsigned int n = mysql_num_fields(res);   // 结果有几列
        MYSQL_FIELD* fields = mysql_fetch_fields(res);  // 所有列的元信息

        MYSQL_ROW row;

        // mysql_fetch_row 取下一行，没有返回nullptr
        while((row = mysql_fetch_row(res)) != nullptr){
            unsigned long* lens = mysql_fetch_lengths(res);     // 当前行各列的字节长度数组。防\0切断
            Row r;  // map <string ,string>
            for (unsigned int i = 0; i < n; i++){
                // row[i] == nullptr 表示 SQL null -> 存空串
                r[fields[i].name] = row[i] ? std::string(row[i], lens[i]) : "";
            }
            task.rows.push_back(std::move(r));
        }
        mysql_free_result(res);     // 必须释放刚刚拉回本地的内存
    } else {
        task.affected = static_cast<int64_t>(mysql_affected_rows(conn));    // 修改了多少行
    }
}

// 生产者
std::shared_ptr<MiniMySqlPool::Task> MiniMySqlPool::submit(std::shared_ptr<Task> task) {
    {
        std::lock_guard<std::mutex> lock(queue_mu_);
        task_queue_.push(task);
    }
    queue_cv_.notify_one(); // 通知
    task->done.wait();  // 阻塞到worker完成
    return task;
}

bool MiniMySqlPool::execute(const std::string& sql) {
    // TODO: 构造 task (is_query=false), submit, 返回 task->ok
    auto t = std::make_shared<Task>();
    t->sql = sql;
    t->is_query = false;
    submit(t);
    return t->ok;
}

int64_t MiniMySqlPool::execute_affected(const std::string& sql) {
    auto t = std::make_shared<Task>();
    t->sql = sql;
    t->is_query = false;
    submit(t);
    return t->ok ? t->affected : -1;
}

Rows MiniMySqlPool::query(const std::string& sql) {
    // TODO: 构造 task (is_query=true), submit, 返回 ok ? rows : {}
    auto t = std::make_shared<Task>();
    t->sql = sql;
    t->is_query = true;
    submit(t);
    return t->ok ? t->rows : Rows{};
}

}  // namespace lab


// MYSQL *mysql_real_connect(MYSQL *mysql,    // mysql_init 返回的句柄
//                           const char *host,     // "127.0.0.1"
//                           const char *user,     // "root"
//                           const char *passwd,   // 空串 "" (本 lab)
//                           const char *db,       // "novachat_lab"
//                           unsigned int port,    // 3307
//                           const char *unix_socket, // nullptr (Windows 无用)
//                           unsigned long clientflag); // 0