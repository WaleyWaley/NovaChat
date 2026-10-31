#include "mini_connection_manager.h"
#include "json.hpp"
#include <chrono>
#include <iostream>
#include <stdexcept>
#include <thread>

namespace lab {

namespace {
int64_t now_ms() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}
}  // namespace

MiniConnectionManager::MiniConnectionManager(size_t max_connections)
    : max_connections_(max_connections) {}

MiniConnectionManager::~MiniConnectionManager() {
    stop_heartbeat();
}

bool MiniConnectionManager::register_user(const std::string& user_id,
                                          const std::string& username,
                                          ConnectionPtr conn) {
    // TODO: 实现注册逻辑
    //  1. std::lock_guard<std::mutex> lock(mu_);
    //  2. 若 by_user_id_.size() >= max_connections_ → return false
    //  3. 若 by_user_id_ 已有该 user_id → 取旧 conn, 调 kick_existing(旧conn)
    //  4. 构造 Entry{conn, username, now_ms(), now_ms()}, 写入 by_user_id_
    //  5. by_conn_[conn.get()] = user_id
    //  6. return true
    std::lock_guard<std::mutex> lock(mu_);
    if(by_user_id_.size() >= max_connections_)
      return false;
    
    // 如果有旧连接就踢掉
    auto it = by_user_id_.find(user_id);
    if(it != by_user_id_.end())
        kick_existing(it->second.conn);

    Entry entry_;
    entry_.conn = conn;
    entry_.username = username;
    entry_.connected_at_ms = now_ms();
    entry_.last_heartbeat_ms = now_ms();

    by_user_id_[user_id] = entry_;
    by_conn_[conn.get()] = user_id;

    return true;
}

std::string MiniConnectionManager::unregister(Connection* conn) {
    // TODO: 实现注销逻辑
    //  1. lock(mu_)
    //  2. 通过 by_conn_ 找 user_id; 找不到 → return ""
    //  3. 安全检查: 若 by_user_id_[user_id].conn.get() != conn, 说明是旧连接,
    //     只从 by_conn_ 删除并 return ""
    //  4. 否则从两个 map 都删除, return user_id
    std::lock_guard<std::mutex> lock(mu_);
    if(by_conn_.count(conn) == 0)
        return "";

    std::string uid = by_conn_[conn];

    // 如果是旧连接
    auto it = by_user_id_.find(uid);
    if (it == by_user_id_.end() or it->second.conn.get() != conn) {
        by_conn_.erase(conn);
        return "";
    } else {
        by_user_id_.erase(uid);
        by_conn_.erase(conn);
        return uid;
    }
}

ConnectionPtr MiniConnectionManager::get_by_user_id(const std::string& user_id) {
    // TODO: lock, 查找 entry, 返回 entry.conn (找不到返回 nullptr)
    std::lock_guard<std::mutex> lock(mu_);
    auto it = by_user_id_.find(user_id);
    if(it == by_user_id_.end()){
        return nullptr;
    }
    return it->second.conn;
}

bool MiniConnectionManager::is_online(const std::string& user_id) {
    std::lock_guard<std::mutex> lock(mu_);
    auto it = by_user_id_.find(user_id);
    if (it != by_user_id_.end()){
        return true;
    }
    return false;
}

size_t MiniConnectionManager::online_count() {
    std::lock_guard<std::mutex> lock(mu_);
    size_t count = by_user_id_.size();
    return count;
}

std::vector<std::string> MiniConnectionManager::online_user_ids() {
    // TODO: lock, 收集 by_user_id_ 的 key
    std::lock_guard<std::mutex> lock(mu_);
    std::vector<std::string> uids;
    uids.reserve(by_user_id_.size());

    // C++17的结构化绑定
    for(const auto& [uid,_] : by_user_id_){
        uids.push_back(uid);
    }
    return uids;
}

bool MiniConnectionManager::send_to_user(const std::string& user_id,
                                         const std::string& message) {
    // TODO: 关键点 —— 不能在持锁时 send
    //  1. lock(mu_), 找到 entry, 复制 ConnectionPtr 到局部变量, 解锁
    //  2. 解锁后调用 conn->send(message)

    ConnectionPtr ws;
    {
        std::lock_guard<std::mutex> lock(mu_);
        auto it = by_user_id_.find(user_id);
        if(it == by_user_id_.end() || !it->second.conn){
            return false;
        }
        ws = it->second.conn;
    }
    try{
        return ws->send(message);
    }catch(...){
        std::cerr << "send error" << std::endl;
        return false;
    }
}

std::pair<std::vector<std::string>, std::vector<std::string>>
MiniConnectionManager::send_to_users(const std::vector<std::string>& user_ids,
                                     const std::string& message) {
    // TODO: 遍历 user_ids, 分别 send_to_user, 收集 delivered / missed
    std::vector<std::string> delievered;
    std::vector<std::string> missed;
    for(const auto& uid:user_ids){
        if(send_to_user(uid, message)){
            delievered.push_back(uid);
        }else{
            missed.push_back(uid);
        }
    }
    return {delievered,missed};
}

