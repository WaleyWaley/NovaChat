#pragma once

#include <atomic>
#include <cstdint>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "connection.h"

namespace lab {

/**
 * C++ 版连接管理器 (基于真实 WebSocket Connection)。
 *
 * 和 TS 版对应, 但 C++ 必须手动处理并发:
 *  - std::mutex 保护共享数据 (by_user_id_ / by_conn_)
 *  - std::thread 跑心跳扫描
 *  - 关键: "持锁时不要做 IO (send/close)"。先在锁内取到 ConnectionPtr 的副本,
 *    解锁后再调用 conn->send()/close(), 避免长时间持锁甚至死锁。
 *
 * 连接对象用 ConnectionPtr (shared_ptr) 保存, 这样即使连接刚被注销, 正在发送的
 * 线程仍持有一份引用, 连接对象不会被提前销毁。
 */
class MiniConnectionManager {
 public:
    explicit MiniConnectionManager(size_t max_connections = 10000);
    ~MiniConnectionManager();

    /**
     * 注册一个已认证用户的连接。
     * 同 userId 已有连接时会踢掉旧连接 (close 4001)。
     * @return true 成功; false 达到最大连接数
     */
    bool register_user(const std::string& user_id, const std::string& username,
                       ConnectionPtr conn);

    /** 注销连接, 返回对应的 userId (找不到返回空串) */
    std::string unregister(Connection* conn);

    ConnectionPtr get_by_user_id(const std::string& user_id);
    bool is_online(const std::string& user_id);
    size_t online_count();
    std::vector<std::string> online_user_ids();

    bool send_to_user(const std::string& user_id, const std::string& message);
    std::pair<std::vector<std::string>, std::vector<std::string>> send_to_users(
        const std::vector<std::string>& user_ids, const std::string& message);

    bool kick_user(const std::string& user_id, const std::string& reason);

    void refresh_heartbeat(Connection* conn);

    void start_heartbeat(int interval_sec = 30, int timeout_sec = 120);
    void stop_heartbeat();

    void disconnect_all(const std::string& reason = "Server shutting down");

 private:
    void kick_existing(const ConnectionPtr& conn);

    struct Entry {
        ConnectionPtr conn;
        std::string username;
        int64_t connected_at_ms;
        int64_t last_heartbeat_ms;
    };

    std::map<std::string, Entry> by_user_id_;
    std::map<Connection*, std::string> by_conn_;

    std::mutex mu_;
    std::atomic<bool> running_{true};
    std::thread heartbeat_thread_;

    size_t max_connections_;
    int heartbeat_interval_sec_ = 30;
    int heartbeat_timeout_sec_ = 120;
};

}  // namespace lab
