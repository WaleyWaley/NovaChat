// =============================================================================
// NovaChat — UserDao 实现
//
// Phase 2: 双模式存储
//   - MySQL 可用 → 用户数据持久化到 MySQL
//   - 回退机制 → MySQL 不可用时使用内存存储 (Phase 1 兼容)
//
// 注: 会话/Redis 已移除 — 鉴权统一由网关负责 (BFF 模式), 本层只存用户数据。
// =============================================================================

#include "user_dao.h"
#include "nova/logger.h"

#include <algorithm>
#include <cstring>
#include <sstream>
#include <vector>

namespace nova {
namespace user {

namespace {

// LIKE 通配符转义: 用户输入的 % _ 按字面匹配 (否则 query="%" 会返回全量用户)
std::string EscapeLike(const std::string& s) {
    std::string r;
    r.reserve(s.size() + 4);
    for (char c : s) {
        if (c == '%' || c == '_' || c == '\\') r += '\\';
        r += c;
    }
    return r;
}

}  // anonymous namespace

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
    NOVA_LOG_INFO << "UserDao: MySQL pool ready (" << addr << ":" << port
                  << "/" << db << ")";
    return true;
}

// ============================= 用户 CRUD → MySQL (或内存) =====================

std::optional<UserRecord> UserDao::CreateUser(
        const std::string& username,
        const std::string& password_hash,
        const std::string& first_name,
        const std::string& last_name,
        const std::string& phone,
        int64_t user_id,
        int64_t created_at) {

    // --- MySQL 路径 (参数化查询: 用户数据一律 ? 占位, 杜绝 SQL 注入) ---
    if (mysql_ && mysql_->IsReady()) {
        // 先检查 username 唯一性 (提前查可给出更友好的错误信息;
        // 并发下仍有 TOCTOU, 见下方 -1062 兜底)
        if (UsernameExists(username)) {
            return std::nullopt;
        }

        const std::string sql =
            "INSERT INTO users "
            "(user_id, username, password_hash, first_name, last_name, "
            "bio, avatar_photo_id, phone, is_deleted, "
            "created_at, updated_at, username_changed_at) VALUES ("
            "?, ?, ?, ?, ?, '', '', ?, 0, ?, ?, ?)";
        const std::vector<nova::SqlParam> params = {
            user_id, username, password_hash, first_name, last_name,
            phone, created_at, created_at, created_at,
        };

        butil::Status st = mysql_->ExecutePrepared(sql, params);
        if (!st.ok()) {
            if (st.error_code() == -1062) {
                // 唯一索引冲突 = 用户名被并发注册抢走 (TOCTOU 兜底)
                return std::nullopt;
            }
            NOVA_LOG_ERROR << "UserDao: MySQL INSERT failed: " << st.error_str();
            return std::nullopt;
        }

        NOVA_VLOG(1) << "UserDao: Created user in MySQL id=" << user_id;

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
        return record;
    }

    // --- 内存回退 (Phase 1) ---
    {
        std::lock_guard<std::mutex> lock(mu_);

        if (users_by_username_.count(username)) {
            return std::nullopt;
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

        NOVA_VLOG(1) << "UserDao: Created user in memory id=" << user_id;
        return record;
    }
}

std::optional<UserRecord> UserDao::FindById(int64_t user_id) {
    // --- MySQL 路径 (参数化查询) ---
    if (mysql_ && mysql_->IsReady()) {
        const std::string sql =
            "SELECT user_id, username, password_hash, first_name, "
            "last_name, bio, avatar_photo_id, phone, is_deleted, "
            "created_at, updated_at, username_changed_at "
            "FROM users WHERE user_id = ?";

        std::vector<nova::Row> rows;
        butil::Status st = mysql_->QueryAllPrepared(sql, {user_id}, &rows);
        if (!st.ok()) {
            NOVA_LOG_ERROR << "UserDao: MySQL FindById failed: " << st.error_str();
            return std::nullopt;
        }

        for (const auto& row : rows) {
            auto it = row.find("is_deleted");
            if (it != row.end() && it->second == "1") continue;

            UserRecord r;
            r.user_id    = user_id;
            r.username   = row.at("username");
            r.password_hash = row.at("password_hash");
            r.first_name = row.at("first_name");
            r.last_name  = row.at("last_name");
            r.bio        = row.count("bio") ? row.at("bio") : "";
            r.avatar_photo_id = row.count("avatar_photo_id") ? row.at("avatar_photo_id") : "";
            r.phone      = row.count("phone") ? row.at("phone") : "";
            r.created_at = std::strtoll(row.at("created_at").c_str(), nullptr, 10);
            r.updated_at = std::strtoll(row.at("updated_at").c_str(), nullptr, 10);
            r.username_changed_at = std::strtoll(
                row.count("username_changed_at") ? row.at("username_changed_at").c_str() : "0",
                nullptr, 10);
            return r;
        }
        return std::nullopt;
    }

    // --- 内存回退 ---
    {
        std::lock_guard<std::mutex> lock(mu_);
        auto it = users_by_id_.find(user_id);
        if (it != users_by_id_.end() && !it->second.is_deleted) {
            return it->second;
        }
        return std::nullopt;
    }
}

std::optional<UserRecord> UserDao::FindByUsername(const std::string& username) {
    if (mysql_ && mysql_->IsReady()) {
        const std::string sql =
            "SELECT user_id, username, password_hash, first_name, "
            "last_name, bio, avatar_photo_id, phone, is_deleted, "
            "created_at, updated_at, username_changed_at "
            "FROM users WHERE username = ?";

        std::vector<nova::Row> rows;
        butil::Status st = mysql_->QueryAllPrepared(sql, {username}, &rows);
        if (!st.ok()) {
            NOVA_LOG_ERROR << "UserDao: MySQL FindByUsername failed: " << st.error_str();
            return std::nullopt;
        }

        for (const auto& row : rows) {
            auto it = row.find("is_deleted");
            if (it != row.end() && it->second == "1") continue;

            UserRecord r;
            r.user_id    = std::strtoll(row.at("user_id").c_str(), nullptr, 10);
            r.username   = username;
            r.password_hash = row.at("password_hash");
            r.first_name = row.at("first_name");
            r.last_name  = row.at("last_name");
            r.bio        = row.count("bio") ? row.at("bio") : "";
            r.avatar_photo_id = row.count("avatar_photo_id") ? row.at("avatar_photo_id") : "";
            r.phone      = row.count("phone") ? row.at("phone") : "";
            r.created_at = std::strtoll(row.at("created_at").c_str(), nullptr, 10);
            r.updated_at = std::strtoll(row.at("updated_at").c_str(), nullptr, 10);
            r.username_changed_at = std::strtoll(
                row.count("username_changed_at") ? row.at("username_changed_at").c_str() : "0",
                nullptr, 10);
            return r;
        }
        return std::nullopt;
    }

    {
        std::lock_guard<std::mutex> lock(mu_);
        auto it = users_by_username_.find(username);
        if (it != users_by_username_.end()) {
            auto user_it = users_by_id_.find(it->second);
            if (user_it != users_by_id_.end() && !user_it->second.is_deleted) {
                return user_it->second;
            }
        }
        return std::nullopt;
    }
}

bool UserDao::UpdateProfile(int64_t user_id,
                            const std::string& first_name,
                            const std::string& last_name,
                            const std::string& bio,
                            const std::string& avatar_photo_id,
                            int64_t updated_at) {
    if (mysql_ && mysql_->IsReady()) {
        // 动态列 + 占位符: 列名由代码控制 (非用户输入), 值一律 ? 绑定
        std::string sql = "UPDATE users SET updated_at = ?";
        std::vector<nova::SqlParam> params = {updated_at};
        if (!first_name.empty()) { sql += ", first_name = ?"; params.emplace_back(first_name); }
        if (!last_name.empty())  { sql += ", last_name = ?";  params.emplace_back(last_name); }
        if (!bio.empty())        { sql += ", bio = ?";        params.emplace_back(bio); }
        sql += ", avatar_photo_id = ?";   params.emplace_back(avatar_photo_id);
        sql += " WHERE user_id = ?";      params.emplace_back(user_id);

        butil::Status st = mysql_->ExecutePrepared(sql, params);
        if (!st.ok()) return false;
        // 检查是否真的更新了行
        return true;
    }

    {
        std::lock_guard<std::mutex> lock(mu_);
        auto it = users_by_id_.find(user_id);
        if (it == users_by_id_.end() || it->second.is_deleted) return false;
        if (!first_name.empty()) it->second.first_name = first_name;
        if (!last_name.empty())  it->second.last_name  = last_name;
        if (!bio.empty())        it->second.bio        = bio;
        it->second.avatar_photo_id = avatar_photo_id;
        it->second.updated_at = updated_at;
        return true;
    }
}

bool UserDao::ChangeUsername(int64_t user_id, const std::string& new_username,
                             int64_t updated_at) {
    if (mysql_ && mysql_->IsReady()) {
        const std::string sql =
            "UPDATE users SET username = ?, username_changed_at = ?, "
            "updated_at = ? WHERE user_id = ?";
        const std::vector<nova::SqlParam> params = {
            new_username, updated_at, updated_at, user_id,
        };
        return mysql_->ExecutePrepared(sql, params).ok();
    }

    {
        std::lock_guard<std::mutex> lock(mu_);
        if (users_by_username_.count(new_username)) return false;
        auto it = users_by_id_.find(user_id);
        if (it == users_by_id_.end() || it->second.is_deleted) return false;
        users_by_username_.erase(it->second.username);
        it->second.username = new_username;
        it->second.username_changed_at = updated_at;
        it->second.updated_at = updated_at;
        users_by_username_[new_username] = user_id;
        return true;
    }
}

bool UserDao::ChangePassword(int64_t user_id,
                             const std::string& new_password_hash,
                             int64_t updated_at) {
    if (mysql_ && mysql_->IsReady()) {
        const std::string sql =
            "UPDATE users SET password_hash = ?, updated_at = ? WHERE user_id = ?";
        const std::vector<nova::SqlParam> params = {
            new_password_hash, updated_at, user_id,
        };
        return mysql_->ExecutePrepared(sql, params).ok();
    }

    {
        std::lock_guard<std::mutex> lock(mu_);
        auto it = users_by_id_.find(user_id);
        if (it == users_by_id_.end() || it->second.is_deleted) return false;
        it->second.password_hash = new_password_hash;
        it->second.updated_at = updated_at;
        return true;
    }
}

bool UserDao::DeleteUser(int64_t user_id) {
    if (mysql_ && mysql_->IsReady()) {
        const std::string sql = "UPDATE users SET is_deleted = 1 WHERE user_id = ?";
        return mysql_->ExecutePrepared(sql, {user_id}).ok();
    }

    {
        std::lock_guard<std::mutex> lock(mu_);
        auto it = users_by_id_.find(user_id);
        if (it == users_by_id_.end()) return false;
        it->second.is_deleted = true;
        users_by_username_.erase(it->second.username);
        return true;
    }
}

bool UserDao::UsernameExists(const std::string& username) {
    if (mysql_ && mysql_->IsReady()) {
        const std::string sql =
            "SELECT COUNT(*) as cnt FROM users WHERE username = ? AND is_deleted = 0";
        std::vector<nova::Row> rows;
        butil::Status st = mysql_->QueryAllPrepared(sql, {username}, &rows);
        if (!st.ok()) {
            NOVA_LOG_ERROR << "UserDao: MySQL UsernameExists failed: " << st.error_str();
            return false;
        }
        if (!rows.empty()) {
            auto it = rows[0].find("cnt");
            if (it != rows[0].end() && it->second != "0") return true;
        }
        return false;
    }

    {
        std::lock_guard<std::mutex> lock(mu_);
        return users_by_username_.count(username) > 0;
    }
}

std::vector<UserRecord> UserDao::SearchUsers(const std::string& query,
                                             int32_t limit, int64_t offset_id) {
    if (mysql_ && mysql_->IsReady()) {
        // LIKE 前缀匹配: 通配符先转义再拼 % (limit 是代码常量, 内联即可)
        std::string sql =
            "SELECT user_id, username, password_hash, first_name, "
            "last_name, bio, avatar_photo_id, phone, "
            "created_at, updated_at, username_changed_at "
            "FROM users WHERE is_deleted = 0 AND "
            "(username LIKE ? OR first_name LIKE ?) ";
        std::vector<nova::SqlParam> params = {
            EscapeLike(query) + "%",
            EscapeLike(query) + "%",
        };
        if (offset_id > 0) {
            sql += "AND user_id < ? ";
            params.emplace_back(offset_id);
        }
        sql += "ORDER BY user_id DESC LIMIT " + std::to_string(limit);

        std::vector<nova::Row> rows;
        butil::Status st = mysql_->QueryAllPrepared(sql, params, &rows);
        if (!st.ok()) {
            NOVA_LOG_ERROR << "UserDao: MySQL SearchUsers failed: " << st.error_str();
            return {};
        }

        std::vector<UserRecord> results;
        for (const auto& row : rows) {
            UserRecord r;
            r.user_id    = std::strtoll(row.at("user_id").c_str(), nullptr, 10);
            r.username   = row.at("username");
            r.password_hash = "";
            r.first_name = row.at("first_name");
            r.last_name  = row.at("last_name");
            r.created_at = std::strtoll(row.at("created_at").c_str(), nullptr, 10);
            r.updated_at = std::strtoll(row.at("updated_at").c_str(), nullptr, 10);
            results.push_back(r);
        }
        return results;
    }

    {
        std::lock_guard<std::mutex> lock(mu_);
        std::vector<UserRecord> results;
        if (query.empty() || limit <= 0) return results;

        for (const auto& [id, record] : users_by_id_) {
            if (record.is_deleted) continue;
            if (id >= offset_id) continue;

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

        std::sort(results.begin(), results.end(),
                  [](const UserRecord& a, const UserRecord& b) {
                      return a.user_id > b.user_id;
                  });
        return results;
    }
}

std::vector<UserRecord> UserDao::GetUsersByIds(
        const std::vector<int64_t>& user_ids) {
    if (mysql_ && mysql_->IsReady()) {
        if (user_ids.empty()) return {};   // 空列表提前返回 (避免生成 IN () 语法错误)

        std::string sql =
            "SELECT user_id, username, password_hash, first_name, "
            "last_name, bio, avatar_photo_id, phone, "
            "created_at, updated_at, username_changed_at "
            "FROM users WHERE is_deleted = 0 AND user_id IN (";
        std::vector<nova::SqlParam> params;
        params.reserve(user_ids.size());
        for (size_t i = 0; i < user_ids.size(); i++) {
            sql += (i > 0) ? ", ?" : "?";
            params.emplace_back(user_ids[i]);
        }
        sql += ")";

        std::vector<nova::Row> rows;
        butil::Status st = mysql_->QueryAllPrepared(sql, params, &rows);
        if (!st.ok()) {
            NOVA_LOG_ERROR << "UserDao: MySQL GetUsersByIds failed: " << st.error_str();
            return {};
        }

        std::vector<UserRecord> results;
        for (const auto& row : rows) {
            UserRecord r;
            r.user_id    = std::strtoll(row.at("user_id").c_str(), nullptr, 10);
            r.username   = row.at("username");
            r.password_hash = "";
            r.first_name = row.at("first_name");
            r.last_name  = row.at("last_name");
            r.created_at = std::strtoll(row.at("created_at").c_str(), nullptr, 10);
            r.updated_at = std::strtoll(row.at("updated_at").c_str(), nullptr, 10);
            results.push_back(r);
        }
        return results;
    }

    {
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
}

}  // namespace user
}  // namespace nova