bool MiniConnectionManager::kick_user(const std::string& user_id,
                                      const std::string& reason) {
    // TODO: 关键点 —— 先在锁内把条目摘除并复制 ConnectionPtr, 解锁后再 close
    //  1. lock(mu_), 找不到 → return false
    //  2. 复制 ConnectionPtr conn, 从两个 map 删除该条目
    //  3. 解锁
    //  4. conn->send({"type":"kicked",...})  (可选)
    //  5. conn->close(4001, reason)  （或延迟一会儿再 close）
    //  6. return true
    std::unique_lock<std::mutex> lock(mu_);
    auto it = by_user_id_.find(user_id);
    if(it == by_user_id_.end())
        return false;
    const auto ws = it->second.conn;
    by_user_id_.erase(user_id);
    by_conn_.erase(ws.get());
    mu_.unlock();
    
    ws->send(nlohmann::json{{"type","kicked"},{"payload",{{"reason",reason}}}}.dump());
    ws->close(4001, reason);
    return true;
}

void MiniConnectionManager::refresh_heartbeat(Connection* conn) {
    // TODO: lock, 通过 by_conn_ 找 user_id, 更新 last_heartbeat_ms = now_ms()
    std::lock_guard<std::mutex> lock(mu_);
    const auto it = by_conn_.find(conn);
    if(it == by_conn_.end()){
        std::cerr << "未找到连接" << std::endl;
        return;
    }
    const auto uid_iter = by_user_id_.find(it->second);
    if(uid_iter == by_user_id_.end()){
        std::cerr << "未在user_id_中找到entry" << std::endl;
        return;
    }
    const std::string& uid = uid_iter->first;
    uid_iter->second.last_heartbeat_ms= now_ms();
    return;
}

void MiniConnectionManager::start_heartbeat(int interval_sec, int timeout_sec) {
    // TODO:
    //  1. 若 heartbeat_thread_.joinable() 直接 return
    //  2. 保存 interval / timeout
    //  3. 启动 std::thread, 循环:
    //     - sleep_for(interval_sec 秒)
    //     - 若 !running_ 退出
    //     - lock, 收集超时条目 (now_ms() - last_heartbeat_ms > timeout_sec*1000)
    //       并从两个 map 删除, 复制 ConnectionPtr 列表, 解锁
    //     - 解锁后逐个 conn->close(4002, "Heartbeat timeout")

    // 如果当前thread已经关联心跳线程直接退出
    if(heartbeat_thread_.joinable())
        return;

    heartbeat_interval_sec_ = interval_sec;
    heartbeat_timeout_sec_ = timeout_sec;

    running_ = true;

    heartbeat_thread_ = std::thread([this, interval_sec, timeout_sec]() {
        const int64_t limit_ms = static_cast<int64_t>(timeout_sec) * 1000;
        while(running_){
            std::this_thread::sleep_for(std::chrono::seconds(interval_sec));
            if(not running_)
                break;
            std::vector<ConnectionPtr> time_out;
            // 只做map操作，把连接摘出来
            {
                std::lock_guard<std::mutex> lock(mu_);
                const int64_t now = now_ms();
                for (auto it = by_user_id_.begin(); it != by_user_id_.end();){
                    if(now - it->second.last_heartbeat_ms > limit_ms){
                        time_out.push_back(it->second.conn);
                        by_conn_.erase(it->second.conn.get());
                        // 防止迭代器失效
                        it = by_user_id_.erase(it);
                    } else {
                        it++;
                    }
                }
            }
            // 锁外逐个关闭
            for(const auto& c: time_out){
                std::cout << "[heartbeat] timeout, closing conn" << c->id() << "\n";
                c->close(4002, "Heartbeat timeout");
            }
        }
    });
}

void MiniConnectionManager::stop_heartbeat() {
    // TODO: running_ = false; 若 joinable 则 join()
    running_ = false;
    if(heartbeat_thread_.joinable())
        heartbeat_thread_.join();
}

void MiniConnectionManager::disconnect_all(const std::string& reason) {
    // TODO:
    //  1. lock, 复制所有 ConnectionPtr 到临时 vector, 清空两个 map, 解锁
    //  2. 逐个 conn->close(4000, reason)
    std::unique_lock<std::mutex> lock(mu_);
    std::vector<ConnectionPtr> sendList;
    auto it = by_user_id_.begin();
    while(it != by_user_id_.end()){
        sendList.push_back(it->second.conn);
        it++;
    }
    by_conn_.clear();
    by_user_id_.clear();
    mu_.unlock();
    // 锁外慢慢send
    for(const auto& conn : sendList){
        conn->close(4000, reason);
    }
}

void MiniConnectionManager::kick_existing(const ConnectionPtr& conn) {
    conn->close(4001, "Replaced by new connection");
    by_conn_.erase(conn.get());
}

}  // namespace lab
