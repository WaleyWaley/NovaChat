// =============================================================================
// NovaChat — UserDao 实现
//
// Phase 1: 内存模拟存储 (线程安全)
// Phase 2: 迁移到 MySQL + Redis, 对外接口不变
// =============================================================================

#include "user_dao.h"
#include "nova/logger.h"

#include <algorithm>
#include <cstring>

namespace nova {
namespace user {

// ============================= 初始化 =========================================

bool UserDao::InitMySql(const std::string& addr, int port,
                        const std::string& user, const std::string& passwd,
                        const std::string& db, int pool_size) {
    mysql_ = std::make_unique<nova::MySqlPool>();
    if (!mysql_->Init(addr, port, user, passwd, db, pool_size)) {
        NOVA_LOG_ERROR << "UserDao: Failed to initialize MySQL pool";
        mysql_.reset();
        return false;
    }
    NOVA_LOG_INFO << "UserDao: MySQL pool initialized ("
                  << addr << ":" << port << "/" << db << ")";
    return true;
}

bool UserDao::InitRedis(const std::string& addr, int port,
                        const std::string& password) {
    redis_ = std::make_unique<nova::RedisClient>();
    if (!redis_->Init(addr, port, password)) {
        NOVA_LOG_ERROR << "UserDao: Failed to initialize Redis client";
        redis_.reset();
        return false;
    }
    NOVA_LOG_INFO << "UserDao: Redis client initialized ("
                  << addr << ":" << port << ")";
    return true;
}

// ============================= 用户 CRUD ======================================

std::optional<UserRecord> UserDao::CreateUser(
        const std::string& username,
        const std::string& password_hash,
        const std::string& first_name,
        const std::string& last_name,
        const std::string& phone,
        int64_t user_id,
        int64_t created_at) {

    std::lock_guard<std::mutex> lock(mu_);

    // 检查 username 唯一性
    if (users_by_username_.count(username)) {
        return std::nullopt;  // username 已存在
    }

    UserRecord record;
    record.user_id       = user_id;
    record.username      = username;
    record.password_hash = password_hash;
    record.first_name    = first_name;
    record.last_name     = last_name;
    record.phone         = phone;
    record.created_at    = created_at;
    record.updated_at    = created_at;
    record.username_changed_at = created_at;

    users_by_id_[user_id] = record;
    users_by_username_[username] = user_id;

    NOVA_VLOG(1) << "UserDao: Created user id=" << user_id
                 << " username=" << username;

    return record;
}

std::optional<UserRecord> UserDao::FindById(int64_t user_id) {
    std::lock_guard<std::mutex> lock(mu_);

    auto it = users_by_id_.find(user_id);
    if (it == users_by_id_.end() || it->second.is_deleted) {
        return std::nullopt;
    }
    return it->second;
}

std::optional<UserRecord> UserDao::FindByUsername(const std::string& username) {
    std::lock_guard<std::mutex> lock(mu_);

    auto it = users_by_username_.find(username);
    if (it == users_by_username_.end()) {
        return std::nullopt;
    }
    auto user_it = users_by_id_.find(it->second);
    if (user_it == users_by_id_.end() || user_it->second.is_deleted) {
        return std::nullopt;
    }
    return user_it->second;
}

bool UserDao::UpdateProfile(int64_t user_id,
                            const std::string& first_name,
                            const std::string& last_name,
                            const std::string& bio,
                            const std::string& avatar_photo_id,
                            int64_t updated_at) {
    std::lock_guard<std::mutex> lock(mu_);

    auto it = users_by_id_.find(user_id);
    if (it == users_by_id_.end() || it->second.is_deleted) {
        return false;
    }

    if (!first_name.empty()) it->second.first_name = first_name;
    if (!last_name.empty())  it->second.last_name  = last_name;
    if (!bio.empty())        it->second.bio        = bio;
    // avatar_photo_id 允许设为空 (删除头像)
    it->second.avatar_photo_id = avatar_photo_id;
    it->second.updated_at = updated_at;

    return true;
}

bool UserDao::ChangeUsername(int64_t user_id, const std::string& new_username,
                             int64_t updated_at) {
    std::lock_guard<std::mutex> lock(mu_);

    // 检查新用户名是否已被占用
    if (users_by_username_.count(new_username)) {
        return false;
    }

    auto it = users_by_id_.find(user_id);
    if (it == users_by_id_.end() || it->second.is_deleted) {
        return false;
    }

    // 删除旧映射, 添加新映射
    users_by_username_.erase(it->second.username);
    it->second.username = new_username;
    it->second.username_changed_at = updated_at;
    it->second.updated_at = updated_at;
    users_by_username_[new_username] = user_id;

    return true;
}

bool UserDao::ChangePassword(int64_t user_id,
                             const std::string& new_password_hash,
                             int64_t updated_at) {
    std::lock_guard<std::mutex> lock(mu_);

    auto it = users_by_id_.find(user_id);
    if (it == users_by_id_.end() || it->second.is_deleted) {
        return false;
    }

    it->second.password_hash = new_password_hash;
    it->second.updated_at = updated_at;
    return true;
}

bool UserDao::DeleteUser(int64_t user_id) {
    std::lock_guard<std::mutex> lock(mu_);

    auto it = users_by_id_.find(user_id);
    if (it == users_by_id_.end()) {
        return false;
    }

    it->second.is_deleted = true;
    users_by_username_.erase(it->second.username);
    return true;
}

bool UserDao::UsernameExists(const std::string& username) {
    std::lock_guard<std::mutex> lock(mu_);
    return users_by_username_.count(username) > 0;
}

std::vector<UserRecord> UserDao::SearchUsers(const std::string& query,
                                             int32_t limit, int64_t offset_id) {
    std::lock_guard<std::mutex> lock(mu_);

    std::vector<UserRecord> results;
    if (query.empty() || limit <= 0) return results;

    for (const auto& [id, record] : users_by_id_) {
        if (record.is_deleted) continue;
        if (id >= offset_id) continue;  // offset_id 分页

        // 前缀匹配 username 或 first_name (case-insensitive 简化版)
        bool match = false;
        if (record.username.size() >= query.size() &&
            strncasecmp(record.username.c_str(), query.c_str(), query.size()) == 0) {
            match = true;
        }
        if (!match && record.first_name.size() >= query.size() &&
            strncasecmp(record.first_name.c_str(), query.c_str(), query.size()) == 0) {
            match = true;
        }

        if (match) {
            results.push_back(record);
            if (static_cast<int32_t>(results.size()) >= limit) break;
        }
    }

    // 按 user_id 降序 (较新的在前)
    std::sort(results.begin(), results.end(),
              [](const UserRecord& a, const UserRecord& b) {
                  return a.user_id > b.user_id;
              });

    return results;
}

std::vector<UserRecord> UserDao::GetUsersByIds(
        const std::vector<int64_t>& user_ids) {
    std::lock_guard<std::mutex> lock(mu_);

    std::vector<UserRecord> results;
    results.reserve(user_ids.size());

    for (int64_t id : user_ids) {
        auto it = users_by_id_.find(id);
        if (it != users_by_id_.end() && !it->second.is_deleted) {
            results.push_back(it->second);
        }
    }
    return results;
}

// ============================= Session 管理 ===================================

void UserDao::CreateSession(const SessionRecord& session) {
    std::lock_guard<std::mutex> lock(mu_);
    sessions_[session.refresh_token] = session;
}

std::optional<SessionRecord> UserDao::FindSession(
        const std::string& refresh_token) {
    std::lock_guard<std::mutex> lock(mu_);

    auto it = sessions_.find(refresh_token);
    if (it == sessions_.end()) {
        return std::nullopt;
    }
    return it->second;
}

void UserDao::DeleteSession(const std::string& refresh_token) {
    std::lock_guard<std::mutex> lock(mu_);
    sessions_.erase(refresh_token);
}

void UserDao::DeleteAllSessions(int64_t user_id) {
    std::lock_guard<std::mutex> lock(mu_);

    auto it = sessions_.begin();
    while (it != sessions_.end()) {
        if (it->second.user_id == user_id) {
            it = sessions_.erase(it);
        } else {
            ++it;
        }
    }
}

}  // namespace user
}  // namespace nova
